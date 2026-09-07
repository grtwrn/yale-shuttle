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
// WHAT IT PINS, AND WHAT CHANGED ON 2026-09-07. Both recordings are now priced
// on the RING (`web/src/eta/`), because Red's published line is registered
// below. It was not, and that omission hid a rider-facing defect for three
// days: with no polyline the two recordings fell through to the legacy
// arithmetic, and CI never saw what a browser sees. Registering the line made
// four assertions fail — the belief ENDED the rest when the bus rolled the
// last 83-147 m to the marker and charged 344 Winchester's whole stand a
// second time, stepping the board UP by 185 s / 190 s (#310) and
// 154 s / 144 s (#304). Fixed in `eta/filter.ts` (the rest's identity across
// a roll-in) and pinned by "one visit, one stand" below.
//
// The two arms are the SAME code over the SAME recording, differing in one
// payload field: `stationary_since`. On the ring that field is nearly
// redundant — the rest is read off the repeated fixes — so the arms must AGREE
// to within a few seconds, and the assertions below say so. (On the legacy
// arithmetic, withholding it froze the board for the whole wait; that is what
// the retired approach zone was for, and it is not what this file measures any
// more.)
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

import incidents from "./__fixtures__/anchor-incidents.json";
import onRoadFx from "./__fixtures__/red-approach-rest.json";
import garageFx from "./__fixtures__/red-garage-rest.json";

const ROUTE = "3";
const LAYOVER = 11; // 344 Winchester
const PREV = 27; // Canal / Munson — the stop the bus had just left

/**
 * RED'S PUBLISHED LINE. A browser always has it — it arrives in the same
 * payload as the buses — so Red is priced on the ring (web/src/eta/), not by
 * the legacy arithmetic. This file used to register NO polyline, which sent
 * both recordings down the legacy path and hid the double stand from CI for
 * three days (docs/eta-ring-posterior.md, "the second stand"). The boards
 * below are built while the module loads, so this registration is too.
 */
const RED_PATH = (incidents as unknown as { routes: Record<string, { path: [number, number][] }> })
  .routes[ROUTE]!.path;
registerRoutePaths({ [ROUTE]: RED_PATH });

type Fixture = typeof onRoadFx;
type Position = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number; stationary_since: number; at_stop_id: number | null;
};

/**
 * Everything the assertions need for one recorded incident.
 *
 * `fallsBySec` is the floor on how far the board must come DOWN over the rest.
 * It is per fixture because it is a property of the recording — how much of
 * the layover ran while the bus sat short of the marker — not of anything the
 * estimator chooses. The retired approach-zone arm froze the number here; the
 * belief counts it down where the wait actually happens.
 */
function incident(fx: Fixture, fallsBySec: number) {
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

  /** The FIRST poll at the marker — the instant the roll-in completes. */
  const FIRST_AT_MARKER = positions.find((p) => p.t > REST_TO && p.at_stop_id === LAYOVER)!.t;

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

  return { fx, names, dwellsOf, positions, REST_FROM, REST_TO, FIRST_AT_MARKER, LAST_AT_MARKER, arrivedAt, board, duringRest, fallsBySec };
}

const INCIDENTS = [
  // Measured falls over the rest: #310 209 s / 202 s, #304 105 s / 102 s at
  // the two target stops. The bounds are the recordings rounded down.
  { title: "Red #310 taking its 344 Winchester layover short of the marker", ctx: incident(onRoadFx, 180) },
  { title: "Red #304 taking the same layover in the Science Park Garage lot (report #102)", ctx: incident(garageFx, 90) },
];

for (const { title, ctx } of INCIDENTS) {
  const {
    fx, names, dwellsOf, positions, REST_FROM, REST_TO, FIRST_AT_MARKER, LAST_AT_MARKER,
    arrivedAt, board, duringRest, fallsBySec,
  } = ctx;

  describe(title, () => {
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

        it("the board COUNTS DOWN across the rest — the wait is served where it happens", () => {
          // The rest is the layover, so the number must fall through it at
          // roughly the rate the clock runs. The retired approach zone froze
          // it instead (its stand was charged but never spent), and the
          // legacy arithmetic without `stationary_since` froze it too — the
          // shape this file used to pin. Neither is what the recordings show.
          const rows = duringRest(withSignal).filter((r) => r.eta != null);
          const first = rows[0]!, last = rows.at(-1)!;
          expect((last.t - first.t) / 1000).toBeGreaterThan(180);
          expect(
            first.eta! - last.eta!,
            `${names[target]}: the board moved ${(first.eta! - last.eta!).toFixed(0)}s over the rest`,
          ).toBeGreaterThan(fallsBySec);
        });

        it("withholding `stationary_since` barely changes it — the rest is read off the fixes", () => {
          // The belief calls a repeated fix a rest on its own; the server's
          // clock is read into it but is not what establishes it. So a browser
          // talking to a server that stops sending the field sees the same
          // number, which is also why this file's second arm is no longer a
          // stand-in for the old client.
          let worst = 0, at = 0;
          for (let i = 0; i < withSignal.length; i++) {
            const a = withSignal[i]!.eta, b = withheld[i]!.eta;
            if (a == null || b == null) continue;
            if (Math.abs(a - b) > worst) { worst = Math.abs(a - b); at = withSignal[i]!.t; }
          }
          expect(
            worst,
            `${names[target]}: the arms differ by ${worst.toFixed(0)}s at ${new Date(at).toISOString().slice(11, 19)}`,
          ).toBeLessThan(10);
        });

        it("with the signal the standing term is charged against the layover stop", () => {
          const last = duringRest(withSignal).filter((r) => r.eta != null).at(-1)!;
          const error = last.eta! - (truth - last.t) / 1000;
          expect(Math.abs(error)).toBeLessThan(120);
        });

        it("the countdown never climbs from the start of the rest to the marker", () => {
          // The window is the wait itself: the bus comes to rest short of the
          // marker, sits, then rolls in. It is ONE wait and must read as one.
          //
          // Tolerance 10 s, the bound `accuracy-layover.test.ts` uses on the
          // ring for the same reason: the standing and moving pricings of the
          // same arrival differ by a few seconds and the mixture's weight
          // shifts on the poll the bus settles. It is two orders below the
          // 154-190 s steps this test exists to catch, and below any display
          // bucket.
          const rows = withSignal
            .filter((r) => r.t >= REST_FROM && r.t <= FIRST_AT_MARKER && r.eta != null);
          expect(rows.length).toBeGreaterThan(40);
          for (let i = 1; i < rows.length; i++) {
            const rise = rows[i]!.eta! - rows[i - 1]!.eta!;
            expect(
              rise,
              `${new Date(rows[i]!.t).toISOString()} rose ${rise.toFixed(0)}s while the bus stood still`,
            ).toBeLessThanOrEqual(10);
          }
        });

        it("standing on at the marker never re-charges the stand", () => {
          // Past the roll-in the bus shuffles at the kerb and the belief
          // carries a departure hypothesis for a poll or two — the residue
          // §3 of docs/eta-ring-posterior.md measured and kept (holding the
          // number until the bus cleared the rest radius was tried and cost
          // more than it saved). What must NEVER happen is the one this test
          // is about: the number going back ABOVE the wait it was already
          // serving when it reached the marker.
          const atMarker = withSignal.find((r) => r.t === FIRST_AT_MARKER)!.eta!;
          const after = withSignal
            .filter((r) => r.t > FIRST_AT_MARKER && r.t <= LAST_AT_MARKER && r.eta != null);
          expect(after.length).toBeGreaterThan(3);
          for (const r of after) {
            expect(
              r.eta!,
              `${new Date(r.t).toISOString()} showed ${r.eta!.toFixed(0)}s, past the ${atMarker.toFixed(0)}s it had at the marker`,
            ).toBeLessThanOrEqual(atMarker + 1);
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
