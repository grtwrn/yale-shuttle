import { describe, expect, it } from "vitest";

import { billedDwellSec, computeUpcomingArrivals, STALL_CREDIT_MAX_FRACTION } from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { findRouteAnchor } from "./anchor";
import {
  at, makeBus, routeStops, segmentTimes, STOP, stopCoords,
} from "./__fixtures__/payload";

const NOW = new Date("2026-08-31T20:30:00Z").getTime();
const blueWeekend = routeStops["4"]!;
const blueDay = routeStops["1"]!;

/** The feed sends a naive (Z-less) UTC timestamp; the app appends the "Z". */
const dwellingSince = (secondsAgo: number) =>
  new Date(NOW - secondsAgo * 1000).toISOString().replace("Z", "");

const etaFor = (arrivals: { stopId: number; eta: number }[], stopId: number) =>
  arrivals.find((a) => a.stopId === stopId)?.eta;

describe("computeUpcomingArrivals", () => {
  it("produces ETAs in ascending order for a bus on the route", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const targets = [STOP.cedar333, STOP.york129, STOP.elmYork];
    const arrivals = computeUpcomingArrivals(targets, [bus], routeStops, stopCoords, segmentTimes, NOW);
    expect(arrivals.length).toBeGreaterThan(0);
    const etas = arrivals.map((a) => a.eta);
    expect([...etas].sort((x, y) => x - y)).toEqual(etas);
    expect(arrivals.every((a) => a.routeLabel === "Blue Day")).toBe(true);
  });

  it("emits at most two arrivals per stop per bus — this lap and the next", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const arrivals = computeUpcomingArrivals(
      [STOP.cedar333], [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    // Report #29: on a single-bus route the second-lap entry is the only way
    // to answer "and the one after that?".
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0].eta).toBeLessThan(arrivals[1].eta);
  });

  // Report #89 ("isn't red closed for the day?"): at 6:14pm ET on a Thursday
  // — Red is published 7am–6pm — the trip row read "🚌 in 25, 78 min". The 78
  // was the last Red of the day projected to lap at 7:32pm, long after the
  // route stops running. The lap-2 entry is a projection, so it has to answer
  // to the timetable; the bus you can actually see does not.
  describe("the second-lap projection stops at the end of service", () => {
    // Blue Day runs M–F 07:00–18:00 ET. This bus is 6 min from 333 Cedar on
    // this lap and 47 min away on the next.
    const busOnBlueDay = () =>
      makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const etasAt = (iso: string) =>
      computeUpcomingArrivals(
        [STOP.cedar333], [busOnBlueDay()], routeStops, stopCoords, segmentTimes,
        new Date(iso).getTime(),
      ).map((a) => Math.round(a.eta / 60));

    it("keeps the next lap while the route is still running", () => {
      // Monday 16:30 ET — the lap lands at 17:17, inside the window.
      expect(etasAt("2026-08-31T20:30:00Z")).toEqual([6, 47]);
    });

    it("drops the next lap once the window has closed by then", () => {
      // Monday 17:45 ET. The bus 6 min out is real and stays; the lap after
      // it would land at 18:32, past Blue Day's 18:00 close.
      expect(etasAt("2026-08-31T21:45:00Z")).toEqual([6]);
    });

    it("still drops it when the rider is already past the close", () => {
      // Monday 18:10 ET — a bus finishing its last loop. It is visible; the
      // lap after it is not offered at all.
      expect(etasAt("2026-08-31T22:10:00Z")).toEqual([6]);
    });
  });

  it("ignores buses parked off the route", () => {
    const ghost = makeBus({
      route_id: 1,
      // ~5 km north — the Hamden depot case, well past every Blue Day stop.
      lat: at(STOP.phelpsGate).lat + 5_000 / 111_000,
      lon: at(STOP.phelpsGate).lon,
    });
    const arrivals = computeUpcomingArrivals(
      [STOP.cedar333], [ghost], routeStops, stopCoords, segmentTimes, NOW,
    );
    expect(arrivals).toEqual([]);
  });

  it("returns nothing when no bus serves the target stop", () => {
    expect(computeUpcomingArrivals([STOP.cedar333], [], routeStops, stopCoords, segmentTimes, NOW))
      .toEqual([]);
  });

  it("strips the leading # from the bus name", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, bus_name: "#317", last_stop_id: 42 });
    const arrivals = computeUpcomingArrivals(
      [STOP.cedar333], [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    expect(arrivals[0].busName).toBe("317");
  });
});

describe("dwell credit is gated on at_stop_id agreeing with the GPS anchor", () => {
  // Report #32 ("6 min, then it said 16"): the dwell/stall credit used to be
  // granted off a raw at_stop_id with no distance and no ordering check. On
  // routes where two stops nearly touch but sit far apart in the sequence, a
  // few metres of GPS wobble handed a long dwell credit to the wrong segment
  // and swung the displayed ETA by ~10 minutes.
  const busAtElmYork = (atStopId: number) => makeBus({
    ...at(STOP.elmYorkTyco),
    route_id: 4,
    last_stop_id: STOP.stopAndShop,
    at_stop_id: atStopId,
    at_stop_since: dwellingSince(20 * 60),
  });

  it("grants credit when the feed and the GPS anchor name the same stop", () => {
    const bus = busAtElmYork(STOP.elmYorkTyco);
    expect(findRouteAnchor(bus, blueWeekend, stopCoords))
      .toBe(blueWeekend.indexOf(STOP.elmYorkTyco));
    const arrivals = computeUpcomingArrivals(
      [STOP.collegeWallN], [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    // 20 minutes of dwell cancels as much of the first segment as the cap
    // allows — the bus is about to pull out, but the hop still has to be
    // driven (the replay showed 'imminent' was 3 min optimistic after a long
    // layover). Half the segment remains: ~370 m at the 6 m/s fallback ≈ 60 s.
    const eta = etaFor(arrivals, STOP.collegeWallN)!;
    expect(eta).toBeGreaterThan(20);
    expect(eta).toBeLessThan(40);
  });

  it("withholds credit when the feed names a DIFFERENT stop than the anchor", () => {
    // Same bus, same 20-minute dwell — but the feed says Broadway/York, 23 m
    // away and two stops back. It must not be believed.
    const bus = busAtElmYork(STOP.broadwayYork);
    const anchor = findRouteAnchor(bus, blueWeekend, stopCoords);
    expect(anchor).not.toBe(blueWeekend.indexOf(STOP.broadwayYork));
    const arrivals = computeUpcomingArrivals(
      [STOP.collegeWallN], [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    // No credit, so the Elm/York → College/Wall (N) segment is paid in full
    // (~370 m at the 6 m/s fallback ≈ 60 s).
    expect(etaFor(arrivals, STOP.collegeWallN)).toBeGreaterThan(30);
  });

  it("does not let a stale at_stop_id erase a segment the bus is only halfway along", () => {
    // The sharpest form of the bug: the bus is genuinely MID-SEGMENT between
    // Stop & Shop and Elm/York, but the feed still carries a 20-minute dwell
    // at Broadway/York — 23 m from Elm/York, two stops back. Ungated, that
    // credit wipes out the whole remaining segment and the board says the bus
    // is about to arrive when it is 400 m away.
    const a = at(STOP.stopAndShop);
    const b = at(STOP.elmYorkTyco);
    const bus = makeBus({
      lat: a.lat + (b.lat - a.lat) * 0.5,
      lon: a.lon + (b.lon - a.lon) * 0.5,
      route_id: 4,
      last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.broadwayYork,
      at_stop_since: dwellingSince(20 * 60),
    });
    expect(findRouteAnchor(bus, blueWeekend, stopCoords))
      .toBe(blueWeekend.indexOf(STOP.stopAndShop));
    const eta = etaFor(
      computeUpcomingArrivals([STOP.elmYorkTyco], [bus], routeStops, stopCoords, segmentTimes, NOW),
      STOP.elmYorkTyco,
    )!;
    // Half a ~790 m segment at the 6 m/s fallback ≈ 66 s, not "arriving now".
    expect(eta).toBeGreaterThan(30);
  });

  /**
   * Red, 2026-09-03, reported by a rider: bus #316 had been sitting at 344
   * Winchester for 10 minutes of its ~8-minute layover — about to pull out,
   * 82 s of driving from the next stop — and the board told someone three
   * stops down the line "5 min". It left, arrived about 2.5 min later, and
   * anyone who trusted the 5 missed it. Arriving EARLY is the dangerous
   * direction: the rider is not there.
   *
   * The numbers below are that hop's live calibration: the segment averages
   * 557 s BECAUSE it contains the 475 s layover. What a dwelling bus can
   * cancel is the layover, not the drive.
   */
  it("a bus that has finished a long layover is not padded by half of it", () => {
    const LAYOVER = 475.2;
    const segs: SegmentTimes = {
      "4": {
        [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: 557.4, sd: 60, n: 34 },
        [`${STOP.elmYorkTyco}-${STOP.collegeWallN}`]: { avg: 37.4, sd: 10, n: 32 },
      },
    };
    const dwells: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: LAYOVER, sd: 120, n: 13 } },
    };
    const bus = makeBus({
      ...at(STOP.stopAndShop), route_id: 4, last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.stopAndShop, at_stop_since: dwellingSince(10 * 60),
    });
    const eta = etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [bus], routeStops, stopCoords, segs, NOW, dwells),
      STOP.collegeWallN,
    )!;
    // 557 - 475 = 82 s of driving, then the 37 s hop: about two minutes.
    expect(eta).toBeGreaterThan(90);
    expect(eta).toBeLessThan(150);
    // Without a dwell statistic the fraction cap still applies — and that is
    // the reading the rider was shown, half the segment being pure padding.
    const padded = etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [bus], routeStops, stopCoords, segs, NOW),
      STOP.collegeWallN,
    )!;
    expect(padded).toBeGreaterThan(300);
  });

  // The "layover taken one stop early" block that lived here is gone with the
  // behaviour it pinned. A week of `arrivals` says a long hold at a
  // non-layover stop is followed by the scheduled layover 292 times out of
  // 321 — the credit would have been wrong in 91% of the cases it fired on.
  // See the note above STALL_CREDIT_MAX_FRACTION in arrivals.ts.

  it("still does not promise a bus that is part way through its layover", () => {
    const segs: SegmentTimes = {
      "4": { [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: 557.4, sd: 60, n: 34 } },
    };
    const dwells: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: 475.2, sd: 120, n: 13 } },
    };
    const justArrived = makeBus({
      ...at(STOP.stopAndShop), route_id: 4, last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.stopAndShop, at_stop_since: dwellingSince(30),
    });
    const eta = etaFor(
      computeUpcomingArrivals([STOP.elmYorkTyco], [justArrived], routeStops, stopCoords, segs, NOW, dwells),
      STOP.elmYorkTyco,
    )!;
    // 30 s served of an ~8 min layover: the rest of the wait is still ahead.
    expect(eta).toBeGreaterThan(480);
  });

  it("never credits more than the capped share of the first hop", () => {
    // Replay finding (2026-09-02): a bus that has sat 5+ min was promised at
    // the next stop ~3.4 min early because every elapsed second came off the
    // hop. Whatever the dwell, at least (1 - cap) of the hop must remain.
    const uncapped = etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [makeBus({
        ...at(STOP.elmYorkTyco), route_id: 4, last_stop_id: STOP.stopAndShop,
        at_stop_id: STOP.elmYorkTyco, at_stop_since: dwellingSince(0),
      })], routeStops, stopCoords, segmentTimes, NOW),
      STOP.collegeWallN,
    )!;
    for (const minutes of [2, 5, 20, 60]) {
      const eta = etaFor(
        computeUpcomingArrivals([STOP.collegeWallN], [makeBus({
          ...at(STOP.elmYorkTyco), route_id: 4, last_stop_id: STOP.stopAndShop,
          at_stop_id: STOP.elmYorkTyco, at_stop_since: dwellingSince(minutes * 60),
        })], routeStops, stopCoords, segmentTimes, NOW),
        STOP.collegeWallN,
      )!;
      expect(eta).toBeGreaterThanOrEqual(uncapped * (1 - STALL_CREDIT_MAX_FRACTION) - 1e-6);
    }
  });

  it("a fresh dwell earns no credit; a long one does", () => {
    const fresh = makeBus({
      ...at(STOP.elmYorkTyco), route_id: 4, last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.elmYorkTyco, at_stop_since: dwellingSince(0),
    });
    const stale = busAtElmYork(STOP.elmYorkTyco);
    const freshEta = etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [fresh], routeStops, stopCoords, segmentTimes, NOW),
      STOP.collegeWallN,
    )!;
    const staleEta = etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [stale], routeStops, stopCoords, segmentTimes, NOW),
      STOP.collegeWallN,
    )!;
    expect(freshEta).toBeGreaterThan(staleEta);
  });
});

  /**
   * A hold the bus has not reached is priced at the SEGMENT AVERAGE, full
   * stop — the `low` quantile must not touch the estimate.
   *
   * This was briefly `max(30, seg.avg - med) + low`, on the theory that a hop
   * is a rest plus a drive and only the rest should be discounted. It is not:
   * `dwell_sec` and `travel_sec` are the same number out of `detector.ts`, so
   * `seg.avg - med` is estimator noise and the 30 s floor turned the discount
   * into a SURCHARGE on 77% of hops. Replayed over 262,762 real pairs it took
   * the median absolute error 37.5 -> 46.7 s and the share more than two
   * minutes pessimistic 11.0% -> 13.0%. See WHAT A DWELL STATISTIC ACTUALLY
   * MEASURES in arrivals.ts.
   *
   * These tests exist so a `low` field can never silently move a rider's ETA
   * again. Numbers are Red's live calibration at 344 Winchester.
   */
  describe("a rest the bus has not reached yet is not re-priced", () => {
    const LAYOVER_SEG = 452, DWELL_MED = 395, DWELL_LOW = 240;
    const segs: SegmentTimes = {
      "4": {
        [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: LAYOVER_SEG, sd: 60, n: 34 },
        [`${STOP.elmYorkTyco}-${STOP.collegeWallN}`]: { avg: 26, sd: 8, n: 32 },
      },
    };
    const withLowQ: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13, low: DWELL_LOW } },
    };
    const noLowQ: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13 } },
    };
    // The bus is at York/Chapel, one hop BEFORE the layover stop.
    const approaching = () => makeBus({
      ...at(STOP.yorkChapel), route_id: 4, last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.yorkChapel, at_stop_since: dwellingSince(5),
    });
    const eta = (dwells?: DwellTimes) => etaFor(
      computeUpcomingArrivals([STOP.collegeWallN], [approaching()], routeStops, stopCoords, segs, NOW, dwells),
      STOP.collegeWallN,
    )!;

    it("ignores the low quantile entirely", () => {
      expect(eta(withLowQ)).toBe(eta(noLowQ));
    });

    it("is identical to serving no dwell statistics at all", () => {
      expect(eta(withLowQ)).toBe(eta(undefined));
    });

    it("charges the rest hop its full calibrated segment", () => {
      // Difference the two stops either side of the quick hop that follows the
      // layover: everything upstream cancels, so what is left is exactly the
      // calibrated segment. Nothing is shaved off the rest.
      const toTyco = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [approaching()], routeStops, stopCoords, segs, NOW, withLowQ),
        STOP.elmYorkTyco,
      )!;
      expect(eta(withLowQ) - toTyco).toBeCloseTo(26, 5);
      // ...and the layover hop itself is untouched by the quantile.
      const toTycoNoLow = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [approaching()], routeStops, stopCoords, segs, NOW, noLowQ),
        STOP.elmYorkTyco,
      )!;
      expect(toTyco).toBe(toTycoNoLow);
    });

    it("does not surcharge a hop that is almost all rest", () => {
      // The old floor made THIS case explode: seg.avg - med hit 30 and the hop
      // became 30 + low, larger than the segment it replaced.
      const allDwell: DwellTimes = {
        "4": { [String(STOP.stopAndShop)]: { med: LAYOVER_SEG, sd: 150, n: 13, low: 60 } },
      };
      const withAllDwell = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [approaching()], routeStops, stopCoords, segs, NOW, allDwell),
        STOP.elmYorkTyco,
      )!;
      const plain = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [approaching()], routeStops, stopCoords, segs, NOW),
        STOP.elmYorkTyco,
      )!;
      expect(withAllDwell).toBe(plain);
    });
  });


describe("billedDwellSec — one number, shown and billed (reports #73, #77)", () => {
  // #73: a rider read the route page and did the arithmetic — "it says arrive
  // in 8 but expected dwell is 10". The 10 was the stop's median on screen,
  // the 8 an ETA computed from the low quantile. #77, an hour after that
  // low-quantile pricing shipped: "it said five minutes dwell, then nine when
  // it got there." Both complaints are the same complaint — two prices for
  // one hold — and the estimator now has only one, so this does too.
  const rest = { med: 600, low: 420 };

  it("bills the median for a stop still ahead", () => {
    expect(billedDwellSec(rest, false)).toBe(600);
  });

  it("bills the median at the stop the bus is standing at", () => {
    expect(billedDwellSec(rest, true)).toBe(600);
  });

  it("shows the same figure before and after the bus arrives (report #77)", () => {
    expect(billedDwellSec(rest, false)).toBe(billedDwellSec(rest, true));
  });

  it("ignores a low quantile however it is shaped", () => {
    expect(billedDwellSec({ med: 240 }, false)).toBe(240);
    expect(billedDwellSec({ med: 200, low: 260 }, false)).toBe(200);
    expect(billedDwellSec({ med: 200, low: 10 }, false)).toBe(200);
  });

  it("says nothing when there is no statistic at all", () => {
    expect(billedDwellSec(undefined, false)).toBeNull();
    expect(billedDwellSec({ med: NaN }, false)).toBeNull();
  });
});
