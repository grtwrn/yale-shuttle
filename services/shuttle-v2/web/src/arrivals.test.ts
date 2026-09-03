import { describe, expect, it } from "vitest";

import { computeUpcomingArrivals, STALL_CREDIT_MAX_FRACTION, STALL_CREDIT_MAX_STEPS } from "./arrivals";
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

  describe("a layover taken one stop early (operator, 2026-09-03)", () => {
    // Red's ~8 min hold is calibrated at 344 Winchester, but a bus took it at
    // Canal/Munson instead — 10 min sat where that stop typically holds ~2.
    // The ETA cancelled only Canal/Munson's own 2 min and then charged the
    // full 344 Winchester layover as well, so every downstream board read
    // minutes too late for a hold the bus had ALREADY taken. Here
    // stopAndShop stands in for Canal/Munson and elmYorkTyco for 344
    // Winchester (adjacent in the route-4 fixture, idx 23 and 24).
    const SHORT_HOP = 120;   // stopAndShop -> elmYorkTyco: mostly driving
    const LAYOVER_HOP = 557; // elmYorkTyco -> collegeWallN: 475 s of it is the hold
    const segs: SegmentTimes = {
      "4": {
        [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: SHORT_HOP, sd: 30, n: 20 },
        [`${STOP.elmYorkTyco}-${STOP.collegeWallN}`]: { avg: LAYOVER_HOP, sd: 60, n: 34 },
      },
    };
    const dwells: DwellTimes = {
      "4": {
        [String(STOP.stopAndShop)]: { med: 120, sd: 40, n: 18 },
        [String(STOP.elmYorkTyco)]: { med: 475, sd: 120, n: 13 },
      },
    };
    const busSatAt = (seconds: number) => makeBus({
      ...at(STOP.stopAndShop), route_id: 4, last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.stopAndShop, at_stop_since: dwellingSince(seconds),
    });
    const etaAt = (stopId: number, seconds: number) => etaFor(
      computeUpcomingArrivals([stopId], [busSatAt(seconds)], routeStops, stopCoords, segs, NOW, dwells),
      stopId,
    )!;

    it("does not charge a hold the bus has already taken", () => {
      // 10 min sat: 2 of it cancels this stop's own dwell, and the 8 that are
      // left cancel the layover baked into the NEXT hop. What remains is the
      // driving: 557 - 475 = 82 s.
      const eta = etaAt(STOP.collegeWallN, 600);
      expect(eta).toBeLessThan(150);
      expect(eta).toBeGreaterThan(60);
    });

    it("leaves a normal pause alone — nothing carries forward", () => {
      // Sat exactly its measured 2 min: no evidence any hold has moved, so
      // the layover ahead is still charged in full.
      const eta = etaAt(STOP.collegeWallN, 120);
      expect(eta).toBeGreaterThan(LAYOVER_HOP - 1);
    });

    it("credits the adjacent stop and no further", () => {
      // Two hops past the stall the segment must be charged in full: a long
      // stall is evidence a measured hold moved, not that the whole route
      // will run early.
      const twoPast = routeStops["4"]![26]!;
      const uncredited = etaAt(twoPast, 120) - etaAt(STOP.collegeWallN, 120);
      const credited = etaAt(twoPast, 600) - etaAt(STOP.collegeWallN, 600);
      expect(credited).toBeCloseTo(uncredited, 6);
      expect(STALL_CREDIT_MAX_STEPS).toBe(2);
    });

    it("only spills into a LAYOVER, not into any old pause", () => {
      // Same 10-minute stall, but the adjacent stop merely pauses a minute.
      // Measured (229,907 pairs): crediting stalls into small neighbouring
      // dwells cost 1.8 s of median accuracy, because most long stalls are
      // just long stalls — so this hop must be charged in full.
      const smallDwells: DwellTimes = {
        "4": {
          [String(STOP.stopAndShop)]: { med: 120, sd: 40, n: 18 },
          [String(STOP.elmYorkTyco)]: { med: 60, sd: 20, n: 22 },
        },
      };
      const eta = etaFor(
        computeUpcomingArrivals(
          [STOP.collegeWallN], [busSatAt(600)], routeStops, stopCoords, segs, NOW, smallDwells,
        ),
        STOP.collegeWallN,
      )!;
      expect(eta).toBeGreaterThan(LAYOVER_HOP - 1);
    });

    it("requires the bus to have plausibly SERVED the layover", () => {
      // Sat only 3 min: past this stop's own 2 min there is one minute left,
      // nowhere near half of the ~8 min hold ahead, so it is not evidence
      // the layover moved and the hop stays intact.
      const eta = etaFor(
        computeUpcomingArrivals(
          [STOP.collegeWallN], [busSatAt(180)], routeStops, stopCoords, segs, NOW, dwells,
        ),
        STOP.collegeWallN,
      )!;
      expect(eta).toBeGreaterThan(LAYOVER_HOP - 1);
    });

    it("never drives a hop below zero, however long the stall", () => {
      for (const minutes of [10, 30, 90]) {
        expect(etaAt(STOP.collegeWallN, minutes * 60)).toBeGreaterThanOrEqual(0);
        expect(etaAt(STOP.elmYorkTyco, minutes * 60)).toBeGreaterThanOrEqual(0);
      }
    });
  });

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

describe("mid-segment proration", () => {
  it("shrinks the first-segment ETA as the bus approaches the next stop", () => {
    const a = at(STOP.phelpsGate);
    const b = at(38); // College / Crown, the next Blue Day stop
    const between = (t: number) => ({
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
    });
    const etaAt = (t: number) => {
      const bus = makeBus({ ...between(t), route_id: 1, last_stop_id: STOP.phelpsGate });
      return etaFor(
        computeUpcomingArrivals([38], [bus], routeStops, stopCoords, segmentTimes, NOW), 38,
      )!;
    };
    const early = etaAt(0.1);
    const late = etaAt(0.9);
    expect(late).toBeLessThan(early);
    expect(early).toBeGreaterThan(0);
  });
});

describe("segment statistics", () => {
  it("uses the calibrated mean when the route has observations", () => {
    // Blue Day has real segment data (n >= 1); Blue Weekend's are priors.
    const observed = Object.values(segmentTimes["1"]!).filter((s) => s.n >= 1);
    expect(observed.length).toBeGreaterThan(20);
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const [next] = computeUpcomingArrivals(
      [38], [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    const seg = segmentTimes["1"]![`${STOP.phelpsGate}-38`];
    expect(seg).toBeDefined();
    expect(next.eta).toBeLessThanOrEqual(seg!.avg + 0.001);
  });

  it("reports a confidence band around the point estimate", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    for (const a of computeUpcomingArrivals(
      [STOP.cedar333], [bus], routeStops, stopCoords, segmentTimes, NOW,
    )) {
      expect(a.low).toBeGreaterThanOrEqual(0);
      expect(a.low).toBeLessThanOrEqual(a.eta);
      expect(a.high).toBeGreaterThanOrEqual(a.eta);
    }
  });

  it("caps ETAs at 90 minutes rather than emitting lap-2 noise", () => {
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const all = computeUpcomingArrivals(
      blueDay, [bus], routeStops, stopCoords, segmentTimes, NOW,
    );
    expect(all.length).toBeGreaterThan(0);
    expect(Math.max(...all.map((a) => a.eta))).toBeLessThanOrEqual(90 * 60);
  });
});
