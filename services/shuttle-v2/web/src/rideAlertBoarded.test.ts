/**
 * THE GET-OFF ALERT WAITS FOR THE BUS TO CARRY THE RIDER — incident ridecountpreboard20261005.
 *
 * A ride can be started before its bus comes (TripBoardingActions). The ride
 * banner's count is to the exit on whichever pass of it comes first, and that
 * can come before the pickup. A Green bus on Orange Street, coming to a rider at
 * Building 400, counted 2 and 1 to West Haven Train Station's outbound call; a
 * Red bus calling at LEPH / 60 College on its way round to Division / Prospect
 * counted 0. The one-shot alert (buzz, notification, popup) fired
 * there, before the rider boarded, and so never on the ride. It now waits for
 * the bus to have been on the ride: at the pickup or a call before the exit,
 * the row the ride page draws it on (rideAlert.ts `rideBoarded`, liveAnchor.ts
 * `rideCallIndex`). Each recorded ride is replayed fix by fix through the shared
 * anchor, the banner's count (`rideStopsToExit`) and its countdown, as the page
 * runs them, from the first feed row the fixtures hold.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { isBusOnRoute, registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals } from "./arrivals";
import type { AnchorStore } from "./eta";
import { haversineMeters, type LatLon } from "./geo";
import { anchorIndexOnList, rideCallIndex, rideCalls, rideStopsToExit } from "./liveAnchor";
import { getOffAlertDue, getOffAlertTitle, rideBoarded } from "./rideAlert";
import { ROUTE_LISTS } from "./routes";
import payload from "./__fixtures__/buses-payload.json";
import green from "./__fixtures__/green-published-order.json";
import pink from "./__fixtures__/pink-published-order.json";
import purple from "./__fixtures__/purple-published-order.json";
import banner from "./__fixtures__/ride-banner-count-2026-10-04.json";
import preboard from "./__fixtures__/ride-preboard-2026-10-05.json";
import printedLists from "./__fixtures__/ride-stop-list-2026-10-05.json";

type Fix = (typeof banner.rides)[number]["positions"][number] & { at_stop_id?: number | null };
type Ride = {
  runId: string; routeLabel: string; routeId: number; busName: string;
  boardStopId: number; alightStopId: number; boardedAt: string; arrivedAt: string; positions: Fix[];
};

const arrays = (stops: Record<string, unknown>): Record<number, LatLon> => Object.fromEntries(
  Object.entries(stops).map(([id, ll]) => [Number(id), { lat: (ll as number[])[0]!, lon: (ll as number[])[1]! }]),
);
// The folded lines on #367's published geometry; Red on the payload fixture's,
// identical to production's route 3 on 2026-10-05.
const folded = {
  stops: { "8": pink.stops, "9": green.stops, "10": purple.stops } as Record<string, number[]>,
  coords: { ...arrays(pink.stopCoords), ...arrays(green.stopCoords), ...arrays(purple.stopCoords) },
  paths: { "8": pink.path, "9": green.path, "10": purple.path },
  segments: {}, dwells: {},
};
const red = {
  stops: { "3": payload.routes["3"] } as Record<string, number[]>,
  coords: payload.stop_coords as unknown as Record<number, LatLon>,
  paths: { "3": payload.route_paths["3"] },
  segments: payload.segments, dwells: payload.dwells,
};
const geometry = (r: Ride) => (r.routeLabel === "Red" ? red : folded);
const norm = (s: string) => s.replace(/^#/, "");

/** Green #321 run 1791116282719 from the ride page fixture's earlier feed rows, 21 min before boarding. */
const greenEarly: Ride = (() => {
  const r = banner.rides.find((x) => x.runId === "1791116282719")!;
  const early = (printedLists.rides.find((p) => p.runId === r.runId) as { early: Fix[] }).early;
  return { ...r, positions: [...early, ...r.positions] };
})();
const redEarly = preboard.rides[0] as unknown as Ride;

afterEach(() => registerRoutePaths(null));

/** Each recorded fix as the banner reads it: its count, the bus's row on the
 * ride's calls, the countdown, its drive and the distance to the exit. */
function replay(r: Ride) {
  const g = geometry(r);
  registerRoutePaths(g.paths as unknown as Record<string, [number, number][]>);
  const cfg = ROUTE_LISTS.find((c) => c.label === r.routeLabel)!;
  const list = [...new Set(g.stops[String(r.routeId)]!)];
  const calls = rideCalls(cfg, g.stops, g.coords, r.boardStopId, r.alightStopId);
  const store: AnchorStore = new Map();
  return r.positions.map((fix) => {
    const now = Date.parse(fix.at);
    const bus = { ...fix, bus_id: 0, route_id: r.routeId, bus_name: r.busName };
    const exit = computeUpcomingArrivals([r.alightStopId], [bus], g.stops, g.coords, g.segments, now, g.dwells, store)
      .filter((a) => a.stopId === r.alightStopId && norm(a.busName) === norm(r.busName));
    const idx = isBusOnRoute(bus, list, g.coords) ? anchorIndexOnList(bus, cfg, g.stops, g.coords, list, now, store) : -1;
    const count = idx >= 0 ? rideStopsToExit(bus, cfg, g.stops, g.coords, r.alightStopId, exit, now, store) : null;
    return {
      at: fix.at,
      boarded: now >= Date.parse(r.boardedAt),
      riding: fix.phase !== "waiting" && now <= Date.parse(r.arrivedAt),
      count,
      row: rideCallIndex(bus, cfg, g.stops, g.coords, calls, count, now, store),
      calls: calls.length,
      eta: exit[0]?.eta ?? null,
      drive: exit[0]?.departNow ?? null,
      exitMeters: haversineMeters(bus, g.coords[r.alightStopId]!),
    };
  });
}
type Poll = ReturnType<typeof replay>[number];

/** The banner's one-shot alert over polls from the ride's start: the first that
 * is due, with the guard (`rideBoarded`) or, as on master, without it. */
function firstAlert(polls: Poll[], guarded = true): Poll | null {
  let seen = false;
  for (const p of polls) {
    if (guarded) seen = rideBoarded(seen, p.row, p.calls);
    if ((seen || !guarded) && getOffAlertDue(p.count, p.eta, p.drive, p.exitMeters)) return p;
  }
  return null;
}
const fromBoarding = (polls: Poll[]) => polls.slice(polls.findIndex((p) => p.riding));

describe("the reported ride: Green #321 run 1791116282719, Building 400 -> West Haven Train Station, started 21 min before boarding", () => {
  const polls = replay(greenEarly);

  it("counts down to the station's outbound call on Orange Street, the bus nowhere on the ride", () => {
    const coming = polls.filter((p) => !p.boarded);
    expect(coming[0]!.at).toBe("2026-10-04T12:32:10.882Z");
    expect(coming.filter((p) => p.count !== null && p.count <= 2 && p.count > 0).length).toBeGreaterThan(30);
    expect(coming.filter((p) => p.count === 0).every((p) => p.row === 5)).toBe(true);
    expect(coming.filter((p) => rideBoarded(false, p.row, p.calls))).toEqual([]);
  });
  it("without the guard, alerted 'next stop' before boarding, and never on the ride", () => {
    const a = firstAlert(polls, false)!;
    expect(a.boarded).toBe(false);
    expect(getOffAlertTitle(a.count)).toBe("Get off at the next stop");
    expect((Date.parse(greenEarly.boardedAt) - Date.parse(a.at)) / 60_000).toBeGreaterThan(9);
  });
  it("now alerts on the ride, at the poll a ride started at boarding does", () => {
    const a = firstAlert(polls)!;
    expect(a.boarded).toBe(true);
    expect(a.at).toBe(firstAlert(fromBoarding(polls))!.at);
    expect(a.at).toBe(firstAlert(fromBoarding(polls), false)!.at);
    expect(getOffAlertTitle(a.count)).toBe("Get off at the next stop");
  });
});

describe("Red #308 run 1791197575974, Division / Prospect -> LEPH / 60 College, started 40 min before boarding", () => {
  const polls = replay(redEarly);

  it("without the guard, said 'Get off here' with the bus calling at the exit on its way round, 33 min before boarding", () => {
    const a = firstAlert(polls, false)!;
    expect(a.at).toBe("2026-10-05T11:00:31.443Z");
    expect(a.count).toBe(0);
    expect((Date.parse(redEarly.boardedAt) - Date.parse(a.at)) / 60_000).toBeGreaterThan(33);
  });
  it("now alerts on the ride, at the poll a ride started at boarding does", () => {
    const a = firstAlert(polls)!;
    expect(a.boarded).toBe(true);
    expect(a.at).toBe(firstAlert(fromBoarding(polls))!.at);
    expect(a.at).toBe(firstAlert(fromBoarding(polls), false)!.at);
    expect(getOffAlertTitle(a.count)).toBe("Get off in 2 stops");
  });
});

describe.each([...banner.rides as unknown as Ride[], redEarly].map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s, started on board",
  (_name, r) => {
    const riding = fromBoarding(replay(r)).filter((p) => p.riding);

    it("alerts at the same poll as without the guard, from boarding or from any later poll short of the exit", () => {
      const starts = riding.map((p, i) => [p, i] as const).filter(([p]) => p.row < p.calls - 1);
      expect(starts.length).toBeGreaterThan(20);
      for (const [p, i] of starts) expect(firstAlert(riding.slice(i))?.at, p.at).toBe(firstAlert(riding.slice(i), false)?.at);
      expect(firstAlert(riding)).not.toBeNull();
    });
  },
);

describe("rideBoarded", () => {
  it("not before the bus is at the pickup or a call of the ride short of the exit", () => {
    expect(rideBoarded(false, -1, 6)).toBe(false); // coming, or counting another pass of the exit
    expect(rideBoarded(false, 5, 6)).toBe(false); // at the exit, on its way round to the pickup
  });
  it("the pickup and every call before the exit, and from then on", () => {
    for (const row of [0, 1, 4]) expect(rideBoarded(false, row, 6)).toBe(true);
    expect(rideBoarded(false, 0, 2)).toBe(true); // a one-stop ride, at its pickup
    for (const row of [-1, 5]) expect(rideBoarded(true, row, 6)).toBe(true);
  });
});

// No DOM library here, so the banner's wiring is pinned in the source (as in
// rideAlertTiming.test.ts).
describe("OnBusBanner", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
  const bannerSrc = src.slice(src.indexOf("const OnBusBanner: FC<"), src.indexOf("const TransitMap: FC"));

  it("reads the bus's row on the ride's calls from the banner's own count, as the ride page does", () => {
    expect(bannerSrc).toMatch(/const rideCallList = cfg \? rideCalls\(cfg, routeStops, stopCoords, ride\.boardStopId, ride\.alightStopId\) : \[\];/);
    expect(bannerSrc).toMatch(/rideCallIndex\(bus, cfg, routeStops, stopCoords, rideCallList, stopsRemaining, Date\.now\(\), liveAnchorStore\)/);
    expect(bannerSrc).toMatch(/const boarded = rideBoarded\(rideBoardedSeen\(ride\), busRow, rideCallList\.length\);/);
  });
  it("keeps it with the ride and fires the one-shot alert only once boarded", () => {
    expect(bannerSrc).toMatch(/useEffect\(\(\) => \{ if \(boarded\) noteRideBoarded\(ride\); \}, \[boarded, ride\]\);/);
    expect(bannerSrc).toMatch(/if \(!boarded\) return;\n\s*if \(!getOffAlertDue\(stopsRemaining, etaSec, driveSec, exitMeters\)\) return;/);
    expect(bannerSrc).toMatch(/\}, \[boarded, stopsRemaining, etaSec, driveSec, exitMeters,/);
    // Pin both the bounded fallback and the original persisted identity check,
    // with key computation inside the catch on reads AND writes (PR387).
    expect(src).toContain("let rideBoardedMemory: string | null = null;");
    expect(src).toContain("function rideBoardedSeen(r: BoardedRide): boolean {\n  try {\n    const key = rideBoardedKey(r);\n    return key !== null && (rideBoardedMemory === key || localStorage.getItem(RIDE_BOARDED_LS_KEY) === key);\n  } catch { return false; }\n}");
    expect(src).toContain("function noteRideBoarded(r: BoardedRide): void {\n  try {\n    const key = rideBoardedKey(r);\n    if (key === null) return;\n    rideBoardedMemory = key;\n    localStorage.setItem(RIDE_BOARDED_LS_KEY, key);");
  });
});
