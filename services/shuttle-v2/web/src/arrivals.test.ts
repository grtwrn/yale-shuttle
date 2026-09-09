import { describe, expect, it } from "vitest";

import { computeUpcomingArrivals, nextArrivalAfterPinned, shownStandSec } from "./arrivals";
import { fromQuantiles } from "./eta/dist";
import type { StandingForecasts } from "./eta/standingForecast";
import type { DwellStat, DwellTimes, SegmentTimes } from "./arrivals";
import { at, makeBus, routeStops, segmentTimes, STOP, stopCoords } from "./__fixtures__/payload";

const NOW = new Date("2026-08-31T20:30:00Z").getTime();

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
  const WINCHESTER: DwellStat = {
    med: 574.9, sd: 279.8, n: 28,
    q: [112, 140, 145, 216, 294, 339, 440, 478, 538, 663],
    qn: 28,
  };
  const KERB: DwellStat = { med: 30, sd: 20, n: 40, q: [0, 12, 15, 18, 22, 26, 31, 40, 55, 90], qn: 40 };
  const ROUTE: Record<string, DwellStat> = { "11": WINCHESTER, "27": KERB };
  const STOOD = 180;

  it("keeps this visit's forecast total stable while conditioning its remaining wait", () => {
    const arrival = 4_000_000;
    const forecasts: StandingForecasts = new Map([[0, {
      prior: { history_available_at: 1, route_id: 3, route_pattern_id: "fixture", canonical_stop_ids: [11, 27],
        stop_id: 11, stop_index: 0, previous_departed_at: arrival - 3_000_000,
        observed_visit_start_at: arrival, fitted_at: 1, valid_until: 86_400_000,
        phase_slot_at: arrival + 600_000, phase_error_q: [-100, -80, -60, -40, -20, 0, 30, 60, 100, 180],
        phase_weight: 0.9, duration_dist: { xs: [0, 600], ps: [0, 0.95], tail_hazard: 0.01 } },
      duration: fromQuantiles(WINCHESTER.q!),
    }]]);
    const show = (elapsed: number) => shownStandSec(WINCHESTER, elapsed, ROUTE, undefined,
      { forecasts, stopId: 11, now: arrival + elapsed * 1000 })!;
    const early = show(30), later = show(300), overdue = show(900);
    expect(early.typicalSec).toBeGreaterThan(550);
    expect(later.typicalSec).toBe(early.typicalSec);
    expect(overdue.typicalSec).toBe(early.typicalSec);
    expect(later.sec).toBeLessThan(early.sec);
    expect(overdue.sec).toBeGreaterThan(0);
    expect(shownStandSec(KERB, 30, ROUTE, undefined, { forecasts, stopId: 27, now: arrival + 30_000 }))
      .toEqual(shownStandSec(KERB, 30, ROUTE));
  });

  it("says what is LEFT, not a total the rider has to subtract from", () => {
    const shown = shownStandSec(WINCHESTER, STOOD, ROUTE)!;
    expect(shown.remaining).toBe(true);
    // The chip used to print ~10 min (dwell.med, 574.9 s) beside a countdown
    // of 5 min. The quantiles above the 180 s already stood put the residual
    // median near 4 min, which IS what the rider was being told, less the drive.
    expect(shown.sec).toBeGreaterThan(120);
    expect(shown.sec).toBeLessThan(420);
    expect(shown.sec).toBeLessThan(WINCHESTER.med);
  });

  it("states the stop's typical hold beside it, and does not move it as the bus sits", () => {
    const early = shownStandSec(WINCHESTER, 60, ROUTE)!;
    const late = shownStandSec(WINCHESTER, 400, ROUTE)!;
    expect(late.sec).toBeLessThan(early.sec);
    expect(late.typicalSec).toBeCloseTo(early.typicalSec!, 6);
  });

  it("is the typical hold for a stop the bus is not standing at", () => {
    const shown = shownStandSec(WINCHESTER, null, ROUTE)!;
    expect(shown.remaining).toBe(false);
    expect(shown.typicalSec).toBeUndefined();
    expect(shown.sec).toBeCloseTo(shownStandSec(WINCHESTER, 0, ROUTE)!.typicalSec!, 6);
  });

  it("reads the same table the price does, network pools included", () => {
    // A thin table leans on a pool, and which pool it is decides the number.
    // The price takes the route's pool where it has one and the NETWORK's
    // where it does not (eta/tables.ts), so the chip must do the same or the
    // two disagree again. Same stat, same clock; the only difference is
    // whether the rest of the payload is in hand.
    const thin: DwellStat = { med: 40, sd: 20, n: 2, q: [10, 15, 20, 25, 30, 35, 45, 60, 80, 120], qn: 2 };
    const noTables: Record<string, DwellStat> = { "27": { med: 0, sd: 0, n: 0 } };
    const alone = shownStandSec(thin, 60, noTables)!;
    const pooled = shownStandSec(thin, 60, noTables, { "3": { "11": WINCHESTER, "27": KERB } })!;
    expect(pooled.sec).not.toBeCloseTo(alone.sec, 3);
  });

  it("says nothing when there is no table at all", () => {
    expect(shownStandSec(undefined, STOOD, ROUTE)).toBeNull();
    expect(shownStandSec({ med: 300, sd: 10, n: 4 }, STOOD, ROUTE)).toBeNull();
    expect(shownStandSec({ med: 300, sd: 10, n: 4, q: [10, 20] }, STOOD, ROUTE)).toBeNull();
  });
});

describe("every route the payload describes is priced", () => {
  // The retirement of the legacy arm (2026-09-06). `computeUpcomingArrivals`
  // used to hand two classes of route to a second arithmetic — a route with
  // no measured drive, and a ring whose published line could not be traced —
  // and both are now priced from the pooled priors on the ring. What still
  // declines is having no ring: fewer than two stops, or a stop with no
  // coordinate, and then there is nothing to price on either side.
  const POOLED_SPM = [0.0769, 0.0971, 0.1117, 0.1259, 0.1363, 0.1535, 0.1713, 0.1979, 0.2459, 0.3357];
  const bare = (stops: number[]): SegmentTimes[string] => {
    const out: SegmentTimes[string] = { __pace: { avg: 0, sd: 0, n: 0, spm: POOLED_SPM, spmN: 9077, spmPooled: true } };
    for (let i = 0; i < stops.length; i++) out[`${stops[i]}-${stops[(i + 1) % stops.length]}`] = { avg: 0, n: 0 };
    return out;
  };

  it("a line with no measured drive and no stand table still counts a bus down", () => {
    // The grocery lines' weekly state: rows in the payload, not one leg timed.
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const segs: SegmentTimes = { "1": bare(routeStops["1"]!) };
    const arrivals = computeUpcomingArrivals(
      [STOP.cedar333], [bus], routeStops, stopCoords, segs, NOW, {},
    );
    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(Number.isFinite(a.eta)).toBe(true);
      expect(a.eta).toBeGreaterThan(0);
      expect(a.low).toBeLessThanOrEqual(a.eta);
      expect(a.high).toBeGreaterThanOrEqual(a.eta);
      // ...and it says so: nothing on this chain was measured.
      expect(a.estimated).toBe(true);
    }
  });

  it("a measured line does not read as estimated", () => {
    // The same route with the served hop quantiles and stand tables on it.
    const stops = routeStops["1"]!;
    const segs: SegmentTimes = { "1": bare(stops) };
    const dwells: DwellTimes = { "1": {} };
    for (let i = 0; i < stops.length; i++) {
      segs["1"]![`${stops[i]}-${stops[(i + 1) % stops.length]}`] = {
        avg: 90, sd: 20, n: 50, drive: 70, driveN: 50,
        dq: [55, 60, 64, 67, 70, 73, 77, 83, 92, 110], dqn: 50,
      };
      dwells["1"]![String(stops[i])] = {
        med: 30, sd: 20, n: 50, q: [0, 12, 15, 18, 22, 26, 31, 40, 55, 90], qn: 50,
      };
    }
    const bus = makeBus({ ...at(STOP.phelpsGate), route_id: 1, last_stop_id: 42 });
    const arrivals = computeUpcomingArrivals(
      [STOP.cedar333], [bus], routeStops, stopCoords, segs, NOW, dwells,
    );
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.every((a) => !a.estimated)).toBe(true);
  });
});
