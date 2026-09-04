import { describe, expect, it } from "vitest";

import { remainingSec } from "./format";
import { haversineMeters } from "./geo";
import { computeUpcomingArrivals } from "./arrivals";
import { DIRECT_COMMUTE_MARGIN_SEC, directPromotion, dwellBoardWindowSec, findPotentialRoutes, isAlreadyThere, MAX_RIDE_SEC, mostDirectOption, PIN_SWITCH_MARGIN_SEC, pickLiveArrival, planTrip, publishedWindowFor, routeHoursCaption, SAME_SPOT_M, THIRD_SHUTTLE_SLACK_SEC, topVisibleOptions } from "./planner";
import { fmtSchedule, HEADWAY_MIN, isRouteActiveAt } from "./schedule";
import { AT_PLACE_M, MAX_WALK_M, WALK_ONLY_MAX_SEC, walkSecFromMeters } from "./walk";
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

// The operator, 2026-09-03: setting the same place as both origin and
// destination "gets confused". planTrip is right — every shuttle option is
// dominated by a direct walk of ~zero, leaving one 0-minute Walk. What was
// wrong is that the walk-only shape is ALSO the trigger for the "shuttles that
// go there — none on the map yet" fallback, so the rider standing at their
// destination got a dozen routes and "Should be running now" instead of the
// answer.
describe("isAlreadyThere", () => {
  const walkOnly = (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => {
    const options = plan(from, to);
    expect(options.every((o) => o.mode === "walk")).toBe(true);
    return options;
  };

  it("is true for the exact same point, where the plan is a 0-minute walk", () => {
    const here = at(STOP.phelpsGate);
    const options = walkOnly(here, here);
    expect(options).toHaveLength(1);
    expect(options[0].totalSec).toBe(0);
    expect(isAlreadyThere(here, here, options)).toBe(true);
  });

  // The near miss the exact case hides behind: a saved "Home" a few metres off
  // the GPS fix produces the same walk-only state with a 20-second walk.
  it("is true for a near miss — a saved place metres from the fix", () => {
    const from = at(STOP.phelpsGate);
    const to = northOf(STOP.phelpsGate, 22);
    expect(walkSecFromMeters(haversineMeters(from, to))).toBeLessThan(30);
    expect(isAlreadyThere(from, to, walkOnly(from, to))).toBe(true);
  });

  it("holds up to AT_PLACE_M and stops there", () => {
    const from = at(STOP.phelpsGate);
    const inside = northOf(STOP.phelpsGate, AT_PLACE_M - 5);
    const outside = northOf(STOP.phelpsGate, AT_PLACE_M + 5);
    expect(isAlreadyThere(from, inside, walkOnly(from, inside))).toBe(true);
    expect(isAlreadyThere(from, outside, walkOnly(from, outside))).toBe(false);
  });

  // The threshold has room: nothing is being suppressed at 80 m because
  // planTrip has no shuttle to offer until the endpoints are ~200 m apart.
  it("cannot hide a ride — the first shuttle option needs far more separation", () => {
    const from = at(STOP.phelpsGate);
    for (const m of [AT_PLACE_M, 120]) {
      expect(plan(from, northOf(STOP.phelpsGate, m)).some((o) => o.mode === "shuttle")).toBe(false);
    }
    expect(plan(from, northOf(STOP.phelpsGate, 200)).some((o) => o.mode === "shuttle")).toBe(true);
  });

  // Distance alone must not decide: two stops in this network are 10 m apart,
  // so a (silly but real) ride between them can survive the dominance rule,
  // and a message must never overrule an option the planner kept.
  it("is false whenever a shuttle option survives, however close the ends", () => {
    const here = at(STOP.phelpsGate);
    const shuttle = { ...plan(northOf(STOP.phelpsGate, 200), at(STOP.cedar333)).find((o) => o.mode === "shuttle")! };
    expect(shuttle).toBeDefined();
    expect(isAlreadyThere(here, here, [shuttle])).toBe(false);
  });

  // And an empty shuttle list alone must not decide either: an off-hours
  // cross-town trip looks identical, and THAT rider wants the route list.
  it("is false for a long walk-only trip, so the route list still shows", () => {
    const from = { lat: 41.20, lon: -72.90 };
    const to = { lat: 41.25, lon: -72.90 };
    expect(isAlreadyThere(from, to, walkOnly(from, to))).toBe(false);
  });

  it("is false before a trip exists", () => {
    const here = at(STOP.phelpsGate);
    expect(isAlreadyThere(null, here, [])).toBe(false);
    expect(isAlreadyThere(here, null, [])).toBe(false);
    expect(isAlreadyThere(here, here, null)).toBe(false);
  });

  // The wording split. SAME_SPOT_M sits below the closest pair of distinct
  // stops this network serves (10.3 m), so "the same place you're starting
  // from" is never printed for two points the app calls different stops.
  it("splits its wording below the closest distinct stop pair", () => {
    expect(SAME_SPOT_M).toBeLessThan(10.3);
    expect(SAME_SPOT_M).toBeLessThan(AT_PLACE_M);
    const here = at(STOP.phelpsGate);
    expect(haversineMeters(here, northOf(STOP.phelpsGate, 5))).toBeLessThanOrEqual(SAME_SPOT_M);
    expect(haversineMeters(here, northOf(STOP.phelpsGate, 22))).toBeGreaterThan(SAME_SPOT_M);
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

  // The canary, 2026-09-03 21:48 UTC on Brown: "in 1, 57 min" became "in 56
  // min" in fifteen seconds while #301 was 77 m from the kerb, and the card
  // sank to the bottom of the list. The rider's billed walk (204 m, 185 s)
  // had crossed the pinned bus's eta + 60 + 90, so the first CATCHABLE entry
  // was that same vehicle a lap later. Swapping to it says nothing — it is
  // the same bus — and it deletes the only actionable fact on the row.
  it("does not swap a still-approaching pinned bus for its own next lap", () => {
    const live = [arr("301", 24), arr("301", 3439)];
    const pick = pickLiveArrival(live, "301", 185)!;
    expect(pick.match.eta).toBe(24);
    expect(pick.departed).toBe(false);
    expect(pick.missedBus).toBeUndefined();
  });

  it("still hands over to a DIFFERENT catchable bus, and names the one that got away", () => {
    // Same rider, but a second vehicle is genuinely reachable: that is a real
    // alternative and the card says why it moved.
    const live = [arr("301", 24), arr("302", 600), arr("301", 3439)];
    const pick = pickLiveArrival(live, "301", 185)!;
    expect(pick.match.busName).toBe("302");
    expect(pick.missedBus).toBe("301");
  });

  it("does not reach past its own lap for a later vehicle", () => {
    // Both buses are out of reach this time round. The soonest thing the
    // rider can catch is #301's own next lap, so #302's lap — 200 s LATER —
    // must not take the row just because it is a different vehicle.
    const live = [arr("301", 100), arr("302", 150), arr("301", 2400), arr("302", 2600)];
    const pick = pickLiveArrival(live, "301", 400)!;
    expect(pick.match.busName).toBe("301");
    expect(pick.match.eta).toBe(100);
  });

  it("lets the departure clear the row: once the bus has gone, its lap is all there is", () => {
    // #301 has left the stop, so computeUpcomingArrivals prices it a lap out
    // and its soonest entry IS that lap. Catchable again, so the row follows
    // it honestly at 40 min rather than defending a number the bus no longer
    // owns.
    const live = [arr("301", 2400)];
    const pick = pickLiveArrival(live, "301", 185)!;
    expect(pick.match.eta).toBe(2400);
    expect(pick.departed).toBe(false);
  });

  // Report #99, 2026-09-04: "How could I catch the blue if its a 7min walk and
  // it arrives in 5?" — the card read `Blue Day · in 5, 17 min · 16 min ·
  // arrive 11:46a · 🚶 7 min › 🚌 4 min › 🚶 5 min`. The pin is right to stay
  // (a 60 s shortfall is ~66 m, inside the walking-GPS buffer the constant
  // exists for); the TOTAL must not price a boarding on it.
  it("prices the wait on a bus the rider can reach, not the one they are watching", () => {
    const live = [arr("B1", 300), arr("B2", 1020)];
    const pick = pickLiveArrival(live, "B1", 420)!;
    // The countdown still follows the bus that is 5 min out...
    expect(pick.match.eta).toBe(300);
    // ...and the trip is priced on the one 17 min out, which is the one a
    // rider seven minutes' walk away will actually board.
    expect(pick.boardable.eta).toBe(1020);
  });

  it("keeps boardable identical to match for a rider at the stop", () => {
    // walk 0 makes every arrival catchable, so the two questions have one
    // answer and every existing verdict is untouched.
    for (const live of [[arr("101", 30)], [arr("202", 220), arr("101", 2440)], [arr("101", 1500)]]) {
      const pick = pickLiveArrival(live, "101", 0)!;
      expect(pick.boardable).toBe(pick.match);
    }
  });

  it("falls back to the watched bus when nothing at all is catchable", () => {
    const pick = pickLiveArrival([arr("101", 100)], "101", 1000)!;
    expect(pick.departed).toBe(true);
    expect(pick.boardable).toBe(pick.match);
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

  // Riders are shown the operator's PUBLISHED timetable, not ROUTE_HOURS —
  // that table is the in-service gate and was widened on purpose, so Red read
  // "5:40a–7p" while Yale publishes 7am–6pm. When `/api/buses` carries a
  // parsed window for the route, it drives the text, "Next:" and "should be
  // running"; ROUTE_HOURS stays the fallback.
  describe("with published hours", () => {
    // Blue Day's fixture routes (id "1") stand in for Red: the fixture payload
    // only maps stops for Blue Day / Blue Weekend. The window is the one Yale
    // publishes for Red, which disagrees with the gate table at both ends.
    const publishedHours = {
      "1": { days: [1, 2, 3, 4, 5], startMin: 7 * 60, endMin: 18 * 60, text: "7am - 6pm, M - F" },
    };
    const wed0610 = new Date("2026-09-02T06:10:00-04:00");
    const wed0710 = new Date("2026-09-02T07:10:00-04:00");

    it("prefers the published window for text, activeNow and nextActive", () => {
      // Sanity: the gate table for Red says 05:40 — a rider at 06:10 would
      // otherwise be told the route "should be running".
      expect(fmtSchedule("Red")).toBe("M–F 5:40a–7p");
      expect(isRouteActiveAt("Red", wed0610)).toBe(true);

      const early = findPotentialRoutes(from, to, routeStops, stopCoords, wed0610, publishedHours);
      const day = early.find((r) => r.label === "Blue Day")!;
      expect(day.schedule).toBe("M–F 7a–6p");
      expect(day.activeNow).toBe(false);
      expect(day.nextActive!.toISOString()).toBe(new Date("2026-09-02T07:00:00-04:00").toISOString());

      const later = findPotentialRoutes(from, to, routeStops, stopCoords, wed0710, publishedHours);
      expect(later.find((r) => r.label === "Blue Day")!.activeNow).toBe(true);
    });

    it("falls back to ROUTE_HOURS for routes without a published window", () => {
      const found = findPotentialRoutes(from, to, routeStops, stopCoords, wed0610, publishedHours);
      const weekend = found.find((r) => r.label === "Blue Weekend")!;
      expect(weekend.schedule).toBe(fmtSchedule("Blue Weekend"));
      expect(weekend.activeNow).toBe(false);
    });

    it("is byte-identical to the old behaviour when nothing is published", () => {
      for (const at of [wed0610, wed0710, new Date(NOW)]) {
        const without = findPotentialRoutes(from, to, routeStops, stopCoords, at);
        expect(findPotentialRoutes(from, to, routeStops, stopCoords, at, {})).toEqual(without);
        expect(findPotentialRoutes(from, to, routeStops, stopCoords, at, undefined)).toEqual(without);
        const day = without.find((r) => r.label === "Blue Day")!;
        expect(day.schedule).toBe(fmtSchedule("Blue Day"));
        expect(day.activeNow).toBe(isRouteActiveAt("Blue Day", at));
      }
    });
  });
});

describe("publishedWindowFor", () => {
  const w = { days: [1], startMin: 0, endMin: 60 };
  it("looks up routeIds first, then the bus route ids", () => {
    const cfg = { routeIds: ["3"], busRouteIds: [3, 30] };
    expect(publishedWindowFor(cfg, { "3": w })).toBe(w);
    expect(publishedWindowFor(cfg, { "30": w })).toBe(w);
    expect(publishedWindowFor(cfg, { "4": w })).toBeUndefined();
    expect(publishedWindowFor(cfg, undefined)).toBeUndefined();
    expect(publishedWindowFor(cfg, {})).toBeUndefined();
  });
});

describe("routeHoursCaption (report #57: hours atop the route details page)", () => {
  const blueDay = { label: "Blue Day", routeIds: ["3"], busRouteIds: [30] };
  const published = { days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 17 * 60 + 30, text: "8am - 5:30pm, M - F" };

  it("prefers the operator's published window over ROUTE_HOURS", () => {
    expect(routeHoursCaption(blueDay, { "3": published })).toBe("Runs M–F 8a–5:30p");
    // Looked up by busRouteIds too, like the All tab.
    expect(routeHoursCaption(blueDay, { "30": published })).toBe("Runs M–F 8a–5:30p");
  });

  it("falls back to the ROUTE_HOURS table when nothing is published for the route", () => {
    expect(routeHoursCaption(blueDay, undefined)).toBe(`Runs ${fmtSchedule("Blue Day")}`);
    expect(routeHoursCaption(blueDay, { "4": published })).toBe(`Runs ${fmtSchedule("Blue Day")}`);
    expect(fmtSchedule("Blue Day")).not.toBe("");
  });

  it("is null when neither source knows the route, so the caption is not drawn", () => {
    const unknown = { label: "Route That Does Not Exist", routeIds: ["999"], busRouteIds: [9990] };
    expect(routeHoursCaption(unknown, undefined)).toBeNull();
    expect(routeHoursCaption(unknown, { "3": published })).toBeNull();
  });
});

describe("topVisibleOptions", () => {
  // Legs default to "the whole total is riding", so every option's commute
  // orders the same way as its total and the direct-route promotion below
  // never fires unless a test asks for it. `directWalkSec` is deliberately
  // over an hour: walking is not a real alternative in these fixtures.
  const opt = (
    mode: "shuttle" | "walk", label: string, totalSec: number,
    legs?: { walkToSec?: number; rideSec?: number; walkFromSec?: number },
  ) => ({
    mode, routeLabel: label, totalSec,
    walkToSec: legs?.walkToSec ?? 0,
    rideSec: legs?.rideSec ?? totalSec,
    walkFromSec: legs?.walkFromSec ?? 0,
    directWalkSec: 99_999,
  } as unknown as import("./planner").TripOption);

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

  // ── The direct route always shows (report #93) ───────────────────────────
  //
  // The live trip from the report, measured against production 2026-09-04:
  // Division/Prospect → LEPH. Red's total is a huge WAIT wrapped around the
  // shortest commute on offer; Blue wins on total only because its bus is
  // two minutes out rather than twenty-eight.
  const report93 = () => [
    opt("shuttle", "Blue Day", 22 * 60, { walkToSec: 78, rideSec: 1254, walkFromSec: 48 }),
    opt("shuttle", "Orange Day", 34 * 60, { walkToSec: 972, rideSec: 786, walkFromSec: 48 }),
    opt("walk", "Walk", 37 * 60),
    opt("shuttle", "Red", 39 * 60, { walkToSec: 0, rideSec: 732, walkFromSec: 48 }),
    opt("shuttle", "Brown", 66 * 60, { walkToSec: 126, rideSec: 1338, walkFromSec: 564 }),
  ];

  it("promotes the direct route out from behind 'Show more' (report #93)", () => {
    const sorted = report93();
    // Red is 4th on total and the third-shuttle slack does not reach it, yet
    // it is the one that runs straight there — 13 min of walking + riding
    // against Blue's 23 and Orange's 30.
    expect(mostDirectOption(sorted)?.routeLabel).toBe("Red");
    expect(directPromotion(sorted)?.routeLabel).toBe("Red");
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel))
      .toEqual(["Blue Day", "Orange Day", "Walk", "Red"]);
  });

  it("keeps the fastest option on top — promotion adds a row, never reorders", () => {
    const sorted = report93();
    const visible = topVisibleOptions(sorted);
    expect(visible[0].routeLabel).toBe("Blue Day");
    // Every visible row keeps its rank from the sorted list.
    const rank = (l: string) => sorted.findIndex((o) => o.routeLabel === l);
    const ranks = visible.map((o) => rank(o.routeLabel));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // ...and Brown, which is neither fast nor direct, stays hidden.
    expect(visible.map((o) => o.routeLabel)).not.toContain("Brown");
  });

  it("does not flicker as the wait moves: the promotion ignores live totals", () => {
    // Replay the same plan with Red's wait sweeping the whole range that made
    // it cross the slack boundary in the first place. Only totalSec changes —
    // exactly what the per-poll live recompute rewrites.
    for (let waitMin = 0; waitMin <= 40; waitMin++) {
      const sorted = report93()
        .map((o) => (o.routeLabel === "Red"
          ? { ...o, totalSec: 13 * 60 + waitMin * 60 }
          : o))
        .sort((a, b) => a.totalSec - b.totalSec);
      expect(mostDirectOption(sorted)?.routeLabel).toBe("Red");
      expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toContain("Red");
    }
  });

  it("stays quiet when the top of the list is already the direct route", () => {
    // Blue is both fastest and most direct — no fourth row.
    const sorted = [
      opt("shuttle", "Blue Day", 12 * 60, { walkToSec: 60, rideSec: 600, walkFromSec: 60 }),
      opt("shuttle", "Orange Day", 20 * 60, { walkToSec: 600, rideSec: 600, walkFromSec: 0 }),
      opt("shuttle", "Red", 30 * 60, { walkToSec: 120, rideSec: 660, walkFromSec: 60 }),
    ];
    expect(directPromotion(sorted)).toBeUndefined();
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["Blue Day", "Orange Day"]);
  });

  it("needs a real margin — a hair more direct does not earn a row", () => {
    const near = (extra: number) => [
      opt("shuttle", "A", 10 * 60, { rideSec: 600 }),
      opt("shuttle", "B", 20 * 60, { rideSec: 1200 }),
      opt("shuttle", "C", 40 * 60, { rideSec: 600 - extra }),
    ];
    // One second short of the margin: A is already the direct answer.
    expect(directPromotion(near(DIRECT_COMMUTE_MARGIN_SEC - 1))).toBeUndefined();
    expect(directPromotion(near(DIRECT_COMMUTE_MARGIN_SEC))?.routeLabel).toBe("C");
  });

  it("never promotes a bus the rider cannot catch, or one slower than walking", () => {
    const base = [
      opt("shuttle", "A", 10 * 60, { rideSec: 600 }),
      opt("shuttle", "B", 20 * 60, { rideSec: 1200 }),
    ];
    const departed = {
      ...opt("shuttle", "C", 40 * 60, { rideSec: 60 }), departed: true,
    } as import("./planner").TripOption;
    expect(directPromotion([...base, departed])).toBeUndefined();
    // Same option, catchable but with both walks longer than walking direct.
    const slower = {
      ...opt("shuttle", "C", 40 * 60, { walkToSec: 900, rideSec: 60, walkFromSec: 900 }),
      directWalkSec: 1200,
    } as import("./planner").TripOption;
    expect(directPromotion([...base, slower])).toBeUndefined();
  });

  it("a short hop that leaves the rider far from the door is not 'direct'", () => {
    // The operator's own caveat: "a short route that doesn't get you far
    // wouldn't be good". C rides two minutes and drops them a 12-minute walk
    // short; A carries them to the door in ten.
    const sorted = [
      opt("shuttle", "A", 10 * 60, { walkToSec: 60, rideSec: 480, walkFromSec: 60 }),
      opt("shuttle", "B", 20 * 60, { rideSec: 1200 }),
      opt("shuttle", "C", 40 * 60, { walkToSec: 60, rideSec: 120, walkFromSec: 720 }),
    ];
    expect(mostDirectOption(sorted)?.routeLabel).toBe("A");
    expect(directPromotion(sorted)).toBeUndefined();
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["A", "B"]);
  });

  it("adds at most one row", () => {
    const sorted = [
      opt("shuttle", "A", 10 * 60, { rideSec: 3000 }),
      opt("shuttle", "B", 20 * 60, { rideSec: 2400 }),
      opt("shuttle", "C", 40 * 60, { rideSec: 600 }),
      opt("shuttle", "D", 50 * 60, { rideSec: 300 }),
      opt("shuttle", "E", 60 * 60, { rideSec: 120 }),
    ];
    // E is the most direct; C and D do not each get a row of their own.
    expect(topVisibleOptions(sorted).map((o) => o.routeLabel)).toEqual(["A", "B", "E"]);
  });
});
