import { afterEach, describe, expect, it } from "vitest";
import { buildRing, type Ring } from "./ring";
import { fromQuantiles } from "./dist";
import {
  P_DEPART_ON_FRESH,
  P_DEPART_ON_FRESH_IN_REST,
  REST_RADIUS_M,
  SHUFFLE_PER_POLL,
  SHUFFLE_PER_POLL_IN_REST,
  kerbShuffleEvidenceOn,
  setKerbShuffleEvidence,
  stepBelief,
  type Belief,
} from "./filter";
import type { LatLon } from "../geo";

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
/** Standing mass inside the rest's own extent — what the rule is about. */
function standInRest(b: Belief, r: Ring): number {
  let s = 0;
  for (let c = 0; c < r.C; c++) if (b.restMask[c] === 1) s += b.p[c]!;
  return s;
}

/**
 * A bus standing at `restM` along leg 0 for `standSec`, then one fresh fix
 * `stepM` further along it.
 */
function afterOneFreshFix(opts: { standSec: number; stepM: number; table?: boolean; restM?: number }): { moving: number; b: Belief; r: Ring } {
  const r = ring();
  if (opts.table) {
    // 344 Winchester's own served stand table (filter.test.ts uses the same row).
    r.stand[0] = fromQuantiles([83, 129, 145, 191, 288, 333, 437, 473, 543, 674]);
    r.layover[0] = 1;
  }
  const restM = opts.restM ?? 0;
  const t0 = 600_000;
  const since = new Date(t0 - opts.standSec * 1000).toISOString();
  let b = stepBelief(undefined, r, bus(onLeg0(restM), since), t0, STOPS);
  for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(restM), since), t0 + t * 5000, STOPS);
  b = stepBelief(b, r, bus(onLeg0(restM + opts.stepM), since), t0 + 35_000, STOPS);
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
    // hold. The RULE is not this rate (a flat rate was measured and refused,
    // PR #246); these two numbers are the evidence it rests on and are kept as
    // the record of it.
    expect(P_DEPART_ON_FRESH_IN_REST).toBeLessThan(P_DEPART_ON_FRESH);
    expect(SHUFFLE_PER_POLL_IN_REST).toBeGreaterThan(SHUFFLE_PER_POLL);
    expect(P_DEPART_ON_FRESH_IN_REST).toBeCloseTo(0.335, 3);
    expect(SHUFFLE_PER_POLL_IN_REST).toBeCloseTo(0.117, 3);
  });

  it("keeps the standing mass inside the rest on an in-rest fresh fix", () => {
    // The defect: a 32 m kerb shuffle is inside the rest radius, and the
    // departure kernel walked most of the stand out of it anyway. With the
    // rule, no standing mass leaves the rest's extent on such a fix.
    const off = afterOneFreshFix({ standSec: 300, stepM: 32, table: true });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 300, stepM: 32, table: true });
    // Master walks the MAJORITY of the stand into MOVE on that one fix
    // (measured in this harness: 0.617 moving, 0.383 still standing in the
    // rest). With the rule the majority stays in the rest: 0.320 / 0.680.
    expect(off.moving).toBeGreaterThan(0.5);
    expect(standInRest(off.b, off.r)).toBeLessThan(0.5);
    expect(on.moving).toBeLessThan(0.45);
    expect(standInRest(on.b, on.r)).toBeGreaterThan(0.6);
    expect(standInRest(on.b, on.r)).toBeGreaterThan(1.5 * standInRest(off.b, off.r));
    // The mass the rule keeps is standing IN THE REST, not standing anywhere:
    // everything that did not leave is inside the mask.
    expect(standInRest(on.b, on.r)).toBeGreaterThan(0.97 * (1 - on.moving));
    // It is not absolutist either — the moving hypothesis still explains a
    // 32 m step better than a reposition does, and keeps a third of the mass.
  });

  it("still lets a bus with no table depart normally once it is beyond the rest", () => {
    // 300 m along the leg is past REST_RADIUS_M: the bus really has gone, the
    // measured departure share there is 74.2%, and the pooled constants
    // already say so. Both arms must be bit-identical.
    const off = afterOneFreshFix({ standSec: 300, stepM: 300, table: true });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 300, stepM: 300, table: true });
    expect(300).toBeGreaterThan(REST_RADIUS_M);
    expect(Array.from(on.b.p)).toEqual(Array.from(off.b.p));
    // The rest is over on that poll: `moved` drops its identity and the mass is
    // released (0.442 moving in both arms). `rested` itself can come straight
    // back in this harness because the served clock is frozen at 300 s old and
    // keeps claiming a stand at the NEW point — in production the collector
    // restarts that clock on its own 125 m rule.
    expect(on.b.restStop).toBe(-1);
    expect(on.moving).toBeGreaterThan(0.4);
  });

  it("releases the mass on the FIRST poll beyond the radius, after a held shuffle", () => {
    // The bound the two rate-based forms broke: a real departure is never
    // delayed past the rest, because the fix beyond the radius ends the rest by
    // construction. Shuffle first (held), then leave.
    const t0 = 600_000;
    const since = new Date(t0 - 300_000).toISOString();
    const run = (on: boolean) => {
      setKerbShuffleEvidence(on);
      const r = ring();
      r.stand[0] = fromQuantiles([83, 129, 145, 191, 288, 333, 437, 473, 543, 674]);
      r.layover[0] = 1;
      let b = stepBelief(undefined, r, bus(onLeg0(0), since), t0, STOPS);
      for (let t = 1; t <= 6; t++) b = stepBelief(b, r, bus(onLeg0(0), since), t0 + t * 5000, STOPS);
      b = stepBelief(b, r, bus(onLeg0(32), since), t0 + 35_000, STOPS);   // the shuffle
      const held = { moving: 1 - standMass(b, r), restStop: b.restStop };
      b = stepBelief(b, r, bus(onLeg0(300), since), t0 + 40_000, STOPS);  // gone
      return { held, gone: { moving: 1 - standMass(b, r), restStop: b.restStop } };
    };
    const a = run(false);
    const c = run(true);
    expect(c.held.moving).toBeLessThan(a.held.moving);   // the shuffle was held
    expect(c.gone.restStop).toBe(-1);                    // the rest ended on that poll
    expect(c.gone.moving).toBeGreaterThan(0.5);          // and the mass was released
    // Within a tenth of master's release on the same poll (0.711 vs 0.822): the
    // held shuffle delays nothing once the bus is beyond the radius.
    expect(c.gone.moving).toBeGreaterThan(a.gone.moving - 0.15);
  });

  it("leaves a rest the belief cannot name exactly as it was", () => {
    // Restricted to a rest with an identity, like the emission's own `held`:
    // 400 m along the leg is 400 m from stop 1 and 500 m from stop 2, so no
    // zone holds the standing mass and `restStop` is -1 — Purple's fold detour
    // is that case, and it keeps its escape hatch.
    const off = afterOneFreshFix({ standSec: 300, stepM: 32, restM: 400 });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 300, stepM: 32, restM: 400 });
    expect(off.b.restStop).toBe(-1);
    expect(Array.from(on.b.p)).toEqual(Array.from(off.b.p));
  });

  it("does not reach a bus that was never at rest", () => {
    // No served clock, so the belief never called it standing: a moving bus's
    // fresh fix is priced identically in both arms.
    const t0 = 600_000;
    const run = (on: boolean) => {
      setKerbShuffleEvidence(on);
      const r = ring();
      let b = stepBelief(undefined, r, { lat: onLeg0(0).lat, lon: onLeg0(0).lon }, t0, STOPS);
      b = stepBelief(b, r, { lat: onLeg0(40).lat, lon: onLeg0(40).lon }, t0 + 5_000, STOPS);
      b = stepBelief(b, r, { lat: onLeg0(80).lat, lon: onLeg0(80).lon }, t0 + 10_000, STOPS);
      return Array.from(b.p);
    };
    expect(run(true)).toEqual(run(false));
  });
});
