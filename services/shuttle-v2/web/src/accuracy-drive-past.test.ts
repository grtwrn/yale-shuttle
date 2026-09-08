/**
 * THE BUS HAS PULLED AWAY, AND THE CLOCK IS STILL RUNNING.
 *
 * The companion to `accuracy-ghost-arrival.test.ts` and the case its rule
 * cannot reach. #173 refuses a cold stand only where the bus is more than 55 m
 * from the marker AND `last_stop_id` has already advanced to that stop. Buses
 * come to rest 22 m past the sign at the median, so the radius is real — but it
 * hands the whole band between the marker and 55 m back to the served clock,
 * and `last_stop_id` lags a median 34 m past the closest approach and often
 * never names the stop while the bus is still in its zone.
 *
 * Blue Day, 2026-09-04, **Phelps Gate (#98)**. #38 stood there for 25 s and
 * pulled away; the payload went on publishing `at_stop_id = 98` with a clock
 * 40 s old, because the collector pins that clock to the stop until the bus is
 * 125 m off (deliberately — #82, so a yard shuffle cannot restart a layover):
 *
 *   09:03:32  #38 arrives, 16 m from the marker      (`stop_visits`: stood 24.9 s)
 *   09:03:57  #38 departs
 *   09:04:07  #38 53 m PAST, moving, `last_stop_id` still 42   <- a cold load says "now"
 *   09:22:26  #44 arrives — the next Blue Day bus, nineteen minutes later
 *
 * At 09:04:07 both of #173's witnesses are absent: 53 m is inside its radius,
 * and the feed still names the PREVIOUS stop. On master this row is `eta 0`.
 *
 * What settles it is the ring's own travel order — the fix is more than one
 * cell PAST the marker — together with the fact that the fix changed on the
 * newest poll (`seen_at` equals `last_moved_at`, both server clocks). Neither
 * is a radius and neither is `last_stop_id`.
 *
 * Both tails are asserted, because they are one coin: a bus still CLOSING on
 * the stop keeps its "now" (refusing that prices the stop a lap away, which is
 * a worse sentence than the ghost), and what a single frame genuinely cannot
 * settle — the poll on which a bus pulls up past the sign — is pinned to one
 * poll, with the recovery on the next.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "./arrivals";
import type { AnchorStore } from "./eta";
import { haversineMeters, type LatLon } from "./geo";
import fixture from "./__fixtures__/blue-drive-past.json";

type Poll = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number | null;
  at_stop_id: number | null;
  at_stop_since: string | null;
  stationary_since: string;
  last_moved_at: string;
  seen_at: string;
};

const FX = fixture as unknown as {
  routeId: string; routeLabel: string; busRouteId: number;
  passingBus: string; boardStopId: number;
  pass: {
    pinnedAt: number; arrivedAt: number; departedAt: number | null;
    outcome: string; standSec: number; closestM: number;
  };
  nextArrivals: Array<{ busName: string; arrivedAt: number; outcome: string; standSec: number }>;
  stopNames: Record<string, string>;
  routeStops: Record<string, number[]>;
  stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes;
  dwells: DwellTimes;
  buses: Record<string, Poll[]>;
};

const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(FX.stopCoords)) stopCoords[Number(k)] = v;
const norm = (s: string) => s.replace(/^#/, "");
const board = stopCoords[FX.boardStopId]!;
/** The bus the rider was really waiting for. */
const NEXT_BUS = "#44";
/** One ring cell, the sensor's own quantum — the slack inside which "past the marker" is not a fact. */
const CELL_M = 30;

const ticks = [...new Set(Object.values(FX.buses).flatMap((ps) => ps.map((p) => p.t)))]
  .sort((a, b) => a - b);

const fixAt = (busName: string, t: number): Poll | null => {
  let row: Poll | null = null;
  for (const p of FX.buses[busName] ?? []) { if (p.t <= t) row = p; else break; }
  return row;
};

/** The payload's `buses` array as of `t` — the freshest fix at or before it. */
function busesAt(t: number) {
  const out: Array<Record<string, unknown>> = [];
  for (const busName of Object.keys(FX.buses)) {
    const row = fixAt(busName, t);
    if (!row) continue;
    out.push({
      bus_id: 0, bus_name: busName, route_id: FX.busRouteId,
      lat: row.lat, lon: row.lon, heading: row.heading,
      ...(row.last_stop_id != null ? { last_stop_id: row.last_stop_id } : {}),
      ...(row.at_stop_id != null
        ? { at_stop_id: row.at_stop_id, at_stop_since: row.at_stop_since }
        : {}),
      stationary_since: row.stationary_since,
      last_moved_at: row.last_moved_at,
      seen_at: row.seen_at,
    });
  }
  return out as never[];
}

/** What a FRESH PAGE LOAD renders from the single frame current at `t`. */
function coldRowAt(t: number) {
  const store: AnchorStore = new Map();
  return computeUpcomingArrivals(
    [FX.boardStopId], busesAt(t), FX.routeStops, stopCoords,
    FX.segments, t, FX.dwells, store,
  ).filter((a) => a.routeLabel === FX.routeLabel);
}

const etTime = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

/**
 * The blind frame: the first poll after the bus pulled out on which it is more
 * than a cell past the marker but still inside #173's 55 m radius. Named by
 * what it is, so the poll cadence cannot slide the test onto its neighbour.
 */
const GHOST_TICK = ticks.find((t) => {
  const f = fixAt(FX.passingBus, t);
  if (!f || t <= FX.pass.departedAt!) return false;
  const d = haversineMeters(f, board);
  return d > CELL_M && d <= 55;
})!;

describe("a bus that has pulled away is not arriving (Blue Day #38 at Phelps Gate, 2026-09-04)", () => {
  beforeEach(() => registerRoutePaths(FX.routePath));

  it("is the recorded incident: it stood, and then it left", () => {
    expect(FX.passingBus).toBe("#38");
    expect(FX.stopNames[String(FX.boardStopId)]).toBe("Phelps Gate");
    // Ground truth from `stop_visits`, not from our own maths.
    expect(FX.pass.outcome).toBe("stopped");
    expect(FX.pass.standSec).toBeGreaterThan(20);
    expect(FX.pass.departedAt).not.toBeNull();
    // The rider's real bus was another vehicle, several minutes out.
    const next = FX.nextArrivals.find((a) => a.busName !== FX.passingBus)!;
    expect(next.busName).toBe(NEXT_BUS);
    expect((next.arrivedAt - FX.pass.departedAt!) / 60_000).toBeGreaterThan(15);
  });

  it("neither a 55 m radius nor `last_stop_id` can see this frame", () => {
    // Why this test exists. At the blind frame the bus has left, is moving, and
    // BOTH of the witnesses #173 spends are absent — while the served clock is
    // still counting a stand at this very stop.
    const t = GHOST_TICK;
    expect(etTime(t)).toBe("09:04:07");
    const f = fixAt(FX.passingBus, t)!;
    const d = haversineMeters(f, board);
    expect(d).toBeGreaterThan(CELL_M);
    expect(d).toBeLessThanOrEqual(55);
    expect(f.last_stop_id).not.toBe(FX.boardStopId);
    // The payload still says: at stop 98, standing, for over half a minute.
    expect(f.at_stop_id).toBe(FX.boardStopId);
    expect((t - Date.parse(f.stationary_since + "Z")) / 1000).toBeGreaterThan(30);
    // ...and the two server clocks say the fix changed on this very poll.
    expect(f.seen_at).toBe(f.last_moved_at);
  });

  it("no cold render calls the departed bus an arrival at the board stop", () => {
    // THE REGRESSION. On master the 09:04:07 row is `eta 0` — "now", for a bus
    // that had pulled away ten seconds earlier and does not come back for a lap.
    for (const t of ticks) {
      const f = fixAt(FX.passingBus, t);
      if (!f || t <= FX.pass.departedAt!) continue;
      const away = haversineMeters(f, board);
      if (away <= CELL_M) continue;
      const mine = coldRowAt(t).find((a) => norm(a.busName) === norm(FX.passingBus));
      if (!mine) continue;
      expect(
        mine.eta,
        `at ${etTime(t)} a cold load offered ${FX.passingBus} in ${Math.round(mine.eta)} s `
          + `while it was ${Math.round(away)} m PAST the stop and driving away`,
      ).toBeGreaterThan(600);
    }
  });

  it("the bus the rider was actually waiting for is still shown arriving", () => {
    // The rule must not buy its way out by never saying "now".
    const arrival = FX.nextArrivals.find((a) => a.busName === NEXT_BUS)!;
    const t = arrival.arrivedAt + 10_000;
    expect(haversineMeters(fixAt(NEXT_BUS, t)!, board)).toBeLessThan(80);
    const mine = coldRowAt(t).find((a) => norm(a.busName) === norm(NEXT_BUS));
    expect(mine, `no cold arrival offered for ${NEXT_BUS} while it stood at the stop`).toBeDefined();
    expect(mine!.eta).toBeLessThan(60);
  });

  it("a bus still CLOSING on the stop keeps its arrival", () => {
    // The other tail, and the reason the rule is shaped this way. On the polls
    // where the next bus is inside the zone and still closing it shows
    // everything the departing bus shows — a fresh fix every poll, a served
    // clock claiming a stand — except which side of the marker it is on.
    const arrival = FX.nextArrivals.find((a) => a.busName === NEXT_BUS)!;
    const closing = ticks.filter((t, i) => {
      const f = fixAt(NEXT_BUS, t);
      const nextTick = ticks[i + 1];
      const g = nextTick === undefined ? null : fixAt(NEXT_BUS, nextTick);
      if (!f || !g || t >= arrival.arrivedAt) return false;
      const d = haversineMeters(f, board);
      return d > 20 && d <= 75 && haversineMeters(g, board) < d;
    });
    expect(closing.length).toBeGreaterThan(0);
    for (const t of closing) {
      const mine = coldRowAt(t).find((a) => norm(a.busName) === norm(NEXT_BUS));
      expect(mine, `no row for ${NEXT_BUS} closing on the stop at ${etTime(t)}`).toBeDefined();
      expect(
        mine!.eta,
        `at ${etTime(t)} a cold load put closing ${NEXT_BUS} ${Math.round(mine!.eta)} s away`,
      ).toBeLessThan(120);
    }
  });

  it("what one frame cannot settle lasts one poll", () => {
    // The honest residue, written down. At the poll a bus comes to rest PAST
    // the sign it looks exactly like a bus driving on — a fresh fix, past the
    // marker — and nothing in that frame separates them. The next poll does:
    // the fix repeats, which is 5.8 : 1 evidence of a stand, and the row says
    // now. The guarantee is the recovery, and it is one poll.
    const arrival = FX.nextArrivals.find((a) => a.busName === NEXT_BUS)!;
    const after = ticks.filter((t) => t > arrival.arrivedAt);
    const settled = after.find((t) => {
      const f = fixAt(NEXT_BUS, t)!;
      return f.seen_at !== f.last_moved_at;
    })!;
    expect((settled - arrival.arrivedAt) / 1000).toBeLessThanOrEqual(10);
    const mine = coldRowAt(settled).find((a) => norm(a.busName) === norm(NEXT_BUS));
    expect(mine, `no row for ${NEXT_BUS} one poll after it came to rest`).toBeDefined();
    expect(mine!.eta).toBeLessThan(60);
  });
});
