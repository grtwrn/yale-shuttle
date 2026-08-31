import { describe, expect, it } from "vitest";

import { haversineMeters } from "./geo";
import { dwellBoardWindowSec, findPotentialRoutes, MAX_RIDE_SEC, planTrip } from "./planner";
import { HEADWAY_MIN } from "./schedule";
import { MAX_WALK_M, WALK_ONLY_MAX_SEC, walkSecFromMeters } from "./walk";
import {
  at, dwellTimes, makeBus, routeStops, segmentTimes, STOP, stopCoords,
} from "./__fixtures__/payload";

// Monday 16:30 ET — Blue Day is in service, Blue Weekend is not.
const NOW = new Date("2026-08-31T20:30:00Z").getTime();

/** A live Blue Day bus parked at the top of the loop. */
const liveBus = () => makeBus({ ...at(STOP.prospectSachemN), route_id: 1, last_stop_id: 108 });

const plan = (
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  buses = [liveBus()],
  targetDate: Date | null = null,
) => planTrip(from, to, buses, routeStops, stopCoords, segmentTimes, dwellTimes, targetDate, NOW);

/** `m` metres north of a stop. */
const northOf = (stopId: number, m: number) =>
  ({ lat: at(stopId).lat + m / 111_000, lon: at(stopId).lon });

describe("planTrip: the walk option", () => {
  // Report #35: a 4.3 km trip returned a bare "No trip options found between
  // these locations" while the server planner had a perfectly good 53-minute
  // walk. The one-hour cutoff on the walk suggestion is there to remove
  // CLUTTER; it must never remove the last remaining option.
  it("keeps the walk even past the one-hour cutoff when nothing else exists", () => {
    // Eleven km south of campus — no shuttle stop within walking distance.
    const from = { lat: 41.20, lon: -72.90 };
    const to = { lat: 41.25, lon: -72.90 };
    const directSec = walkSecFromMeters(haversineMeters(from, to));
    expect(directSec).toBeGreaterThan(WALK_ONLY_MAX_SEC);

    const options = plan(from, to);
    expect(options).toHaveLength(1);
    expect(options[0].mode).toBe("walk");
    expect(options[0].totalSec).toBeCloseTo(directSec, 6);
  });

  it("suppresses a 60+ min walk once a shuttle option exists", () => {
    const from = northOf(105, 1_400);            // 1.4 km N of Prospect/Huntington
    const to = northOf(STOP.cedar333, -1_400);   // 1.4 km S of 333 Cedar
    expect(walkSecFromMeters(haversineMeters(from, to))).toBeGreaterThan(WALK_ONLY_MAX_SEC);

    const options = plan(from, to);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.mode === "walk")).toBe(false);
    expect(options.every((o) => o.mode === "shuttle")).toBe(true);
  });

  it("offers the walk for an ordinary short trip", () => {
    const from = northOf(STOP.phelpsGate, 110);
    const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
    const options = plan(from, to);
    const walk = options.find((o) => o.mode === "walk");
    expect(walk).toBeDefined();
    expect(walk!.totalSec).toBeCloseTo(walkSecFromMeters(haversineMeters(from, to)), 6);
  });
});

describe("planTrip: walking dominance", () => {
  it("drops an option that walks further than the whole trip", () => {
    // Origin and destination 40 m apart, both beside Phelps Gate: every
    // shuttle pairing means walking at least as far as simply walking there.
    const from = at(STOP.phelpsGate);
    const to = northOf(STOP.phelpsGate, 40);
    const options = plan(from, to);
    expect(options).toHaveLength(1);
    expect(options[0].mode).toBe("walk");
  });

  // Report #15: an option that is merely SLOWER than walking is kept on
  // purpose — the rider asked to see the routes — and the picker labels it.
  // Only "more walking than the direct walk" removes an option.
  it("keeps a shuttle option that is slower than walking but walks less", () => {
    const from = northOf(STOP.phelpsGate, 110);
    const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
    const options = plan(from, to);
    const shuttle = options.find((o) => o.mode === "shuttle");
    expect(shuttle).toBeDefined();
    // Slower overall than just walking...
    expect(shuttle!.totalSec).toBeGreaterThan(shuttle!.directWalkSec);
    // ...but it survives because its walking legs are shorter than the walk.
    expect(shuttle!.walkToSec + shuttle!.walkFromSec).toBeLessThan(shuttle!.directWalkSec);
  });

  it("never returns a surviving option whose walk legs beat the direct walk", () => {
    const from = northOf(STOP.phelpsGate, 110);
    const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
    for (const o of plan(from, to)) {
      if (o.mode !== "shuttle") continue;
      expect(o.walkToSec + o.walkFromSec).toBeLessThan(o.directWalkSec);
    }
  });
});

describe("planTrip: option shape", () => {
  const from = northOf(STOP.phelpsGate, 110);
  const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };

  it("returns options sorted by total time", () => {
    const totals = plan(from, to).map((o) => o.totalSec);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });

  it("emits at most one option per route", () => {
    const labels = plan(from, to).filter((o) => o.mode === "shuttle").map((o) => o.routeLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("keeps totalSec equal to the sum of its legs", () => {
    for (const o of plan(from, to)) {
      if (o.mode === "walk") {
        // The walk option carries its whole duration in totalSec — the leg
        // fields describe a shuttle trip and stay zero.
        expect(o.totalSec).toBe(o.directWalkSec);
        continue;
      }
      expect(o.totalSec).toBeCloseTo(o.walkToSec + o.waitSec + o.rideSec + o.walkFromSec, 6);
    }
  });

  it("never proposes a ride longer than MAX_RIDE_SEC", () => {
    for (const o of plan(from, to)) expect(o.rideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
  });

  it("never proposes a walk leg longer than MAX_WALK_M", () => {
    const maxWalkSec = walkSecFromMeters(MAX_WALK_M);
    for (const o of plan(from, to)) {
      expect(o.walkToSec).toBeLessThanOrEqual(maxWalkSec);
      expect(o.walkFromSec).toBeLessThanOrEqual(maxWalkSec);
    }
  });

  it("names the bus it pinned", () => {
    const shuttle = plan(from, to).find((o) => o.mode === "shuttle");
    expect(shuttle!.busName).toBe("101");
  });

  it("returns walk-only when no bus is running", () => {
    const options = plan(from, to, []);
    expect(options).toHaveLength(1);
    expect(options[0].mode).toBe("walk");
  });
});

describe("planTrip: a bus already dwelling at the board stop", () => {
  // Report #28: a bus parked 13 m from the board stop emitted no ETA for its
  // own stop, so every pairing that boarded there was silently discarded and
  // the planner missed the fastest route entirely.
  it("boards a dwelling bus with zero wait", () => {
    const from = northOf(STOP.phelpsGate, 30);
    const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
    const dwelling = makeBus({
      ...at(STOP.phelpsGate), route_id: 1, bus_name: "#209",
      last_stop_id: 42, at_stop_id: STOP.phelpsGate,
      at_stop_since: new Date(NOW - 30_000).toISOString().replace("Z", ""),
    });
    const shuttle = plan(from, to, [dwelling]).find((o) => o.mode === "shuttle");
    expect(shuttle).toBeDefined();
    expect(shuttle!.boardStopId).toBe(STOP.phelpsGate);
    expect(shuttle!.waitSec).toBe(0);
    expect(shuttle!.busName).toBe("209");
  });
});

describe("dwellBoardWindowSec", () => {
  const bus = (secondsAgo: number) => makeBus({
    ...at(STOP.phelpsGate), route_id: 1,
    at_stop_id: STOP.phelpsGate,
    at_stop_since: new Date(NOW - secondsAgo * 1000).toISOString().replace("Z", ""),
  });

  it("floors at 120 s of boarding slack", () => {
    expect(dwellBoardWindowSec(bus(0), "1", 99_999, dwellTimes, NOW)).toBe(120);
  });

  it("stretches for a layover stop with a long calibrated dwell", () => {
    // Find a stop on Blue Day whose median dwell has enough samples to count.
    const entry = Object.entries(dwellTimes["1"]!).find(([, d]) => d.n >= 2 && d.med > 120);
    expect(entry).toBeDefined();
    const [stopId, d] = entry!;
    const window = dwellBoardWindowSec(bus(0), "1", Number(stopId), dwellTimes, NOW);
    expect(window).toBeCloseTo(d.med + 60, 6);
    // Once the bus has been sitting there longer than the median, the window
    // collapses back to the floor.
    expect(dwellBoardWindowSec(bus(d.med + 60), "1", Number(stopId), dwellTimes, NOW)).toBe(120);
  });
});

describe("planTrip: planning for a future time", () => {
  // Saturday 2026-09-05, 12:00 ET.
  const saturdayNoon = new Date("2026-09-05T16:00:00Z");
  const from = northOf(STOP.phelpsGate, 110);
  const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };

  it("ignores live buses and uses half the published headway", () => {
    const options = planTrip(
      from, to, [], routeStops, stopCoords, segmentTimes, dwellTimes, saturdayNoon, NOW,
    ).filter((o) => o.mode === "shuttle");
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      expect(o.waitSec).toBe((HEADWAY_MIN[o.routeLabel] ?? 15) * 30);
      expect(o.busName).toBe("");
    }
  });

  it("only offers routes that actually run at that time", () => {
    const saturday = planTrip(
      from, to, [], routeStops, stopCoords, segmentTimes, dwellTimes, saturdayNoon, NOW,
    ).map((o) => o.routeLabel);
    expect(saturday).toContain("Blue Weekend");
    expect(saturday).not.toContain("Blue Day");

    // Monday 12:00 ET flips the pair.
    const mondayNoon = new Date("2026-09-07T16:00:00Z");
    const monday = planTrip(
      from, to, [], routeStops, stopCoords, segmentTimes, dwellTimes, mondayNoon, NOW,
    ).map((o) => o.routeLabel);
    expect(monday).toContain("Blue Day");
    expect(monday).not.toContain("Blue Weekend");
  });
});

describe("findPotentialRoutes", () => {
  const from = northOf(STOP.phelpsGate, 110);
  const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };

  it("lists routes that connect the two points regardless of service hours", () => {
    const found = findPotentialRoutes(from, to, routeStops, stopCoords, new Date(NOW));
    const labels = found.map((r) => r.label);
    // Blue Weekend does not run on a Monday afternoon, but it still goes there
    // — that is the whole point of this fallback.
    expect(labels).toContain("Blue Weekend");
    expect(labels).toContain("Blue Day");
  });

  it("annotates each route with its schedule and next opening", () => {
    const found = findPotentialRoutes(from, to, routeStops, stopCoords, new Date(NOW));
    const weekend = found.find((r) => r.label === "Blue Weekend")!;
    expect(weekend.schedule).toBe("Sa/Su 7a–6p");
    expect(weekend.nextActive!.getTime()).toBeGreaterThan(NOW);
    expect(stopCoords[weekend.boardStopId]).toBeDefined();
    expect(stopCoords[weekend.alightStopId]).toBeDefined();
  });

  it("sorts by next opening, soonest first", () => {
    const found = findPotentialRoutes(from, to, routeStops, stopCoords, new Date(NOW));
    const times = found.map((r) => r.nextActive?.getTime() ?? Infinity);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("returns nothing for a destination no route reaches", () => {
    expect(findPotentialRoutes(
      { lat: 41.20, lon: -72.90 }, { lat: 41.25, lon: -72.90 },
      routeStops, stopCoords, new Date(NOW),
    )).toEqual([]);
  });
});
