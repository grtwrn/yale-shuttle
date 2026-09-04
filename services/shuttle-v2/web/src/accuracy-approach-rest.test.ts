// "this red is doing its long wait short of 344" — the operator, 2026-09-04.
//
// WHY THIS EXISTS. `accuracy-layover.test.ts` replays a bus that takes its
// layover ON the marker, which is what buses usually do. This one replays the
// two shapes that broke, both recorded from production the same afternoon: a
// bus that takes the layover SHORT of the marker, and a bus that takes it in
// an off-route car park nearby. In neither case is `at_stop_id` ever
// published, so the app believes the bus is driving.
//
// (a) **On the road, short of the marker** — Red #310, 13:28 ET. The operator
//     watched it live and called what would happen next before it did:
//
//       "It is not driving; it is doing the stand now, in the wrong place.
//        When it finally rolls the 140 m to the marker it will stop briefly or
//        not at all, the promised 6-minute stand evaporates, and the rider
//        sees the number drop several minutes at once."
//
//       13:27:38  comes to rest 147 m short of 344 Winchester, last_stop_id 27
//       13:27–13:34  79 identical fixes — 7 min 5 s at rest, going nowhere
//       13:34:58  reaches the marker
//       13:36:53  leaves — the detector logged a stand of 115 s
//
//     115 s, against a stand table whose typical hold at that stop is 269 s.
//
// (d) **In the garage lot** — Red #304, 14:06 ET, report #102 "Waiting in a
//     different lot". The bus vanished from the feed for 18 minutes, came back
//     under a NEW `bus_id`, and rested in the Science Park Garage lot: 32 m
//     from a stop of that name which is NOT on Red's sequence, 144 m from the
//     344 Winchester marker, off Red's polyline entirely. Upstream's
//     `last_stop_id` after the reissue was Union Station (N) — Red index 0,
//     seventeen hops behind the truth, i.e. garbage.
//
//     It is the same wait in a different place, and it is caught by the same
//     rule for a reason worth stating: the candidate stop comes from the GPS
//     ANCHOR, never from `last_stop_id`, so the reissue's garbage never enters
//     the decision. The lot is inside the zone (144 m < APPROACH_ZONE_M) and
//     the detector's clock carries across the shuffling (283 s), so the rest
//     reads as one wait rather than three short ones.
//
// WHAT IT PINS. The two arms below are the SAME code over the SAME recording,
// differing in one payload field: `stationary_since`, which is the whole of
// the server side of this fix. So "master" here is not a reconstruction of the
// old client — it is this client with the new signal withheld, which is
// exactly what a browser talking to an un-deployed server sees, and it must
// keep behaving as it always did.
//
// Do not loosen a bound or re-record a fixture to make a change pass. See
// `scripts/record-approach-rest.mjs` to regenerate (`BUS=#304 MIN_REST_SEC=120`
// for the garage one), and say in the PR what moved.
import { describe, expect, it } from "vitest";

import { computeUpcomingArrivals } from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { registerRoutePaths } from "./anchor";
import type { AnchorStore } from "./anchorGate";
import type { LatLon } from "./geo";
import {
  APPROACH_LAYOVER_MIN_SEC,
  APPROACH_REST_MIN_SEC,
  APPROACH_ZONE_M,
  remainingStandSec,
} from "./hopPricing";
import type { BusData } from "./map-data";

import onRoadFx from "./__fixtures__/red-approach-rest.json";
import garageFx from "./__fixtures__/red-garage-rest.json";

const ROUTE = "3";
const LAYOVER = 11; // 344 Winchester
const PREV = 27; // Canal / Munson — the stop the bus had just left

type Fixture = typeof onRoadFx;
type Position = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number; stationary_since: number; at_stop_id: number | null;
};

/**
 * Everything the assertions need for one recorded incident.
 *
 * `lateBySec` is the floor on how wrong the un-signalled client ends up at the
 * end of the rest — per fixture, because it depends on how much of the layover
 * had run by then, not on anything the estimator chooses.
 */
function incident(fx: Fixture, lateBySec: number) {
  const routeStops = fx.routeStops as Record<string, number[]>;
  const stopCoords = fx.stopCoords as unknown as Record<number, LatLon>;
  const names = fx.stopNames as unknown as Record<number, string>;
  const segmentTimes = fx.segments as unknown as SegmentTimes;
  const dwellTimes = fx.dwells as unknown as DwellTimes;
  const dwellsOf = (id: number) =>
    (fx.dwells as Record<string, Record<string, { q?: number[] }>>)[ROUTE]![String(id)]!;
  const positions = fx.positions as Position[];
  const REST_FROM = fx.approachRest.startedAt;
  const REST_TO = fx.approachRest.endedAt;

  /**
   * The LAST poll on which the payload still names 344 — the final instant of
   * the marker stand. Not the first gap in the flag: a parked bus shuffles a
   * few metres and loses `at_stop_id` for a poll while plainly still sitting
   * there, which is the case `standingAt`'s memory was built for (PR #67) and
   * must not read as a departure.
   */
  const LAST_AT_MARKER = positions
    .filter((p) => p.t > REST_TO && p.at_stop_id === LAYOVER)
    .at(-1)!.t;

  const arrivedAt = (stopId: number, after: number): number | null => {
    const v = (fx.visits as { stopId: number; arrivedAt: number | null }[])
      .find((x) => x.stopId === stopId && x.arrivedAt != null && x.arrivedAt >= after);
    return v?.arrivedAt ?? null;
  };

  /**
   * The bus exactly as `/api/buses` describes it at that instant.
   * `withSignal: false` withholds `stationary_since` and nothing else.
   */
  const busAt = (p: Position, withSignal: boolean): BusData => {
    const naive = (ms: number) => new Date(ms).toISOString().replace("Z", "");
    const b: Record<string, unknown> = {
      bus_id: 1, bus_name: fx.busName, route_id: 3,
      lat: p.lat, lon: p.lon, heading: p.heading, last_stop_id: p.last_stop_id,
    };
    // at_stop_* exist only inside AT_STOP_PIN_M, which is the entire problem.
    if (p.at_stop_id != null) {
      b.at_stop_id = p.at_stop_id;
      b.at_stop_since = naive(p.stationary_since);
    }
    if (withSignal) b.stationary_since = naive(p.stationary_since);
    return b as unknown as BusData;
  };

  /** What the board shows a rider at `stopId`, at every recorded moment. */
  const board = (stopId: number, withSignal: boolean) => {
    const store: AnchorStore = new Map();
    return positions.map((p) => {
      const a = computeUpcomingArrivals(
        [stopId], [busAt(p, withSignal)], routeStops, stopCoords,
        segmentTimes, p.t, dwellTimes, store,
      ).filter((x) => x.routeLabel === "Red");
      return { t: p.t, eta: a.length > 0 ? a[0]!.eta : null };
    });
  };

  const duringRest = <T extends { t: number }>(rows: T[]) =>
    rows.filter((r) => r.t >= REST_FROM && r.t <= REST_TO);

  return { fx, names, dwellsOf, positions, REST_FROM, REST_TO, LAST_AT_MARKER, arrivedAt, board, duringRest, lateBySec };
}

const INCIDENTS = [
  { title: "Red #310 taking its 344 Winchester layover short of the marker", ctx: incident(onRoadFx, 300) },
  { title: "Red #304 taking the same layover in the Science Park Garage lot (report #102)", ctx: incident(garageFx, 240) },
];

for (const { title, ctx } of INCIDENTS) {
  const {
    fx, names, dwellsOf, positions, REST_FROM, REST_TO, LAST_AT_MARKER,
    arrivedAt, board, duringRest, lateBySec,
  } = ctx;

  describe(title, () => {
    registerRoutePaths(null);

    it("the recording is the shape this test needs", () => {
      // A real rest, off the marker, inside the zone the client prices in.
      expect(fx.approachRest.metresShort).toBeGreaterThan(75); // past AT_STOP_PIN_M
      expect(fx.approachRest.metresShort).toBeLessThanOrEqual(APPROACH_ZONE_M);
      expect((REST_TO - REST_FROM) / 1000).toBeGreaterThan(APPROACH_REST_MIN_SEC);
      // Nothing publishes at_stop_id through the rest — that is the defect.
      expect(duringRest(positions).every((p) => p.at_stop_id == null)).toBe(true);
      // ...and the bus does reach the marker afterwards, briefly.
      expect(arrivedAt(LAYOVER, REST_TO)).toBeTruthy();

      // The stand the detector actually credited to 344 is a fraction of the
      // wait. This is what the server-side follow-up fixes; here it is the
      // evidence that the rest WAS the layover.
      const visit = (fx.visits as { stopId: number; standSec: number | null; arrivedAt: number | null }[])
        .find((v) => v.stopId === LAYOVER && v.arrivedAt != null && v.arrivedAt >= REST_TO)!;
      expect(visit.standSec!).toBeLessThan((REST_TO - REST_FROM) / 1000);

      // 344 qualifies as a layover stop; the stop the bus came FROM does not,
      // so the rule cannot fire on the approach to Canal / Munson.
      expect(remainingStandSec(dwellsOf(LAYOVER).q!, 0)).toBeGreaterThanOrEqual(APPROACH_LAYOVER_MIN_SEC);
      expect(remainingStandSec(dwellsOf(PREV).q!, 0)).toBeLessThan(APPROACH_LAYOVER_MIN_SEC);
    });

    // Winchester / Division is the first stop past the layover, Division /
    // Prospect the one after it — the chain the operator named.
    for (const target of [146, 48]) {
      describe(names[target]!, () => {
        const truth = arrivedAt(target, REST_FROM)!;
        const withSignal = board(target, true);
        const withheld = board(target, false);

        it("without the signal the board FREEZES while the bus's wait runs out", () => {
          // The defect, stated as a measurement: over the rest the bus's real
          // remaining time falls by minutes and the number does not move.
          const rows = duringRest(withheld).filter((r) => r.eta != null);
          const first = rows[0]!, last = rows.at(-1)!;
          const realFall = (last.t - first.t) / 1000;
          expect(realFall).toBeGreaterThan(180);
          const spread = Math.max(...rows.map((r) => r.eta!)) - Math.min(...rows.map((r) => r.eta!));
          expect(spread).toBeLessThan(15);
        });

        it("without the signal it ends the rest minutes LATE — the rider misses the bus", () => {
          const last = duringRest(withheld).filter((r) => r.eta != null).at(-1)!;
          const error = last.eta! - (truth - last.t) / 1000;
          // Promising a bus LATER than it comes is the direction that has a
          // rider stroll down and find it gone.
          expect(error).toBeGreaterThan(lateBySec);
        });

        it("with the signal the standing term is charged against the layover stop", () => {
          const last = duringRest(withSignal).filter((r) => r.eta != null).at(-1)!;
          const error = last.eta! - (truth - last.t) / 1000;
          expect(Math.abs(error)).toBeLessThan(120);
        });

        it("with the signal the countdown never climbs while the bus stands", () => {
          // #119's ceiling, reaching a case it could not previously see: the
          // standing term was never charged, so there was nothing to hold flat.
          //
          // The window runs from the start of the rest to the last poll the bus
          // is still at the marker, so it spans the roll-in AND the shuffles
          // that drop at_stop_id for a poll — the case `standingAt`'s memory
          // exists for. It is all one wait and must read as one.
          const rows = withSignal
            .filter((r) => r.t >= REST_FROM && r.t <= LAST_AT_MARKER && r.eta != null);
          expect(rows.length).toBeGreaterThan(40);
          for (let i = 1; i < rows.length; i++) {
            const rise = rows[i]!.eta! - rows[i - 1]!.eta!;
            expect(
              rise,
              `${new Date(rows[i]!.t).toISOString()} rose ${rise.toFixed(0)}s while the bus stood still`,
            ).toBeLessThanOrEqual(1);
          }
        });

        it("one visit, one stand: reaching the marker does not restart the wait", () => {
          // at_stop_since begins at the roll-in, minutes after the bus actually
          // stopped. Read raw it would hand the rider the whole layover a
          // second time, the number JUMPING UP at the moment the bus arrives.
          const touch = positions.find((p) => p.t > REST_TO && p.at_stop_id === LAYOVER)!;
          const i = withSignal.findIndex((r) => r.t === touch.t);
          expect(i).toBeGreaterThan(0);
          const before = withSignal[i - 1]!.eta!, after = withSignal[i]!.eta!;
          expect(
            after - before,
            `arriving at the marker moved the estimate by ${(after - before).toFixed(0)}s`,
          ).toBeLessThanOrEqual(1);
          // And the clock really did carry across. Checked at the FIRST stop
          // past the layover only: there the estimate is 344's remaining hold
          // plus one short drive, so an uncarried clock — which would re-charge
          // the typical hold from zero — cannot fit under it. Further down the
          // chain the number also carries the stands of the stops in between,
          // and the comparison stops meaning anything.
          if (target === 146) {
            expect(after).toBeLessThan(remainingStandSec(dwellsOf(LAYOVER).q!, 0));
          }
        });

        it("the departure still collapses the number on the same poll", () => {
          // The fix must not delay the honest 5 -> 1.
          const i = positions.findIndex((p) => p.t === LAST_AT_MARKER);
          const leaving = positions[i + 1]!;
          expect(leaving.at_stop_id).toBeNull();

          // Both arms leave the standing path on the very same poll: the
          // standing term is dropped the instant the bus rolls, which is what
          // keeps a genuine early departure collapsing at full speed.
          const aBefore = withSignal.find((r) => r.t === LAST_AT_MARKER)!.eta;
          const aAfter = withSignal.find((r) => r.t === leaving.t)!.eta;
          const bBefore = withheld.find((r) => r.t === LAST_AT_MARKER)!.eta;
          const bAfter = withheld.find((r) => r.t === leaving.t)!.eta;
          expect(aAfter === null).toBe(bAfter === null);
          if (aAfter != null && bAfter != null) {
            // The fix may not make the post-departure number BIGGER — that is
            // the whole content of "it does not delay the collapse". It is
            // allowed to be smaller: once the bus rolls, the standing memory
            // still covers the shuffle radius for a poll or two, and the fixed
            // arm's clock is the true one, so it can honestly be further
            // through the hold than the withheld arm believes.
            expect(
              aAfter,
              `departure poll: fixed ${aAfter.toFixed(0)}s vs withheld ${bAfter.toFixed(0)}s`,
            ).toBeLessThanOrEqual(bAfter + 1);
          }
        });
      });
    }
  });
}

describe("the garage lot is judged by the anchor, never by last_stop_id", () => {
  it("upstream's last_stop_id after the id reissue is seventeen hops wrong", () => {
    // Red #304 came back from an 18-minute feed absence under a new bus_id,
    // reporting Union Station (N) — index 0 — while it sat by 344 Winchester
    // at index 14. The rule reads the GPS anchor, so this never reaches it;
    // the assertion exists so nobody "simplifies" the candidate to
    // `last_stop_id + 1` and reintroduces the bug.
    const stops = (garageFx.routeStops as Record<string, number[]>)[ROUTE]!;
    const during = (garageFx.positions as Position[])
      .filter((p) => p.t >= garageFx.approachRest.startedAt && p.t <= garageFx.approachRest.endedAt);
    const claimed = new Set(during.map((p) => p.last_stop_id));
    // Every last_stop_id it published through the rest is nowhere near 344.
    for (const id of claimed) {
      const idx = stops.indexOf(id);
      if (idx < 0) continue; // 0 = "no stop", published on the first poll back
      expect(Math.abs(idx - stops.indexOf(LAYOVER))).toBeGreaterThan(5);
    }
  });
});
