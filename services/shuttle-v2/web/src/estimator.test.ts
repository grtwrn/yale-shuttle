import { describe, expect, it } from "vitest";

import { computeUpcomingArrivals } from "./arrivals";
import { mixtureQuantile, normalCdf, peekBelief, SWITCH_AT, tobitUpdate, updateBelief, type Placement } from "./estimator";
import type { AnchorStore } from "./anchorGate";
import { at, makeBus, routeStops, segmentTimes, STOP, stopCoords } from "./__fixtures__/payload";

/**
 * A fold, as small as one can be and still be the real problem: out along one
 * side of a road and back along the other, 55 m apart — well inside
 * `ANCHOR_GPS_THRESHOLD_M`, so both chords are candidates, anti-parallel, so a
 * point anchor has to choose, and four positions apart in the sequence, so
 * choosing wrong is most of the loop.
 *
 *   1 --- 2 --- 3 --- 4        outbound, west to east, at lat 41.3000
 *   11 -- 13 -- 14 -- (turn)   inbound,  east to west, at lat 41.3005
 */
const OUT_LAT = 41.3;
const IN_LAT = 41.3005;
const foldStops = [1, 2, 3, 4, 14, 13, 11];
const foldCoords: Record<number, { lat: number; lon: number }> = {
  1: { lat: OUT_LAT, lon: -72.94 },
  2: { lat: OUT_LAT, lon: -72.935 },
  3: { lat: OUT_LAT, lon: -72.93 },
  4: { lat: OUT_LAT, lon: -72.925 },
  14: { lat: IN_LAT, lon: -72.93 },
  13: { lat: IN_LAT, lon: -72.935 },
  11: { lat: IN_LAT, lon: -72.94 },
};
/** Leg 1 is 2 -> 3 (east, outbound); leg 4 is 14 -> 13 (west, inbound). */
const LEG_OUT = 1;
const LEG_IN = 4;

const shippedAt = (idx: number): Placement => ({
  idx, standingSec: null, stallCredit: 0, progressFactor: 1, weight: 1, lead: true,
});

const poll = (
  store: object,
  bus: { lat: number; lon: number; last_stop_id?: number | null },
  now: number,
  shippedIdx: number,
  stops: number[] = foldStops,
  coords: Record<number, { lat: number; lon: number }> = foldCoords,
) => updateBelief(store, "fold|#1", bus, stops, coords, now, shippedAt(shippedIdx), null);

const weightOf = (ps: Placement[], leg: number) =>
  ps.filter((p) => p.idx === leg).reduce((n, p) => n + p.weight, 0);

const T0 = new Date("2026-09-03T18:00:00Z").getTime();

describe("the branch posterior", () => {
  it("a stationary bus on a shared segment with no history is ~50/50, and says so", () => {
    // Midway along the shared stretch, equidistant from the chord out and the
    // chord back. This is the case docs/eta-estimator-design.md says is not
    // identifiable: the correct answer is two hypotheses, not a tie-break.
    const store = new Map();
    const bus = { lat: (OUT_LAT + IN_LAT) / 2, lon: -72.9325 };
    const ps = poll(store, bus, T0, LEG_OUT);
    expect(ps.length).toBe(2);
    expect(weightOf(ps, LEG_OUT)).toBeGreaterThan(0.35);
    expect(weightOf(ps, LEG_OUT)).toBeLessThan(0.65);
    expect(weightOf(ps, LEG_IN)).toBeGreaterThan(0.35);
  });

  it("two chords leaving the SAME repeated stop tie at forward-distance 0, and the belief keeps both", () => {
    // Stop 3 is VISITED TWICE: [1, 2, 3, 4, 3, 13, 11]. A bus sitting at it is
    // on the chord out of the first occurrence or the chord out of the second,
    // and the two leave the same point — an occurrence-aware POINT anchor ties
    // at forward-distance 0 and is settled by centimetres of rounding. That
    // tie is the argument for a belief, in one fixture.
    const stops = [1, 2, 3, 4, 3, 13, 11];
    const store = new Map();
    const ps = poll(store, { lat: OUT_LAT + 0.000_002, lon: -72.93 }, T0, 2, stops, foldCoords);
    const legs = [...new Set(ps.map((p) => p.idx))].sort();
    expect(legs.length).toBe(2);
    expect(legs).toContain(2);
    expect(legs).toContain(4);
    expect(Math.abs(weightOf(ps, 2) - weightOf(ps, 4))).toBeLessThan(0.3);
  });

  it("a departure resolves the branch within two fresh fixes — in EITHER direction", () => {
    for (const outbound of [true, false]) {
      const store = new Map();
      const lat = (OUT_LAT + IN_LAT) / 2;
      // Cold, stationary, ambiguous.
      poll(store, { lat, lon: -72.934 }, T0, LEG_OUT);
      // Then two fixes that move — east if outbound, west if inbound. 0.0005
      // of longitude is ~42 m, past the 30 m deadband, so each is a real step.
      const dir = outbound ? +1 : -1;
      poll(store, { lat, lon: -72.934 + dir * 0.0005 }, T0 + 5_000, LEG_OUT);
      const ps = poll(store, { lat, lon: -72.934 + dir * 0.001 }, T0 + 10_000, LEG_OUT);
      const believed = outbound ? LEG_OUT : LEG_IN;
      expect(weightOf(ps, believed)).toBeGreaterThan(0.9);
    }
  });

  it("a stale last_stop_id held across a long run carries no evidence", () => {
    // The reading is applied on the poll it CHANGES and never again: a value
    // frozen at one stop for a whole 5 km run must not be counted a hundred
    // times. Held stationary so nothing else can move the weights either.
    const store = new Map();
    const bus = { lat: (OUT_LAT + IN_LAT) / 2, lon: -72.9325, last_stop_id: 1 };
    const first = poll(store, bus, T0, LEG_OUT);
    let last = first;
    for (let i = 1; i <= 100; i++) last = poll(store, bus, T0 + i * 5_000, LEG_OUT);
    // Both branches survive 100 polls of the same stale reading, and the
    // weights are where the first application left them.
    expect(last.length).toBe(2);
    expect(Math.abs(weightOf(last, LEG_OUT) - weightOf(first, LEG_OUT))).toBeLessThan(0.05);
  });

  it("never argues a geometrically possible branch to zero — the anti-lock floor", () => {
    // Drive east for a minute: the outbound chord should win overwhelmingly,
    // and the inbound one must still be alive, because 7.5% of departures were
    // a full lap wrong on filters that let a branch die.
    const store = new Map();
    const lat = (OUT_LAT + IN_LAT) / 2;
    let ps = poll(store, { lat, lon: -72.9345 }, T0, LEG_OUT);
    for (let i = 1; i <= 6; i++) {
      ps = poll(store, { lat, lon: -72.9345 + i * 0.0005 }, T0 + i * 5_000, LEG_OUT);
    }
    expect(weightOf(ps, LEG_OUT)).toBeGreaterThan(0.8);
    const alt = ps.find((p) => p.idx !== LEG_OUT);
    if (alt) expect(alt.weight).toBeGreaterThanOrEqual(0.02);
  });

  it("the number a rider reads stays on production's branch until the belief passes SWITCH_AT", () => {
    // Cold and ambiguous: the belief has one poll of evidence and no right to
    // overrule an anchor built from the same fix, so the lead is production's.
    const store = new Map();
    const lat = (OUT_LAT + IN_LAT) / 2;
    const cold = poll(store, { lat, lon: -72.934 }, T0, LEG_OUT);
    expect(cold.find((p) => p.lead)!.idx).toBe(LEG_OUT);
    // Now the bus drives WEST — the inbound chord's way, against the leg
    // production is holding. One fresh fix is ~20:1 of direction evidence, so
    // the lead moves as soon as the belief does, not on a timer.
    poll(store, { lat, lon: -72.9345 }, T0 + 5_000, LEG_OUT);
    const after = poll(store, { lat, lon: -72.935 }, T0 + 10_000, LEG_OUT);
    expect(after.find((p) => p.lead)!.idx).toBe(LEG_IN);
    expect(weightOf(after, LEG_IN)).toBeGreaterThanOrEqual(SWITCH_AT);
  });

  it("does not hand the lead to a branch the evidence merely prefers", () => {
    // A single ambiguous poll after a cold start moves the weights a little.
    // A little is not SWITCH_AT, and the countdown does not move a lap on it.
    const store = new Map();
    const lat = (OUT_LAT + IN_LAT) / 2;
    poll(store, { lat, lon: -72.9325 }, T0, LEG_OUT);
    const next = poll(store, { lat, lon: -72.9325 }, T0 + 5_000, LEG_OUT);
    expect(next.find((p) => p.lead)!.idx).toBe(LEG_OUT);
  });

  it("the shipped placement is always in the mixture, whatever the belief thinks", () => {
    const store = new Map();
    const lat = (OUT_LAT + IN_LAT) / 2;
    for (let i = 0; i <= 6; i++) poll(store, { lat, lon: -72.9345 + i * 0.0005 }, T0 + i * 5_000, LEG_OUT);
    // Production says leg 0 — a leg the belief has no time for. It is still
    // priced, because this module may only ever ADD alternatives.
    const ps = poll(store, { lat, lon: -72.921 }, T0 + 70_000, 0);
    expect(ps.some((p) => p.idx === 0)).toBe(true);
  });
});

describe("the censored (Tobit) update", () => {
  it("a repeated fix is evidence FOR standing and against running", () => {
    // 20 s since the last fresh fix. Standing predicts no displacement and
    // explains "under 30 m" easily; running at 7 m/s predicts 140 m and cannot.
    const standing = { s: 0, v: 0, p: [4, 0, 1] as [number, number, number] };
    const running = { s: 140, v: 7, p: [400, 20, 4] as [number, number, number] };
    const a = tobitUpdate(standing, 0);
    const b = tobitUpdate(running, 0);
    expect(a.like).toBeGreaterThan(0.9);
    expect(b.like).toBeLessThan(0.01);
    // ...and it pulls the running hypothesis BACK towards the deadband rather
    // than letting it keep converging forward. That is the opposite of an EMA,
    // which manufactures motion on polls that carry no observation.
    expect(b.g.s).toBeLessThan(running.s);
  });

  it("does not move a state that already agrees with the censoring", () => {
    const standing = { s: 3, v: 0, p: [4, 0, 1] as [number, number, number] };
    const after = tobitUpdate(standing, 0);
    expect(Math.abs(after.g.s - 3)).toBeLessThan(1);
  });
});

describe("the mixture summary", () => {
  it("one component is that component's own quantile", () => {
    expect(mixtureQuantile([{ mu: 300, sigma: 60, w: 1 }], 0.5)).toBeCloseTo(300, 3);
  });

  it("moves continuously in the weight instead of flipping between modes", () => {
    // Two branches 20 minutes apart. As the belief slides from one to the
    // other the reported median slides with it — no point in the sweep moves
    // by more than the gap itself, and the ends are the two modes.
    const near = { mu: 120, sigma: 40 };
    const far = { mu: 1500, sigma: 200 };
    const at = (w: number) => mixtureQuantile([{ ...near, w }, { ...far, w: 1 - w }], 0.5);
    expect(at(1)).toBeCloseTo(120, 0);
    expect(at(0)).toBeCloseTo(1500, 0);
    const xs = [];
    for (let w = 0; w <= 1.0001; w += 0.05) xs.push(at(w));
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]! + 1e-6);
    // At 50/50 it is neither mode: it sits past the near branch's own tail,
    // which is the only honest scalar for a bimodal belief.
    expect(at(0.5)).toBeGreaterThan(near.mu + 2 * near.sigma);
    expect(at(0.5)).toBeLessThan(far.mu);
  });

  it("normalCdf is accurate enough to be used as a likelihood", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
});

describe("computeUpcomingArrivals with a store", () => {
  const NOW = new Date("2026-08-31T20:30:00Z").getTime();

  it("is byte-identical to the storeless client when nothing disputes the anchor", () => {
    // Blue Day is a plain loop: one candidate leg, one hypothesis, and the
    // belief hands production's placement straight back. Anything else here
    // would mean the estimator had quietly changed every rider's number.
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const targets = [STOP.cedar333, STOP.york129, STOP.elmYork];
    const pure = computeUpcomingArrivals(targets, [bus], routeStops, stopCoords, segmentTimes, NOW);
    const store: AnchorStore = new Map();
    const gated = computeUpcomingArrivals(targets, [bus], routeStops, stopCoords, segmentTimes, NOW, {}, store);
    expect(gated).toEqual(pure);
  });

  it("records a belief per bus that a replay can read back", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const store: AnchorStore = new Map();
    computeUpcomingArrivals([STOP.cedar333], [bus], routeStops, stopCoords, segmentTimes, NOW, {}, store);
    const belief = peekBelief(store, `Blue Day|${bus.bus_name}`);
    expect(belief).not.toBeNull();
    expect(belief!.length).toBeGreaterThan(0);
    expect(belief!.reduce((n, b) => n + b.w, 0)).toBeCloseTo(1, 6);
  });
});
