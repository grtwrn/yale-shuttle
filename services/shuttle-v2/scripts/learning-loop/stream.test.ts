import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ExactForecastStream, SourceContextChanged, digest, pruneRuntimes } from './stream';
import { resetModelParams } from '../../web/src/eta/params';
import { registerRoutePaths } from '../../web/src/anchor';
import { scoreEstimate } from './lib.mjs';

import { setup, sourceKey, build } from './__fixtures__/exact-source';
// V8 encoding is not canonical across a deserialize/serialize round trip.
// Compare complete decoded state, then require identical future forecasts.
function decodedRuntime(bytes: Uint8Array) {
  const value = deserialize(Buffer.from(bytes));
  for (const arm of Object.values(value.arms) as any[]) arm.bytes = deserialize(arm.bytes);
  return value;
}
afterEach(() => { resetModelParams(); registerRoutePaths(null); });
describe('exact source consumption and paired recovery', () => {
  it('compares model parameters semantically rather than by JSON key insertion order',()=>{
    const f=setup(),champion=structuredClone(f.champion);champion.params=Object.fromEntries(Object.entries(champion.params).reverse()) as typeof champion.params;
    champion.params.CONFORMAL=Object.fromEntries(Object.entries(champion.params.CONFORMAL).reverse()) as typeof champion.params.CONFORMAL;
    const stream=new ExactForecastStream(build,sourceKey,champion,f.candidate);stream.seed(f.seed,f.seed.at);
    f.publish(5);const packet=f.source.read(stream.epoch,stream.cursor);stream.advance(packet);
    expect(stream.sample(packet.feed,f.clock()).productionControl!.mismatched).toBe(0);
  });
  it('uses complete past history and every source frame to reproduce the entire served control', () => {
    const f = setup(); expect(f.stream.canSample()).toBe(false);
    for (let i = 5; i < 15; i++) f.publish(i);
    const packet = f.source.read(f.stream.epoch, f.stream.cursor);
    expect(f.stream.advance(packet)).toBe(10);
    const result = f.stream.sample(packet.feed, f.clock());
    expect(result.productionControl).toMatchObject({ missing: 0, mismatched: 0 });
    expect(result.productionControl!.compared).toBeGreaterThan(50);
    expect(result.champion.every(p => p.runtimeIntervals)).toBe(true);
    expect(f.stream.stores.champion.engine).not.toBe(f.stream.stores.challenger.engine);
    expect(result.challenger.some((p, i) => p.raw.eta !== result.champion[i]?.raw.eta)).toBe(true);
  });
  it('catches up bounded pages without creating historical live samples', () => {
    const f = setup(); for (let i = 5; i < 11; i++) f.publish(i);
    const first = f.source.read(f.stream.epoch, f.stream.cursor, 2); expect(first.feed).toBeNull();
    f.stream.advance(first); expect(() => f.stream.sample(f.seed.feed, f.clock())).toThrow('catchup');
    const last = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(last);
    expect(f.stream.sample(last.feed, f.clock()).productionControl!.mismatched).toBe(0);
  });
  it.each(['missing', 'payload-checksum', 'context-checksum','response-clock'])('refuses %s without moving either arm or cursor', mode => {
    const f = setup(); f.publish(5); f.publish(6); const packet = structuredClone(f.source.read(f.stream.epoch, f.stream.cursor));
    if (mode === 'missing') packet.frames.shift();
    if (mode === 'payload-checksum') (packet.frames[0] as any).json += ' ';
    if (mode === 'context-checksum') (packet.frames[0] as any).contextJson += ' ';
    if (mode === 'response-clock') packet.responseAt=Date.now()+86400000;
    const before = f.stream.runtime(); expect(() => f.stream.advance(packet)).toThrow();
    expect(isDeepStrictEqual(decodedRuntime(f.stream.runtime()), decodedRuntime(before))).toBe(true);
  });
  it('rolls both engines back after a complete control mismatch, retaining the rejected packet for the caller', () => {
    const f = setup(); f.publish(5); const packet = structuredClone(f.source.read(f.stream.epoch, f.stream.cursor));
    const frame = packet.frames[0]!, payload = JSON.parse(frame.json); payload.server_eta.rows[0][2] += 100;
    (frame as any).json = JSON.stringify(payload); (frame as any).bytes = Buffer.byteLength(frame.json); (frame as any).sha256 = digest(frame.json);
    const before = f.stream.runtime(); expect(() => f.stream.advance(packet)).toThrow('complete served');
    expect(isDeepStrictEqual(decodedRuntime(f.stream.runtime()), decodedRuntime(before))).toBe(true); expect(JSON.parse(packet.frames[0]!.json).server_eta.rows[0][2]).toBe(payload.server_eta.rows[0][2]);
    const untouched = new ExactForecastStream(build, sourceKey, f.champion, f.candidate); untouched.seed(f.seed, f.seed.at);
    const good = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(good); untouched.advance(good);
    expect(f.stream.sample(good.feed, f.clock())).toEqual(untouched.sample(good.feed, f.clock()));
  });
  it('resumes the candidate own posterior and raw forecasts, with bounded current/previous storage', () => {
    const f = setup(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-stream-runtime-'));
    try {
      const receipts = [];
      for (let i = 5; i < 8; i++) { f.publish(i); f.stream.advance(f.source.read(f.stream.epoch, f.stream.cursor)); receipts.push(f.stream.persist(directory)); }
      pruneRuntimes(directory, receipts.slice(-2)); expect(fs.readdirSync(directory)).toHaveLength(2);
      const resumed = new ExactForecastStream(build, sourceKey, f.champion, f.candidate);
      resumed.recover(directory, receipts.at(-1)!, f.stream.seedSha256);
      expect(isDeepStrictEqual(decodedRuntime(resumed.runtime()), decodedRuntime(f.stream.runtime()))).toBe(true);
      f.publish(8); const packet = f.source.read(f.stream.epoch, f.stream.cursor);
      f.stream.advance(packet); resumed.advance(packet);
      expect(resumed.sample(packet.feed, f.clock())).toEqual(f.stream.sample(packet.feed, f.clock()));
      const swapped = deserialize(resumed.runtime()); swapped.arms.challenger = swapped.arms.champion;
      expect(() => resumed.restore(serialize(swapped))).toThrow('another model');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('waits for a new model computation after interval freezing and scores that actual runtime interval', () => {
    const f = setup(); f.publish(5); f.stream.advance(f.source.read(f.stream.epoch, f.stream.cursor));
    const before = f.stream.stores.challenger.engine.captureEvaluation('runtime')!.modelParams;
    const final = structuredClone(f.candidate); final.params.CONFORMAL = { '0-2': 2, '2-5': 2, '5-10': 2, '10-30': 2 };
    f.stream.setModels(f.champion, final); expect(f.stream.canSample()).toBe(false);
    expect(f.stream.stores.challenger.engine.captureEvaluation('runtime')!.modelParams).toEqual(before);
    const resumed = new ExactForecastStream(build, sourceKey, f.champion, final); resumed.restore(f.stream.runtime(), f.stream.seedSha256);
    expect(resumed.canSample()).toBe(false);
    f.publish(6); const packet = f.source.read(f.stream.epoch, f.stream.cursor); resumed.advance(packet);
    const p = resumed.sample(packet.feed, f.clock()).challenger[0]!;
    expect(p.runtimeIntervals).toBe(true);
    expect(scoreEstimate(p, final.params.CONFORMAL)).toMatchObject({ eta: p.eta, low: Math.max(0, p.raw.low - p.ageSec), high: p.high });
    expect((resumed.stores.challenger.engine.captureEvaluation('runtime')!.modelParams as any).params.CONFORMAL).toEqual(final.params.CONFORMAL);
  });
  it('keeps a valid empty observation on its actual model clock', () => {
    const f = setup(); f.publish(5, true); const packet = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(packet);
    const before = f.stream.runtime(), result = f.stream.sample(packet.feed, f.clock() + 2000);
    expect(result.champion).toEqual([]); expect(result.productionControl!.modelAt).toBe(f.clock());
    expect(isDeepStrictEqual(decodedRuntime(f.stream.runtime()), decodedRuntime(before))).toBe(true);
  });
  it('keeps watching an expired modeled fleet while a fresh unmodeled bus remains', () => {
    const f = setup(); f.publish(5); const packet = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(packet);
    const expired = structuredClone(packet.feed), at = f.clock() + 45000;
    expired.buses.push({ ...expired.buses[0], bus_name: '#unmodeled', bus_id: -1, observed_at: at });
    delete expired.server_eta;
    const before = decodedRuntime(f.stream.runtime());
    expect(f.stream.sample(expired, at + 35, at)).toMatchObject({champion: [], challenger: [],
      productionControl: {modelAt: f.clock(), compared: 0, matched: 0, missing: 0, mismatched: 0}});
    expect(decodedRuntime(f.stream.runtime())).toEqual(before);
    f.publish(6); const resumed = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(resumed);
    expect(f.stream.sample(resumed.feed, f.clock()).productionControl!.compared).toBeGreaterThan(0);
  });
  it('still refuses a missing served control when the caught-up engine has visible forecasts', () => {
    const f = setup(); f.publish(5); const packet = f.source.read(f.stream.epoch, f.stream.cursor); f.stream.advance(packet);
    const missing = structuredClone(packet.feed); delete missing.server_eta;
    const before = decodedRuntime(f.stream.runtime());
    expect(() => f.stream.sample(missing, f.clock())).toThrow('Current served control differs');
    expect(decodedRuntime(f.stream.runtime())).toEqual(before);
  });
  it('forks idle past state after a model publication without relabeling past computations',()=>{
    const f=setup(),seed=structuredClone(f.seed),champion=structuredClone(f.champion);champion.version='published-while-idle';
    seed.idle=true;seed.feed.buses=[];delete seed.feed.server_eta;seed.feed.model_params=champion;seed.modelParams=champion;
    const stream=new ExactForecastStream(build,sourceKey,champion,f.candidate);
    stream.seed(seed,seed.at+3600000);
    expect(stream.at).toBe(seed.at);expect(stream.canSample()).toBe(false);
    expect(stream.stores.champion.engine.captureEvaluation()!.modelParams).toEqual(f.champion);
  });
  it('reports an external context change explicitly and never silently reseeds', () => {
    const f = setup(); f.publish(5); const packet = f.source.read(f.stream.epoch, f.stream.cursor), before = f.stream.runtime();
    for (const mutation of [{ epoch: 'new-epoch' }, { build: 'new-build' }]) {
      expect(() => f.stream.advance({ ...packet, ...mutation })).toThrow(SourceContextChanged);
      expect(isDeepStrictEqual(decodedRuntime(f.stream.runtime()), decodedRuntime(before))).toBe(true);
    }
  });
});
