/**
 * THE GET-OFF ALERT WAITS FOR THE EXIT TO BE CLOSE — incident bannerpopuptime20261005.
 *
 * Since #367 the ride banner counts the stops to the exit right, and the
 * one-shot alert (buzz, notification, popup) fired at the first count of two.
 * On Purple's Building 400 -> LEPH/60 College return, two stops out is
 * Building 900, then the station's hold and the drive downtown: run
 * 1790971678692 printed 22 min on the countdown there, and the rider reached
 * LEPH 18 min later. Each ride of #367's fixture is replayed fix by fix
 * through the shared anchor and the banner's count (liveAnchor.ts
 * `rideStopsToExit`), beside the countdown the page printed ("· 22 min"). A
 * hold's name stands in the countdown's place while the bus stands, so the
 * last one printed carries over.
 *
 * "Get off at the next stop" waits for the countdown too
 * (nextstoppopupfloor20261005): the same ride's next stop is West Haven
 * station, where it fired with 18 min on the countdown and 13.7 min to go.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBusOnRoute, registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals } from "./arrivals";
import type { AnchorStore } from "./eta";
import type { LatLon } from "./geo";
import { anchorIndexOnList, rideStopsToExit } from "./liveAnchor";
import { getOffAlertDue, getOffAlertTitle } from "./rideAlert";
import { ROUTE_LISTS } from "./routes";
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

/** The countdown the headline printed, in seconds (`formatRideEta` floors). */
function printedEta(shown: string | null): number | null {
  if (!shown) return null;
  if (shown.endsWith("· <1 min")) return 30;
  const m = /· (\d+) min$/.exec(shown);
  return m ? Number(m[1]) * 60 : null;
}

/** The ride's polls as the banner reads them: its count and the countdown. */
function replay(r: Ride) {
  const cfg = ROUTE_LISTS.find((c) => c.label === r.routeLabel)!;
  const list = [...new Set(routeStops[String(r.routeId)]!)];
  const store: AnchorStore = new Map();
  let eta: number | null = null;
  return r.positions.map((fix) => {
    const now = Date.parse(fix.at);
    const bus = { ...fix, bus_id: 0, route_id: r.routeId, bus_name: r.busName };
    const exit = computeUpcomingArrivals([r.alightStopId], [bus], routeStops, coords, {}, now, {}, store)
      .filter((a) => a.stopId === r.alightStopId && norm(a.busName) === norm(r.busName));
    const idx = isBusOnRoute(bus, list, coords) ? anchorIndexOnList(bus, cfg, routeStops, coords, list, now, store) : -1;
    eta = printedEta(fix.shown) ?? eta;
    return {
      at: fix.at,
      riding: fix.phase !== "waiting" && now <= Date.parse(r.arrivedAt),
      minutesLeft: (Date.parse(r.arrivedAt) - now) / 60_000,
      standing: fix.stationary && fix.at_stop_id != null ? fix.at_stop_id : null,
      count: idx >= 0 ? rideStopsToExit(bus, cfg, routeStops, coords, r.alightStopId, exit, now, store) : null,
      eta,
    };
  }).filter((s) => s.riding);
}

beforeEach(() => registerRoutePaths({ "8": pink.path, "9": green.path, "10": purple.path } as unknown as Record<string, [number, number][]>));
afterEach(() => registerRoutePaths(null));

describe("the reported ride: Purple #126 run 1790971678692, Building 400 -> LEPH/60 College", () => {
  const steps = () => replay(ride("1790971678692"));

  it("reads two stops at Building 900 with 22 min on the countdown and 18 min to go", () => {
    const two = steps().find((s) => s.count !== null && s.count <= 2)!;
    expect(two).toMatchObject({ standing: 26, count: 2, eta: 22 * 60 });
    expect(two.minutesLeft).toBeGreaterThan(18);
  });

  it("holds the alert past Building 900, the drive to the station and its hold, then says 'next stop'", () => {
    const s = steps();
    const fired = s.find((x) => getOffAlertDue(x.count, x.eta))!;
    expect(getOffAlertTitle(fired.count)).toBe("Get off at the next stop");
    expect(s.filter((x) => x.at < fired.at && x.count === 2).length).toBeGreaterThan(10);
    // At West Haven Train Station, the stop before LEPH, the count was already
    // one with 18 min on the countdown: no alert there any more.
    const station = s.find((x) => x.count === 1 && x.standing === 127)!;
    expect(station.eta).toBe(18 * 60);
    expect(station.minutesLeft).toBeGreaterThan(13);
    expect(station.at < fired.at).toBe(true);
    expect(fired.eta).toBe(5 * 60);
    expect(fired.minutesLeft).toBeCloseTo(7, 0);
  });
});

describe.each(fixture.rides.map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s (bannerpopuptime20261005)",
  (_name, r) => {
    it("never says 'Get off in 2 stops' or 'next stop' with more than 5 min on the countdown", () => {
      const s = replay(r);
      expect(s.some((x) => x.count === 2)).toBe(true);
      expect(s.filter((x) => (x.count === 2 || x.count === 1) && getOffAlertDue(x.count, x.eta) && x.eta! >= 6 * 60)
        .map((x) => `${x.at}: ${x.count} stops, ${x.eta! / 60} min`)).toEqual([]);
    });

    it("still alerts before the exit: before 'here', and at least a minute before the bus got there", () => {
      const s = replay(r);
      const fired = s.findIndex((x) => getOffAlertDue(x.count, x.eta));
      expect(fired).toBeGreaterThanOrEqual(0);
      expect(s[fired]!.count).toBeGreaterThan(0);
      expect(s[fired]!.minutesLeft).toBeGreaterThan(1);
    });
  },
);

describe("getOffAlertDue", () => {
  it("waits at two stops until the countdown shows 5 min or less", () => {
    expect(getOffAlertDue(2, 22 * 60)).toBe(false);
    expect(getOffAlertDue(2, 6 * 60)).toBe(false);
    expect(getOffAlertDue(2, 6 * 60 - 1)).toBe(true);
    expect(getOffAlertDue(2, 0)).toBe(true);
  });
  it("waits at the next stop until the countdown shows 5 min or less (nextstoppopupfloor20261005)", () => {
    expect(getOffAlertDue(1, 18 * 60)).toBe(false);
    expect(getOffAlertDue(1, 6 * 60)).toBe(false);
    expect(getOffAlertDue(1, 6 * 60 - 1)).toBe(true);
    expect(getOffAlertDue(1, 0)).toBe(true);
  });
  it("fires on the count alone without a countdown, as before", () => {
    expect(getOffAlertDue(2, null)).toBe(true);
    expect(getOffAlertDue(1, null)).toBe(true);
  });
  it("never holds 'here', and never fires farther out", () => {
    expect(getOffAlertDue(0, 40 * 60)).toBe(true);
    expect(getOffAlertDue(0, null)).toBe(true);
    expect(getOffAlertDue(3, 60)).toBe(false);
    expect(getOffAlertDue(3, 60, 60, 100)).toBe(false);
    expect(getOffAlertDue(null, 60)).toBe(false);
  });
  it("says 'next stop' on a countdown stuck high: within 1 km and 6+ min of it drive, not hold", () => {
    expect(getOffAlertDue(1, 726, 671, 758)).toBe(true);
    expect(getOffAlertDue(1, 726, 671, 1000)).toBe(false); // farther out: a long last leg
    expect(getOffAlertDue(1, 470, 159, 363)).toBe(false); // a priced hold: wait for 5 min
    expect(getOffAlertDue(2, 726, 671, 758)).toBe(false); // two stops: "next stop" is the backstop
    expect(getOffAlertDue(1, 726, null, 758)).toBe(false);
    expect(getOffAlertDue(1, 726, 671, null)).toBe(false);
  });
});

/** Recorded polls replayed through the production path (ServerEta wire, the
 * shared anchor store, `rideStopsToExit`, the exit's arrival): time, count,
 * countdown (s), its drive alone (`departNow`, s), metres to the exit. */
type Poll = [at: string, count: number, eta: number, drive: number, exitM: number];
const firstDue = (polls: Poll[], escape = true) =>
  polls.find(([, c, eta, drive, m]) => (escape ? getOffAlertDue(c, eta, drive, m) : getOffAlertDue(c, eta)))?.[0];

describe("a countdown stuck high: Blue West #303 to 333 Cedar, 2026-10-04 (run 1791154329383's feed)", () => {
  // #303 stood at stop 98, 760 m out, then drove in; it was counted at 333 Cedar
  // at 23:05:47Z, and the countdown read 6 to 12 min until 30 s before that.
  const polls: Poll[] = [
    ["23:01:57", 2, 690, 690, 822], ["23:02:07", 1, 726, 671, 758], ["23:02:17", 1, 643, 643, 725],
    ["23:02:27", 1, 658, 658, 725], ["23:02:37", 1, 635, 635, 694], ["23:02:47", 1, 619, 619, 633],
    ["23:02:57", 1, 579, 579, 569], ["23:03:07", 1, 635, 140, 569], ["23:03:17", 1, 554, 554, 511],
    ["23:03:27", 1, 494, 494, 446], ["23:03:37", 1, 462, 462, 417], ["23:03:47", 1, 430, 430, 358],
    ["23:03:57", 1, 404, 404, 331], ["23:04:07", 1, 497, 95, 331], ["23:04:17", 1, 532, 95, 331],
    ["23:04:27", 1, 562, 95, 331], ["23:04:37", 1, 596, 95, 331], ["23:04:47", 1, 630, 95, 331],
    ["23:04:57", 1, 423, 423, 277], ["23:05:07", 1, 379, 379, 210], ["23:05:17", 1, 223, 223, 186],
    ["23:05:27", 1, 168, 168, 164], ["23:05:37", 1, 95, 95, 105], ["23:05:47", 0, 40, 40, 37],
  ];
  it("says 'next stop' as the bus leaves stop 98, 3.7 min out, as before", () => {
    expect(firstDue(polls)).toBe("23:02:07");
  });
  it("where the countdown alone would wait until 30 s before the stop", () => {
    expect(firstDue(polls, false)).toBe("23:05:17");
  });
});

describe("a hold before the exit: Purple #330 laying over at 333 Cedar, then 300 George St, 2026-10-02 (run 1790938611526's feed)", () => {
  // #330 stood at 333 Cedar, 360 m short of 300 George St, from 11:03Z to 11:11Z;
  // counted at 300 George St at 11:14:59Z. A subset of the 10 s polls.
  const hold: Poll[] = [
    ["11:03:09", 2, 471, 471, 427], ["11:03:19", 1, 470, 159, 397], ["11:05:19", 1, 469, 159, 363],
    ["11:08:59", 1, 367, 159, 363], ["11:09:09", 1, 363, 159, 363], ["11:09:19", 1, 358, 159, 363],
    ["11:11:49", 1, 280, 159, 363], ["11:12:19", 1, 119, 119, 322], ["11:14:59", 0, 14, 14, 41],
  ];
  it("waits out the hold until the countdown shows 5 min, not from the bus pulling in", () => {
    expect(firstDue(hold)).toBe("11:09:19");
  });
});

// No DOM library here, so the banner's wiring is pinned in the source (same
// approach as rideBannerStacking.test.ts): the alert waits on the countdown,
// while the headline, the red banner and the stop list keep the count.
describe("OnBusBanner", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
  const banner = src.slice(src.indexOf("const OnBusBanner: FC<"), src.indexOf("const TransitMap: FC"));

  it("fires the one-shot alert through getOffAlertDue with the ride countdown, its drive and the distance", () => {
    expect(banner).toMatch(/if \(!getOffAlertDue\(stopsRemaining, etaSec, driveSec, exitMeters\)\) return;/);
    expect(banner).toMatch(/if \(mine\) \{ etaSec = mine\.eta; driveSec = mine\.departNow; \}/);
    expect(banner).toMatch(/const exitMeters = bus && exitCoord \? haversineMeters\(bus, exitCoord\) : null;/);
    expect(banner).not.toMatch(/stopsRemaining > 2\) return;/);
  });
  it("keeps the headline and the red banner on the count", () => {
    expect(banner).toMatch(/const arriving = stopsRemaining !== null && stopsRemaining <= 2;/);
    expect(banner).toMatch(/rideHeadline\(\{\s*busFound: bus !== undefined, stopsRemaining,/);
  });
});
