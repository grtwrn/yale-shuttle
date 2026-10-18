import { createHash, randomUUID } from 'node:crypto';
import { validEvaluationContext, type EtaEvaluationContext } from './etaEvaluationContext.js';

export interface EvaluationFrame {
  readonly seq: number;
  readonly at: number;
  readonly observationVersion: number;
  readonly json: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contextJson: string | null;
  readonly contextSha256: string | null;
  readonly contextBytes: number;
}
export class EvaluationInputError extends Error {
  constructor(readonly code: 'epoch' | 'cursor' | 'gap' | 'unavailable', message: string) { super(message); }
}

/** Bounded immutable first payload per production observation. Cached HTTP
 * rebuilds must not replace the exact input that advanced the real engine. */
export class EvaluationInputs {
  readonly epoch: string;
  private frames: EvaluationFrame[] = [];
  private totalBytes = 0;
  private sequence = 0;
  private lastVersion = -1;
  private lastAt = -Infinity;
  private failure: string | null = null;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor({ epoch = randomUUID(), maxFrames = 120, maxBytes = 16 * 1024 * 1024, maxAgeMs = 600000 }:
    { epoch?: string; maxFrames?: number; maxBytes?: number; maxAgeMs?: number } = {}) {
    if (!epoch || epoch.length > 100 || ![maxFrames, maxBytes, maxAgeMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw Error('Invalid evaluation journal limits');
    this.epoch = epoch; this.maxFrames = maxFrames; this.maxBytes = maxBytes; this.maxAgeMs = maxAgeMs;
  }

  /** A failed source capture cannot be hidden by later successful appends. */
  fail(reason: string): void { this.failure ??= reason.slice(0, 200); }

  append(observationVersion: number, at: number, json: string, context?: EtaEvaluationContext): void {
    if (this.failure) throw new EvaluationInputError('unavailable', this.failure);
    try {
      if (!Number.isSafeInteger(observationVersion) || observationVersion < 0 || !Number.isSafeInteger(at) || at < 0
        || typeof json !== 'string' || !json.length) throw Error('Invalid production observation');
      if (observationVersion === this.lastVersion) {
        if (at !== this.lastAt) throw Error('A cached observation changed its model clock');
        return;
      }
      if (observationVersion < this.lastVersion || at <= this.lastAt) throw Error('Production observation order regressed');
      if (context !== undefined && !validEvaluationContext(context, at)) throw Error('Invalid production forecast context');
      const contextJson = context === undefined ? null : JSON.stringify(context);
      const contextBytes = contextJson === null ? 0 : Buffer.byteLength(contextJson);
      const bytes = Buffer.byteLength(json);
      if (bytes + contextBytes > this.maxBytes) throw Error('A production observation exceeds the journal byte limit');
      const frame = Object.freeze({ seq: ++this.sequence, at, observationVersion, json, bytes,
        sha256: createHash('sha256').update(json).digest('hex'), contextJson, contextBytes,
        contextSha256: contextJson === null ? null : createHash('sha256').update(contextJson).digest('hex') });
      this.frames.push(frame); this.totalBytes += bytes + contextBytes; this.lastVersion = observationVersion; this.lastAt = at;
      this.expire(at);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Production observation capture failed');
      throw new EvaluationInputError('unavailable', this.failure!);
    }
  }

  private expire(now: number): void {
    while (this.frames.length && (this.frames.length > this.maxFrames || this.totalBytes > this.maxBytes
      || this.frames[0]!.at < now - this.maxAgeMs)) {
      const frame = this.frames.shift()!; this.totalBytes -= frame.bytes + frame.contextBytes;
    }
  }

  head() { return { epoch: this.epoch, cursor: this.sequence, at: Number.isFinite(this.lastAt) ? this.lastAt : null,
    observationVersion: this.lastVersion < 0 ? null : this.lastVersion }; }

  /** Public identity only. A cached HTTP variant is NOT the immutable input
   * itself; its separate body checksum identifies the bytes actually served. */
  reference(at: number | null, now = Date.now()) {
    this.expire(now);
    const frame = this.frames.at(-1);
    return !this.failure && frame && frame.at === at
      ? { epoch: this.epoch, cursor: frame.seq, at: frame.at, sha256: frame.sha256 } : undefined;
  }

  read(epoch: string, after: number, { limit = 16, now = Date.now() }: { limit?: number; now?: number } = {}) {
    if (this.failure) throw new EvaluationInputError('unavailable', this.failure);
    if (epoch !== this.epoch) throw new EvaluationInputError('epoch', 'The production observation epoch changed');
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 120 || !Number.isFinite(now))
      throw new EvaluationInputError('cursor', 'Invalid production observation cursor');
    this.expire(now);
    const oldest = this.frames[0]?.seq ?? this.sequence + 1;
    if (after < oldest - 1) throw new EvaluationInputError('gap', 'Required production observations have expired');
    const frames = this.frames.filter(f => f.seq > after).slice(0, limit);
    const cursor = frames.at(-1)?.seq ?? after;
    return { epoch: this.epoch, cursor, latest: this.sequence, hasMore: cursor < this.sequence, frames };
  }

  /** Cross-index for durable diagnostic capture. It exposes only references
   * already bound to immutable model inputs, never a replacement context. */
  collectorReferences(epoch: string, selected: readonly { seq: number; sha256: string }[], now = Date.now()) {
    this.expire(now);
    const wanted = new Map(selected.map(frame => [frame.seq, frame.sha256]));
    const references = [];
    for (const frame of this.frames) {
      if (!frame.contextJson) continue;
      const context = JSON.parse(frame.contextJson) as EtaEvaluationContext, witness = context.collectorWitness;
      if (!witness || witness.epoch !== epoch || wanted.get(witness.seq) !== witness.sha256) continue;
      references.push({ collectorEpoch: epoch, collectorSeq: witness.seq, collectorSHA256: witness.sha256,
        evaluation: { epoch: this.epoch, cursor: frame.seq, at: frame.at,
          sha256: frame.sha256, contextSha256: frame.contextSha256 } });
    }
    return references;
  }

  stats() { return { epoch: this.epoch, latest: this.sequence, retained: this.frames.length,
    retainedBytes: this.totalBytes, maxFrames: this.maxFrames, maxBytes: this.maxBytes, maxAgeMs: this.maxAgeMs,
    failed: this.failure !== null }; }
}
