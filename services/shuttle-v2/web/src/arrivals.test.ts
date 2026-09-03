import { describe, expect, it } from "vitest";

import { billedDwellSec, computeUpcomingArrivals, dwellRangeLabel, STALL_CREDIT_MAX_FRACTION } from "./arrivals";
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
   * A layover the bus has NOT started is priced at a low quantile, not the
   * median. The operator's watchers found the board pessimistic by 3-5 min on
   * Blue, Red and Green whenever the estimate spanned a rest the bus had yet
   * to take, which is the direction that costs a rider the bus.
   *
   * Numbers below are Red's live calibration: the 344 Winchester hop averages
   * 452 s because the dwell there is 395 s (median) with a 35th percentile of
   * about 240 s; the drive is the ~57 s remainder.
   */
  describe("a rest the bus has not reached yet", () => {
    const LAYOVER_SEG = 452, DWELL_MED = 395, DWELL_LOW = 240;
    const segs: SegmentTimes = {
      "4": {
        // stopAndShop -> elmYorkTyco is the layover hop; the two beyond it are
        // quick, as they are on Red.
        [`${STOP.stopAndShop}-${STOP.elmYorkTyco}`]: { avg: LAYOVER_SEG, sd: 60, n: 34 },
        [`${STOP.elmYorkTyco}-${STOP.collegeWallN}`]: { avg: 26, sd: 8, n: 32 },
      },
    };
    const dwells: DwellTimes = {
      "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13, low: DWELL_LOW } },
    };
    // The bus is at York/Chapel, one hop BEFORE the layover stop.
    const approaching = () => makeBus({
      ...at(STOP.yorkChapel), route_id: 4, last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.yorkChapel, at_stop_since: dwellingSince(5),
    });

    it("bills the low quantile for the rest, not the median", () => {
      const eta = etaFor(
        computeUpcomingArrivals([STOP.collegeWallN], [approaching()], routeStops, stopCoords, segs, NOW, dwells),
        STOP.collegeWallN,
      )!;
      // Without this the layover hop costs the full 452 s; with it the rest is
      // priced at 240 s and the drive survives, so the estimate drops by about
      // the difference between the median and the low quantile.
      const withoutLow = etaFor(
        computeUpcomingArrivals([STOP.collegeWallN], [approaching()], routeStops, stopCoords, segs, NOW, {
          "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13 } },
        }),
        STOP.collegeWallN,
      )!;
      expect(withoutLow - eta).toBeGreaterThan(DWELL_MED - DWELL_LOW - 30);
      expect(eta).toBeLessThan(withoutLow);
    });

    it("still prices the driving, even when the hop is almost all rest", () => {
      // A pathological stop whose whole segment average is dwell: the estimate
      // must not collapse to the low quantile alone.
      const allDwell: DwellTimes = {
        "4": { [String(STOP.stopAndShop)]: { med: LAYOVER_SEG, sd: 150, n: 13, low: 60 } },
      };
      const eta = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [approaching()], routeStops, stopCoords, segs, NOW, allDwell),
        STOP.elmYorkTyco,
      )!;
      expect(eta).toBeGreaterThan(60);
    });

    it("does not touch the stop the bus is standing at", () => {
      // Step 1 is the anchor's own hop: its dwell is handled by the elapsed
      // credit, which knows how long the bus has really sat. Re-pricing it
      // here would double-count.
      const atLayover = makeBus({
        ...at(STOP.stopAndShop), route_id: 4, last_stop_id: STOP.yorkChapel,
        at_stop_id: STOP.stopAndShop, at_stop_since: dwellingSince(30),
      });
      const withLow = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [atLayover], routeStops, stopCoords, segs, NOW, dwells),
        STOP.elmYorkTyco,
      )!;
      const withoutLow = etaFor(
        computeUpcomingArrivals([STOP.elmYorkTyco], [atLayover], routeStops, stopCoords, segs, NOW, {
          "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13 } },
        }),
        STOP.elmYorkTyco,
      )!;
      expect(withLow).toBe(withoutLow);
    });

    it("is inert at a stop with no low quantile yet", () => {
      const noLow: DwellTimes = {
        "4": { [String(STOP.stopAndShop)]: { med: DWELL_MED, sd: 150, n: 13 } },
      };
      const a = etaFor(
        computeUpcomingArrivals([STOP.collegeWallN], [approaching()], routeStops, stopCoords, segs, NOW, noLow),
        STOP.collegeWallN,
      )!;
      const b = etaFor(
        computeUpcomingArrivals([STOP.collegeWallN], [approaching()], routeStops, stopCoords, segs, NOW),
        STOP.collegeWallN,
      )!;
      expect(a).toBe(b);
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

describe("billedDwellSec — one number, shown and billed (report #73)", () => {
  // A rider read the route page and did the arithmetic: "it says arrive in 8
  // but expected dwell is 10". Both numbers came from this app — the 10 was
  // the stop's MEDIAN hold on screen, the 8 was an ETA computed from the LOW
  // quantile. Displaying one while billing the other is a bug whichever is
  // right, so there is one definition now and the page calls it too.
  const rest = { med: 600, low: 420 };

  it("bills the low quantile for a stop still ahead", () => {
    expect(billedDwellSec(rest, false)).toBe(420);
  });

  it("bills the median at the stop the bus is standing at", () => {
    // Step 1 is where the elapsed-dwell credit lives, and it caps against the
    // median — so that is the honest number to show there.
    expect(billedDwellSec(rest, true)).toBe(600);
  });

  it("falls back to the median when no low quantile exists yet", () => {
    // A stop the calibrator has not placed a quantile for.
    expect(billedDwellSec({ med: 240 }, false)).toBe(240);
  });

  it("never bills a low quantile that exceeds the median", () => {
    // The calibrator clamps this, but the display must not depend on that.
    expect(billedDwellSec({ med: 200, low: 260 }, false)).toBe(200);
  });

  it("says nothing when there is no statistic at all", () => {
    expect(billedDwellSec(undefined, false)).toBeNull();
    expect(billedDwellSec({ med: NaN }, false)).toBeNull();
  });
});

describe("dwellRangeLabel — the badge must not jump as the bus pulls in (report #77)", () => {
  // Red / 344 Winchester as production served it on 2026-09-03.
  const winchester = { med: 575.1, low: 325.3 };

  it("does not change when the bus arrives", () => {
    // The whole report: "it said it would be five minutes dwell, but once it
    // got there, it went to a nine minute dwell". One label, both states.
    const ahead = dwellRangeLabel(winchester);
    const standing = dwellRangeLabel(winchester);
    expect(ahead).toBe(standing);
    expect(ahead).toBe("5-10 min");
  });

  it("spans both numbers the arithmetic bills (report #73 still holds)", () => {
    const label = dwellRangeLabel(winchester)!;
    const [lo, hi] = label.replace(" min", "").split("-").map(Number);
    expect(lo).toBe(Math.round(billedDwellSec(winchester, false)! / 60));
    expect(hi).toBe(Math.round(billedDwellSec(winchester, true)! / 60));
  });

  it("collapses to one figure when the two bills round together", () => {
    expect(dwellRangeLabel({ med: 300, low: 290 })).toBe("5 min");
  });

  it("collapses when the calibrator has placed no low quantile yet", () => {
    expect(dwellRangeLabel({ med: 600 })).toBe("10 min");
  });

  it("never prints a low bound above the median", () => {
    // billedDwellSec clamps this; the label must not depend on that.
    expect(dwellRangeLabel({ med: 200, low: 260 })).toBe("3 min");
  });

  it("never prints '0 min' for a short hold", () => {
    expect(dwellRangeLabel({ med: 200, low: 20 })).toBe("1-3 min");
  });

  it("keeps sub-minute holds in seconds, with no spread", () => {
    expect(dwellRangeLabel({ med: 40, low: 12 })).toBe("40s");
  });

  it("says nothing when there is no statistic", () => {
    expect(dwellRangeLabel(undefined)).toBeNull();
    expect(dwellRangeLabel({ med: NaN })).toBeNull();
  });
});
