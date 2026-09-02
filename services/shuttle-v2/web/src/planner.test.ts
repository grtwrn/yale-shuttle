import { describe, expect, it } from "vitest";

import { remainingSec } from "./format";
import { haversineMeters, type LatLon } from "./geo";
import type { BusData } from "./map-data";
import { computeUpcomingArrivals } from "./arrivals";
import {
  ALT_PICKUP_MIN_GAIN_SEC, alternatePickup, dwellBoardWindowSec, findPotentialRoutes, MAX_ALTERNATES,
  MAX_RIDE_SEC, PIN_SWITCH_MARGIN_SEC, pickLiveArrival, planTrip, THIRD_SHUTTLE_SLACK_SEC, topVisibleOptions,
  type TripOption,
} from "./planner";
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
    // The bus is AT the stop: its own arrival is now, not "walk-time from now".
    expect(shuttle!.busEtaSec).toBe(0);
  });
});

// Report #49: a rider standing AT their board stop watched their pinned Blue
// pass, and the card told them to wait for it to come back around (a full lap,
// 20-40 min) even though a second Blue was minutes away. At the stop the walk
// is 0, so the old inline canCatch(pinned) — 0 <= eta + 60 — held for ANY eta
// and the loyalty never broke; the ~20 s "recovery" the rider saw was a GPS
// jitter incidentally re-running planTrip. pickLiveArrival now breaks the pin
// when a DIFFERENT catchable bus wins by PIN_SWITCH_MARGIN_SEC, and being
// stateless it does so within the same poll.
describe("pickLiveArrival", () => {
  const arr = (busName: string, eta: number) => ({ busName, eta });

  it("switches off a passed pinned bus in the same poll when another bus is far better", () => {
    // #101 just passed: its next arrival is a lap away. #202 is 3.7 min out.
    const live = [arr("202", 220), arr("101", 2440)];
    const pick = pickLiveArrival(live, "101", 0)!;
    expect(pick.match.busName).toBe("202");
    expect(pick.departed).toBe(false);
    // Not a "missed bus" — #101 is still catchable (a lap later), just
    // dominated. No false "You can't catch #101" banner.
    expect(pick.missedBus).toBeUndefined();
  });

  it("keeps a passed bus on a single-bus route — the honest come-around wait", () => {
    // Second-lap entries carry the same name: that is the same vehicle, and
    // there is nothing better to switch to.
    const live = [arr("101", 1500)];
    const pick = pickLiveArrival(live, "101", 0)!;
    expect(pick.match.busName).toBe("101");
    expect(pick.departed).toBe(false);
  });

  it("stays loyal between near-equivalent buses so ETA noise cannot flap the card", () => {
    const live = [arr("202", 200), arr("101", 200 + PIN_SWITCH_MARGIN_SEC - 1)];
    expect(pickLiveArrival(live, "101", 0)!.match.busName).toBe("101");
    // ...and the margin is inclusive at exactly the boundary.
    const boundary = [arr("202", 200), arr("101", 200 + PIN_SWITCH_MARGIN_SEC)];
    expect(pickLiveArrival(boundary, "101", 0)!.match.busName).toBe("202");
  });

  it("still tolerates GPS reading long: borderline-uncatchable pinned bus is kept", () => {
    // walk 150 s vs eta 30 s: past catchable (30 + 60) but inside the 90 s
    // switch buffer (30 + 60 + 90) — the spurious-flip guard from before.
    const live = [arr("101", 30), arr("202", 500)];
    const pick = pickLiveArrival(live, "101", 150)!;
    expect(pick.match.busName).toBe("101");
    expect(pick.departed).toBe(false);
  });

  it("flags a genuinely missed different bus when advancing to a later one", () => {
    // walk 400 s: #101 at 100 s is gone before the rider arrives (and past
    // the buffer); #202 at 400 s is makeable.
    const live = [arr("101", 100), arr("202", 400)];
    const pick = pickLiveArrival(live, "101", 400)!;
    expect(pick.match.busName).toBe("202");
    expect(pick.missedBus).toBe("101");
    expect(pick.departed).toBe(false);
  });

  it("declares departed only when nothing is catchable", () => {
    const pick = pickLiveArrival([arr("101", 100)], "101", 1000)!;
    expect(pick.departed).toBe(true);
    expect(pick.match.busName).toBe("101");
    expect(pickLiveArrival([], "101", 0)).toBeNull();
  });

  it("report #49 end-to-end: the pick leaves the passed bus the poll it passes", () => {
    // Real geometry: #101 just past Phelps Gate heading to College/Crown,
    // #202 trailing between Peabody and Temple/Grove. Rider at the stop.
    const past = { lat: (at(STOP.phelpsGate).lat + at(38).lat) / 2, lon: (at(STOP.phelpsGate).lon + at(38).lon) / 2 };
    const behind = { lat: (at(STOP.peabody).lat + at(118).lat) / 2, lon: (at(STOP.peabody).lon + at(118).lon) / 2 };
    const buses = [
      makeBus({ ...past, route_id: 1, bus_name: "#101", bus_id: 1, last_stop_id: STOP.phelpsGate }),
      makeBus({ ...behind, route_id: 1, bus_name: "#202", bus_id: 2, last_stop_id: STOP.peabody }),
    ];
    const live = computeUpcomingArrivals([STOP.phelpsGate], buses, routeStops, stopCoords, segmentTimes, NOW)
      .filter((a) => a.routeLabel === "Blue Day");
    const pick = pickLiveArrival(live, "101", 0)!;
    expect(pick.match.busName).toBe("202");
    expect(pick.match.eta).toBeLessThan(10 * 60);
    expect(pick.departed).toBe(false);
  });
});

// Report #48: the collapsed card's "🚌 in …" showed walkToSec + waitSec, and
// waitSec = max(0, busEta - walk) clamps at 0 once the bus will beat the rider
// to the stop — so the display froze at the constant walk time ("in 1:49" for
// over a minute) while the bus visibly closed in. The option must therefore
// carry the pinned bus's own arrival (busEtaSec, stamped computedAtMs) for the
// renderer to count down instead.
describe("report #48: the pinned bus's arrival keeps moving", () => {
  const from = northOf(STOP.phelpsGate, 66); // ~60 s walk to the board stop
  const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
  /** A Blue Day bus part-way along the final segment into Phelps Gate. */
  const approaching = (t: number) => {
    const a = at(42), b = at(STOP.phelpsGate); // College/Wall (S) → Phelps Gate
    return makeBus({
      lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t,
      route_id: 1, last_stop_id: 42,
    });
  };
  const blueOpt = (t: number) => {
    const o = plan(from, to, [approaching(t)]).find(
      (x) => x.mode === "shuttle" && x.boardStopId === STOP.phelpsGate,
    );
    expect(o).toBeDefined();
    return o!;
  };

  it("stamps every live shuttle option with busEtaSec and computedAtMs", () => {
    const o = blueOpt(0.4);
    expect(o.busEtaSec).toBeGreaterThan(0);
    expect(o.computedAtMs).toBe(NOW);
  });

  it("busEtaSec strictly decreases as the bus advances, even while the old walk-clamped sum sits frozen", () => {
    const near = blueOpt(0.4);
    const nearer = blueOpt(0.7);
    // Preconditions: both positions are inside the frozen regime — the bus
    // arrives before the rider can walk there, so waitSec is clamped to 0.
    expect(near.busEtaSec!).toBeLessThan(near.walkToSec);
    expect(nearer.busEtaSec!).toBeLessThan(nearer.walkToSec);
    expect(near.waitSec).toBe(0);
    expect(nearer.waitSec).toBe(0);
    // The old displayed value — walk + wait — is identical at both positions:
    // this constant is exactly what report #48 watched for a minute.
    expect(nearer.walkToSec + nearer.waitSec).toBe(near.walkToSec + near.waitSec);
    // The value the card now renders keeps falling as the bus closes in.
    expect(nearer.busEtaSec!).toBeLessThan(near.busEtaSec!);
  });

  it("the rendered countdown also falls with wall-clock time between polls", () => {
    const o = blueOpt(0.4);
    const atPoll = remainingSec(o.busEtaSec!, o.computedAtMs, NOW);
    const fourSecLater = remainingSec(o.busEtaSec!, o.computedAtMs, NOW + 4_000);
    expect(atPoll).toBe(o.busEtaSec);
    expect(fourSecLater).toBe(o.busEtaSec! - 4);
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

  it("flags a route the schedule says is running right now", () => {
    // 07:02 on a Wednesday: Blue Day opened two minutes ago and no bus is in
    // the feed yet. The panel must say "should be running", not "Next: Thu".
    const wed0702 = new Date("2026-09-02T07:02:00-04:00");
    const found = findPotentialRoutes(from, to, routeStops, stopCoords, wed0702);
    const day = found.find((r) => r.label === "Blue Day")!;
    const weekend = found.find((r) => r.label === "Blue Weekend")!;
    expect(day.activeNow).toBe(true);
    expect(weekend.activeNow).toBe(false);
    // Active-now routes lead the list even though their nextActive is later.
    expect(found[0]!.activeNow).toBe(true);
  });

  it("returns nothing for a destination no route reaches", () => {
    expect(findPotentialRoutes(
      { lat: 41.20, lon: -72.90 }, { lat: 41.25, lon: -72.90 },
      routeStops, stopCoords, new Date(NOW),
    )).toEqual([]);
  });
});

describe("topVisibleOptions", () => {
  const opt = (mode: "shuttle" | "walk", label: string, totalSec: number) =>
    ({ mode, routeLabel: label, totalSec } as unknown as import("./planner").TripOption);

  it("keeps a third shuttle that is nearly as good as the second (report #46)", () => {
    // The live case: Red 17 min, walk 31, Orange 34, Blue 35 — Blue is one
    // minute behind Orange with far less walking and must be visible.
    const sorted = [
      opt("shuttle", "Red", 17 * 60), opt("walk", "Walk", 31 * 60),
      opt("shuttle", "Orange Day", 34 * 60), opt("shuttle", "Blue Day", 35 * 60),
    ];
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel))
      .toEqual(["Red", "Walk", "Orange Day", "Blue Day"]);
  });

  it("drops a distant third shuttle", () => {
    const sorted = [
      opt("shuttle", "Red", 17 * 60), opt("walk", "Walk", 31 * 60),
      opt("shuttle", "Orange Day", 34 * 60), opt("shuttle", "Green", 55 * 60),
    ];
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel))
      .toEqual(["Red", "Walk", "Orange Day"]);
  });

  it("draws the line at the slack boundary", () => {
    const sorted = [
      opt("shuttle", "A", 1000), opt("shuttle", "B", 2000),
      opt("shuttle", "C", 2000 + THIRD_SHUTTLE_SLACK_SEC),
      opt("shuttle", "D", 2000 + THIRD_SHUTTLE_SLACK_SEC),
    ];
    // C squeaks in at exactly the boundary; D never shows — the rule is top
    // three shuttles at most, however similar the rest are.
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["A", "B", "C"]);
  });

  it("passes walk rows through untouched, wherever they sort", () => {
    const sorted = [opt("walk", "Walk", 600), opt("shuttle", "A", 900)];
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["Walk", "A"]);
  });

  it("handles fewer than three shuttles", () => {
    const sorted = [opt("shuttle", "A", 900), opt("walk", "Walk", 1200)];
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["A", "Walk"]);
  });
});

// Report #55: "sometimes the shuttle loops around my pickup location so
// multiple stops could work — if I miss the Blue at Prospect/Canner I could
// pick it up on Whitney/Canner." Blue Day runs 100 → 102 → 105 → 69 → 139 →
// 136 → 130 → 129: seven stops and ~401 s of driving between two stops 512 m
// apart on the ground. planTrip scores both and keeps one; the live layer then
// re-derives against the FROZEN board stop and only ever switches vehicle. So a
// rider who watches the bus leave Prospect/Canner is told to wait a lap.
describe("report #55: alternate board stops on the same route", () => {
  const PROSPECT_CANNER = 100;
  const WHITNEY_CANNER = 129;
  const PROSPECT_HIGHLAND = 102;
  const DIVINITY = 47;
  /** `m` metres east of a stop — down Canner St, toward Whitney. */
  const eastOf = (stopId: number, m: number) =>
    ({ lat: at(stopId).lat, lon: at(stopId).lon + m / 84_000 });
  /** A Blue Day bus a fraction `t` of the way from stop `a` to stop `b`. */
  const between = (a: number, b: number, t: number, over: Partial<BusData> = {}) => makeBus({
    lat: at(a).lat + (at(b).lat - at(a).lat) * t,
    lon: at(a).lon + (at(b).lon - at(a).lon) * t,
    route_id: 1, last_stop_id: a, bus_name: "#101", ...over,
  });
  const from = eastOf(PROSPECT_CANNER, 150);
  const to = { lat: at(STOP.phelpsGate).lat, lon: at(STOP.phelpsGate).lon - 0.001 };
  /**
   * Plan while the bus is still four stops up the line (Prospect/Sachem →
   * Chemistry, ~3.4 min out): Prospect/Canner is catchable, so it is kept.
   */
  const approaching = () => between(STOP.prospectSachemN, 34, 0.5);
  const blueOption = (buses = [approaching()]) => {
    const o = plan(from, to, buses).find((x) => x.mode === "shuttle" && x.routeLabel === "Blue Day");
    expect(o).toBeDefined();
    expect(o!.boardStopId).toBe(PROSPECT_CANNER);
    return o!;
  };
  /**
   * What the live layer in TransitMap does each poll: re-derive wait/total for
   * the option's frozen board stop against the buses now in the feed.
   */
  const liveState = (o: TripOption, buses: BusData[]): TripOption => {
    const live = computeUpcomingArrivals([o.boardStopId], buses, routeStops, stopCoords, segmentTimes, NOW)
      .filter((a) => a.routeLabel === o.routeLabel);
    const picked = pickLiveArrival(live, o.busName, o.walkToSec);
    if (!picked) return { ...o, departed: true };
    const waitSec = Math.max(0, picked.match.eta - o.walkToSec);
    return {
      ...o, waitSec, totalSec: o.walkToSec + waitSec + o.rideSec + o.walkFromSec,
      busName: picked.match.busName, departed: picked.departed, missedBus: picked.missedBus,
      busEtaSec: picked.match.eta, computedAtMs: NOW,
    };
  };
  const alt = (o: TripOption, buses: BusData[], liveFrom?: LatLon) =>
    alternatePickup(o, buses, routeStops, stopCoords, segmentTimes, dwellTimes, NOW, liveFrom);

  describe("planTrip keeps the losing same-route board stops", () => {
    it("lists Whitney/Canner as an alternate to Prospect/Canner with its real walk", () => {
      const o = blueOption();
      const whitney = o.alternates?.find((a) => a.boardStopId === WHITNEY_CANNER);
      expect(whitney).toBeDefined();
      expect(whitney!.walkToSec).toBeCloseTo(walkSecFromMeters(haversineMeters(from, at(WHITNEY_CANNER))), 6);
      // A ride from seven stops further round the loop is shorter by that much.
      expect(whitney!.rideSec).toBeLessThan(o.rideSec);
      expect(whitney!.alightStopId).toBe(o.alightStopId);
    });

    it("alternates are distinct other stops, nearest walk first, capped", () => {
      const o = blueOption();
      const ids = o.alternates!.map((a) => a.boardStopId);
      expect(ids).not.toContain(o.boardStopId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(MAX_ALTERNATES);
      const walks = o.alternates!.map((a) => a.walkToSec);
      expect([...walks].sort((a, b) => a - b)).toEqual(walks);
      expect(ids).toEqual([DIVINITY, PROSPECT_HIGHLAND, WHITNEY_CANNER]);
    });

    it("keeps the ranking and the one-option-per-route shape unchanged", () => {
      const options = plan(from, to, [approaching()]);
      const labels = options.filter((o) => o.mode === "shuttle").map((o) => o.routeLabel);
      expect(new Set(labels).size).toBe(labels.length);
      expect(options.map((o) => o.totalSec)).toEqual([...options.map((o) => o.totalSec)].sort((a, b) => a - b));
      expect(options.find((o) => o.mode === "walk")!.alternates).toBeUndefined();
    });

    it("has no alternates when the route offers a single board stop", () => {
      // Far enough north that exactly one Blue Day stop is within MAX_WALK_M.
      const lonely = northOf(105, 1_490);
      const reachable = routeStops["1"].filter((s) => haversineMeters(lonely, at(s)) <= MAX_WALK_M);
      expect(reachable).toEqual([105]);
      const o = plan(lonely, to, [approaching()])
        .find((x) => x.mode === "shuttle" && x.routeLabel === "Blue Day");
      expect(o).toBeDefined();
      expect(o!.boardStopId).toBe(105);
      expect(o!.alternates).toBeUndefined();
    });
  });

  describe("alternatePickup", () => {
    it("names Whitney/Canner once the bus has left Prospect/Canner", () => {
      const planned = blueOption();
      const justPast = [between(PROSPECT_CANNER, PROSPECT_HIGHLAND, 0.1)];
      const o = liveState(planned, justPast);
      // The single-bus state the departed/missedBus flags never see: the card
      // now quietly promises the same bus a full lap later.
      expect(o.departed).toBe(false);
      expect(o.missedBus).toBeUndefined();
      expect(o.busEtaSec!).toBeGreaterThan(30 * 60);

      const pick = alt(o, justPast);
      expect(pick).not.toBeNull();
      expect(pick!.stopId).toBe(WHITNEY_CANNER);
      expect(pick!.busName).toBe("101");
      // The rider must be able to reach it: eta + dwell slack covers the walk.
      expect(pick!.walkSec).toBeLessThanOrEqual(pick!.busEtaSec + 60);
      expect(pick!.walkSec).toBeCloseTo(walkSecFromMeters(haversineMeters(from, at(WHITNEY_CANNER))), 6);
      expect(pick!.busEtaSec).toBeLessThan(8 * 60);
      // ...and it beats staying put by well over the margin.
      const whitney = planned.alternates!.find((a) => a.boardStopId === WHITNEY_CANNER)!;
      const viaWhitney = Math.max(pick!.walkSec, pick!.busEtaSec) + whitney.rideSec + whitney.walkFromSec;
      expect(o.totalSec - viaWhitney).toBeGreaterThan(ALT_PICKUP_MIN_GAIN_SEC);
      expect(pick!.computedAtMs).toBe(NOW);
    });

    it("declines a departed option rather than compare against a stale total", () => {
      // departed = nothing catchable within the 90-min horizon, so the option's
      // totalSec is plan-time data and no alternate can be judged against it.
      // Without this the nearest alternate (Divinity, bus a lap away) "won".
      const justPast = [between(PROSPECT_CANNER, PROSPECT_HIGHLAND, 0.1)];
      const o = { ...liveState(blueOption(), justPast), departed: true };
      expect(alt(o, justPast)).toBeNull();
    });

    it("is null when the bus is already past every alternate too", () => {
      const planned = blueOption();
      const gone = [between(140, 133, 0.5)]; // past Whitney/Canner, heading to Cottage
      const o = liveState(planned, gone);
      expect(alt(o, gone)).toBeNull();
    });

    it("is null when the walk to the alternate is too long to make the bus", () => {
      const planned = blueOption();
      const justPast = [between(PROSPECT_CANNER, PROSPECT_HIGHLAND, 0.1)];
      const o = liveState(planned, justPast);
      // The rider's live position has drifted 700 m west: Whitney/Canner is
      // now a 1.2 km walk against a ~6.5 min bus.
      const farWest = { lat: at(PROSPECT_CANNER).lat, lon: at(PROSPECT_CANNER).lon - 700 / 84_000 };
      expect(walkSecFromMeters(haversineMeters(farWest, at(WHITNEY_CANNER)))).toBeGreaterThan(10 * 60);
      expect(alt(o, justPast, farWest)).toBeNull();
      // Same feed, rider where they planned from: it fires.
      expect(alt(o, justPast, from)?.stopId).toBe(WHITNEY_CANNER);
    });

    it("stays quiet while the pinned bus is still catchable at the rider's stop", () => {
      const feed = [approaching()];
      const o = liveState(blueOption(feed), feed);
      expect(o.departed).toBe(false);
      expect(alt(o, feed)).toBeNull();
    });

    it("is null for options without alternates and for the walk", () => {
      const options = plan(from, to, [between(PROSPECT_CANNER, PROSPECT_HIGHLAND, 0.1)]);
      const walk = options.find((o) => o.mode === "walk")!;
      expect(alt(walk, [])).toBeNull();
      const bare = { ...blueOption(), alternates: undefined };
      expect(alt(bare, [between(PROSPECT_CANNER, PROSPECT_HIGHLAND, 0.1)])).toBeNull();
    });
  });
});

describe("report #55: alternates skip stops the loop visits twice", () => {
  it("offers no alternate at a repeated stop", () => {
    // Synthetic out-and-back on Blue Day's id: York/Chapel is listed twice,
    // so an alternate there could not say which pass the bus is on.
    const stops = routeStops["1"]!;
    const twice = [...stops, STOP.yorkChapel];
    const from = northOf(STOP.phelpsGate, 110);
    const to = { lat: at(STOP.cedar333).lat, lon: at(STOP.cedar333).lon - 0.002 };
    const bus = makeBus({ route_id: 1, bus_name: "#77", ...at(stops[stops.length - 3]!) });
    const opts = planTrip(from, to, [bus], { ...routeStops, "1": twice }, stopCoords, segmentTimes, dwellTimes, undefined, NOW);
    const blue = opts.find((o) => o.mode === "shuttle" && o.routeLabel === "Blue Day");
    if (blue?.alternates) {
      expect(blue.alternates.map((a) => a.boardStopId)).not.toContain(STOP.yorkChapel);
    }
    // Sanity: the same trip on the unmodified list may offer York/Chapel.
    const plain = planTrip(from, to, [bus], routeStops, stopCoords, segmentTimes, dwellTimes, undefined, NOW)
      .find((o) => o.mode === "shuttle" && o.routeLabel === "Blue Day");
    expect(plain).toBeDefined();
  });
});
