/**
 * A BUS THAT HAS ALREADY GONE IS NOT SHOWN AS ARRIVING NOW.
 *
 * The canary's worst live finding, replayed off the production rows it
 * happened on (`__fixtures__/red-ghost-arrival.json`, written by
 * `scripts/record-ghost-arrival.mjs`).
 *
 * Red, 2026-09-08, the operator's canonical trip: Prospect / Canner → the
 * School of Public Health, board stop Division / Prospect (#48). #307 drew
 * level with the stop at 10:35:05 and drove straight on — the detector scored
 * that visit `outcome=passed, stand_sec=0`, and the bus was 129 m down
 * Prospect by 10:35:20, doing about 6.6 m/s.
 *
 *   10:35:05  #307 at the stop, 14 m           (it never stopped)
 *   10:35:15  #307 67 m PAST, moving           <- a fresh page load says "now"
 *   10:35:20  #307 129 m past, accelerating
 *   10:46:50  #306 arrives — the rider's actual bus, 11.5 min later
 *
 * The canary loaded the page at 10:35:20 and read "now, then 67 min"; 17 s
 * later the same row read "in 13, 26 min". Both numbers in the first reading
 * were #307: "now" because the belief put it AT the stop, and 67 min because
 * a belief anchored there reaches stop 48 again only a lap on.
 *
 * WHY. `initBelief` had one frame and no history, so it took the server's
 * stationary clock as evidence of a stand. That clock is pinned to a stop —
 * the collector anchors it the moment a bus comes within 75 m and carries it
 * until the bus is 125 m away (detector.ts `stationaryFields`) — so it runs
 * straight through a bus that is only driving past. At 10:35:15 it read 20 s
 * old, and `at_stop_id` was 48, for a bus that had served the stop ten seconds
 * earlier. A WARM belief never had this problem: it watches the fixes and drops
 * #307 to next-lap on the very poll it pulls out. Every rider's first render is
 * a cold start.
 *
 * The fix hands the cold start the evidence the warm belief builds for itself:
 * `last_moved_at`, when the reported fix last changed.
 *
 * The bound is the invariant, not a tolerance: from the moment the bus is past
 * the stop, no cold render may call it an arrival at that stop.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "./arrivals";
import type { AnchorStore } from "./eta";
import { haversineMeters, type LatLon } from "./geo";
import fixture from "./__fixtures__/red-ghost-arrival.json";

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
  pass: { anchoredAt: number; pinnedAt: number; arrivedAt: number; departedAt: number | null; outcome: string; standSec: number; closestM: number };
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

const ticks = [...new Set(Object.values(FX.buses).flatMap((ps) => ps.map((p) => p.t)))]
  .sort((a, b) => a - b);

/** The payload's `buses` array as of `t` — the freshest fix at or before it. */
function busesAt(t: number) {
  const out: Array<Record<string, unknown>> = [];
  for (const [busName, polls] of Object.entries(FX.buses)) {
    let row: Poll | null = null;
    for (const p of polls) { if (p.t <= t) row = p; else break; }
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

const fixAt = (busName: string, t: number): Poll => {
  let row: Poll | null = null;
  for (const p of FX.buses[busName]!) { if (p.t <= t) row = p; else break; }
  return row!;
};

const etTime = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

/**
 * The ghost frame: the LAST poll on which the departing bus is still inside
 * the board stop's 75 m zone — the collector's own at-stop radius, and the
 * outer edge of where the belief will stand a bus at the kerb. Named by what
 * it is rather than by a timestamp, so the poll cadence cannot slide the test
 * onto its neighbour.
 */
const GHOST_TICK = ticks.filter((t) =>
  t > FX.pass.arrivedAt && haversineMeters(fixAt(FX.passingBus, t), board) <= 75).pop()!;

describe("a bus that has driven past is not priced as arriving (Red #307, 2026-09-08)", () => {
  beforeEach(() => registerRoutePaths(FX.routePath));

  it("is the recorded incident: the detector says it never stood", () => {
    expect(FX.passingBus).toBe("#307");
    expect(FX.stopNames[String(FX.boardStopId)]).toBe("Division / Prospect");
    // Ground truth from `stop_visits`, not from our own maths: the bus PASSED.
    expect(FX.pass.outcome).toBe("passed");
    expect(FX.pass.standSec).toBe(0);
    expect(FX.pass.closestM).toBeLessThan(20);
    // ...and it was nonetheless pinned, which is the `at_stop_since` the
    // payload publishes and the clock the cold start believed.
    expect(FX.pass.pinnedAt).toBeLessThan(FX.pass.arrivedAt);
    // The rider's real bus was another vehicle, ~12 min out.
    const next = FX.nextArrivals.find((a) => a.busName !== FX.passingBus)!;
    expect(next.busName).toBe("#306");
    expect((next.arrivedAt - FX.pass.arrivedAt) / 60_000).toBeGreaterThan(10);
    // And the case that stops this being fixed by never saying "now": the SAME
    // bus, at the SAME stop, one lap later, really did stand there for 55 s.
    // "Now" was a lie at 10:35 and the truth at 11:35, and nothing in the frame
    // itself distinguishes them — only whether the fix is moving does.
    const laterStand = FX.nextArrivals.find(
      (a) => a.busName === FX.passingBus && a.outcome === "stopped");
    expect(laterStand).toBeDefined();
    expect(laterStand!.standSec).toBeGreaterThan(30);
  });

  it("the payload really did claim a 20 s stand on a bus doing 6+ m/s", () => {
    // This is the defect's raw material, pinned so a change in the collector's
    // clocks cannot quietly invalidate the test above.
    const t = GHOST_TICK;
    expect(etTime(t)).toBe("10:35:15");
    const f = fixAt(FX.passingBus, t);
    expect(f.at_stop_id).toBe(FX.boardStopId);
    const stationaryFor = (t - Date.parse(f.stationary_since + "Z")) / 1000;
    expect(stationaryFor).toBeGreaterThanOrEqual(15);
    // ...while the bus was well past the stop and still moving.
    expect(haversineMeters(f, board)).toBeGreaterThan(60);
    // ...and the movement clock says so: the fix changed on this very poll,
    // which is what the pair of server clocks in the payload states exactly —
    // `seen_at` is the poll the fix was reported on, `last_moved_at` the poll
    // it last changed on.
    expect(f.seen_at).toBe(f.last_moved_at);
  });

  it("no cold render calls the departed bus an arrival at the board stop", () => {
    // THE REGRESSION. From the poll the bus is level with the stop onward, a
    // fresh page load must not offer #307 as an imminent arrival at #48.
    for (const t of ticks) {
      if (t < FX.pass.arrivedAt) continue;
      const mine = coldRowAt(t).find((a) => norm(a.busName) === norm(FX.passingBus));
      if (!mine) continue;
      const away = haversineMeters(fixAt(FX.passingBus, t), board);
      expect(
        mine.eta,
        `at ${new Date(t).toISOString()} a cold load offered ${FX.passingBus} in ` +
          `${Math.round(mine.eta)} s while it was ${Math.round(away)} m PAST the stop`,
      ).toBeGreaterThan(600);
    }
  });

  it("the exact frame the canary read: 10:35:15, 67 m past, and it said now", () => {
    // The reported moment, to the poll. On master this row is `eta 0` — "now"
    // — for a bus that had gone; the rider's bus was 11.5 min away.
    const t = GHOST_TICK;
    const live = coldRowAt(t);
    const mine = live.find((a) => norm(a.busName) === norm(FX.passingBus));
    expect(haversineMeters(fixAt(FX.passingBus, t), board)).toBeGreaterThan(60);
    if (mine) expect(mine.eta).toBeGreaterThan(600);
    // And what the rider should be told instead is the bus that really came:
    // #306, which arrived 11.5 min later.
    const soonest = [...live].sort((a, b) => a.eta - b.eta)[0]!;
    expect(norm(soonest.busName)).toBe("306");
    const truth = (FX.nextArrivals.find((a) => a.busName === "#306")!.arrivedAt - t) / 1000;
    expect(Math.abs(soonest.eta - truth)).toBeLessThan(240);
  });

  it("a bus that really is standing at the stop still reads as arriving", () => {
    // The fix must not buy its way out by refusing to say "now" at all. #306
    // reaches the board stop later in the same recording and stands there;
    // once it has been still for the model's STANDING_MIN_S, a cold load
    // must show it.
    const arrival = FX.nextArrivals.find((a) => a.busName === "#306" && a.outcome === "stopped")!;
    const t = arrival.arrivedAt + 40_000;
    const f = fixAt("#306", t);
    expect(haversineMeters(f, board)).toBeLessThan(80);
    const mine = coldRowAt(t).find((a) => norm(a.busName) === "306");
    expect(mine, "no cold arrival offered for #306 while it stood at the stop").toBeDefined();
    expect(mine!.eta).toBeLessThan(60);
  });
});
