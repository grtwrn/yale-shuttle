import { deserialize, serialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta, type EtaPayloadView, type EvaluationForecast } from './serverEta';
import { unpackAnchorStore } from './etaSnapshot';
import { resetModelParams } from '../../web/src/eta/params';
import { clockOrigin } from '../../web/src/eta/filter';
import type { LatLon } from '../../web/src/geo';

// Fresh, declared software inputs: these never restore a recorded trajectory
// or assert that a current forecast equals a historical domain's output.
const STOPS = [9101, 9102, 9103, 9104];
const COORDS: Record<number, LatLon> = {
  9101: { lat: 41.31, lon: -72.93 }, 9102: { lat: 41.31, lon: -72.928 },
  9103: { lat: 41.312, lon: -72.928 }, 9104: { lat: 41.312, lon: -72.93 },
};
const START = Date.parse('2026-11-02T12:00:00Z');
const SMALL = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const HEAVY = [0, 20, 40, 80, 160, 320, 640, 1200, 2400, 4800];
const PATH = [...STOPS, STOPS[0]!].map(id => [COORDS[id]!.lat, COORDS[id]!.lon] as [number, number]);
function payload(at: number, q = SMALL, point = COORDS[9101]!, restSince: number | null = START): EtaPayloadView {
  return {
    buses: [{ bus_id: 990001, bus_name: '#current-synthetic', route_id: 4, ...point,
      heading: 0, last_stop_id: 9101, observed_at: at, stationary: restSince !== null,
      last_moved_at: new Date(restSince ?? at).toISOString(),
      ...(restSince === null ? {} : { at_stop_id: 9101,
        at_stop_since: new Date(restSince).toISOString(), stationary_since: new Date(restSince).toISOString() }) }],
    routes: { '4': STOPS }, stop_coords: COORDS, route_paths: { '4': PATH },
    segments: { '4': Object.fromEntries(STOPS.map((id, i) => [id + '-' + STOPS[(i + 1) % STOPS.length],
      { avg: 60, sd: 5, n: 10000, dq: [50, 52, 54, 56, 58, 60, 62, 64, 66, 68], dqn: 10000 }])) },
    dwells: { '4': Object.fromEntries(STOPS.map((id, i) => [String(id), {
      med: i === 0 ? 120 : 5, sd: 5, n: 10000, qn: 10000, q: i === 0 ? q : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }])) },
  };
}
function trackedEngine() {
  let calls = 0, raw: readonly EvaluationForecast[] = [];
  const engine = new ServerEta({ routes: ['Blue Weekend'],
    onBaseForecasts: () => { calls++; }, onServedForecasts: rows => { raw = rows; } });
  return { engine, calls: () => calls, raw: () => raw };
}
type Tracked = ReturnType<typeof trackedEngine>;
function tick(t: Tracked, value: EtaPayloadView, at: number) {
  const count = t.calls(), steps = t.engine.stats().steps;
  const wire = t.engine.contribute(value, at, at);
  expect(t.calls()).toBe(count + 1);
  expect(t.engine.stats().steps).toBe(steps + 1);
  expect(t.engine.stats().failures).toBe(0);
  expect(wire?.rows.length).toBeGreaterThan(0);
  return wire!;
}
function warm(q = SMALL) {
  const t = trackedEngine();
  let at = START;
  for (let i = 1; i <= 20; i++) { at = START + i * 5000; tick(t, payload(at, q), at); }
  return { t, at };
}
function state(engine: ServerEta, kind: 'history' | 'runtime' = 'history') {
  return deserialize(Buffer.from(engine.captureEvaluation(kind)!.bytes));
}
function tracking(engine: ServerEta) {
  return [...unpackAnchorStore(state(engine), false).values()][0]!;
}
afterEach(resetModelParams);

describe('fresh CURRENT-domain future pricing and state custody', () => {
  it('refuses a synthetic legacy runtime atomically instead of blessing its old cached output', () => {
    const source = warm(), target = warm(HEAVY), legacy = state(source.t.engine, 'runtime');
    legacy.store = unpackAnchorStore(legacy, false);
    for (const entry of legacy.store.values()) if (entry.floors) delete entry.floors.pricingLawKey;
    delete legacy.pricingLawSchema; delete legacy.snapshotPackingSchema; delete legacy.pricingLaws;
    const before = target.t.engine.captureEvaluation('runtime')!;
    expect(target.t.engine.restoreEvaluation(serialize(legacy), 'runtime', source.at)).toBe(false);
    expect(Buffer.from(target.t.engine.captureEvaluation('runtime')!.bytes).equals(Buffer.from(before.bytes))).toBe(true);
  });

  it('warm-starts synthetic legacy tracking into the new domain, then prices future laws through its own packed runtime', () => {
    const seeded = warm(), history = state(seeded.t.engine);
    history.store = unpackAnchorStore(history, false);
    for (const entry of history.store.values()) if (entry.floors) delete entry.floors.pricingLawKey;
    delete history.pricingLawSchema; delete history.snapshotPackingSchema; delete history.pricingLaws;
    const referenceHistory = structuredClone(history);
    for (const entry of referenceHistory.store.values()) delete entry.floors;
    const direct = trackedEngine(), reference = trackedEngine(), resumed = trackedEngine();
    expect(direct.engine.restoreEvaluation(serialize(history), 'history', seeded.at)).toBe(true);
    expect(reference.engine.restoreEvaluation(serialize(referenceHistory), 'history', seeded.at)).toBe(true);
    const origin = clockOrigin(tracking(direct.engine).belief!);
    const currentRuntime = direct.engine.captureEvaluation('runtime')!;
    expect(resumed.engine.restoreEvaluation(currentRuntime.bytes, 'runtime', seeded.at)).toBe(true);
    for (let i = 1; i <= 3; i++) {
      const at = seeded.at + i * 5000, frame = payload(at, HEAVY);
      const actual = tick(direct, frame, at);
      expect(tick(resumed, structuredClone(frame), at)).toEqual(actual);
      expect(tick(reference, structuredClone(frame), at)).toEqual(actual);
      expect(resumed.raw()).toEqual(direct.raw());
      expect(reference.raw()).toEqual(direct.raw());
      expect(clockOrigin(tracking(resumed.engine).belief!)).toBe(origin);
    }
  });

  it('preserves fresh departure, return-to-curb and new-rest pricing after a current packed checkpoint', () => {
    const { t: continuous, at: seededAt } = warm(HEAVY), resumed = trackedEngine();
    const snapshot = continuous.engine.captureEvaluation('runtime')!;
    expect(resumed.engine.restoreEvaluation(snapshot.bytes, 'runtime', seededAt)).toBe(true);
    const origin = clockOrigin(tracking(continuous.engine).belief!);
    const movement = [
      [41.31, -72.9295], [41.31, -72.929], [41.31, -72.9285], [41.31, -72.928],
      [41.3105, -72.928], [41.311, -72.928], [41.3115, -72.928], [41.312, -72.928],
      [41.312, -72.9285], [41.312, -72.929], [41.312, -72.9295], [41.312, -72.93],
      [41.3115, -72.93], [41.311, -72.93], [41.3105, -72.93], [41.31, -72.93],
    ];
    let at = seededAt, departed = false, newRest = false;
    const compare = (frame: EtaPayloadView) => {
      const actual = tick(continuous, frame, at);
      expect(tick(resumed, structuredClone(frame), at)).toEqual(actual);
      expect(resumed.raw()).toEqual(continuous.raw());
      const belief = tracking(resumed.engine).belief!;
      if (!belief.rested) departed = true;
      if (belief.rested && belief.restStop === 0 && clockOrigin(belief) > origin) newRest = true;
    };
    for (const [lat, lon] of movement) {
      at += 5000; compare(payload(at, HEAVY, { lat: lat!, lon: lon! }, null));
    }
    const restStart = at;
    for (let i = 0; i < 10 && !newRest; i++) {
      at += 5000; compare(payload(at, HEAVY, COORDS[9101]!, restStart));
    }
    expect(departed).toBe(true);
    expect(newRest).toBe(true);
  });
});
