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

  it("holds the alert past Building 900 and the drive to the station, then says 'next stop'", () => {
    const s = steps();
    const fired = s.find((x) => getOffAlertDue(x.count, x.eta))!;
    expect(fired.standing).toBe(127); // West Haven Train Station, the stop before LEPH
    expect(getOffAlertTitle(fired.count)).toBe("Get off at the next stop");
    expect(s.filter((x) => x.at < fired.at && x.count === 2).length).toBeGreaterThan(10);
  });
});

describe.each(fixture.rides.map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s (bannerpopuptime20261005)",
  (_name, r) => {
    it("never says 'Get off in 2 stops' with more than 5 min on the countdown", () => {
      const s = replay(r);
      expect(s.some((x) => x.count === 2)).toBe(true);
      expect(s.filter((x) => x.count === 2 && getOffAlertDue(x.count, x.eta) && x.eta! >= 6 * 60)
        .map((x) => `${x.at}: ${x.eta! / 60} min`)).toEqual([]);
    });

    it("still alerts before the exit, no later than the count's first 'next stop'", () => {
      const s = replay(r);
      const fired = s.findIndex((x) => getOffAlertDue(x.count, x.eta));
      const next = s.findIndex((x) => x.count !== null && x.count <= 1);
      expect(fired).toBeGreaterThanOrEqual(0);
      expect(fired).toBeLessThanOrEqual(next);
      expect(s[fired]!.count).toBeGreaterThan(0);
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
  it("fires on the count alone without a countdown, as before", () => {
    expect(getOffAlertDue(2, null)).toBe(true);
  });
  it("never holds 'next stop' or 'here', and never fires farther out", () => {
    expect(getOffAlertDue(1, 18 * 60)).toBe(true);
    expect(getOffAlertDue(0, 40 * 60)).toBe(true);
    expect(getOffAlertDue(3, 60)).toBe(false);
    expect(getOffAlertDue(null, 60)).toBe(false);
  });
});

// No DOM library here, so the banner's wiring is pinned in the source (same
// approach as rideBannerStacking.test.ts): the alert waits on the countdown,
// while the headline, the red banner and the stop list keep the count.
describe("OnBusBanner", () => {
  const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
  const banner = src.slice(src.indexOf("const OnBusBanner: FC<"), src.indexOf("const TransitMap: FC"));

  it("fires the one-shot alert through getOffAlertDue with the ride countdown", () => {
    expect(banner).toMatch(/if \(!getOffAlertDue\(stopsRemaining, etaSec\)\) return;/);
    expect(banner).not.toMatch(/stopsRemaining > 2\) return;/);
  });
  it("keeps the headline and the red banner on the count", () => {
    expect(banner).toMatch(/const arriving = stopsRemaining !== null && stopsRemaining <= 2;/);
    expect(banner).toMatch(/rideHeadline\(\{\s*busFound: bus !== undefined, stopsRemaining,/);
  });
});
