import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta, type EtaPayloadView } from './serverEta';
import { EvaluationSource } from './evaluationSource';
import { EvaluationInputs, EvaluationInputError } from './evaluationInputs';
import { ROUTE_LISTS } from '../../web/src/routes';
import { registerRoutePaths } from '../../web/src/anchor';
import { resetModelParams } from '../../web/src/eta/params';

const cap = JSON.parse(fs.readFileSync(new URL('./__fixtures__/live-frames.json', import.meta.url), 'utf8'));
afterEach(() => { resetModelParams(); registerRoutePaths(null); });
function setup(options = {}) {
  const engine = new ServerEta({ routes: ROUTE_LISTS.map(r => r.label) }), inputs = new EvaluationInputs({ epoch: 'fixture', ...options });
  let json = '{}', clock = cap.frames[0].t;
  const source = new EvaluationSource(engine, () => json, inputs, () => 'fixture-build', () => clock);
  const publish = (i: number) => {
    clock = cap.frames[i].t;
    const p: EtaPayloadView = { ...cap.static, buses: structuredClone(cap.frames[i].buses) };
    const wire = engine.contribute(p, i, clock); json = JSON.stringify({ ...p, ...(wire ? { server_eta: wire } : {}) });
    inputs.append(i, engine.evaluationClock()!, json);
  };
  return { engine, source, inputs, publish, setPublic: (value: unknown) => { json = JSON.stringify(value); },
    setPublicRaw: (value: string) => { json = value; }, setClock: (at: number) => { clock = at; } };
}
describe('auth-scoped source history and catchup payloads', () => {
  it('serializes identical pages through backfill, the final page and caught-up polling', () => {
    const f = setup(); for (let i = 0; i < 5; i++) f.publish(i);
    for (const after of [0, 2, 4, 5]) {
      const expected = f.source.read('fixture', after, 2);
      expect(f.source.readJson('fixture', after, 2)).toBe(JSON.stringify(expected));
      expect(JSON.parse(f.source.readJson('fixture', after, 2))).toEqual(expected);
    }
  });
  it('keeps serialized feeds independent of mutations to a previous object response', () => {
    const f = setup(); f.publish(0); const expected = f.source.readJson('fixture', 1);
    const object = f.source.read('fixture', 1); object.feed.buses.length = 0;
    expect(f.source.readJson('fixture', 1)).toBe(expected);
  });
  it('preserves valid noncanonical JSON and Unicode without turning the feed into a string', () => {
    const f = setup(); f.publish(0); const feed = f.source.head().feed;
    f.setPublicRaw(' \n' + JSON.stringify({ ...feed, note: '"}\\\n雪\u2028', extra: [1e3, -0, null] }) + '\t');
    expect(JSON.parse(f.source.readJson('fixture', 1))).toEqual(f.source.read('fixture', 1));
  });
  it('rejects malformed public JSON before emitting a serialized response', () => {
    const f = setup(); f.publish(0); f.setPublicRaw('{"buses":');
    expect(() => f.source.readJson('fixture', 1)).toThrow(SyntaxError);
    expect(() => f.source.read('fixture', 1)).toThrow(SyntaxError);
  });
  it.each(['epoch', 'cursor', 'gap'] as const)('preserves the %s refusal in the serialized reader', code => {
    const f = setup({ maxFrames: 2 }); for (let i = 0; i < 4; i++) f.publish(i);
    const request = code === 'epoch' ? ['other', 4] as const : code === 'cursor' ? ['fixture', -1] as const : ['fixture', 0] as const;
    const refusal = (run: () => unknown) => {
      try { run(); throw Error('Expected source refusal'); }
      catch (error) { expect(error).toBeInstanceOf(EvaluationInputError); return (error as EvaluationInputError).code; }
    };
    expect(refusal(() => f.source.readJson(request[0], request[1]))).toBe(code);
    expect(refusal(() => f.source.read(request[0], request[1]))).toBe(code);
  });
  it('refuses failed capture and incoherent model clocks before serializing a feed', () => {
    const failed = setup(); failed.publish(0); failed.inputs.fail('Missing model observation');
    expect(() => failed.source.readJson('fixture', 1)).toThrow('Evaluation source unavailable');
    const drifted = setup(); drifted.publish(0);
    drifted.engine.contribute({ ...cap.static, buses: structuredClone(cap.frames[1].buses) }, 1, cap.frames[1].t);
    expect(() => drifted.source.readJson('fixture', 1)).toThrow('not ready');
  });
  it('serializes unchanged idle history with the current response clock', () => {
    const f = setup(); f.publish(0); const head = f.source.head(), empty = { ...head.feed, buses: [] }; delete empty.server_eta;
    f.setPublic(empty); f.setClock(cap.frames[0].t + 3600000);
    const expected = f.source.read('fixture', 1);
    expect(f.source.readJson('fixture', 1)).toBe(JSON.stringify(expected));
    expect(expected.frames).toEqual([]); expect(expected.feed.server_eta).toBeUndefined();
    expect(expected.responseAt).toBe(cap.frames[0].t + 3600000);
  });
  it('exports pre-forecast history with a coherent cursor and checksummed bytes', () => {
    const f = setup(); f.publish(0); const before = f.engine.stats(), seed = f.source.seed();
    expect(seed.v).toBe(1); expect(seed.cursor).toBe(1); expect(seed.at).toBe(cap.frames[0].t);
    const bytes = Buffer.from(seed.history.data, 'base64'); expect(seed.history.bytes).toBe(bytes.length);
    expect(seed.history.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const decoded = deserialize(bytes); expect(decoded.kind).toBe('history'); expect(decoded.cache).toBeUndefined();
    expect(f.engine.stats()).toEqual(before);
  });
  it('returns every model observation and withholds live sampling until catchup completes', () => {
    const f = setup(); for (let i = 0; i < 5; i++) f.publish(i);
    const first = f.source.read('fixture', 0, 2); expect(first.frames.map(x => x.seq)).toEqual([1, 2]); expect(first.feed).toBeNull();
    const second = f.source.read('fixture', first.cursor, 2); expect(second.frames.map(x => x.seq)).toEqual([3, 4]);
    const last = f.source.read('fixture', second.cursor, 2); expect(last.frames.map(x => x.seq)).toEqual([5]);
    expect(last.hasMore).toBe(false); expect(last.feed.server_eta.at).toBe(cap.frames[4].t);
  });
  it('rejects a gap instead of returning only the latest public feed', () => {
    const f = setup({ maxFrames: 2 }); for (let i = 0; i < 4; i++) f.publish(i);
    try { f.source.read('fixture', 0); throw Error('Expected gap'); }
    catch (e) { expect(e).toBeInstanceOf(EvaluationInputError); expect((e as EvaluationInputError).code).toBe('gap'); }
  });
  it('refuses a new public model until an observation computed with that model exists', () => {
    const f = setup(); f.publish(0); const head = f.source.head();
    f.setPublic({ ...head.feed, model_params: { version: 'changed' } }); expect(() => f.source.seed()).toThrow('coherent');
  });
  it('refuses stale or incomplete source history and disabled model serving', () => {
    const f = setup(); expect(() => f.source.seed()).toThrow(); f.publish(0);
    f.setClock(cap.frames[0].t + 120001); expect(() => f.source.seed()).toThrow('coherent');
    const disabled = new EvaluationSource(null, () => '{}', f.inputs, () => 'fixture-build'); expect(() => disabled.head()).toThrow();
  });
  it('preserves an explicit failed capture and does not imply that old frames are complete', () => {
    const f = setup(); f.publish(0); f.inputs.fail('Missing model observation');
    expect(() => f.source.head()).toThrow(); expect(() => f.source.seed()).toThrow(); expect(f.inputs.stats().retained).toBe(1);
  });
  it('forks unchanged idle history without manufacturing a fresh model observation', () => {
    const f = setup(); f.publish(0); const before = f.engine.stats(), head = f.source.head();
    const empty = { ...head.feed, buses: [] }; delete empty.server_eta;
    f.setPublic(empty); f.setClock(cap.frames[0].t + 3600000);
    const seed = f.source.seed(); expect(seed.idle).toBe(true); expect(seed.at).toBe(cap.frames[0].t);
    expect(f.engine.stats()).toEqual(before);
  });
  it('distinguishes the current idle model from the model that last produced historical state',()=>{
    const f=setup();f.publish(0);const before=f.engine.stats(),head=f.source.head();
    const next={version:'published-while-idle',params:{test:1}},empty={...head.feed,buses:[],model_params:next};delete empty.server_eta;
    f.setPublic(empty);f.setClock(cap.frames[0].t+3600000);
    const seed=f.source.seed();expect(seed.modelParams).toEqual(next);expect(seed.pastModelParams).toBeNull();
    expect(seed.idle).toBe(true);expect(f.engine.stats()).toEqual(before);
  });
});
