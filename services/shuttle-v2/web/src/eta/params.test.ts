import { afterEach, describe, expect, it } from "vitest";

import {
  applyModelParams, COMPILED_MODEL_PARAMS, CONFORMAL_HORIZONS, MP, PARAM_RANGES, parseModelParams,
  resetModelParams, SCALAR_PARAM_KEYS, widenBand, activeModelParams,
} from "./params";
import {
  HOLD_ENTER_PER_S, HOLD_LEAVE_PER_S, P_DEPART_ON_FRESH, P_REPEAT_MOVE, P_REPEAT_MOVE_ZONE, P_REPEAT_STAND,
  SHUFFLE_PER_POLL, stepBelief, type Belief,
} from "./filter";
import { priceRoute } from "./arrival";
import { buildRing, type Ring } from "./ring";
import { buildTables } from "./tables";
import type { LatLon } from "../geo";

afterEach(() => resetModelParams());

// The same synthetic block as filter.test.ts: four stops at the corners of a
// 900 x 450 m loop.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
function at(xm: number, ym: number): LatLon { return { lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon }; }
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);
function ring(): Ring {
  const r = buildRing("test", PATH, STOPS, COORDS);
  if (!r) throw new Error("ring");
  return r;
}
const SEGS = {
  "1-2": { avg: 150, sd: 20, n: 30, dq: [110, 120, 130, 140, 150, 160, 170, 185, 200, 240], dqn: 30 },
  "2-3": { avg: 80, sd: 10, n: 30, dq: [60, 65, 70, 75, 80, 85, 90, 95, 105, 130], dqn: 30 },
  "3-4": { avg: 150, sd: 20, n: 30, dq: [110, 120, 130, 140, 150, 160, 170, 185, 200, 240], dqn: 30 },
  "4-1": { avg: 80, sd: 10, n: 30, dq: [60, 65, 70, 75, 80, 85, 90, 95, 105, 130], dqn: 30 },
};
const DWELLS = {
  "1": { med: 30, sd: 10, n: 30, q: [0, 10, 15, 20, 25, 30, 40, 50, 70, 120], qn: 30, pstop: 0.9 },
  "2": { med: 30, sd: 10, n: 30, q: [0, 10, 15, 20, 25, 30, 40, 50, 70, 120], qn: 30, pstop: 0.9 },
  "3": { med: 30, sd: 10, n: 30, q: [0, 10, 15, 20, 25, 30, 40, 50, 70, 120], qn: 30, pstop: 0.9 },
  "4": { med: 240, sd: 60, n: 30, q: [0, 60, 120, 180, 220, 240, 280, 320, 400, 600], qn: 30, pstop: 0.95 },
};

/**
 * A scripted day on the block: a drive along leg 0 with a crawl, a stand at
 * stop 2, a shuffle, a departure, a hold on the road, a stand at the layover.
 * Every branch of the step that reads a parameter is exercised.
 */
function scenario(): Array<{ pos: LatLon; t: number; extra?: { last_stop_id?: number; stationary_since?: string } }> {
  const out: Array<{ pos: LatLon; t: number; extra?: { last_stop_id?: number; stationary_since?: string } }> = [];
  let t = 0;
  const push = (pos: LatLon, extra?: { last_stop_id?: number; stationary_since?: string }) => { out.push({ pos, t, ...(extra ? { extra } : {}) }); t += 5000; };
  for (let x = 100; x < 880; x += 35) push(at(x, 0), { last_stop_id: 1 });
  for (let i = 0; i < 4; i++) push(at(880, 0));           // crawl repeats near the kerb
  for (let i = 0; i < 12; i++) push(at(900, 0));          // stands at stop 2
  push(at(900, 35)); for (let i = 0; i < 4; i++) push(at(900, 35)); // a shuffle, refreezes
  for (let y = 70; y < 430; y += 35) push(at(900, y), { last_stop_id: 2 });
  for (let i = 0; i < 6; i++) push(at(900, 430));         // a hold short of stop 3
  for (let x = 900; x > 20; x -= 35) push(at(x, 450), { last_stop_id: 3 });
  for (let i = 0; i < 40; i++) push(at(0, 450), { stationary_since: new Date(t - 5000).toISOString().replace(/Z$/, "") }); // the layover
  push(at(0, 415)); push(at(0, 380));
  return out;
}

function run(): { masses: number[]; rows: string[] } {
  const r = ring();
  const tables = buildTables(STOPS, COORDS, SEGS, DWELLS, r);
  const masses: number[] = [];
  const rows: string[] = [];
  let b: Belief | undefined;
  const floors = { map: new Map() };
  for (const s of scenario()) {
    b = stepBelief(b, r, { lat: s.pos.lat, lon: s.pos.lon, ...s.extra }, s.t, STOPS);
    for (let i = 0; i < b.p.length; i++) masses.push(b.p[i]!);
    const priced = priceRoute(b, r, tables, STOPS, new Set(STOPS), s.t, 0.5, floors);
    for (const row of priced) rows.push(`${row.stopId}|${row.occurrence}|${row.eta}|${row.low}|${row.high}|${row.leadMass}`);
  }
  return { masses, rows };
}

describe("the compiled defaults are the constants", () => {
  it("pins params.ts to filter.ts", () => {
    expect(COMPILED_MODEL_PARAMS.P_REPEAT_STAND).toBe(P_REPEAT_STAND);
    expect(COMPILED_MODEL_PARAMS.P_REPEAT_MOVE).toBe(P_REPEAT_MOVE);
    expect(COMPILED_MODEL_PARAMS.P_REPEAT_MOVE_ZONE).toBe(P_REPEAT_MOVE_ZONE);
    expect(COMPILED_MODEL_PARAMS.HOLD_ENTER_PER_S).toBe(HOLD_ENTER_PER_S);
    expect(COMPILED_MODEL_PARAMS.HOLD_LEAVE_PER_S).toBe(HOLD_LEAVE_PER_S);
    expect(COMPILED_MODEL_PARAMS.SHUFFLE_PER_POLL).toBe(SHUFFLE_PER_POLL);
    expect(COMPILED_MODEL_PARAMS.P_DEPART_ON_FRESH).toBe(P_DEPART_ON_FRESH);
    for (const h of CONFORMAL_HORIZONS) expect(COMPILED_MODEL_PARAMS.CONFORMAL[h]).toBe(1);
    for (const k of SCALAR_PARAM_KEYS) {
      const [lo, hi] = PARAM_RANGES[k];
      expect(COMPILED_MODEL_PARAMS[k]).toBeGreaterThanOrEqual(lo);
      expect(COMPILED_MODEL_PARAMS[k]).toBeLessThanOrEqual(hi);
    }
  });

  it("a served set equal to the compiled one reproduces every mass and every row exactly", () => {
    resetModelParams();
    const base = run();
    expect(base.rows.length).toBeGreaterThan(50);
    expect(applyModelParams({ version: "fit-test", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL } } })).toBe(true);
    expect(activeModelParams()?.version).toBe("fit-test");
    const served = run();
    expect(served.masses).toEqual(base.masses);
    expect(served.rows).toEqual(base.rows);
  });

  it("a served set that differs changes the output (the plumbing is live)", () => {
    const base = run();
    applyModelParams({ version: "x", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, P_REPEAT_STAND: 0.8, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL } } });
    const changed = run();
    expect(changed.masses).not.toEqual(base.masses);
    applyModelParams({ version: "y", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, CONFORMAL: { "0-2": 1.5, "2-5": 1.5, "5-10": 1.5, "10-30": 1.5 } } });
    const widened = run();
    expect(widened.masses).toEqual(base.masses);
    expect(widened.rows).not.toEqual(base.rows);
  });
});

describe("validation", () => {
  it("rejects a value outside its range, a missing key, or a broken conformal table — the whole set", () => {
    expect(parseModelParams({ ...COMPILED_MODEL_PARAMS, P_REPEAT_STAND: 1.2 })).toBeNull();
    expect(parseModelParams({ ...COMPILED_MODEL_PARAMS, HOLD_ENTER_PER_S: -1 })).toBeNull();
    expect(parseModelParams({ ...COMPILED_MODEL_PARAMS, SHUFFLE_PER_POLL: "0.03" })).toBeNull();
    const { P_REPEAT_MOVE: _drop, ...missing } = COMPILED_MODEL_PARAMS;
    expect(parseModelParams(missing)).toBeNull();
    expect(parseModelParams({ ...COMPILED_MODEL_PARAMS, CONFORMAL: { "0-2": 1 } })).toBeNull();
    expect(parseModelParams({ ...COMPILED_MODEL_PARAMS, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL, "2-5": 9 } })).toBeNull();
    expect(parseModelParams(null)).toBeNull();
    expect(parseModelParams(COMPILED_MODEL_PARAMS)).toEqual(COMPILED_MODEL_PARAMS);
  });

  it("an absent or malformed payload field falls back to the compiled constants", () => {
    applyModelParams({ version: "x", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, P_REPEAT_STAND: 0.8, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL } } });
    expect(MP.P_REPEAT_STAND).toBe(0.8);
    expect(applyModelParams(undefined)).toBe(false);
    expect(MP.P_REPEAT_STAND).toBe(P_REPEAT_STAND);
    expect(activeModelParams()).toBeNull();
    applyModelParams({ version: "x", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, P_REPEAT_STAND: 0.8, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL } } });
    expect(applyModelParams({ version: "bad", params: { ...COMPILED_MODEL_PARAMS, P_REPEAT_MOVE: 0.9 } })).toBe(false);
    expect(MP.P_REPEAT_STAND).toBe(P_REPEAT_STAND);
  });
});

describe("the conformal widening", () => {
  it("is a no-op at 1 and scales the band about the number per bucket", () => {
    expect(widenBand(100, 80, 130)).toEqual([80, 130]);
    applyModelParams({ version: "w", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, CONFORMAL: { "0-2": 2, "2-5": 1, "5-10": 0.5, "10-30": 1.5 } } });
    expect(widenBand(100, 80, 130)).toEqual([60, 160]);
    expect(widenBand(200, 150, 260)).toEqual([150, 260]);
    expect(widenBand(400, 300, 500)).toEqual([350, 450]);
    expect(widenBand(1200, 1000, 1400)).toEqual([900, 1500]);
    // Past the cap nothing is learned about, so nothing is applied.
    expect(widenBand(2400, 2000, 2800)).toEqual([2000, 2800]);
  });
});
