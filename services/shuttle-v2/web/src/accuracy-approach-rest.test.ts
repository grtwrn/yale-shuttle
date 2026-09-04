// "this red is doing its long wait short of 344" — the operator, 2026-09-04.
//
// WHY THIS EXISTS. `accuracy-layover.test.ts` replays a bus that takes its
// layover ON the marker, which is what buses usually do. This one replays the
// case that broke: a bus that takes the layover SHORT of the marker, where
// `at_stop_id` is never published and the app therefore believes it is
// driving.
//
// The operator watched it happen on Red #310, 13:28 ET, and called what would
// happen next before it did:
//
//   "It is not driving; it is doing the stand now, in the wrong place. When it
//    finally rolls the 140 m to the marker it will stop briefly or not at all,
//    the promised 6-minute stand evaporates, and the rider sees the number
//    drop several minutes at once."
//
// The recording (`__fixtures__/red-approach-rest.json`, captured from
// production the same afternoon) says he was right on every count:
//
//   13:27:38  comes to rest 147 m short of 344 Winchester, last_stop_id 27
//   13:27–13:34  79 identical fixes — 7 min 5 s at rest, going nowhere
//   13:34:58  reaches the marker
//   13:36:53  leaves — the detector logged a stand of 115 s
//
// 115 s, against a stand table for that stop whose typical hold is 269 s. The
// layover was taken; it was just taken in the wrong place, and every party to
// the estimate — the stand table, the card, the chip — was told otherwise.
//
// WHAT IT PINS. The two arms below are the SAME code over the SAME recording,
// differing in one payload field: `stationary_since`, which is the whole of
// the server side of this fix. So "master" here is not a reconstruction of the
// old client — it is this client with the new signal withheld, which is
// exactly what a browser talking to an un-deployed server sees, and it must
// keep behaving as it always did.
//
// Do not loosen a bound or re-record the fixture to make a change pass. See
// `scripts/record-approach-rest.mjs` to regenerate, and say in the PR what
// moved.
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

import fx from "./__fixtures__/red-approach-rest.json";

const ROUTE = "3";
const LAYOVER = 11; // 344 Winchester
const PREV = 27; // Canal / Munson — the stop the bus had just left
const routeStops = fx.routeStops as Record<string, number[]>;
const stopCoords = fx.stopCoords as unknown as Record<number, LatLon>;
const names = fx.stopNames as unknown as Record<number, string>;
const segmentTimes = fx.segments as unknown as SegmentTimes;
const dwellTimes = fx.dwells as unknown as DwellTimes;
const dwellsOf = (id: number) => (fx.dwells as Record<string, Record<string, { q?: number[] }>>)[ROUTE]![String(id)]!;

const REST_FROM = fx.approachRest.startedAt;
const REST_TO = fx.approachRest.endedAt;
const positions = fx.positions as {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number; stationary_since: number; at_stop_id: number | null;
}[];

/**
 * The LAST poll on which the payload still names 344 — i.e. the final instant
 * of the marker stand. Not the first gap in the flag: at 13:36:13 the bus
 * shuffles a few metres and loses `at_stop_id` for one poll while plainly
 * still sitting there, which is precisely the shuffle `standingAt`'s memory
 * was built for (PR #67) and must not read as a departure.
 */
const LAST_AT_MARKER = positions
  .filter((p) => p.t > REST_TO && p.at_stop_id === LAYOVER)
  .at(-1)!.t;

/** When the bus really got to a stop, as the collector recorded it. */
function arrivedAt(stopId: number, after: number): number | null {
  const v = (fx.visits as { stopId: number; arrivedAt: number | null }[])
    .find((x) => x.stopId === stopId && x.arrivedAt != null && x.arrivedAt >= after);
  return v?.arrivedAt ?? null;
}

/**
 * The bus exactly as `/api/buses` describes it at that instant.
 *
 * `withSignal: false` withholds `stationary_since` and nothing else — the same
 * bytes a client gets from a server that has not shipped this change.
 */
function busAt(p: (typeof positions)[number], withSignal: boolean): BusData {
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
}

/** What the board shows a rider at `stopId`, at every recorded moment. */
function board(stopId: number, withSignal: boolean): { t: number; eta: number | null }[] {
  const store: AnchorStore = new Map();
  return positions.map((p) => {
    const a = computeUpcomingArrivals(
      [stopId], [busAt(p, withSignal)], routeStops, stopCoords,
      segmentTimes, p.t, dwellTimes, store,
    ).filter((x) => x.routeLabel === "Red");
    return { t: p.t, eta: a.length > 0 ? a[0]!.eta : null };
  });
}

const duringRest = <T extends { t: number }>(rows: T[]) =>
  rows.filter((r) => r.t >= REST_FROM && r.t <= REST_TO);

describe("Red #310 taking its 344 Winchester layover short of the marker", () => {
  registerRoutePaths(null);

  it("the recording is the shape this test needs", () => {
    // A real rest, off the marker, inside the zone the client prices in.
    expect(fx.approachRest.metresShort).toBeGreaterThan(75); // past AT_STOP_PIN_M
    expect(fx.approachRest.metresShort).toBeLessThanOrEqual(APPROACH_ZONE_M);
    expect((REST_TO - REST_FROM) / 1000).toBeGreaterThan(APPROACH_REST_MIN_SEC);
    // Nothing publishes at_stop_id through the rest — that is the defect.
    expect(duringRest(positions).every((p) => p.at_stop_id == null)).toBe(true);
    // ...and the bus does reach the marker afterwards, briefly.
    const touched = arrivedAt(LAYOVER, REST_TO);
    expect(touched).toBeTruthy();

    // The stand the detector actually credited to 344 is a fraction of the
    // wait. This is what PR 2 fixes on the server; here it is the evidence
    // that the rest was the layover.
    const visit = (fx.visits as { stopId: number; standSec: number | null; arrivedAt: number | null }[])
      .find((v) => v.stopId === LAYOVER && v.arrivedAt != null && v.arrivedAt >= REST_TO)!;
    expect(visit.standSec!).toBeLessThan((REST_TO - REST_FROM) / 1000);

    // 344 qualifies as a layover stop; the stop the bus came FROM does not, so
    // the rule cannot fire on the approach to Canal / Munson.
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
        // remaining time falls by minutes and the number does not move at all.
        const rows = duringRest(withheld).filter((r) => r.eta != null);
        const first = rows[0]!, last = rows.at(-1)!;
        const realFall = (truth - first.t) / 1000 - (truth - last.t) / 1000;
        expect(realFall).toBeGreaterThan(240);
        // Frozen: the last four minutes of the rest are one number.
        const tail = rows.filter((r) => r.t >= REST_TO - 240_000).map((r) => r.eta!);
        expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(1);
      });

      it("without the signal it ends the rest minutes LATE — the rider misses the bus", () => {
        const last = duringRest(withheld).filter((r) => r.eta != null).at(-1)!;
        const error = last.eta! - (truth - last.t) / 1000;
        // Promising a bus LATER than it comes is the direction that has a
        // rider stroll down and find it gone.
        expect(error).toBeGreaterThan(300);
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
        // is still at the marker, so it spans the roll-in AND the shuffle at
        // 13:36:13 that drops at_stop_id for one poll — the case `standingAt`'s
        // memory exists for. It is all one wait and must read as one.
        const rows = withSignal
          .filter((r) => r.t >= REST_FROM && r.t <= LAST_AT_MARKER && r.eta != null);
        expect(rows.length).toBeGreaterThan(60);
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
        // stopped. Read raw it would hand the rider the whole layover a second
        // time, the number JUMPING UP at the very moment the bus arrives.
        const touch = positions.find((p) => p.t > REST_TO && p.at_stop_id === LAYOVER)!;
        const i = withSignal.findIndex((r) => r.t === touch.t);
        expect(i).toBeGreaterThan(0);
        const before = withSignal[i - 1]!.eta!, after = withSignal[i]!.eta!;
        expect(
          after - before,
          `arriving at the marker moved the estimate by ${(after - before).toFixed(0)}s`,
        ).toBeLessThanOrEqual(1);
        // And the clock really did carry across: at_stop_since restarted here,
        // so an uncarried clock would have re-charged most of the typical hold.
        expect(after).toBeLessThan(remainingStandSec(dwellsOf(LAYOVER).q!, 0));
      });

      it("the departure still collapses the number on the same poll", () => {
        // The fix must not delay the honest 5 -> 1. `LAST_AT_MARKER` is the
        // final poll the flag names 344 — deliberately the LAST one, not the
        // first gap, because the gap at 13:36:13 is a shuffle and the bus is
        // still standing there.
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
        // Neither arm may still be holding a standing term after the bus goes:
        // the drive to the next stop is all that is left, and it is short.
        if (aAfter != null && aBefore != null) {
          expect(Math.sign(aAfter - aBefore)).toBe(Math.sign(bAfter! - bBefore!));
        }
      });
    });
  }
});
