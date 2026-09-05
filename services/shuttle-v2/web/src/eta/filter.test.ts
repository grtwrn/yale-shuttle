import { describe, expect, it } from "vitest";
import { buildRing, CELL_M, type Ring } from "./ring";
import { legMass, P_DEPART_ON_FRESH, situations, standingSec, stepBelief, type Belief } from "./filter";
import type { LatLon } from "../geo";

// A synthetic rectangular loop: four stops at the corners of a ~900 x 450 m
// block, the published line running along its edges. Metres per degree at
// 41.31 N: lat 111,195 m, lon ~83,500 m.
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

/** Position xm metres along the bottom edge from stop 1 toward stop 2. */
function onLeg0(xm: number): LatLon { return at(xm, 0); }

function bus(pos: LatLon, extra: Partial<{ last_stop_id: number; stationary_since: string }> = {}) {
  return { lat: pos.lat, lon: pos.lon, ...extra };
}

function standMass(b: Belief, r: Ring): number { let s = 0; for (let c = 0; c < r.C; c++) s += b.p[c]!; return s; }
function meanCell(b: Belief, r: Ring): number {
  let s = 0;
  for (let c = 0; c < r.C; c++) s += c * (b.p[c]! + b.p[r.C + c]!);
  return s;
}

describe("ring", () => {
  it("cuts the loop into ~30 m cells with a cell on every stop", () => {
    const r = ring();
    expect(r.N).toBe(4);
    expect(r.loopM).toBeCloseTo(2700, -1);
    expect(r.C).toBe(Math.round(900 / CELL_M) * 2 + Math.round(450 / CELL_M) * 2);
    for (let i = 0; i < r.N; i++) expect(r.frac[r.stopCell[i]!]).toBe(0);
    expect(r.nearStop[r.stopCell[1]!]).toBe(1);
    // 100 m before stop 2 along leg 0: approach zone of stop 2, not near.
    const c = r.stopCell[1]! - 3;
    expect(r.nearStop[c]).toBe(-1);
    expect(r.approachOf[c]).toBe(1);
  });
});

describe("filter: the deadband is the observation model", () => {
  it("conserves mass and never moves backwards", () => {
    const r = ring();
    let b = stepBelief(undefined, r, bus(onLeg0(300)), 0, STOPS);
    let prevMean = meanCell(b, r);
    for (let t = 1; t <= 20; t++) {
      b = stepBelief(b, r, bus(onLeg0(300 + 35 * t)), t * 5000, STOPS);
      let sum = 0;
      for (const v of b.p) sum += v;
      expect(sum).toBeCloseTo(1, 9);
      const m = meanCell(b, r);
      expect(m).toBeGreaterThan(prevMean - 0.5);
      prevMean = m;
    }
    expect(b.lead).toBe(1); // 300 + 35 * 20 m is past stop 2
  });

  it("a repeated fix leaves the position where it was", () => {
    const r = ring();
    let b = stepBelief(undefined, r, bus(onLeg0(300)), 0, STOPS);
    const m0 = meanCell(b, r);
    for (let t = 1; t <= 12; t++) b = stepBelief(b, r, bus(onLeg0(300)), t * 5000, STOPS);
    expect(Math.abs(meanCell(b, r) - m0)).toBeLessThan(0.3);
    // ...and a minute of repeats is a standing bus.
    expect(standMass(b, r)).toBeGreaterThan(0.95);
  });

  it("a fresh fix from a short stand moves the measured departure share into MOVE, and a second fix settles it", () => {
    const r = ring();
    // Standing 60 s: an ordinary stop, not a layover.
    const since = new Date(60_000).toISOString().replace("Z", "");
    let b = stepBelief(undefined, r, bus(onLeg0(0), { stationary_since: since }), 90_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), { stationary_since: since }), 90_000 + t * 5000, STOPS);
    expect(standMass(b, r)).toBeGreaterThan(0.95);
    b = stepBelief(b, r, bus(onLeg0(35)), 125_000, STOPS);
    const moving1 = 1 - standMass(b, r);
    expect(moving1).toBeGreaterThanOrEqual(P_DEPART_ON_FRESH - 0.05);
    expect(moving1).toBeLessThan(0.9);
    b = stepBelief(b, r, bus(onLeg0(70)), 130_000, STOPS);
    expect(1 - standMass(b, r)).toBeGreaterThan(0.85); // measured 0.87 after the 2nd fresh fix
  });

  it("the first step off a layover-length stand is more likely a reposition; three steps make it a departure", () => {
    const r = ring();
    const since = new Date(0).toISOString().replace("Z", "");
    let b = stepBelief(undefined, r, bus(onLeg0(0), { stationary_since: since }), 300_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), { stationary_since: since }), 300_000 + t * 5000, STOPS);
    b = stepBelief(b, r, bus(onLeg0(35)), 335_000, STOPS);
    expect(1 - standMass(b, r)).toBeLessThan(0.55);
    b = stepBelief(b, r, bus(onLeg0(70)), 340_000, STOPS);
    b = stepBelief(b, r, bus(onLeg0(105)), 345_000, STOPS);
    expect(1 - standMass(b, r)).toBeGreaterThan(0.7);
  });

  it("a shuffle that re-freezes goes back to standing at the same stop", () => {
    const r = ring();
    const since = new Date(0).toISOString().replace("Z", "");
    let b = stepBelief(undefined, r, bus(onLeg0(0), { stationary_since: since }), 120_000, STOPS);
    for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), { stationary_since: since }), 120_000 + t * 5000, STOPS);
    b = stepBelief(b, r, bus(onLeg0(32), { stationary_since: since }), 155_000, STOPS);
    for (let t = 1; t <= 3; t++) b = stepBelief(b, r, bus(onLeg0(32), { stationary_since: since }), 155_000 + t * 5000, STOPS);
    // Three repeats call it a shuffle (the collector's own rule); six make it certain.
    expect(standMass(b, r)).toBeGreaterThan(0.7);
    for (let t = 4; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(32), { stationary_since: since }), 155_000 + t * 5000, STOPS);
    expect(standMass(b, r)).toBeGreaterThan(0.9);
    const s = situations(b, r);
    expect(s[0]!.standing).toBe(true);
    expect(s[0]!.zoneStop).toBe(0);
    // The clock is the server's, unbroken by the shuffle.
    expect(standingSec(b, 170_000)).toBe(170);
  });

  it("is idempotent within a poll", () => {
    const r = ring();
    const b = stepBelief(undefined, r, bus(onLeg0(300)), 0, STOPS);
    const b1 = stepBelief(b, r, bus(onLeg0(335)), 5000, STOPS);
    const b2 = stepBelief(b1, r, bus(onLeg0(335)), 5000, STOPS);
    expect(b2).toBe(b1);
  });

  it("follows a driving bus one leg at a time", () => {
    const r = ring();
    let b = stepBelief(undefined, r, bus(onLeg0(0)), 0, STOPS);
    let prev = b.lead;
    // Drive the whole loop at 7 m/s.
    const total = 2700;
    for (let t = 1; t * 35 < total * 1.5; t++) {
      const m = (t * 35) % total;
      let pos: LatLon;
      if (m < 900) pos = at(m, 0);
      else if (m < 1350) pos = at(900, m - 900);
      else if (m < 2250) pos = at(900 - (m - 1350), 450);
      else pos = at(0, 450 - (m - 2250));
      b = stepBelief(b, r, bus(pos), t * 5000, STOPS);
      const forward = (b.lead - prev + r.N) % r.N;
      expect(forward).toBeLessThanOrEqual(1);
      prev = b.lead;
    }
  });

  it("splits between two coincident legs with no history and resolves on direction", () => {
    // A folded route: out along the bottom edge and straight back.
    const fold: [number, number][] = [[corners[0]!.lat, corners[0]!.lon], [corners[1]!.lat, corners[1]!.lon], [corners[0]!.lat, corners[0]!.lon]];
    const stops = [1, 2];
    const r = buildRing("fold", fold, stops, COORDS)!;
    expect(r).not.toBeNull();
    // Standing mid-way with no history: both legs plausible.
    let b = stepBelief(undefined, r, bus(onLeg0(450)), 0, stops);
    const m = legMass(b, r);
    expect(m[0]).toBeGreaterThan(0.3);
    expect(m[1]).toBeGreaterThan(0.3);
    // Two fresh fixes heading back toward stop 1: the inbound leg wins.
    b = stepBelief(b, r, bus(onLeg0(415)), 5000, stops);
    b = stepBelief(b, r, bus(onLeg0(380)), 10_000, stops);
    b = stepBelief(b, r, bus(onLeg0(345)), 15_000, stops);
    expect(legMass(b, r)[1]).toBeGreaterThan(0.85);
    expect(b.lead).toBe(1);
  });
});
