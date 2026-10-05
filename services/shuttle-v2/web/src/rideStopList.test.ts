/**
 * THE RIDE PAGE LISTS THE RIDE'S CALLS, IN TRAVEL ORDER — incident ridestoplist20261004.
 *
 * The ride page's stop list (TransitMap `RideStopList`) walked the de-duplicated
 * stop list from the pickup's slot to the exit's. That list keeps the order in
 * which upstream first names each stop: on Green, Building 900, 800, 600, 400,
 * 750, West Haven Train Station. So every recorded Building 400 -> station ride
 * listed "Building 400 · Building 750 · West Haven Train Station", without the
 * 600, 800 and 900 the bus calls at on the way, and drew the bus at Building 750
 * while it stood at Building 800, or nowhere. Purple's Building 400 -> LEPH /
 * 60 College listed the two of them. The list is now the ride's calls
 * (liveAnchor.ts `rideCalls`) with the bus on the row the banner's count puts it
 * (`rideStopsToExit`, `rideCallIndex`), replayed here over the rides of
 * ridebannercount20261004 and scored against the stops the feed had the bus
 * standing at.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBusOnRoute, registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals } from "./arrivals";
import type { AnchorStore } from "./eta";
import { haversineMeters, type LatLon } from "./geo";
import { anchorIndexOnList, rideCallIndex, rideCalls, rideStopsToExit } from "./liveAnchor";
import { mergedRouteStops, ROUTE_LISTS } from "./routes";
import payload from "./__fixtures__/buses-payload.json";
import green from "./__fixtures__/green-published-order.json";
import pink from "./__fixtures__/pink-published-order.json";
import purple from "./__fixtures__/purple-published-order.json";
import banner from "./__fixtures__/ride-banner-count-2026-10-04.json";
import printedLists from "./__fixtures__/ride-stop-list-2026-10-05.json";

const routeStops: Record<string, number[]> = { "8": pink.stops, "9": green.stops, "10": purple.stops };
const coords: Record<number, LatLon> = {};
for (const [id, ll] of Object.entries({ ...pink.stopCoords, ...green.stopCoords, ...purple.stopCoords })) {
  const [lat, lon] = ll as [number, number];
  coords[Number(id)] = { lat, lon };
}
const names: Record<number, string> = {};
for (const [id, name] of Object.entries({ ...pink.stopNames, ...green.stopNames, ...purple.stopNames })) {
  names[Number(id)] = (name as string).replace(/\s*\/\s*/g, "/");
}

type Ride = (typeof banner.rides)[number];
const ride = (runId: string) => banner.rides.find((r) => r.runId === runId)!;
const cfgOf = (label: string) => ROUTE_LISTS.find((c) => c.label === label)!;
const norm = (s: string) => s.replace(/^#/, "");

/** Master's list: the de-duplicated list walked from the pickup's slot to the exit's. */
function walked(label: string, boardStopId: number, alightStopId: number, stops = routeStops): number[] {
  const list = [...new Set(mergedRouteStops(cfgOf(label), stops))];
  const out: number[] = [];
  for (let i = list.indexOf(boardStopId), guard = 0; guard++ <= list.length; i = (i + 1) % list.length) {
    out.push(list[i]!);
    if (list[i] === alightStopId) break;
  }
  return out;
}

/** What the page printed at each riding poll: the stop names (suffixes such as
 * "boarded" and "~10 min" dropped) and the row icons. */
function printed(r: Ride) {
  const polls = printedLists.rides.find((p) => p.runId === r.runId)!.polls;
  return polls.map((p) => ({
    at: p.at,
    names: p.rows.map(([, text]) => text!.replace(/(boarded|~?\d+ min|<1 min)$/, "")),
    icons: p.rows.map(([icon]) => icon).join(""),
  }));
}

/** Each recorded poll as the page runs it: one anchor store for the ride, the
 * ride countdown's arrivals at the exit, the banner's count, the list's bus row.
 * `early` starts the ride from the fixture's earlier feed rows. */
function replay(r: Ride, early = false) {
  const cfg = cfgOf(r.routeLabel);
  const list = [...new Set(routeStops[String(r.routeId)]!)];
  const calls = rideCalls(cfg, routeStops, coords, r.boardStopId, r.alightStopId);
  const store: AnchorStore = new Map();
  const before = early ? (printedLists.rides.find((p) => p.runId === r.runId) as { early?: typeof r.positions }).early! : [];
  return [...before, ...r.positions].map((fix) => {
    const now = Date.parse(fix.at);
    const bus = { ...fix, bus_id: 0, route_id: r.routeId, bus_name: r.busName };
    const exit = computeUpcomingArrivals([r.alightStopId], [bus], routeStops, coords, {}, now, {}, store)
      .filter((a) => a.stopId === r.alightStopId && norm(a.busName) === norm(r.busName));
    const idx = isBusOnRoute(bus, list, coords) ? anchorIndexOnList(bus, cfg, routeStops, coords, list, now, store) : -1;
    const count = idx >= 0 ? rideStopsToExit(bus, cfg, routeStops, coords, r.alightStopId, exit, now, store) : null;
    const stop = fix.at_stop_id != null ? coords[fix.at_stop_id] : undefined;
    return {
      at: fix.at,
      riding: fix.phase !== "waiting" && Date.parse(fix.at) <= Date.parse(r.arrivedAt),
      // The feed has the bus standing at this stop.
      standing: fix.stationary && fix.at_stop_id != null && stop && haversineMeters(fix, stop) <= 75 ? fix.at_stop_id : null,
      count,
      row: rideCallIndex(bus, cfg, routeStops, coords, calls, count, now, store),
    };
  });
}

beforeEach(() => registerRoutePaths({ "8": pink.path, "9": green.path, "10": purple.path } as unknown as Record<string, [number, number][]>));
afterEach(() => registerRoutePaths(null));

describe.each(banner.rides.map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s (incident ridestoplist20261004)",
  (_name, r) => {
    const cfg = cfgOf(r.routeLabel);

    it("master's list is what the page printed", () => {
      const seen = printed(r);
      expect(seen.length).toBeGreaterThan(20);
      const want = walked(r.routeLabel, r.boardStopId, r.alightStopId).map((s) => names[s]);
      for (const p of seen) expect(p.names, p.at).toEqual(want);
    });

    it("lists the ride's calls in travel order, pickup first", () => {
      expect(rideCalls(cfg, routeStops, coords, r.boardStopId, r.alightStopId)).toEqual(r.rideStops);
    });

    it("draws the bus at the call the feed has it standing at", () => {
      const steps = replay(r).filter((s) => s.riding && s.standing !== null && r.rideStops.includes(s.standing));
      expect(steps.length).toBeGreaterThan(2);
      for (const s of steps) {
        // A stand's first poll can still read the leg before it (the banner's count is one high there).
        const at = r.rideStops.indexOf(s.standing!);
        expect([at - 1, at], `${s.at} at ${s.standing}: row ${s.row}`).toContain(s.row);
      }
    });

    it("moves the bus down the list to the exit without going back", () => {
      const s = replay(r).filter((x) => x.riding);
      const first = s.findIndex((x) => x.standing === r.rideStops[1]);
      expect(first).toBeGreaterThan(0);
      const rows = s.slice(first).map((x) => x.row);
      expect(rows).not.toContain(-1);
      expect(rows).toEqual([...rows].sort((a, b) => a - b));
      // The rider's arrival poll: the bus at the exit's kerb, on the exit's row.
      expect(rows[rows.length - 1]).toBe(r.rideStops.length - 1);
    });
  },
);

describe("the reported rides", () => {
  it("Green #321 run 1791116282719 listed Building 400 · Building 750 · West Haven Train Station", () => {
    const r = ride("1791116282719");
    const seen = printed(r);
    expect(new Set(seen.map((p) => p.names.join(" · ")))).toEqual(new Set(["Building 400 · Building 750 · West Haven Train Station"]));
    // While the bus stood at Building 800 and Building 900, the page drew it at
    // Building 750 or nowhere.
    const standing = new Map(replay(r).map((s) => [s.at, s.standing]));
    const at = (stopId: number) => seen.filter((p) => standing.get(p.at) === stopId);
    expect(at(25).length).toBeGreaterThan(5);
    expect(at(26).length).toBeGreaterThan(5);
    const drawn = [...at(25), ...at(26)].map((p) => p.icons);
    expect(new Set(drawn)).toEqual(new Set(["·🚌🚏", "··🚏"]));
    expect(rideCalls(cfgOf("Green"), routeStops, coords, 22, 127).map((s) => names[s])).toEqual([
      "Building 400", "Building 600", "Building 750", "Building 800", "Building 900", "West Haven Train Station",
    ]);
    // Now: the bus walks the list, Building 400 to the station.
    const rows = replay(r).filter((x) => x.riding && x.row >= 0).map((x) => x.row);
    expect(rows.filter((x, i) => i === 0 || rows[i - 1] !== x)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // A ride can be started before its bus comes (TripBoardingActions). The
  // countdown to the station is then for its outbound call, which the bus makes
  // before it reaches Building 400, so the banner counted 5, 4, 3, 2, 1 to it
  // down Whitney Avenue; the list draws no bus until the shared anchor has it at
  // one of the ride's calls. Standing at that outbound call it is at the exit's
  // stop, and reads as there (as on master, and the banner's "Arriving at").
  it("Green #321 run 1791116282719, started before the bus came: no bus between pickup and exit until it is on the ride", () => {
    const r = ride("1791116282719");
    const s = replay(r, true);
    const exit = r.rideStops.length - 1;
    const pickup = s.findIndex((x) => x.standing === r.boardStopId);
    expect(pickup).toBeGreaterThan(60);
    const coming = s.slice(0, pickup);
    // What the guard is for: the count runs down within the list's length here.
    expect(coming.filter((x) => x.count !== null && x.count > 0 && x.count < exit).length).toBeGreaterThan(10);
    expect(coming.filter((x) => x.row >= 0 && x.row < exit).map((x) => `${x.at}: row ${x.row}`)).toEqual([]);
    for (const x of coming.filter((y) => y.row === exit)) expect(x.count, x.at).toBe(0);
    expect(s.slice(pickup, pickup + 3).map((x) => x.row)).toContain(0);
  });

  it("Purple #126 run 1790971678692 listed Building 400 · LEPH/60 College", () => {
    const r = ride("1790971678692");
    expect(new Set(printed(r).map((p) => p.names.join(" · ")))).toEqual(new Set(["Building 400 · LEPH/60 College"]));
    expect(rideCalls(cfgOf("Purple"), routeStops, coords, 22, 72).map((s) => names[s])).toEqual([
      "Building 400", "Building 600", "Building 750", "Building 800", "Building 900", "West Haven Train Station", "LEPH/60 College",
    ]);
  });
});

describe("rideCalls on the folded lines", () => {
  const calls = (label: string, board: number, alight: number) => rideCalls(cfgOf(label), routeStops, coords, board, alight);

  it("keeps every call of the ring: the station's added call and both passes of a West Campus stop", () => {
    // Green from Orange / Pearl (S) to Building 750: out past the station, down the spur, back up it.
    expect(calls("Green", 92, 24)).toEqual([92, 81, 127, 26, 25, 23, 22, 23, 24]);
    // Purple from LEPH / 60 College out to Building 400.
    expect(calls("Purple", 72, 22)).toEqual([72, 10, 9, 1, 122, 127, 26, 25, 24, 23, 22]);
  });

  it("boards the pass of a twice-served pickup nearest before the exit, as the planner does", () => {
    // Building 800 for downtown: the return pass, not the outbound one and the whole spur.
    expect(calls("Purple", 25, 72)).toEqual([25, 26, 127, 72]);
    expect(calls("Green", 25, 127)).toEqual([25, 26, 127]);
    // Building 600 to Building 750 on Green: the return pass.
    expect(calls("Green", 23, 24)).toEqual([23, 24]);
  });

  it("is empty for a stop the line does not serve", () => {
    expect(calls("Green", 22, 72)).toEqual([]);
  });
});

describe("rideCalls on every line", () => {
  const stops = payload.routes as unknown as Record<string, number[]>;
  const all: Record<number, LatLon> = {};
  for (const [id, c] of Object.entries(payload.stop_coords as unknown as Record<string, LatLon>)) all[Number(id)] = c;
  beforeEach(() => registerRoutePaths(payload.route_paths as unknown as Record<string, [number, number][]>));

  it("walks upstream's list on a line that names each stop once, as before; the folded lines run pickup to exit", () => {
    let pairs = 0;
    for (const cfg of ROUTE_LISTS) {
      const seq = mergedRouteStops(cfg, stops);
      if (seq.length === 0) continue;
      const folded = new Set(seq).size !== seq.length;
      expect(folded, cfg.label).toBe(cfg.label === "Green" || cfg.label === "Purple");
      for (const board of new Set(seq)) {
        for (const alight of new Set(seq)) {
          if (board === alight) continue;
          const got = rideCalls(cfg, stops, all, board, alight);
          pairs++;
          if (!folded) { expect(got, `${cfg.label} ${board}->${alight}`).toEqual(walked(cfg.label, board, alight, stops)); continue; }
          expect(got[0]).toBe(board);
          expect(got[got.length - 1]).toBe(alight);
          // Neither the pickup nor the exit comes round again in between.
          expect(got.slice(1).includes(board) || got.slice(0, -1).includes(alight), `${cfg.label} ${board}->${alight}`).toBe(false);
        }
      }
    }
    expect(pairs).toBeGreaterThan(2000);
  });
});
