import { randomUUID } from 'node:crypto';
import { witnessJSON, witnessSHA } from './witnessCodec.js';

export interface WitnessTopology {
  readonly sha256: string;
  readonly json: string;
  readonly bytes: number;
}
export interface WitnessFrame {
  readonly seq: number;
  readonly at: number;
  readonly json: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly topologySha256: string | null;
  readonly status: 'recorded' | 'unavailable';
  readonly previousChain: string;
  readonly chain: string;
}
export class WitnessReadError extends Error {
  constructor(readonly code: 'epoch' | 'cursor' | 'gap' | 'unavailable', message: string) { super(message); }
}

/** A rolling diagnostic journal, independent of ETA availability and scoring.
 * Expired or oversized inputs are explicit gaps. Capturing a witness must
 * never prevent the collector from publishing live bus positions. */
export class CollectorWitnessJournal {
  readonly epoch: string;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private frames: WitnessFrame[] = [];
  private topologies = new Map<string, WitnessTopology>();
  private bytes = 0;
  private sequence = 0;
  private lastAt = -Infinity;
  private chain: string;
  private failure: string | null = null;
  private hardFailure: string | null = null;
  private captureFailures = 0;
  private latestReference: Omit<WitnessFrame, 'json' | 'bytes' | 'previousChain'> | null = null;

  constructor({ epoch = randomUUID(), maxFrames = 720, maxBytes = 16 * 1024 * 1024, maxAgeMs = 3600000 }:
    { epoch?: string; maxFrames?: number; maxBytes?: number; maxAgeMs?: number } = {}) {
    if (!epoch || epoch.length > 100 || ![maxFrames, maxBytes, maxAgeMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid collector witness bounds');
    this.epoch = epoch; this.maxFrames = maxFrames; this.maxBytes = maxBytes; this.maxAgeMs = maxAgeMs;
    this.chain = witnessSHA(witnessJSON(['collector-witness-v1', epoch]));
  }

  static topology(value: unknown): WitnessTopology {
    const json = witnessJSON(value), bytes = Buffer.byteLength(json);
    if (bytes > 2 * 1024 * 1024) throw new Error('Collector topology exceeds capture bound');
    return Object.freeze({ json, bytes, sha256: witnessSHA(json) });
  }

  /** Call once per attempted poll, including a failed or empty poll. A caller
   * that cannot capture the input marks a gap instead of copying a later poll. */
  append(at: number, input: unknown, topology: WitnessTopology | null): WitnessFrame {
    if (this.hardFailure) throw new Error(this.hardFailure);
    if (!Number.isSafeInteger(at) || at < 0 || at <= this.lastAt) throw new Error('Invalid collector witness clock');
    const json = witnessJSON(input), bytes = Buffer.byteLength(json);
    if (bytes > 512 * 1024) throw new Error('Collector witness exceeds capture bound');
    if (topology && (topology.bytes !== Buffer.byteLength(topology.json) || topology.sha256 !== witnessSHA(topology.json)))
      throw new Error('Invalid collector topology receipt');
    return this.retain(at, json, bytes, topology, 'recorded');
  }

  private retain(at: number, json: string, bytes: number, topology: WitnessTopology | null,
    status: WitnessFrame['status']): WitnessFrame {
    const seq = ++this.sequence, sha256 = witnessSHA(json), previousChain = this.chain;
    this.chain = witnessSHA(witnessJSON([previousChain, seq, at, sha256, topology?.sha256 ?? null, status]));
    const frame = Object.freeze({ seq, at, json, sha256, bytes, topologySha256: topology?.sha256 ?? null, status,
      previousChain, chain: this.chain });
    this.latestReference = { seq, at, sha256, topologySha256: frame.topologySha256, status, chain: frame.chain };
    this.lastAt = at;
    if (topology && !this.topologies.has(topology.sha256)) {
      this.topologies.set(topology.sha256, Object.freeze({ ...topology })); this.bytes += topology.bytes;
    }
    this.frames.push(frame); this.bytes += bytes; this.expire(at);
    if (status === 'recorded') this.failure = null;
    return frame;
  }

  /** A missed capture must be visible even when no frame bytes could be kept. */
  fail(at: number, reason: string): void {
    this.captureFailures++;
    this.failure = reason.slice(0, 200);
    if (this.hardFailure) return;
    if (!Number.isSafeInteger(at) || at < 0 || at <= this.lastAt) {
      this.hardFailure = 'Collector capture continuity was lost'; return;
    }
    const json = witnessJSON({ status: 'unavailable', reason: this.failure });
    this.retain(at, json, Buffer.byteLength(json), null, 'unavailable');
  }

  private expire(now: number): void {
    while (this.frames.length && (this.frames.length > this.maxFrames || this.bytes > this.maxBytes
      || now - this.frames[0]!.at > this.maxAgeMs)) {
      const removed = this.frames.shift()!; this.bytes -= removed.bytes;
      const hash = removed.topologySha256;
      if (hash && !this.frames.some(frame => frame.topologySha256 === hash)) {
        this.bytes -= this.topologies.get(hash)?.bytes ?? 0; this.topologies.delete(hash);
      }
    }
  }

  read(epoch: string, after: number, { now = Date.now(), limit = 16 }:
    { now?: number; limit?: number } = {}) {
    if (this.hardFailure) throw new WitnessReadError('unavailable', this.hardFailure);
    if (epoch !== this.epoch) throw new WitnessReadError('epoch', 'Collector witness epoch changed');
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence || !Number.isFinite(now)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new WitnessReadError('cursor', 'Invalid collector witness cursor');
    this.expire(now);
    const oldest = this.frames[0]?.seq ?? this.sequence + 1;
    if (after < oldest - 1) throw new WitnessReadError('gap', 'Required collector witnesses expired');
    const frames = this.frames.filter(frame => frame.seq > after).slice(0, limit);
    const hashes = new Set(frames.map(frame => frame.topologySha256).filter((hash): hash is string => hash !== null));
    const topologies = [...hashes].map(hash => this.topologies.get(hash)!);
    const cursor = frames.at(-1)?.seq ?? after;
    return { v: 1 as const, epoch: this.epoch, cursor, latest: this.sequence,
      hasMore: cursor < this.sequence, frames, topologies };
  }

  head(now = Date.now()) {
    this.expire(now);
    return { v: 1 as const, epoch: this.epoch, latest: this.sequence,
      oldest: this.frames[0]?.seq ?? this.sequence + 1, chain: this.chain, unavailable: this.hardFailure ?? this.failure };
  }

  reference() { return this.hardFailure || !this.latestReference ? null : { epoch: this.epoch, ...this.latestReference }; }

  stats() { return { ...this.head(), retainedFrames: this.frames.length, retainedBytes: this.bytes,
    retainedTopologies: this.topologies.size, captureFailures: this.captureFailures,
    maxFrames: this.maxFrames, maxBytes: this.maxBytes, maxAgeMs: this.maxAgeMs }; }
}
