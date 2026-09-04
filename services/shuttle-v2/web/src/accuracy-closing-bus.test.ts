/**
 * A BUS THAT IS CLOSING IS NOT REMOVED FROM THE ROW.
 *
 * The canary's worst live finding since the anchor work shipped, replayed off
 * the production rows it happened on (`__fixtures__/red-closing-bus.json`,
 * written by `scripts/record-closing-bus.mjs`).
 *
 * Red, 2026-09-04, the operator's own trip: Prospect / Canner → the School of
 * Public Health, board stop Division / Prospect (#48), which is 83 m from the
 * origin — a 76-second walk, and just outside `AT_PLACE_M`. #304 had been the
 * bus on the card for sixteen minutes.
 *
 *   16:03:15  "in <1, 19 min"   #304 235 m out and closing
 *   16:03:30  "in 26, 46 min"   #304  97 m out and closing   <- the defect
 *   16:03:37  #304 at the kerb, 6 m
 *
 * #304 never left `computeUpcomingArrivals`' answer — it was eleven seconds
 * away. It left `catchable`, because `canCatch` is `walk <= eta + 60` and the
 * rider's walk was 76 s: past that boundary the bus is TOO CLOSE to be
 * counted as reachable, and the report-#49 dominance rule then compared the
 * pinned vehicle only against what survived, which was #310 twenty-six
 * minutes away.
 *
 * This is the second half of the "declined" drop class in `docs/rider-sim.md`.
 * #120 closed the first half — the pin released in favour of the SAME vehicle
 * a lap later. `rider-sim`'s default riders stand AT the board stop, where
 * `canCatch` is true for every arrival, so neither half is visible to it
 * without `ORIGIN_OFFSET_M`; this test is the one that stands a short walk
 * away on purpose.
 *
 * The bound is the invariant, not a tolerance: from the moment the row first
 * follows the closing bus until it actually arrives, the row does not hand
 * itself to a vehicle a lap out.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import { type AnchorStore } from "./anchorGate";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "./arrivals";
import { haversineMeters, type LatLon } from "./geo";
import { pickLiveArrival } from "./planner";
import { AT_PLACE_M, walkSecFromMeters } from "./walk";
import fixture from "./__fixtures__/red-closing-bus.json";

type Poll = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number | null;
  at_stop_id: number | null;
  at_stop_since: string | null;
  stationary_since: string;
};

const FX = fixture as unknown as {
  routeId: string; routeLabel: string; busRouteId: number;
  closingBus: string; boardStopId: number;
  origin: LatLon; arrivedAt: number; departedAt: number | null;
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
const routeStops: Record<string, number[]> = FX.routeStops;
const norm = (s: string) => s.replace(/^#/, "");

/** Every distinct poll instant in the recording, in order. */
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
    });
  }
  return out as never[];
}

const board = stopCoords[FX.boardStopId]!;
const distToBoard = haversineMeters(FX.origin, board);
const walkSec = distToBoard < AT_PLACE_M ? 0 : walkSecFromMeters(distToBoard);

/** What the row follows at `t`, given the vehicle the plan pinned. */
function rowAt(t: number, store: AnchorStore, pinnedBusName: string) {
  const live = computeUpcomingArrivals(
    [FX.boardStopId], busesAt(t), routeStops, stopCoords,
    FX.segments, t, FX.dwells, store,
  ).filter((a) => a.routeLabel === FX.routeLabel);
  if (live.length === 0) return null;
  const picked = pickLiveArrival(live, pinnedBusName, walkSec);
  return picked ? { live, ...picked } : null;
}

describe("a bus closing on the board stop keeps the row (Red #304, 2026-09-04)", () => {
  beforeEach(() => registerRoutePaths(FX.routePath));

  it("is the recorded incident: a short walk, and the bus really arrives", () => {
    expect(FX.closingBus).toBe("#304");
    expect(FX.stopNames[String(FX.boardStopId)]).toBe("Division / Prospect");
    // 83 m — outside AT_PLACE_M, so the rider has a walk and `canCatch` bites.
    expect(distToBoard).toBeGreaterThan(AT_PLACE_M);
    expect(distToBoard).toBeLessThan(120);
    expect(Math.round(walkSec)).toBe(76);
    // The arrival is ground truth from `arrivals`, not from our own maths.
    expect(FX.arrivedAt).toBeGreaterThan(ticks[0]!);
    expect(FX.arrivedAt).toBeLessThan(ticks[ticks.length - 1]!);
  });

  it("the estimator never withdrew the bus — it was 11 s out when the card dropped it", () => {
    // The anchor is not the defect here, and this pins that: through the whole
    // approach `computeUpcomingArrivals` keeps offering #304, imminently.
    const store: AnchorStore = new Map();
    let lastEta = Infinity;
    for (const t of ticks) {
      if (t > FX.arrivedAt) break;
      const r = rowAt(t, store, FX.closingBus);
      if (!r) continue;
      const mine = r.live.find((a) => norm(a.busName) === norm(FX.closingBus));
      if (t >= FX.arrivedAt - 30_000) {
        expect(mine, `no arrival offered for ${FX.closingBus} at ${new Date(t).toISOString()}`)
          .toBeDefined();
        expect(mine!.eta).toBeLessThan(90);
        lastEta = mine!.eta;
      }
    }
    expect(lastEta).toBeLessThan(30);
  });

  it("the row follows the closing bus until it arrives, whichever bus was pinned", () => {
    // The vehicle `planTrip` pinned is whatever was best when the trip was
    // planned, minutes earlier, and the row is re-picked every poll. Every
    // pin on the line must reach the same verdict about a bus at the kerb.
    for (const pinned of Object.keys(FX.buses)) {
      const store: AnchorStore = new Map();
      let followed = false;
      for (const t of ticks) {
        if (t > FX.arrivedAt) break;
        const r = rowAt(t, store, pinned);
        if (!r) continue;
        const mine = r.live.find((a) => norm(a.busName) === norm(FX.closingBus));
        if (!mine) continue;
        const isOurs = norm(r.match.busName) === norm(FX.closingBus);
        if (isOurs) followed = true;
        // Once the row is counting down to the closing bus, it may not hand
        // itself to another vehicle while that bus is still closing. Report
        // #49's switch is still allowed the other way: a bus that has PASSED
        // the stop has no arrival under 60 s and never reaches this line.
        if (followed && mine.eta < 60) {
          expect(
            norm(r.match.busName),
            `pinned ${pinned}: at ${new Date(t).toISOString()} the row moved to ` +
              `#${r.match.busName} (${Math.round(r.match.eta / 60)} min) while ` +
              `${FX.closingBus} was ${Math.round(mine.eta)} s away`,
          ).toBe(norm(FX.closingBus));
        }
      }
      expect(followed, `pinned ${pinned}: the row never followed the closing bus`).toBe(true);
    }
  });

  it("the exact card the canary read: 16:03:30, 97 m out, and it was 26 min", () => {
    // The reported moment, to the poll. On master the row reads a bus
    // twenty-six minutes away here; the rider was 83 m from a bus that
    // pulled in seven seconds later.
    const t = ticks.filter((x) => x <= Date.parse("2026-09-04T20:03:31Z")).pop()!;
    const store: AnchorStore = new Map();
    for (const x of ticks) { if (x > t) break; rowAt(x, store, "#310"); }
    const r = rowAt(t, store, "#310")!;
    const mine = r.live.find((a) => norm(a.busName) === norm(FX.closingBus))!;
    expect(mine.eta).toBeLessThan(30);
    expect(haversineMeters(busesAt(t).find(
      (b) => (b as { bus_name: string }).bus_name === FX.closingBus,
    ) as unknown as LatLon, board)).toBeLessThan(120);
    expect(norm(r.match.busName)).toBe(norm(FX.closingBus));
    // ...and the total is still priced on a bus the rider can reach, which is
    // report #99 and is deliberately NOT changed by this.
    expect(norm(r.boardable.busName)).not.toBe(norm(FX.closingBus));
  });
});
