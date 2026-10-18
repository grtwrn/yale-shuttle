import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { FeedbackSourceReceipt } from '../schema/api.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clock = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
export interface FeedbackEvidenceBundle {
  v: 1; source: FeedbackSourceReceipt; capturedAt: number; retainedAt: number;
  gzipSha256: string; gzipBytes: number; gzipBase64: string;
}
export type FeedbackEvidenceReceipt = { v: 1; status: 'retained'; snapshotId: string; sha256: string; bundleSha256: string; bytes: number }
  | { v: 1; status: 'unavailable'; reason: 'source-not-supplied' | 'invalid-source' | 'source-not-retained'
    | 'source-mismatch' | 'storage-limit' | 'storage-space' | 'storage-failed' };
type Entry = { source: FeedbackSourceReceipt; gzip: Buffer; capturedAt: number; cost: number };

/** Exact PUBLIC HTTP responses, never reporter payloads or private model state.
 * Recent compressed responses are bounded in memory. Only referenced report
 * inputs go to disk; open reports protect those files from rolling eviction.
 * A receipt is provenance for a response, not proof of a reporter's claim. */
export class FeedbackEvidence {
  private readonly recent = new Map<string, Entry>();
  private recentBytes = 0;
  private lastError: string | null = null;
  private lastMaintenance = -Infinity;
  private retained: { bytes: number; files: number; protectedBytes: number; unknownBytes: number; availableBytes: number | null }
    = { bytes: 0, files: 0, protectedBytes: 0, unknownBytes: 0, availableBytes: null };
  constructor(private readonly options: {
    dir: string; now?: () => number; recentMaxBytes?: number; recentMaxEntries?: number;
    recentMaxAgeMs?: number; retainedMaxBytes?: number; retainedMaxAgeMs?: number; maxSourceBytes?: number;
    minFreeBytes?: number; availableBytes?: () => number;
    protectedHashes?: () => ReadonlySet<string>;
  }) {
    for (const value of [this.recentMaxBytes, this.recentMaxEntries, this.recentMaxAgeMs,
      this.retainedMaxBytes, this.retainedMaxAgeMs, this.maxSourceBytes, this.minFreeBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid feedback evidence limits');
    }
  }
  private get now() { return (this.options.now ?? Date.now)(); }
  private get recentMaxBytes() { return this.options.recentMaxBytes ?? 32 * 1024 * 1024; }
  private get recentMaxEntries() { return this.options.recentMaxEntries ?? 600; }
  private get recentMaxAgeMs() { return this.options.recentMaxAgeMs ?? 15 * 60_000; }
  private get retainedMaxBytes() { return this.options.retainedMaxBytes ?? 32 * 1024 * 1024; }
  private get minFreeBytes() { return this.options.minFreeBytes ?? 96 * 1024 * 1024; }
  private get retainedMaxAgeMs() { return this.options.retainedMaxAgeMs ?? 7 * 86400_000; }
  private get maxSourceBytes() { return this.options.maxSourceBytes ?? 2 * 1024 * 1024; }
  private availableBytes() {
    const disk = this.options.availableBytes ? null : fs.statfsSync(this.options.dir);
    const value = this.options.availableBytes?.() ?? disk!.bavail * disk!.bsize;
    if (!Number.isFinite(value) || value < 0) throw Error('Invalid disk space observation');
    return value;
  }
  private expireRecent(now: number) {
    for (const [sha, entry] of this.recent) {
      if (now - entry.capturedAt <= this.recentMaxAgeMs && this.recent.size <= this.recentMaxEntries
        && this.recentBytes <= this.recentMaxBytes) continue;
      this.recent.delete(sha); this.recentBytes -= entry.cost;
    }
  }

  observe(json: string, build: string, evaluation?: FeedbackSourceReceipt['evaluation']): FeedbackSourceReceipt | null {
    try {
      const now = this.now, bytes = Buffer.byteLength(json); this.expireRecent(now);
      if (bytes > this.maxSourceBytes || !/^[A-Za-z0-9_-]{1,80}$/.test(build)) return null;
      const sha256 = hash(json);
      const feed = JSON.parse(json), w = feed?.server_eta;
      if (!object(feed) || !Array.isArray(feed.buses)) return null;
      const modelAt = clock(w?.at) ? w.at : null, servedAt = clock(w?.servedAt) ? w.servedAt : null;
      const source: FeedbackSourceReceipt = { v: 1, snapshotId: '', sha256, bytes, build, modelAt, servedAt };
      if (evaluation && modelAt !== null && evaluation.at === modelAt && typeof evaluation.epoch === 'string'
        && /^[A-Za-z0-9_-]{1,100}$/.test(evaluation.epoch) && clock(evaluation.cursor) && evaluation.cursor > 0
        && SHA.test(evaluation.sha256)) source.evaluation = { epoch: evaluation.epoch, cursor: evaluation.cursor,
          at: evaluation.at, sha256: evaluation.sha256 };
      // The same public JSON can recur across builds or producer epochs.
      source.snapshotId = hash(JSON.stringify({ sha256, build, evaluation: source.evaluation ?? null }));
      const old = this.recent.get(source.snapshotId);
      if (old) return structuredClone(old.source);
      const gzip = gzipSync(json, { level: 1 }), cost = gzip.length + JSON.stringify(source).length + 128;
      if (cost > this.recentMaxBytes) return null;
      this.recent.set(source.snapshotId, { source, gzip, capturedAt: now, cost }); this.recentBytes += cost; this.expireRecent(now);
      this.maintain();
      return this.recent.has(source.snapshotId) ? structuredClone(source) : null;
    } catch { this.lastError = 'capture-failed'; return null; }
  }

  private sourceMatches(input: Record<string, unknown>, source: FeedbackSourceReceipt) {
    if (['v', 'snapshotId', 'sha256', 'bytes', 'build', 'modelAt', 'servedAt'].some(k => input[k] !== source[k as keyof FeedbackSourceReceipt])) return false;
    const e = input.evaluation;
    return source.evaluation ? object(e) && ['epoch', 'cursor', 'at', 'sha256'].every(k => e[k] === source.evaluation![k as keyof NonNullable<FeedbackSourceReceipt['evaluation']>])
      : e === undefined;
  }

  /** Verify both the compressed file and exact decompressed HTTP body. */
  read(snapshotId: string, bundleSha256?: string): { bundle: FeedbackEvidenceBundle; bytes: Buffer; sha256: string } {
    if (!SHA.test(snapshotId) || (bundleSha256 !== undefined && !SHA.test(bundleSha256))) throw Error('Invalid evidence key');
    const file = path.join(this.options.dir, snapshotId + '.json'), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > this.maxSourceBytes * 2 + 8192) throw Error('Invalid evidence size');
    const bytes = fs.readFileSync(file), fileHash = hash(bytes);
    if (bundleSha256 && fileHash !== bundleSha256) throw Error('Evidence checksum mismatch');
    const bundle = JSON.parse(bytes.toString('utf8')) as FeedbackEvidenceBundle;
    if (bundle.v !== 1 || bundle.source?.snapshotId !== snapshotId || !SHA.test(bundle.source.sha256) || !clock(bundle.capturedAt) || !clock(bundle.retainedAt)
      || typeof bundle.gzipBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(bundle.gzipBase64)
      || !SHA.test(bundle.gzipSha256)) throw Error('Invalid evidence bundle');
    const compressed = Buffer.from(bundle.gzipBase64, 'base64');
    if (compressed.length !== bundle.gzipBytes || hash(compressed) !== bundle.gzipSha256) throw Error('Evidence compression checksum mismatch');
    const raw = gunzipSync(compressed, { maxOutputLength: this.maxSourceBytes });
    if (raw.length !== bundle.source.bytes || hash(raw) !== bundle.source.sha256) throw Error('Evidence source checksum mismatch');
    if (hash(JSON.stringify({ sha256: bundle.source.sha256, build: bundle.source.build,
      evaluation: bundle.source.evaluation ?? null })) !== snapshotId) throw Error('Evidence identity mismatch');
    const feed = JSON.parse(raw.toString('utf8')), w = feed?.server_eta;
    if (!Array.isArray(feed?.buses) || (clock(w?.at) ? w.at : null) !== bundle.source.modelAt
      || (clock(w?.servedAt) ? w.servedAt : null) !== bundle.source.servedAt) throw Error('Evidence source metadata mismatch');
    return { bundle, bytes, sha256: fileHash };
  }

  private makeRoom(required: number, keep: string) {
    const protectedHashes = this.options.protectedHashes?.() ?? new Set<string>();
    const now = this.now;
    const files = fs.readdirSync(this.options.dir).map(name => {
      const file = path.join(this.options.dir, name), stat = fs.statSync(file);
      if (!stat.isFile()) throw Error('Unknown feedback archive entry');
      return { file, sha256: /^[a-f0-9]{64}\.json$/.test(name) ? name.slice(0, 64) : null, size: stat.size, at: stat.mtimeMs };
    }).sort((a, b) => a.at - b.at);
    let total = files.reduce((n, file) => n + file.size, 0);
    let available = this.availableBytes();
    for (const file of files) {
      if (file.sha256 === null || file.sha256 === keep || protectedHashes.has(file.sha256)) continue;
      if (total + required <= this.retainedMaxBytes && now - file.at <= this.retainedMaxAgeMs
        && available - required >= this.minFreeBytes) continue;
      fs.unlinkSync(file.file); total -= file.size; available = this.availableBytes();
    }
    this.retained = { bytes: total, files: files.filter(file => fs.existsSync(file.file)).length,
      protectedBytes: files.filter(file => file.sha256 !== null && (file.sha256 === keep || protectedHashes.has(file.sha256)))
        .reduce((n, file) => n + file.size, 0),
      unknownBytes: files.filter(file => file.sha256 === null).reduce((n, file) => n + file.size, 0), availableBytes: available };
    return total + required <= this.retainedMaxBytes && available - required >= this.minFreeBytes;
  }

  /** Periodic rolling cleanup; an unavailable protection list forbids deletion. */
  maintain() {
    const now = this.now;
    if (now - this.lastMaintenance < 60_000) return;
    this.lastMaintenance = now;
    try {
      if (fs.existsSync(this.options.dir) && !this.makeRoom(0, '')) this.lastError = (this.retained.availableBytes ?? Infinity) < this.minFreeBytes
        ? 'storage-space' : 'storage-limit';
    } catch { this.lastError = 'maintenance-failed'; }
  }

  retain(input: unknown): FeedbackEvidenceReceipt {
    const unavailable = (reason: Extract<FeedbackEvidenceReceipt, { status: 'unavailable' }>['reason']): FeedbackEvidenceReceipt => ({ v: 1, status: 'unavailable', reason });
    if (input === undefined || input === null) return unavailable('source-not-supplied');
    if (!object(input) || typeof input.snapshotId !== 'string' || !SHA.test(input.snapshotId)
      || typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return unavailable('invalid-source');
    this.expireRecent(this.now);
    try {
      // A retained report remains recoverable across server restarts.
      try {
        const existing = this.read(input.snapshotId);
        if (!this.sourceMatches(input, existing.bundle.source)) return unavailable('source-mismatch');
        return { v: 1, status: 'retained', snapshotId: input.snapshotId, sha256: input.sha256, bundleSha256: existing.sha256, bytes: existing.bytes.length };
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const entry = this.recent.get(input.snapshotId);
      if (!entry) return unavailable('source-not-retained');
      if (!this.sourceMatches(input, entry.source)) return unavailable('source-mismatch');
      const bundle: FeedbackEvidenceBundle = { v: 1, source: entry.source, capturedAt: entry.capturedAt,
        retainedAt: this.now, gzipSha256: hash(entry.gzip), gzipBytes: entry.gzip.length, gzipBase64: entry.gzip.toString('base64') };
      const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
      fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      if (!this.makeRoom(bytes.length, input.snapshotId)) {
        const reason = (this.retained.availableBytes ?? Infinity) - bytes.length < this.minFreeBytes ? 'storage-space' : 'storage-limit';
        this.lastError = reason; return unavailable(reason);
      }
      const file = path.join(this.options.dir, input.snapshotId + '.json'), tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
      try { fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
      finally { try { fs.unlinkSync(tmp); } catch { /* renamed or absent */ } }
      const retained = this.read(input.snapshotId, hash(bytes)); this.lastError = null;
      this.makeRoom(0, input.snapshotId);
      return { v: 1, status: 'retained', snapshotId: input.snapshotId, sha256: input.sha256, bundleSha256: retained.sha256, bytes: retained.bytes.length };
    } catch { this.lastError = 'storage-failed'; return unavailable('storage-failed'); }
  }

  stats() { this.expireRecent(this.now); this.maintain(); return { recentEntries: this.recent.size, recentBytes: this.recentBytes,
    recentMaxBytes: this.recentMaxBytes, recentMaxEntries: this.recentMaxEntries, recentMaxAgeMs: this.recentMaxAgeMs,
    retainedMaxBytes: this.retainedMaxBytes, retainedMaxAgeMs: this.retainedMaxAgeMs, minFreeBytes: this.minFreeBytes,
    retained: { ...this.retained }, lastError: this.lastError }; }
}
