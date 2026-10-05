/**
 * THE RIDE BANNER COUNTS DOWN, IN TRAVEL ORDER — incident ridebannercount20261004.
 *
 * The on-bus banner subtracted slots in its de-duplicated stop list. Green's
 * list keeps Building 900, 800, 600, 400, 750, West Haven Train Station in that
 * order, so every recorded Building 400 -> station ride read 4 (at boarding),
 * 2, 3, 1, 4, 5 stops while the bus drove 400, 600, 750, 800, 900, the
 * station: "Get off in 2 stops!" at the pickup, "Get off NEXT stop!" at
 * Building 750 with three stops to go, "5 stops" at the kerb. The countdown
 * beside it was right. Purple's return leg and Pink's VA spur did the same.
 * Replayed here fix by fix through the shared anchor, the ride countdown's
 * arrivals and the banner's count (liveAnchor.ts `rideStopsToExit`), and
 * scored against the stops the feed had the bus standing at.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBusOnRoute, registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals } from "./arrivals";
import { beliefFor, ringForBus, type AnchorStore } from "./eta";
import type { LatLon } from "./geo";
import { anchorIndexOnList, anchorKeyFor, rideApproach, rideStopsToExit } from "./liveAnchor";
import { getOffAlertTitle } from "./rideAlert";
import { mergedRouteStops, ROUTE_LISTS } from "./routes";
import green from "./__fixtures__/green-published-order.json";
import pink from "./__fixtures__/pink-published-order.json";
import purple from "./__fixtures__/purple-published-order.json";
import fixture from "./__fixtures__/ride-banner-count-2026-10-04.json";

const routeStops: Record<string, number[]> = { "8": pink.stops, "9": green.stops, "10": purple.stops };
const coords: Record<number, LatLon> = {};
for (const [id, ll] of Object.entries({ ...pink.stopCoords, ...green.stopCoords, ...purple.stopCoords })) {
  const [lat, lon] = ll as [number, number];
  coords[Number(id)] = { lat, lon };
}

type Ride = (typeof fixture.rides)[number];
const ride = (runId: string) => fixture.rides.find((r) => r.runId === runId)!;
const norm = (s: string) => s.replace(/^#/, "");

/** The count the page printed: the banner headline (rideArrival.ts `rideHeadline`). */
function printed(shown: string | null): number | null {
  if (!shown) return null;
  if (shown.startsWith("Arriving at ")) return 0;
  if (shown.startsWith("Get off NEXT stop!")) return 1;
  if (shown.startsWith("Get off in 2 stops!")) return 2;
  const m = /^(\d+) stops/.exec(shown);
  return m ? Number(m[1]) : null;
}

/** Each recorded poll as the page runs it: one anchor store for the ride,
 * the ride countdown's arrivals at the exit, then the count. `master` is the
 * banner's old count on the anchor the page printed from, the belief's lead
 * (`anchorLeg` now reads the countdown's leg on four polls of Purple #126,
 * 20:26:47-20:27:17Z, where the countdown went back to Building 400's leg and
 * the bus stood at Building 600 from 20:27:37Z: anchorfarorigin20261004);
 * `card` is the trip card's own count (`rideApproach`) to the exit, the reuse
 * this fix considered. */
function replay(r: Ride) {
  const cfg = ROUTE_LISTS.find((c) => c.label === r.routeLabel)!;
  const list = [...new Set(routeStops[String(r.routeId)]!)];
  const alight = list.indexOf(r.alightStopId);
  const canonical = mergedRouteStops(cfg, routeStops);
  const store: AnchorStore = new Map();
  return r.positions.map((fix) => {
    const now = Date.parse(fix.at);
    const bus = { ...fix, bus_id: 0, route_id: r.routeId, bus_name: r.busName };
    const exit = computeUpcomingArrivals([r.alightStopId], [bus], routeStops, coords, {}, now, {}, store)
      .filter((a) => a.stopId === r.alightStopId && norm(a.busName) === norm(r.busName));
    const idx = isBusOnRoute(bus, list, coords) ? anchorIndexOnList(bus, cfg, routeStops, coords, list, now, store) : -1;
    const ring = ringForBus(bus, canonical, coords)!;
    const lead = beliefFor(store, anchorKeyFor(cfg.label, bus.bus_name), bus, ring, canonical, now).lead;
    const was = idx >= 0 ? list.indexOf(canonical[ring.repaired ? ring.order[lead]! : lead]!) : -1;
    const hops = exit.map((a): [number, number] => [a.stopsAhead, a.stopId]);
    return {
      at: fix.at,
      riding: fix.phase !== "waiting" && Date.parse(fix.at) <= Date.parse(r.arrivedAt),
      printed: printed(fix.shown),
      standing: fix.stationary && fix.at_stop_id != null ? fix.at_stop_id : null,
      master: was >= 0 && alight >= 0 ? (alight - was + list.length) % list.length : null,
      count: idx >= 0 ? rideStopsToExit(bus, cfg, routeStops, coords, r.alightStopId, exit, now, store) : null,
      card: idx >= 0 ? rideApproach(bus, cfg, routeStops, coords, r.alightStopId, hops.length ? hops : undefined, now, store)?.length ?? null : null,
    };
  });
}

type Step = ReturnType<typeof replay>[number];

/** Rides whose production lead held Building 800's RETURN call after #321 left
 * it on the way out (greenb800switch20261004), until the time given: the page
 * printed that call's count (4) while the replay's lead stays on the way out. */
const heldReturnCall: Record<string, string> = {
  "1791116282719": "2026-10-04T12:59:00Z", // released after LEAD_MAX_HOLD_MS
  "1791021569319": "2026-10-03T10:05:20Z", // until the bus reached that call
};
const runs = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null).filter((x, i, a) => i === 0 || a[i - 1] !== x);

/** Stops left after the ride's call at `stopId` (the pickup counts the whole ride). */
const left = (r: Ride, stopId: number) => r.rideStops.length - 1 - r.rideStops.indexOf(stopId);

/** Polls on the ride with the feed standing the bus at one of its calls. */
const stands = (r: Ride, steps: Step[]) =>
  steps.filter((s) => s.riding && s.standing !== null && r.rideStops.includes(s.standing));

/** Polls where `key` read fewer stops than were left: the bus was standing at a
 * call with more still to come. One more than left is the lag of a stand's
 * first poll, which the old count shared. */
const early = (r: Ride, steps: Step[], key: "count" | "master" | "card") =>
  stands(r, steps)
    .filter((s) => s[key] !== null && s[key]! < left(r, s.standing!))
    .map((s) => `${s.at} at ${s.standing}: ${s[key]} of ${left(r, s.standing!)}`);

beforeEach(() => registerRoutePaths({ "8": pink.path, "9": green.path, "10": purple.path } as unknown as Record<string, [number, number][]>));
afterEach(() => registerRoutePaths(null));

describe.each(fixture.rides.map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s (incident ridebannercount20261004)",
  (_name, r) => {
    const steps = () => replay(r).filter((s) => s.riding);

    it("the old count is what the page printed", () => {
      const all = steps().filter((x) => x.printed !== null && x.master !== null);
      const held = heldReturnCall[r.runId];
      const s = held ? all.filter((x) => x.at > held) : all;
      expect(s.length).toBeGreaterThan(20);
      expect(runs(s.map((x) => x.master))).toEqual(runs(s.map((x) => x.printed)));
      if (held) expect(runs(all.filter((x) => x.at <= held).map((x) => x.printed))).toEqual([4]);
    });

    it("is never fewer than the stops left at a call the bus stands at", () => {
      expect(stands(r, steps()).length).toBeGreaterThan(2);
      expect(early(r, replay(r), "count")).toEqual([]);
      for (const s of stands(r, steps())) expect(s.count! - left(r, s.standing!)).toBeLessThanOrEqual(1);
    });

    it("counts down from the whole ride to the exit without rising", () => {
      const s = steps();
      const first = s.findIndex((x) => x.standing === r.rideStops[1]);
      expect(first).toBeGreaterThan(0);
      const after = runs(s.slice(first).map((x) => x.count));
      expect(after).toEqual([...after].sort((a, b) => b - a));
      expect(after[after.length - 1]).toBe(0);
      expect(Math.max(...runs(s.map((x) => x.count)))).toBeLessThanOrEqual(r.rideStops.length);
    });

    it("alerts at two stops out, says NEXT only from the stop before the exit, and 'here' at the kerb", () => {
      const s = steps();
      const alert = s.findIndex((x) => x.count !== null && x.count <= 2);
      expect(getOffAlertTitle(s[alert]!.count)).toBe("Get off in 2 stops");
      // No call with three or more stops to go after the alert.
      expect(s.slice(alert).filter((x) => x.standing !== null && r.rideStops.includes(x.standing) && left(r, x.standing) >= 3)).toEqual([]);
      const next = s.findIndex((x) => x.count !== null && x.count <= 1);
      const beforeExit = r.rideStops[r.rideStops.length - 2]!;
      expect(s.slice(0, next + 1).some((x) => x.standing === beforeExit)).toBe(true);
      // The rider's arrival poll: the bus at the exit's kerb.
      expect(getOffAlertTitle(s[s.length - 1]!.count)).toBe("Get off here");
    });
  },
);

describe("the reported rides", () => {
  it("Green #321 run 1791116282719 read 4, 2, 3, 1, 4, 5 and now reads 5, 4, 3, 2, 1, 0", () => {
    const s = replay(ride("1791116282719")).filter((x) => x.riding);
    expect(runs(s.map((x) => x.printed))).toEqual([4, 2, 3, 1, 4, 5]);
    // The first poll after boarding reads 6: the bus a poll into its stand at
    // Building 400 and the lead a leg behind, the lag of a stand's first poll.
    expect(s[0]!.count).toBe(6);
    expect(runs(s.slice(1).map((x) => x.count))).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("the old count told riders to get off early on Green and Purple, and rose on Pink", () => {
    for (const id of ["1791116282719", "1791021569319", "1790971678692"]) {
      expect(early(ride(id), replay(ride(id)), "master").length, id).toBeGreaterThan(0);
    }
    const pinkRide = replay(ride("1790964170008")).filter((x) => x.riding);
    expect(runs(pinkRide.map((x) => x.master))).toEqual([5, 4, 5, 3, 2, 6, 1]);
    expect(runs(pinkRide.map((x) => x.count))).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("Purple #317 run 1791133745689 said 'Get off NEXT stop!' standing at Building 400; now 'Get off here'", () => {
    const r = ride("1791133745689");
    const kerb = replay(r).filter((x) => x.riding && x.standing === r.alightStopId);
    expect(kerb.map((x) => x.printed)).toContain(1);
    expect(kerb.map((x) => x.count)).toEqual(kerb.map(() => 0));
  });

  // Why the out-and-back lines count the countdown's hops rather than the trip
  // card's approach: the card lists only upstream's slots, so Purple's return
  // call at West Haven Train Station is not a stop to it, and its anchor's pass
  // can run ahead of the bus. On Green that pass was the lead held on Building
  // 800's return call (greenb800switch20261004), and the card's count is no
  // longer early there.
  it("the trip card's count would still be early on Purple's return", () => {
    expect(early(ride("1790971678692"), replay(ride("1790971678692")), "card").length).toBeGreaterThan(0);
    expect(early(ride("1791021569319"), replay(ride("1791021569319")), "card")).toEqual([]);
  });
});
