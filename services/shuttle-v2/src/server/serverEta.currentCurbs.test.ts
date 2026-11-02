import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta, type EvaluationForecast } from './serverEta';
import { SNAPSHOT_PACKING_SCHEMA } from './etaSnapshot';
import { PRICING_LAW_SCHEMA } from '../../web/src/eta/arrival';
import { resetModelParams } from '../../web/src/eta/params';
import curved from '../../web/src/__fixtures__/green-west-haven-curved-curb-20261024.json';
import projected from '../../web/src/__fixtures__/green-west-haven-near-curb-20261024.json';

type Part = { body: string; gzipSHA256: string; decodedSHA256: string };
type Frame = { seq: number; at: number; json: string; sha256: string; contextJson: string; contextSha256: string };
const hash = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');
function decode(part: Part) {
  const compressed = Buffer.from(part.body, 'base64');
  expect(hash(compressed)).toBe(part.gzipSHA256);
  const raw = gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
  expect(hash(raw)).toBe(part.decodedSHA256);
  return raw;
}
function tracked(routes: string[]) {
  let calls = 0, raw: readonly EvaluationForecast[] = [];
  const engine = new ServerEta({ routes, onBaseForecasts: () => { calls++; },
    onServedForecasts: rows => { raw = rows; } });
  return { engine, calls: () => calls, raw: () => raw };
}
type Tracked = ReturnType<typeof tracked>;
type Wire = NonNullable<ReturnType<ServerEta['contribute']>>;
function step(t: Tracked, frame: Frame) {
  expect(hash(frame.json)).toBe(frame.sha256);
  expect(hash(frame.contextJson)).toBe(frame.contextSha256);
  const payload = JSON.parse(frame.json);
  // The current engine receives inputs and tracking history, never the old
  // forecast field as an answer, cache, or current-domain numeric oracle.
  delete payload.server_eta;
  expect(t.engine.useEvaluationContext(JSON.parse(frame.contextJson))).toBe(true);
  const calls = t.calls(), steps = t.engine.stats().steps;
  const wire = t.engine.contribute(payload, frame.at, frame.at, true);
  expect(t.calls()).toBe(calls + 1);
  expect(t.engine.stats().steps).toBe(steps + 1);
  expect(t.engine.stats().failures).toBe(0);
  expect(wire).not.toBeNull();
  return wire!;
}
function watched(wire: Wire, name: string) {
  return wire.rows.flatMap((row, i) => wire.buses[row[0]]![0] === name && row[1] === 127
    ? [{ row, distribution: wire.distributions![i]! }] : []);
}
afterEach(resetModelParams);

describe('CURRENT-domain West Haven tracking warm-start and future pricing', () => {
  for (const sample of [
    { name: 'curved chord', input: curved, bus: '308', sequences: [888, 889, 890, 891], tail: 3000 },
    { name: 'projected marker', input: projected, bus: '332', sequences: [555, 556, 557, 558], tail: 3600 },
  ]) {
    it(`recomputes ${sample.name} and preserves its own packed checkpoint through the curb`, () => {
      const saved = deserialize(decode(sample.input.runtime));
      const frames = JSON.parse(decode(sample.input.frames).toString()) as Frame[];
      expect(frames.map(frame => frame.seq)).toEqual(sample.sequences);
      expect(saved.kind).toBe('runtime');
      expect(saved.pricingLawSchema).toBeUndefined();
      expect(saved.snapshotPackingSchema).toBeUndefined();
      expect(saved.cache.lastVersion).toBeLessThan(frames[0]!.at);
      // Explicit NEW-domain tracking migration. Preserve the posterior graph,
      // raw release clock and observations; discard all forecast memory.
      const tracking = new Map<string, any>();
      for (const [key, entry] of saved.store) tracking.set(key, {
        belief: entry.belief, ...(entry.releasePin === undefined ? {} : { releasePin: entry.releasePin }),
      });
      const history = { ...saved, kind: 'history', store: tracking };
      delete history.cache;
      const continuous = tracked(saved.served), resumed = tracked(saved.served);
      expect(continuous.engine.restoreEvaluation(serialize(history), 'history', sample.input.runtime.at, 120000)).toBe(true);
      expect(continuous.engine.evaluationWire(JSON.parse(frames[0]!.json).buses, frames[0]!.at)).toBeNull();
      expect(continuous.engine.evaluationForecasts()).toEqual([]);
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        expect(saved.at).toBeLessThan(frame.at);
        const actual = step(continuous, frame);
        if (i === 0) {
          const checkpoint = continuous.engine.captureEvaluation('runtime')!;
          const own = deserialize(Buffer.from(checkpoint.bytes));
          expect(own.pricingLawSchema).toBe(PRICING_LAW_SCHEMA);
          expect(own.snapshotPackingSchema).toBe(SNAPSHOT_PACKING_SCHEMA);
          expect(own.cache.lastVersion).toBeLessThan(frames[1]!.at);
          expect(resumed.engine.restoreEvaluation(checkpoint.bytes, 'runtime', frame.at, 120000)).toBe(true);
        } else {
          expect(step(resumed, frame)).toEqual(actual);
          expect(resumed.raw()).toEqual(continuous.raw());
        }
        const current = watched(actual, sample.bus);
        expect(current.length).toBeGreaterThan(0);
        const incoming = current[0]!;
        expect(incoming.row[5]).toBe(i === frames.length - 1 ? 0 : 1);
        if (i < frames.length - 1) {
          expect(incoming.row[2]).toBeGreaterThan(0);
          expect(incoming.row[2]).toBeLessThan(10);
          expect(incoming.distribution.some(value => value > sample.tail)).toBe(true);
        } else expect(incoming.row[2]).toBe(0);
        for (const { row, distribution } of current) {
          expect(row[3]).toBeLessThanOrEqual(row[2]);
          expect(row[4]).toBeGreaterThanOrEqual(row[2]);
          expect(distribution).toHaveLength(50);
          expect(distribution).toEqual([...distribution].sort((a, b) => a - b));
        }
      }
    });
  }
});
