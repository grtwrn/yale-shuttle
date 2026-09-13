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

  it("moves the measured share of a kerb shuffle into MOVE, not the beyond-rest share", () => {
    // No stand table on this stop, so the fallback prior decides. The arms do
    // NOT land on the bare ratio of the two priors (0.44): the moving mass
    // also holds what was already moving, the hold leak and the move kernel,
    // and the position emission renormalises over all of it. Measured in this
    // harness the shuffle keeps a quarter of the departure mass at the kerb.
    const off = afterOneFreshFix({ standSec: 60, stepM: 32 });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 60, stepM: 32 });
    expect(on.moving).toBeLessThan(off.moving);
    expect(on.moving / off.moving).toBeGreaterThan(0.6);
    expect(on.moving / off.moving).toBeLessThan(0.85);
  });

  it("halves the departure mass a 32 m shuffle takes off a LAYOVER stand", () => {
    // The dominant path in production: the stop has a table, so the hazard
    // competes against the reposition rate. Instrumented on the 9/10 replay
    // the standing mass's mean pDepart at a layover was 0.61 against a
    // measured 0.17, and the rate is what corrects it.
    const off = afterOneFreshFix({ standSec: 300, stepM: 32, table: true });
    setKerbShuffleEvidence(true);
    const on = afterOneFreshFix({ standSec: 300, stepM: 32, table: true });
    expect(on.moving).toBeLessThan(off.moving * 0.75);
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
