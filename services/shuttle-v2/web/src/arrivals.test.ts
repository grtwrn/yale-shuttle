import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  billedDwellSec, computeUpcomingArrivals, MAX_PLAUSIBLE_M_S, MIN_HOP_SEC,
  nextArrivalAfterPinned, shownStandSec, splitServedForRoute, STALL_CREDIT_MAX_FRACTION,
} from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { priceFirstHop, remainingStandSec } from "./hopPricing";
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

describe("a stall credit cancels waiting, never driving", () => {
  /**
   * Report #80, Red #316 at 344 Winchester: "if its waited 5/5 already, then
   * it will be here sooner than 3 min". The premise turned out to be right and
   * the conclusion wrong — every elapsed second WAS already credited, and the
   * ~3 min left is three hops of driving. The bug the report actually
   * uncovered is the opposite one, on the other side of the same bound: with
   * the credit capped only by the calibrated dwell, a hop could be billed at
   * ZERO. The dwell median and the segment average estimate the same quantity
   * (see WHAT A DWELL STATISTIC ACTUALLY MEASURES), so `med >= avg` is
   * ordinary — 114 of 274 hops on the live payload — and every one of those
   * promised a bus that still had a block to drive as though it were already
   * there.
   */
  const NEAR = 41.3111, FAR = 41.3211; // ~1.1 km apart at this latitude
  const stops = { "4": [900, 901] } as Record<string, number[]>;
  const coords = { 900: { lat: NEAR, lon: -72.93 }, 901: { lat: FAR, lon: -72.93 } };

  it("floors the first hop at the driving the geometry demands", () => {
    // The dwell median EXCEEDS the whole segment average, so the unfloored
    // bound cancels all of it.
    const segs: SegmentTimes = { "4": { "900-901": { avg: 200, sd: 30, n: 20 } } };
    const dwells: DwellTimes = { "4": { "900": { med: 260, sd: 60, n: 20 } } };
    const bus = makeBus({
      lat: NEAR, lon: -72.93, route_id: 4, last_stop_id: 900,
      at_stop_id: 900, at_stop_since: dwellingSince(30 * 60),
    });
    const eta = etaFor(
      computeUpcomingArrivals([901], [bus], stops, coords, segs, NOW, dwells), 901,
    )!;
    // 1.1 km cannot be driven in 0 s. At MAX_PLAUSIBLE_M_S it is ~50 s.
    expect(eta).toBeGreaterThan(45);
    expect(eta).toBeCloseTo(1_112 / MAX_PLAUSIBLE_M_S, -1);
  });

  it("never bills a hop below the 30 s minimum, however long the bus has sat", () => {
    const close = { 900: { lat: NEAR, lon: -72.93 }, 901: { lat: NEAR + 0.0009, lon: -72.93 } };
    const segs: SegmentTimes = { "4": { "900-901": { avg: 90, sd: 20, n: 20 } } };
    const dwells: DwellTimes = { "4": { "900": { med: 300, sd: 60, n: 20 } } };
    for (const minutes of [1, 10, 60]) {
      const bus = makeBus({
        lat: NEAR, lon: -72.93, route_id: 4, last_stop_id: 900,
        at_stop_id: 900, at_stop_since: dwellingSince(minutes * 60),
      });
      const eta = etaFor(
        computeUpcomingArrivals([901], [bus], stops, close, segs, NOW, dwells), 901,
      )!;
      expect(eta).toBeGreaterThanOrEqual(MIN_HOP_SEC - 1e-6);
    }
  });

  it("leaves report #80's own layover untouched — the floor is not new padding", () => {
    // Red's live calibration for 344 Winchester -> Winchester/Division: the
    // stops are 112 m apart, so the floor is the 30 s minimum, well under the
    // ~99 s of driving the hop is already billed. A bus that has served its
    // whole hold still gets every second of credit it earned.
    const segs: SegmentTimes = {
      "4": { [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: 557.4, sd: 60, n: 34 } },
    };
    const dwells: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: 475.2, sd: 120, n: 13 } },
    };
    const served = makeBus({
      ...at(STOP.stopAndShop), route_id: 4, last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.stopAndShop, at_stop_since: dwellingSince(10 * 60),
    });
    const eta = etaFor(
      computeUpcomingArrivals([STOP.elmYorkTyco], [served], routeStops, stopCoords, segs, NOW, dwells),
      STOP.elmYorkTyco,
    )!;
    // 557.4 - 475.2 = 82.2 s of driving, unchanged by the floor.
    expect(eta).toBeCloseTo(557.4 - 475.2, 3);
  });

  it("mirrors the server's plausible-speed bound", () => {
    // Same discipline as walk.test.ts: parse the SERVER's constant so the two
    // cannot drift. A floor built on a slower speed would withhold credit the
    // bus has genuinely earned — the padding that broke the Red layover, where
    // the board promised 5 min and the bus came in 2.5.
    const src = readFileSync(
      fileURLToPath(new URL("../../src/calibrator/calibrator.ts", import.meta.url)), "utf8",
    );
    const m = /export const MAX_PLAUSIBLE_M_S = ([0-9.]+);/.exec(src);
    expect(m, "MAX_PLAUSIBLE_M_S not found in the calibrator's source").toBeTruthy();
    expect(MAX_PLAUSIBLE_M_S).toBe(Number(m![1]));
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

describe("nextArrivalAfterPinned", () => {
  const a = (busName: string, eta: number) => ({ busName, eta });
  /** What the code used to do, kept here so the bug can be demonstrated. */
  const oldRule = (list: { busName: string; eta: number }[], shownEta: number) =>
    list.filter((x) => x.eta > shownEta + 30).sort((x, y) => x.eta - y.eta)[0] ?? null;

  it("skips the pinned vehicle's own arrival and answers with the bus behind it", () => {
    const list = [a("#40", 450), a("#41", 510), a("#40", 3300)];
    expect(nextArrivalAfterPinned(list, "#40", 450)?.busName).toBe("#41");
  });

  it("is stable while a trailing bus jitters across the OLD boundary", () => {
    // The measured failure, Blue Day 2026-09-03 17:45–17:48: a bus about a
    // minute behind the pinned one, whose recomputed eta wandered either side
    // of `shown + 30`. Each time it fell inside, the old rule had nothing left
    // to answer with except the pinned bus's next lap, and the rider's "next
    // in 8 min" became "next in 37 min" — seven times, while the first figure
    // never moved.
    const shown = 450;
    const jitter = [470, 485, 475, 490, 478, 505, 468];
    const answers = new Set<string>();
    const oldAnswers = new Set<string>();
    for (const trailing of jitter) {
      const list = [a("#40", shown), a("#41", trailing), a("#40", 2670)];
      answers.add(String(nextArrivalAfterPinned(list, "#40", shown)?.eta));
      oldAnswers.add(String(oldRule(list, shown)?.eta));
    }
    // The new rule always answers with the trailing bus, whatever it reads.
    expect([...answers].every((v) => Number(v) < 600)).toBe(true);
    // The old rule swung between the trailing bus and a lap away — 37 minutes.
    expect(oldAnswers.has("2670")).toBe(true);
    expect(oldAnswers.size).toBeGreaterThan(1);
  });

  it("still answers with the same vehicle a lap later on a one-bus line", () => {
    // Brown runs a single bus; "next in 54 min" is the correct answer there.
    const list = [a("#301", 60), a("#301", 3300)];
    expect(nextArrivalAfterPinned(list, "#301", 60)?.eta).toBe(3300);
  });

  it("never answers with a bus that arrives BEFORE the one on screen", () => {
    // The documented reason the old margin existed: an earlier bus the rider
    // cannot catch must not masquerade as "next". That intent is preserved.
    const list = [a("#39", 200), a("#40", 450), a("#40", 3300)];
    expect(nextArrivalAfterPinned(list, "#40", 450)?.eta).toBe(3300);
  });

  it("compares against the pinned vehicle's OWN fresh eta, not the decayed one", () => {
    // `busEtaLive` decays between polls while the candidates are recomputed
    // fresh, so comparing the two was apples to pears. Here the pin is priced
    // at 450 but recomputes to 520; the trailing bus at 500 is earlier than
    // the pin really is, so it must not be offered as the NEXT one.
    const list = [a("#40", 520), a("#41", 500), a("#40", 3300)];
    expect(nextArrivalAfterPinned(list, "#40", 450)?.eta).toBe(3300);
  });

  it("falls back to the shown eta when the pinned vehicle has left the feed", () => {
    const list = [a("#41", 500), a("#42", 900)];
    expect(nextArrivalAfterPinned(list, "#40", 450)?.eta).toBe(500);
  });

  it("answers null when there is nothing later", () => {
    expect(nextArrivalAfterPinned([a("#40", 450)], "#40", 450)).toBeNull();
    expect(nextArrivalAfterPinned([], "#40", 450)).toBeNull();
  });

  it("matches vehicle names with or without the leading hash", () => {
    const list = [a("40", 450), a("#41", 510)];
    expect(nextArrivalAfterPinned(list, "#40", 450)?.busName).toBe("#41");
  });
});

describe("shownStandSec — the chip quotes the number the countdown bills", () => {
  // The operator's own case, 2026-09-04: a Red bus standing at 344 Winchester.
  // Live payload for route 3, stop 11.
  const WINCHESTER = {
    med: 574.9, sd: 279.8, n: 28,
    q: [112, 140, 145, 216, 294, 339, 440, 478, 538, 663],
    qn: 28,
  };
  const DRIVE = { avg: 100, n: 30, drive: 18, driveN: 25 };
  const STOOD = 180;

  it("says what is LEFT, not a total the rider has to subtract from", () => {
    const shown = shownStandSec(WINCHESTER, DRIVE, STOOD, true)!;
    expect(shown.remaining).toBe(true);
    // The chip used to print ~10 min (dwell.med, 574.9 s) beside a countdown
    // of 5 min. The quantiles above the 180 s already stood have a median of
    // 440 s, so ~4 min is what is actually left — and that IS the 5 min the
    // rider was being told, less the drive.
    expect(shown.sec).toBeGreaterThan(180);
    expect(shown.sec).toBeLessThan(360);
    expect(shown.sec).toBeLessThan(WINCHESTER.med);
  });

  it("is EXACTLY the stand term priceFirstHop adds — not a second estimate", () => {
    const shown = shownStandSec(WINCHESTER, DRIVE, STOOD, true)!;
    const billed = priceFirstHop({ q: WINCHESTER.q }, DRIVE.drive, STOOD, 0);
    expect(shown.sec).toBeCloseTo(billed - DRIVE.drive, 6);
    expect(shown.sec).toBeCloseTo(remainingStandSec(WINCHESTER.q, STOOD), 6);
  });

  it("shrinks as the bus keeps standing, the way the countdown does", () => {
    const early = shownStandSec(WINCHESTER, DRIVE, 60, true)!.sec;
    const late = shownStandSec(WINCHESTER, DRIVE, 400, true)!.sec;
    expect(late).toBeLessThan(early);
  });

  // Everything below is the "keep the old behaviour exactly" half: where the
  // split does not price the hop, the legacy stall credit still bills
  // dwell.med, so dwell.med is still the honest thing to show.
  it("keeps the arrival-to-arrival median on a route the split is not served for", () => {
    expect(shownStandSec(WINCHESTER, DRIVE, STOOD, false))
      .toEqual({ sec: WINCHESTER.med, remaining: false });
  });

  it("keeps it when this hop's drive is too thin to price", () => {
    const thinDrive = { avg: 100, n: 30, drive: 18, driveN: 1 };
    expect(shownStandSec(WINCHESTER, thinDrive, STOOD, true))
      .toEqual({ sec: WINCHESTER.med, remaining: false });
    expect(shownStandSec(WINCHESTER, undefined, STOOD, true))
      .toEqual({ sec: WINCHESTER.med, remaining: false });
  });

  it("keeps it when this stop's stand table is too thin", () => {
    const thin = { med: 300, sd: 10, n: 4, q: [10, 20, 30], qn: 4 };
    expect(shownStandSec(thin, DRIVE, STOOD, true)).toEqual({ sec: 300, remaining: false });
  });

  it("keeps it when the bus is not standing there at all", () => {
    // A stop still ahead has no remainder to state, so the typical hold is
    // the only answer — and it is the figure shown before the bus arrives and
    // after it does (report #77).
    expect(shownStandSec(WINCHESTER, DRIVE, null, true))
      .toEqual({ sec: WINCHESTER.med, remaining: false });
  });

  it("says nothing when there is no statistic at all", () => {
    expect(shownStandSec(undefined, DRIVE, STOOD, true)).toBeNull();
    expect(shownStandSec({ med: NaN, sd: 0, n: 0 }, DRIVE, null, false)).toBeNull();
  });
});

describe("splitServedForRoute — one predicate for the screen and the arithmetic", () => {
  const goodSeg = { avg: 100, n: 30, drive: 18, driveN: 25 };
  const goodDwell = { med: 500, sd: 100, n: 28, q: [100, 200, 300], qn: 28 };

  it("needs both halves somewhere on the route", () => {
    expect(splitServedForRoute({ a: goodSeg }, { "1": goodDwell })).toBe(true);
    expect(splitServedForRoute({ a: { avg: 100, n: 30 } }, { "1": goodDwell })).toBe(false);
    expect(splitServedForRoute({ a: goodSeg }, { "1": { med: 500, sd: 1, n: 3 } })).toBe(false);
    expect(splitServedForRoute({}, {})).toBe(false);
  });

  it("is what the estimator itself asks", () => {
    // Guard against the two definitions being forked again: this is the whole
    // reason the chip and the countdown disagreed. If computeUpcomingArrivals
    // stops calling this, the string below stops matching.
    const src = readFileSync(
      fileURLToPath(new URL("./arrivals.ts", import.meta.url)), "utf8",
    );
    expect(src).toContain("const splitServed = splitServedForRoute(routeSegs, routeDwells)");
  });
});
