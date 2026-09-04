import { describe, expect, it } from "vitest";

import { findRouteAnchor, type RingPrior } from "./anchor";
import { ANCHOR_FEED_MOVE_M, gateAnchor, noteFix, ringPrior, type AnchorStore } from "./anchorGate";
import type { LatLon } from "./geo";
import {
  hopLength, occurrenceForward, reachableHops, RING_MAX_SPEED_M_S, ringForward, ringGap,
  travelBudgetM,
} from "./ring";

const LAT = 41.3;
const LON = -72.93;
/**
 * Metres per degree of longitude at this latitude, calibrated so a metre in the
 * fixtures below really is a metre under the same haversine the app uses.
 */
const M_PER_DEG_LON = 83_536.7;
const M_PER_DEG_LAT = 111_000;
const pt = (east: number, north: number): LatLon =>
  ({ lat: LAT + north / M_PER_DEG_LAT, lon: LON + east / M_PER_DEG_LON });

// --- fixture A: a plain loop -------------------------------------------------
//
// Six stops on a circle of radius 400 m, so every chord is exactly 400 m and no
// two legs are anti-parallel. This is the shape of thirteen of the fifteen
// routes, Red included, and it is where the ring window is served.

const LOOP = [11, 12, 13, 14, 15, 16];
const LOOP_N = LOOP.length;
const R = 400;
const vertex = (k: number): LatLon => {
  const a = (k * Math.PI) / 3;
  return pt(R * Math.cos(a), R * Math.sin(a));
};
const LOOP_COORDS: Record<number, LatLon> = Object.fromEntries(
  LOOP.map((id, k) => [id, vertex(k)]),
);
/** `f` of the way along leg `k`, measured on the chord the anchor uses. */
const alongLoop = (k: number, f: number): LatLon => {
  const a = vertex(k), b = vertex((k + 1) % LOOP_N);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
};

// --- fixture B: an out-and-back ----------------------------------------------
//
// The pathology the payload fixture does not contain. Routes 9 and 10 run out
// to West Campus and back along the same road, so ONE stop id occupies TWO
// sequence positions and two legs are the same endpoints in opposite orders:
//
//   position   0     1     2     3     4     5
//   stop id    1     2     3     4     3     2      (and back to 1)
//   metres     0   400   800  1200   800   400
//
// `stops.indexOf(3)` answers 2 for both of the route's visits to it.

const FOLD = [1, 2, 3, 4, 3, 2];
const FOLD_N = FOLD.length;
const east = (x: number): LatLon => pt(x, 0);
const FOLD_COORDS: Record<number, LatLon> = { 1: east(0), 2: east(400), 3: east(800), 4: east(1200) };

const prior = (index: number, at: LatLon | null, budgetM: number): RingPrior =>
  ({ index, at, budgetM });

describe("the fixtures really do contain what they claim", () => {
  it("the loop has six equal 400 m hops and no repeated stop", () => {
    expect(new Set(LOOP).size).toBe(LOOP_N);
    for (let i = 0; i < LOOP_N; i++) {
      expect(Math.abs(hopLength(LOOP, LOOP_COORDS, i) - 400)).toBeLessThan(1);
    }
  });

  it("the fold serves one stop id at two sequence positions, and indexOf sees only the first", () => {
    expect(FOLD[2]).toBe(3);
    expect(FOLD[4]).toBe(3);
    expect(FOLD.indexOf(3)).toBe(2); // the trap
    expect(occurrenceForward(FOLD, 3, 3)).toBe(4); // the ring-aware answer
  });

  it("the fold's legs 1 and 4 are the same segment travelled opposite ways", () => {
    expect([FOLD[1], FOLD[2]]).toEqual([2, 3]);
    expect([FOLD[4], FOLD[5]]).toEqual([3, 2]);
  });
});

describe("ring arithmetic", () => {
  it("reads any change as the smallest forward delta", () => {
    expect(ringForward(0, 1, 6)).toBe(1);
    // "backwards by one" IS "forwards by five" — there is no other reading.
    expect(ringForward(1, 0, 6)).toBe(5);
    expect(ringForward(3, 3, 6)).toBe(0);
    expect(ringGap(1, 0, 6)).toBe(1);
  });

  it("occurrenceForward degrades to indexOf with no prior", () => {
    expect(occurrenceForward(FOLD, 3, -1)).toBe(FOLD.indexOf(3));
    expect(occurrenceForward(FOLD, 99, 0)).toBe(-1);
  });

  it("measures the window from where the bus was ON its leg, not from the stop behind it", () => {
    // At the very start of a leg, the next slot is a whole 400 m hop away.
    expect(reachableHops(LOOP, LOOP_COORDS, 1, vertex(1), 100)).toBe(0);
    // Three-quarters of the way along it, only 100 m is left to run.
    expect(reachableHops(LOOP, LOOP_COORDS, 1, alongLoop(1, 0.75), 120)).toBe(1);
    expect(reachableHops(LOOP, LOOP_COORDS, 1, alongLoop(1, 0.75), 80)).toBe(0);
    // With no remembered position we must assume the worst — the stop behind.
    expect(reachableHops(LOOP, LOOP_COORDS, 1, null, 100)).toBe(0);
  });

  it("spends observed road, not elapsed time", () => {
    // A bus standing still reports the same coordinate, so it accrues nothing
    // but the deadband however long it stands.
    expect(travelBudgetM(0, 600_000, ANCHOR_FEED_MOVE_M)).toBe(ANCHOR_FEED_MOVE_M);
    // And the clock is still the ceiling, so one long step across a feed gap
    // cannot buy an unbounded window.
    expect(travelBudgetM(10_000, 5_000, ANCHOR_FEED_MOVE_M))
      .toBe(5 * RING_MAX_SPEED_M_S + ANCHOR_FEED_MOVE_M);
  });
});

describe("a departure lands in the same poll", () => {
  // The operator's rule, absolute: "it can go 5->1 if it leaves early. but if
  // it is jitter we need a fix."
  //
  // A bus 40 m past stop 12 is 0 m from the leg it is now on and 40 m from the
  // one it just left, so both are candidates every poll. What separates them is
  // whether the ground the bus has covered can account for the move.
  const justLeft = alongLoop(1, 0.1); // 40 m along leg 1

  it("advances on the poll whose step covers the hop, not later", () => {
    // Accepted at the START of leg 0, 400 m of hop still to run: nothing yet.
    const early = findRouteAnchor(
      { ...justLeft }, [...LOOP], LOOP_COORDS, null, prior(0, vertex(0), 100),
    );
    expect(early).toBe(0);

    // Accepted at the same place, but the bus has since reported 410 m of road.
    const arrived = findRouteAnchor(
      { ...justLeft }, [...LOOP], LOOP_COORDS, null, prior(0, vertex(0), 410),
    );
    expect(arrived).toBe(1);
  });

  it("at_stop_id still advances it one slot in the poll it appears", () => {
    const atStop = { ...vertex(1), at_stop_id: 12 };
    const idx = findRouteAnchor(
      atStop, [...LOOP], LOOP_COORDS, null, prior(0, vertex(0), ANCHOR_FEED_MOVE_M),
    );
    expect(idx).toBe(1);
    expect(ringForward(0, idx, LOOP_N)).toBe(1);
  });

  it("but a step too short to cover the ground opens no window at all", () => {
    expect(reachableHops(LOOP, LOOP_COORDS, 1, alongLoop(1, 0.8), 10 + ANCHOR_FEED_MOVE_M)).toBe(0);
  });
});

describe("a stale last_stop_id cannot pull the anchor backwards", () => {
  // Red #316, 2026-09-04: the bus stood ~8 min at 344 Winchester with
  // `last_stop_id` frozen ten stops back, and the stateless chooser ranks
  // candidates by forward distance FROM THAT STALE VALUE — so the chord it had
  // arrived on kept outranking the chord it was leaving on. The gate then
  // refused the retreat for 46 s, straddling the departure.
  const justLeft = { ...alongLoop(1, 0.1), last_stop_id: 11 };

  it("the stale value really does pull the stateless answer back a slot", () => {
    // Documenting the behaviour the prior exists to replace, not endorsing it.
    expect(findRouteAnchor(justLeft, [...LOOP], LOOP_COORDS)).toBe(0);
  });

  it("with a prior the anchor keeps the slot it is on", () => {
    const idx = findRouteAnchor(
      justLeft, [...LOOP], LOOP_COORDS, null, prior(1, alongLoop(1, 0.1), ANCHOR_FEED_MOVE_M),
    );
    expect(idx).toBe(1);
  });

  it("and holds it across a long run of stale readings", () => {
    for (let k = 1; k <= 12; k++) {
      const f = 0.1 + k * 0.05;
      const idx = findRouteAnchor(
        { ...alongLoop(1, f), last_stop_id: 11 }, [...LOOP], LOOP_COORDS, null,
        prior(1, alongLoop(1, 0.1), k * 20 + ANCHOR_FEED_MOVE_M),
      );
      expect(ringForward(1, idx, LOOP_N)).toBeLessThanOrEqual(1);
    }
  });
});

describe("a bus motionless at a stop for ten minutes", () => {
  it("accrues no window, and moves nowhere, until it actually moves", () => {
    const store: AnchorStore = new Map();
    const key = "Loop|#316";
    const parked = { ...alongLoop(1, 0.05), at_stop_id: 12, last_stop_id: 11 };
    let now = 1_000_000;

    noteFix(store, key, parked, now);
    let idx = gateAnchor(
      store, key,
      findRouteAnchor(parked, [...LOOP], LOOP_COORDS, null, ringPrior(store, key, now)),
      parked, now, LOOP_N,
    ).index;
    const settled = idx;

    // Ten minutes of the feed repeating one coordinate — 53.6% of consecutive
    // samples are byte-identical, and a standing bus is the extreme of that.
    for (let poll = 0; poll < 120; poll++) {
      now += 5_000;
      noteFix(store, key, parked, now);
      const p = ringPrior(store, key, now);
      // The budget never grows past one deadband: no distinct fix, no road.
      expect(p.budgetM).toBe(ANCHOR_FEED_MOVE_M);
      idx = gateAnchor(
        store, key,
        findRouteAnchor(parked, [...LOOP], LOOP_COORDS, null, p), parked, now, LOOP_N,
      ).index;
      expect(idx).toBe(settled);
    }
    expect(store.get(key)!.pathM).toBe(0);

    // Then it pulls out and drives the hop. The anchor follows as soon as the
    // ground it has covered accounts for the move — nothing to corroborate,
    // no timeout to wait for.
    let peakBudget = 0;
    for (let poll = 1; poll <= 12; poll++) {
      now += 5_000;
      const f = 0.05 + poll * 0.09;
      const moving = { ...alongLoop(1, Math.min(f, 1.05)), last_stop_id: 12 };
      noteFix(store, key, moving, now);
      const p = ringPrior(store, key, now);
      peakBudget = Math.max(peakBudget, p.budgetM);
      idx = gateAnchor(
        store, key,
        findRouteAnchor(moving, [...LOOP], LOOP_COORDS, null, p), moving, now, LOOP_N,
      ).index;
    }
    // The road it drove is what bought the move.
    expect(peakBudget).toBeGreaterThan(300);
    expect(idx).not.toBe(settled);
    expect(ringForward(settled, idx, LOOP_N)).toBeLessThanOrEqual(2);
  });
});

describe("a shared-segment cold start is not guessed", () => {
  it("with no history the answer is exactly the stateless one", () => {
    const bus = { ...alongLoop(1, 0.4) };
    const stateless = findRouteAnchor(bus, [...LOOP], LOOP_COORDS);
    expect(findRouteAnchor(bus, [...LOOP], LOOP_COORDS, null, null)).toBe(stateless);
    expect(findRouteAnchor(bus, [...LOOP], LOOP_COORDS, null, prior(-1, null, 0))).toBe(stateless);
  });

  it("and a prior whose window admits nothing plausible falls back to it too", () => {
    // Narrowing must not invent an answer. The gate is what holds the line, and
    // its timeout is still the release valve for a prior that has gone wrong.
    const bus = { ...alongLoop(4, 0.5) };
    const stateless = findRouteAnchor(bus, [...LOOP], LOOP_COORDS);
    expect(findRouteAnchor(bus, [...LOOP], LOOP_COORDS, null, prior(0, vertex(0), 10)))
      .toBe(stateless);
  });
});

describe("an out-and-back keeps master's behaviour, byte for byte", () => {
  // The centimetre tie: a bus halfway between stops 2 and 3 is exactly 0 m from
  // leg 1 AND exactly 0 m from leg 4 — the same road, travelled opposite ways.
  // A prior can separate them, and MEASURABLY SHOULD NOT: served on the folds
  // it commits to a branch and reinforces itself (Purple's lap-re-priced share
  // went 10.1 -> 14.6% on the rider simulator). Their half of the ambiguity
  // needs a distribution, not a better point.
  const midway = { ...east(600) };

  it("the two legs really are tied", () => {
    expect([1, 4]).toContain(findRouteAnchor(midway, [...FOLD], FOLD_COORDS));
  });

  it("a prior does not move the answer on a route that repeats a stop", () => {
    const stateless = findRouteAnchor(midway, [...FOLD], FOLD_COORDS);
    for (const p of [prior(4, east(640), 70), prior(1, east(560), 70), prior(2, east(800), 400)]) {
      expect(findRouteAnchor(midway, [...FOLD], FOLD_COORDS, null, p)).toBe(stateless);
    }
  });

  it("nor on any other reading of a folded route", () => {
    const cases = [
      { ...east(830), last_stop_id: 1 },
      { ...east(405), last_stop_id: 3 },
      { ...east(1195), at_stop_id: 4 },
    ];
    for (const bus of cases) {
      const stateless = findRouteAnchor(bus, [...FOLD], FOLD_COORDS);
      const withPrior = findRouteAnchor(
        bus, [...FOLD], FOLD_COORDS, null, prior(3, east(1100), 200),
      );
      expect(withPrior).toBe(stateless);
    }
  });
});
