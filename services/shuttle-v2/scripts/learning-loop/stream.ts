import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validEvaluationContext } from '../../src/server/etaEvaluationContext';
import { advanceForecasts, createForecastStores, forecastArms, type ForecastStores } from './forecasts';
import { identityHash } from '../reestimate-validation.mjs';

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const modelKey = (model: any) => identityHash({ version: model?.version, params: model?.params });
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export class SourceContextChanged extends Error {
  constructor(readonly code: 'epoch' | 'build' | 'champion', message: string) { super(message); }
}
export function validateExactFrame(frame: any, champion: any) {
  if (!frame || !integer(frame.seq) || !integer(frame.at) || !integer(frame.observationVersion)
    || typeof frame.json !== 'string' || Buffer.byteLength(frame.json) !== frame.bytes || frame.bytes > 16 * 1024 * 1024
    || !hashValid(frame.sha256) || digest(frame.json) !== frame.sha256
    || typeof frame.contextJson !== 'string' || Buffer.byteLength(frame.contextJson) !== frame.contextBytes
    || frame.contextBytes > 256 * 1024 || !hashValid(frame.contextSha256) || digest(frame.contextJson) !== frame.contextSha256)
    throw Error('Invalid exact forecast frame or checksum');
  const payload = JSON.parse(frame.json), context = JSON.parse(frame.contextJson);
  if (!validEvaluationContext(context, frame.at) || !Array.isArray(payload.buses) || payload.buses.length > 200
    || !payload.routes || !payload.stop_coords || !payload.segments || !payload.dwells) throw Error('Invalid exact forecast payload/context');
  if (modelKey(payload.model_params) !== modelKey(champion)) throw new SourceContextChanged('champion', 'Published champion changed');
  if (payload.server_eta && (payload.server_eta.at !== frame.at || payload.server_eta.servedAt !== frame.at))
    throw Error('Exact forecast frame does not contain its original model-time answer');
  return { payload, context };
}

export function nextSourceChain(previous: string, frame: any) {
  return digest(JSON.stringify([previous, frame.seq, frame.at, frame.observationVersion, frame.sha256, frame.contextSha256]));
}
export function initialSourceChain(seed: any, seedSha256: string, sourceKey: string) {
  return digest(JSON.stringify([seedSha256, sourceKey, seed.build, seed.epoch, seed.cursor, seed.at]));
}
export interface RuntimeReceipt { file: string; sha256: string; rawSha256: string; bytes: number; cursor: number; at: number }

/** One causal source cursor and two independent production engines. Restarts
 * restore this pair's own state; catchup never creates retrospective samples. */
export class ExactForecastStream {
  stores: ForecastStores = createForecastStores();
  epoch = ''; cursor = 0; at = 0; chain = ''; seedSha256 = '';
  private observationVersion = -1;
  private lastFrame: { sha256: string; contextSha256: string; observationVersion: number } | null = null;
  private computedModels: { champion: string | null; challenger: string | null } = { champion: null, challenger: null };
  private persisted: { key: string; receipt: RuntimeReceipt } | null = null;
  constructor(readonly build: string, readonly sourceKey: string, private champion: any, private challenger: any) {
    this.champion = structuredClone(champion); this.challenger = structuredClone(challenger);
  }

  setModels(champion: any, challenger: any) {
    if (modelKey(champion) !== modelKey(this.champion)) this.champion = structuredClone(champion);
    if (modelKey(challenger) !== modelKey(this.challenger)) this.challenger = structuredClone(challenger);
  }

  seed(seed: any, now: number) {
    const idle = seed?.idle === true && Array.isArray(seed.feed?.buses) && seed.feed.buses.length === 0 && !seed.feed.server_eta;
    if (!seed || seed.v !== 1 || seed.build !== this.build || typeof seed.epoch !== 'string' || !seed.epoch.length
      || seed.epoch.length > 100 || !integer(seed.cursor) || !integer(seed.at) || !integer(seed.observationVersion)
      || seed.at > now + 5000 || (!idle && now - seed.at > 120000)
      || !seed.history || seed.history.encoding !== 'v8-base64' || !integer(seed.history.bytes) || seed.history.bytes > 4 * 1024 * 1024
      || typeof seed.history.data !== 'string' || seed.history.data.length > 6 * 1024 * 1024
      || !hashValid(seed.history.sha256) || modelKey(seed.modelParams) !== modelKey(this.champion))
      throw Error('Invalid causal forecast seed');
    const bytes = Buffer.from(seed.history.data, 'base64');
    if (bytes.length !== seed.history.bytes || bytes.toString('base64') !== seed.history.data || digest(bytes) !== seed.history.sha256)
      throw Error('Forecast seed checksum/encoding mismatch');
    const history = deserialize(bytes);
    if (modelKey(history.modelParams) !== modelKey(seed.pastModelParams) || (!idle && modelKey(history.modelParams) !== modelKey(this.champion)))
      throw Error('Forecast seed belongs to a different model');
    const stores = createForecastStores();
    for (const arm of Object.values(stores)) {
      if (!arm.engine.restoreEvaluation(bytes, 'history', now, idle ? Number.MAX_SAFE_INTEGER : 120000)) throw Error('Forecast history restore refused');
      arm.lastAt = seed.at;
    }
    this.stores = stores; this.epoch = seed.epoch; this.cursor = seed.cursor; this.at = seed.at;
    this.observationVersion = seed.observationVersion;
    this.seedSha256 = digest(JSON.stringify(seed)); this.chain = initialSourceChain(seed, this.seedSha256, this.sourceKey);
    this.lastFrame = null; this.computedModels = { champion: null, challenger: null }; this.persisted = null;
  }

  receipt() {
    return { v: 1, build: this.build, sourceKey: this.sourceKey, epoch: this.epoch, cursor: this.cursor, at: this.at,
      chain: this.chain, seedSha256: this.seedSha256, ...this.lastFrame,
      championModel: this.computedModels.champion, challengerModel: this.computedModels.challenger };
  }
  canSample() {
    return this.lastFrame !== null && this.computedModels.champion === modelKey(this.champion)
      && this.computedModels.challenger === modelKey(this.challenger);
  }

  advance(packet: any): number {
    if (!packet || packet.v !== 1 || typeof packet.build !== 'string' || !packet.build.length
      || typeof packet.epoch !== 'string' || !packet.epoch.length) throw Error('Malformed exact source header');
    if (!integer(packet.responseAt) || packet.responseAt < this.at || packet.responseAt > Date.now() + 5000)
      throw Error('Invalid exact source response clock');
    if (packet?.build !== this.build) throw new SourceContextChanged('build', 'Production build changed');
    if (packet?.epoch !== this.epoch) throw new SourceContextChanged('epoch', 'Production observation epoch changed');
    if (packet.v !== 1 || !integer(packet.cursor) || !integer(packet.latest) || packet.cursor < this.cursor
      || packet.latest < packet.cursor || packet.hasMore !== (packet.cursor < packet.latest)
      || !Array.isArray(packet.frames) || packet.frames.length > 16 || packet.cursor !== this.cursor + packet.frames.length
      || (packet.hasMore ? packet.feed !== null || packet.frames.length === 0 : !packet.feed)) throw Error('Invalid exact source cursor/page');
    let at = this.at, cursor = this.cursor, version = this.observationVersion;
    const frames = packet.frames.map((frame: any) => {
      if (frame.seq !== ++cursor || frame.at <= at || frame.at > packet.responseAt || frame.observationVersion <= version)
        throw Error('Missing/regressing exact source observation');
      at = frame.at; version = frame.observationVersion; return { frame, ...validateExactFrame(frame, this.champion) };
    });
    if (!packet.hasMore && modelKey(packet.feed.model_params) !== modelKey(this.champion))
      throw new SourceContextChanged('champion', 'Published champion changed');
    if (!frames.length) return 0;
    const before = this.runtime();
    try {
      for (const { frame, payload, context } of frames) {
        const control = advanceForecasts(payload, frame.at, context, this.champion, this.challenger, this.stores);
        // Full output and identity comparison catches omitted rows, alternate
        // occurrences and route adjustments before any cohort is sampled.
        if (JSON.stringify(control ?? null) !== JSON.stringify(payload.server_eta ?? null))
          throw Error('Exact control differs from the complete served forecast');
        this.cursor = frame.seq; this.at = frame.at; this.chain = nextSourceChain(this.chain, frame);
        this.observationVersion = frame.observationVersion;
        this.lastFrame = { sha256: frame.sha256, contextSha256: frame.contextSha256, observationVersion: frame.observationVersion };
        this.computedModels = { champion: modelKey(this.champion), challenger: modelKey(this.challenger) };
      }
      this.persisted = null; return frames.length;
    } catch (error) {
      this.restore(before); throw error;
    }
  }

  sample(feed: any, receivedAt: number, responseAt = feed.server_eta?.servedAt ?? receivedAt) {
    if (!this.canSample()) return { champion: [], challenger: [], productionControl: null };
    const reference = feed.server_eta ?? null;
    const control = this.stores.champion.engine.evaluationWire(feed.buses, reference?.servedAt ?? responseAt);
    if (JSON.stringify(control) !== JSON.stringify(reference)) throw Error('Current served control differs after exact catchup');
    return forecastArms(feed, receivedAt, this.champion, this.challenger, this.stores,
      { at: this.at, source: this.receipt(), responseAt });
  }

  runtime(): Uint8Array {
    const arms = Object.fromEntries(Object.entries(this.stores).map(([name, arm]) => {
      const snapshot = arm.engine.captureEvaluation('runtime'); if (!snapshot) throw Error('Cannot checkpoint exact forecast arm');
      return [name, { bytes: snapshot.bytes, lastAt: arm.lastAt }];
    }));
    const bytes = serialize({ v: 1, build: this.build, sourceKey: this.sourceKey, epoch: this.epoch, cursor: this.cursor,
      at: this.at, observationVersion: this.observationVersion, chain: this.chain, seedSha256: this.seedSha256, lastFrame: this.lastFrame, computedModels: this.computedModels,
      desiredModels: { champion: modelKey(this.champion), challenger: modelKey(this.challenger) }, arms });
    if (bytes.length > 12 * 1024 * 1024) throw Error('Exact forecast runtime exceeds retention bound');
    return bytes;
  }

  restore(bytes: Uint8Array, expectedSeedSha256 = this.seedSha256) {
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw Error('Invalid exact runtime size');
    const saved = deserialize(Buffer.from(bytes));
    if (saved.v !== 1 || saved.build !== this.build || saved.sourceKey !== this.sourceKey || !integer(saved.cursor) || !integer(saved.at)
      || typeof saved.epoch !== 'string' || !saved.epoch.length || !integer(saved.observationVersion) || !hashValid(saved.chain) || !hashValid(saved.seedSha256)
      || (expectedSeedSha256 && saved.seedSha256 !== expectedSeedSha256)
      || saved.desiredModels?.champion !== modelKey(this.champion) || saved.desiredModels?.challenger !== modelKey(this.challenger)
      || !saved.computedModels || ![saved.computedModels.champion, saved.computedModels.challenger].every(v => v === null || hashValid(v))
      || (saved.lastFrame !== null && (!hashValid(saved.lastFrame?.sha256) || !hashValid(saved.lastFrame?.contextSha256)
        || !integer(saved.lastFrame?.observationVersion)))) throw Error('Invalid exact runtime identity');
    const stores = createForecastStores();
    for (const [name, arm] of Object.entries(stores)) {
      const snapshot = saved.arms?.[name];
      if (!snapshot || snapshot.lastAt !== saved.at || !arm.engine.restoreEvaluation(snapshot.bytes, 'runtime', Date.now(), Number.MAX_SAFE_INTEGER)
        || arm.engine.evaluationClock() !== saved.at) throw Error('Exact arm recovery refused');
      if (saved.computedModels[name] !== null && modelKey(arm.engine.captureEvaluation('runtime')!.modelParams) !== saved.computedModels[name])
        throw Error('Exact runtime arm contains another model history');
      arm.lastAt = snapshot.lastAt;
    }
    this.stores = stores; this.epoch = saved.epoch; this.cursor = saved.cursor; this.at = saved.at;
    this.observationVersion = saved.observationVersion;
    this.chain = saved.chain; this.seedSha256 = saved.seedSha256; this.lastFrame = saved.lastFrame;
    this.computedModels = saved.computedModels; this.persisted = null;
  }

  persist(directory: string): RuntimeReceipt {
    const key = JSON.stringify([this.cursor, modelKey(this.champion), modelKey(this.challenger)]);
    if (this.persisted?.key === key && fs.existsSync(path.join(directory, this.persisted.receipt.file))) return this.persisted.receipt;
    const raw = this.runtime(), bytes = gzipSync(raw), sha256 = digest(bytes), file = `runtime-${sha256}.v8.gz`;
    const target = path.join(directory, file);
    if (fs.existsSync(target)) { if (digest(fs.readFileSync(target)) !== sha256) throw Error('Conflicting exact runtime receipt'); }
    else { const temporary = target + `.partial-${process.pid}`; fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, target); }
    const receipt = { file, sha256, rawSha256: digest(raw), bytes: bytes.length, cursor: this.cursor, at: this.at };
    this.persisted = { key, receipt }; return receipt;
  }
  recover(directory: string, receipt: RuntimeReceipt, expectedSeedSha256: string) {
    if (!receipt || !/^runtime-[a-f0-9]{64}\.v8\.gz$/.test(receipt.file) || !hashValid(receipt.sha256)
      || receipt.file !== `runtime-${receipt.sha256}.v8.gz` || !hashValid(receipt.rawSha256) || !integer(receipt.bytes)
      || receipt.bytes > 12 * 1024 * 1024) throw Error('Invalid exact runtime file receipt');
    const bytes = fs.readFileSync(path.join(directory, receipt.file));
    if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256) throw Error('Exact runtime file checksum mismatch');
    const raw = gunzipSync(bytes, { maxOutputLength: 12 * 1024 * 1024 });
    if (digest(raw) !== receipt.rawSha256) throw Error('Exact runtime content checksum mismatch');
    this.restore(raw, expectedSeedSha256);
    if (this.cursor !== receipt.cursor || this.at !== receipt.at) throw Error('Exact runtime cursor receipt mismatch');
  }
}

export function pruneRuntimes(directory: string, receipts: (RuntimeReceipt | undefined)[]) {
  const keep = new Set(receipts.filter(Boolean).map(r => r!.file));
  for (const file of fs.readdirSync(directory)) if (/^runtime-[a-f0-9]{64}\.v8\.gz$/.test(file) && !keep.has(file)) fs.unlinkSync(path.join(directory, file));
}
