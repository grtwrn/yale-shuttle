import fs from 'node:fs';
import { ExactForecastStream } from '../stream';
import { ServerEta } from '../../../src/server/serverEta';
import { EvaluationInputs } from '../../../src/server/evaluationInputs';
import { EvaluationSource } from '../../../src/server/evaluationSource';
import { ROUTE_LISTS } from '../../../web/src/routes';
import { COMPILED_MODEL_PARAMS } from '../../../web/src/eta/params';
const cap = JSON.parse(fs.readFileSync(new URL('../../../src/server/__fixtures__/live-frames.json', import.meta.url), 'utf8'));
export const sourceKey = '1'.repeat(64), build = 'fixture-build';
export function setup() {
  const champion = { version: 'champion', publishedAt: cap.frames[0].t - 10000, params: structuredClone(COMPILED_MODEL_PARAMS) };
  const candidate = structuredClone(champion); candidate.version = 'candidate'; candidate.params.P_REPEAT_STAND = .75; candidate.params.CONFORMAL = { '0-2': 1, '2-5': 1, '5-10': 1, '10-30': 1 };
  const producer = new ServerEta({ routes: ROUTE_LISTS.map(r => r.label) }); producer.useK10Trial(() => new Map());
  const inputs = new EvaluationInputs({ epoch: 'fixture-epoch' }); let clock = cap.frames[0].t, json = '{}';
  const source = new EvaluationSource(producer, () => json, inputs, () => build, () => clock);
  const publish = (i: number, empty = false) => {
    clock = cap.frames[i].t;
    const payload = { ...cap.static, model_params: champion,
      buses: empty ? [] : structuredClone(cap.frames[i].buses).map((b: any) => ({ ...b, observed_at: clock })) };
    const wire = producer.contribute(payload, i, clock, true); json = JSON.stringify({ ...payload, ...(wire ? { server_eta: wire } : {}) });
    inputs.append(i, clock, json, producer.evaluationContext()!);
  };
  for (let i = 0; i < 5; i++) publish(i);
  const seed = source.seed(), stream = new ExactForecastStream(build, sourceKey, champion, candidate); stream.seed(seed, clock);
  return { stream, source, seed, champion, candidate, publish, clock: () => clock };
}
