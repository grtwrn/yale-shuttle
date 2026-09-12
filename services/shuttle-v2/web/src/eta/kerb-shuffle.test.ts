import { afterEach, describe, expect, it } from "vitest";
import { buildRing, type Ring } from "./ring";
import { fromQuantiles } from "./dist";
import {
  P_DEPART_ON_FRESH,
  P_DEPART_ON_FRESH_IN_REST,
  SHUFFLE_PER_POLL,
  SHUFFLE_PER_POLL_IN_REST,
  kerbShuffleEvidenceOn,
  setKerbShuffleEvidence,
  stepBelief,
  type Belief,
} from "./filter";
import { haversineMeters, type LatLon } from "../geo";

// filter.test.ts's loop: four stops at the corners of a ~900 x 450 m block.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
function at(xm: number, ym: number): LatLon { return { lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon }; }
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);
function ring(): Ring {
  const r = buildRing("kerb", PATH, STOPS, COORDS);
  if (!r) throw new Error("ring");
  return r;
}
function onLeg0(xm: number): LatLon { return at(xm, 0); }
function bus(pos: LatLon, since: string) { return { lat: pos.lat, lon: pos.lon, stationary_since: since }; }
function standMass(b: Belief, r: Ring): number { let s = 0; for (let c = 0; c < r.C; c++) s += b.p[c]!; return s; }

/**
 * A bus standing at stop 1 for `standSec`, then the given steps in metres
 * along leg 0 (one poll each, 5 s apart): 0 repeats the fix, anything else is
 * a fresh one. Returns the belief after each step.
 */
function afterSteps(opts: { standSec: number; steps: number[]; table?: boolean }): { r: Ring; each: Belief[] } {
  const r = ring();
  if (opts.table) {
    r.stand[0] = fromQuantiles([83, 129, 145, 191, 288, 333, 437, 473, 543, 674]);
    r.layover[0] = 1;
  }
  const t0 = 600_000;
  const since = new Date(t0 - opts.standSec * 1000).toISOString();
  let b = stepBelief(undefined, r, bus(onLeg0(0), since), t0, STOPS);
  for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), since), t0 + t * 5000, STOPS);
  const each: Belief[] = [];
  let x = 0;
  for (let i = 0; i < opts.steps.length; i++) {
    x += opts.steps[i]!;
    b = stepBelief(b, r, bus(onLeg0(x), since), t0 + (7 + i) * 5000, STOPS);
    each.push(b);
  }
  return { r, each };
}

/** A bus standing at stop 1 for `standSec`, then one fresh fix `stepM` along the leg. */
function afterOneFreshFix(opts: { standSec: number; stepM: number; table?: boolean }): { moving: number; b: Belief; r: Ring } {
  const r = ring();
  if (opts.table) {
    // 344 Winchester's own served stand table (filter.test.ts uses the same row).
    r.stand[0] = fromQuantiles([83, 129, 145, 191, 288, 333, 437, 473, 543, 674]);
    r.layover[0] = 1;
  }
  const t0 = 600_000;
  const since = new Date(t0 - opts.standSec * 1000).toISOString();
  let b = stepBelief(undefined, r, bus(onLeg0(0), since), t0, STOPS);
  for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), since), t0 + t * 5000, STOPS);
  b = stepBelief(b, r, bus(onLeg0(opts.stepM), since), t0 + 35_000, STOPS);
  return { moving: 1 - standMass(b, r), b, r };
}

afterEach(() => setKerbShuffleEvidence(false));

describe("the kerb shuffle as departure evidence", () => {
  it("is off by default, so every other caller prices exactly as before", () => {
    expect(kerbShuffleEvidenceOn()).toBe(false);
  });

  it("carries the measured in-rest pair: weaker departure evidence, a higher reposition rate", () => {
    // Measured over 2026-09-03..09-09 against the detector's own departure
    // instants (filter.ts records the counts): P(departure | fresh fix still
    // inside the rest radius) is 33.5% pooled over Red and Blue Day, against
    // 74.2% for a fix beyond it — which is what the pooled constants already
    // hold. So the in-rest number must be the LOWER of the two, and the
    // in-rest reposition rate the HIGHER.
    expect(P_DEPART_ON_FRESH_IN_REST).toBeLessThan(P_DEPART_ON_FRESH);
    expect(SHUFFLE_PER_POLL_IN_REST).toBeGreaterThan(SHUFFLE_PER_POLL);
    expect(P_DEPART_ON_FRESH_IN_REST).toBeCloseTo(0.335, 3);
    expect(SHUFFLE_PER_POLL_IN_REST).toBeCloseTo(0.117, 3);
  });

  it("keeps standing mass off a SECOND kerb shuffle, where the fallback prior decides", () => {
    // No stand table on this stop, so the fallback prior decides. The first
    // fresh fix is deliberately unconditioned, and by then the position
    // emission and the pooled prior have already taken most of the stand:
    // moving mass 0.7654 after fix 1 in both arms, so what is left for the
    // second fix to keep is small — 0.9153 -> 0.9081 moving, i.e. standing
    // 0.0847 -> 0.0919, measured in this harness. Direction, not magnitude, is
    // what this pins; the magnitude is the finding in the PR.
    setKerbShuffleEvidence(false);
    const off = afterSteps({ standSec: 60, steps: [32, 25] });
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 60, steps: [32, 25] });
    const moving = (b: Belief, r: Ring) => { let s = 0; for (let c = 0; c < r.C; c++) s += b.p[c]!; return 1 - s; };
    expect(moving(on.each[1]!, on.r)).toBeLessThan(moving(off.each[1]!, off.r));
    expect(moving(on.each[1]!, on.r) / moving(off.each[1]!, off.r)).toBeGreaterThan(0.95);
  });

  it("does the same on a LAYOVER stand, where the served hazard competes with the reposition rate", () => {
    // The dominant path in production: the stop has a table, so the hazard
    // competes against the reposition rate. Same shape, same size (0.8956 ->
    // 0.8889 moving on the second fix) — and the same reason it is small: the
    // first fix, which this rule exempts to keep the departure's collapse,
    // is the one that empties the stand (0.6173 moving on both arms).
    setKerbShuffleEvidence(false);
    const off = afterSteps({ standSec: 300, steps: [32, 25], table: true });
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32, 25], table: true });
    const moving = (b: Belief, r: Ring) => { let s = 0; for (let c = 0; c < r.C; c++) s += b.p[c]!; return 1 - s; };
    expect(moving(on.each[1]!, on.r)).toBeLessThan(moving(off.each[1]!, off.r));
  });

  it("leaves a fix that has LEFT the rest radius exactly as it was", () => {
    // 300 m along the leg is past REST_RADIUS_M: the bus really has gone, the
    // measured departure share there is 74.2%, and the pooled constants
    // already say so. Both arms must be bit-identical.
    const off = afterOneFreshFix({ standSec: 300, stepM: 300, table: true });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 300, stepM: 300, table: true });
    expect(Array.from(on.b.p)).toEqual(Array.from(off.b.p));
  });
});

describe("the in-rest rates apply from the SECOND consecutive fresh fix, never the first", () => {
  // A bus that really pulled out publishes a first fresh fix inside the rest
  // radius too — its first step off a stand is 30-35 m, the same as a
  // shuffle's (docs/departure-derivation.md) — so conditioning that fix is
  // what withheld a real 5 -> 1 collapse for two polls and failed
  // accuracy-layover.test.ts. By its SECOND fresh fix a departing bus is
  // beyond REST_RADIUS_M (125 m) and a shuffling one is not, so that is where
  // the measured in-rest evidence is charged.

  it("prices the first in-rest fresh fix of a rest exactly as master does", () => {
    const off = afterSteps({ standSec: 300, steps: [32], table: true });
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32], table: true });
    expect(Array.from(on.each[0]!.p)).toEqual(Array.from(off.each[0]!.p));
    expect(on.each[0]!.inRestFresh).toBe(1);
  });

  it("conditions the second consecutive in-rest fresh fix", () => {
    const off = afterSteps({ standSec: 300, steps: [32, 25], table: true });
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32, 25], table: true });
    const mass = (b: Belief, r: Ring) => { let s = 0; for (let c = 0; c < r.C; c++) s += b.p[c]!; return 1 - s; };
    // The first poll is identical (above); the second keeps standing mass the
    // pooled rates would have walked out of the stand.
    expect(mass(on.each[1]!, on.r)).toBeLessThan(mass(off.each[1]!, off.r));
    expect(on.each[1]!.inRestFresh).toBe(2);
  });

  it("counts over the rest's FRESH fixes: a repeated fix between two shuffles does not restart the run", () => {
    // A shuffling bus publishes one fresh fix and then repeats for polls; if a
    // repeat reset the counter, every shuffle would be a "first" and the rule
    // would be inert exactly where the trough is.
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32, 0, 0, 25], table: true });
    expect(on.each[0]!.inRestFresh).toBe(1);
    expect(on.each[1]!.inRestFresh).toBe(1);
    expect(on.each[2]!.inRestFresh).toBe(1);
    expect(on.each[3]!.inRestFresh).toBe(2);
  });

  it("resets the run on a fix beyond the rest radius, so a returning bus's first fix is unconditioned again", () => {
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32, 25, 300], table: true });
    // 357 m along the leg is past REST_RADIUS_M: the rest moves to where the
    // bus now is and the counter starts again. (`rested` is true again on the
    // same poll only because this harness serves an ancient
    // `stationary_since`; what matters is that the rest is a NEW one.)
    expect(on.each[2]!.inRestFresh).toBe(0);
    expect(haversineMeters(on.each[1]!.restPoint, on.each[2]!.restPoint)).toBeGreaterThan(100);
  });

  it("resets the run when the rest identity changes", () => {
    // The rest is re-established at the new point (`moved`), so the next fresh
    // fix there is a first one.
    setKerbShuffleEvidence(true);
    const on = afterSteps({ standSec: 300, steps: [32, 300, 0, 20], table: true });
    expect(on.each[1]!.inRestFresh).toBe(0);
    expect(on.each[2]!.rested).toBe(true);   // a repeat re-establishes the rest
    expect(on.each[2]!.inRestFresh).toBe(0);
    expect(on.each[3]!.inRestFresh).toBe(1); // first fresh fix of the NEW rest
  });
});
