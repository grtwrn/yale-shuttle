import { deserialize, serialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta, type EtaPayloadView } from './serverEta';
import { PRICING_LAW_SCHEMA } from '../../web/src/eta/arrival';
import { resetModelParams } from '../../web/src/eta/params';

const STOPS = [9101, 9102, 9103, 9104];
const COORDS = { 9101: { lat: 41.31, lon: -72.93 }, 9102: { lat: 41.31, lon: -72.928 },
  9103: { lat: 41.312, lon: -72.928 }, 9104: { lat: 41.312, lon: -72.93 } };
const START = Date.parse('2026-11-02T12:00:00Z');
const SMALL = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const HEAVY = [0, 20, 40, 80, 160, 320, 640, 1200, 2400, 4800];
function payload(at: number, q = SMALL): EtaPayloadView {
  return { buses: [{ bus_id: 990001, bus_name: '#synthetic', route_id: 4, ...COORDS[9101],
    heading: 0, last_stop_id: 9101, at_stop_id: 9101, stationary: true, observed_at: at,
    at_stop_since: new Date(START).toISOString(), stationary_since: new Date(START).toISOString(),
    last_moved_at: new Date(START).toISOString() }], routes: { '4': STOPS }, stop_coords: COORDS,
    segments: { '4': Object.fromEntries(STOPS.map((id, i) => [id + '-' + STOPS[(i + 1) % STOPS.length],
      { avg: 60, sd: 5, n: 10000, dq: [50, 52, 54, 56, 58, 60, 62, 64, 66, 68], dqn: 10000 }])) },
    dwells: { '4': Object.fromEntries(STOPS.map((id, i) => [String(id), { med: 5, sd: 5, n: 10000, qn: 10000,
      q: i === 0 ? q : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }])) } };
}
function engine() { return new ServerEta({ routes: ['Blue Weekend'], onServedForecasts: () => {} }); }
function warm() {
  const e = engine();
  let at = START;
  for (let i = 1; i <= 20; i++) {
    at = START + i * 5000;
    expect(e.contribute(payload(at), i, at)?.rows.length).toBeGreaterThan(0);
  }
  return { e, at };
}
afterEach(resetModelParams);

describe('pricing-law state custody', () => {
  it('tags a new exact runtime snapshot and restores its own cached forecasts', () => {
    const { e, at } = warm(), snapshot = e.captureEvaluation('runtime')!;
    expect(snapshot.bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(deserialize(Buffer.from(snapshot.bytes)).pricingLawSchema).toBe(PRICING_LAW_SCHEMA);
    const restored = engine();
    expect(restored.restoreEvaluation(snapshot.bytes, 'runtime', at)).toBe(true);
    expect(restored.evaluationWire(payload(at).buses, at)).toEqual(e.evaluationWire(payload(at).buses, at));
    expect(restored.evaluationForecasts()).toEqual(e.evaluationForecasts());
    expect(restored.evaluationForecasts().length).toBeGreaterThan(0);
  });

  it.each([undefined, 'incompatible-pricing-law'])('refuses runtime schema %s before replacing any state', schema => {
    const { e, at } = warm(), snapshot = e.captureEvaluation('runtime')!;
    const incompatible = deserialize(Buffer.from(snapshot.bytes));
    if (schema === undefined) delete incompatible.pricingLawSchema;
    else incompatible.pricingLawSchema = schema;
    const wire = e.evaluationWire(payload(at).buses, at), bytes = Buffer.from(snapshot.bytes);
    expect(e.restoreEvaluation(serialize(incompatible), 'runtime', at)).toBe(false);
    expect(e.evaluationWire(payload(at).buses, at)).toEqual(wire);
    expect(Buffer.from(e.captureEvaluation('runtime')!.bytes).equals(bytes)).toBe(true);
  });

  it('retains legacy history posterior and rest, then discards only its lawless floor at pricing', () => {
    const { e, at } = warm(), saved = deserialize(Buffer.from(e.captureEvaluation('history')!.bytes));
    delete saved.pricingLawSchema;
    for (const entry of saved.store.values()) delete entry.floors.pricingLawKey;
    const history = serialize(saved), restored = engine();
    expect(restored.restoreEvaluation(history, 'history', at)).toBe(true);
    const before = deserialize(Buffer.from(restored.captureEvaluation('history')!.bytes));
    expect(before.store).toEqual(saved.store);
    const current = structuredClone(saved);
    for (const entry of current.store.values()) delete entry.floors;
    const reference = engine();
    expect(reference.restoreEvaluation(serialize(current), 'history', at)).toBe(true);
    const next = payload(at + 5000, HEAVY);
    expect(restored.contribute(next, at + 5000, at + 5000))
      .toEqual(reference.contribute(structuredClone(next), at + 5000, at + 5000));
    const after = deserialize(Buffer.from(restored.captureEvaluation('history')!.bytes));
    for (const [key, entry] of after.store) {
      expect(entry.belief.restSince).toBe(saved.store.get(key).belief.restSince);
      expect(entry.floors.pricingLawKey).toContain(PRICING_LAW_SCHEMA);
    }
  });

  it('migrates an old local checkpoint without discarding its tracking history', () => {
    const { e, at } = warm(), saved = deserialize(Buffer.from(e.captureEvaluation('history')!.bytes));
    for (const entry of saved.store.values()) delete entry.floors.pricingLawKey;
    const local = { v: 1, at, store: saved.store, seen: saved.seen };
    const referenceLocal = structuredClone(local);
    for (const entry of referenceLocal.store.values()) delete entry.floors;
    const restored = engine(), reference = engine();
    restored.useCheckpoint({ load: () => serialize(local), save: () => {} }, at);
    reference.useCheckpoint({ load: () => serialize(referenceLocal), save: () => {} }, at);
    expect(restored.stats().restored).toBeGreaterThan(0);
    const next = payload(at + 5000, HEAVY);
    expect(restored.contribute(next, 21, at + 5000)).toEqual(reference.contribute(structuredClone(next), 21, at + 5000));
    const after = deserialize(Buffer.from(restored.captureEvaluation('history')!.bytes));
    for (const [key, entry] of after.store) {
      expect(entry.belief.restSince).toBe(saved.store.get(key).belief.restSince);
      expect(entry.floors.pricingLawKey).toContain(PRICING_LAW_SCHEMA);
    }
  });
});
