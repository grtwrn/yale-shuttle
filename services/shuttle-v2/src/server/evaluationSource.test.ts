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
  return { engine, source, inputs, publish, setPublic: (value: unknown) => { json = JSON.stringify(value); }, setClock: (at: number) => { clock = at; } };
}
describe('auth-scoped source history and catchup payloads', () => {
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
