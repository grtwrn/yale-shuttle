/**
 * A STOP ALERT THROUGH A RECORDED PASS — the page's own step, fed the one
 * estimator's answer, over real production polls.
 *
 * The unit tests in stopAlerts.test.ts pin each rule at a contrived moment.
 * What they cannot show is the thing a rider depends on: that a real approach
 * actually DRIVES the arrival through the ≤ 30 s window before the bus reaches
 * the kerb (so the "is at … now" ping fires at all, instead of the soonest
 * entry flipping straight to the next bus), and that three Red buses sharing
 * the row cannot make the alert ping twice. The accuracy suite taught this
 * repo that lesson once already — every unit test passed and the defect lived
 * in a bus MOVING THROUGH a stop.
 *
 * Two recordings, both already in the tree for the accuracy gate:
 *   - red-closing-bus.json: three Red buses at 5 s, #304 closing on
 *     Division / Prospect and arriving (ground truth from `arrivals`).
 *   - red-layover-pass.json: #309 through a 9 min 45 s layover at
 *     344 Winchester, then down to Division / Prospect and Prospect / Hillside.
 *
 * Each is replayed at the recording's own cadence AND thinned to one poll per
 * 30 s — the rate a hidden page polls at, which is the case this feature is for.
 */
import { afterEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "./arrivals";
import { type AnchorStore } from "./eta";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { stepStopAlerts, type StopAlert, type StopAlertPing } from "./stopAlerts";
import closing from "./__fixtures__/red-closing-bus.json";
import pass from "./__fixtures__/red-layover-pass.json";
import incidents from "./__fixtures__/anchor-incidents.json";

type Replay = {
  label: string;
  ticks: number[];
  busesAt: (t: number) => BusData[];
  routeStops: Record<string, number[]>;
  stopCoords: Record<number, LatLon>;
  segments: SegmentTimes;
  dwells: DwellTimes;
  path: Record<string, [number, number][]>;
};

/** Thin a tick list to at most one poll per `everyMs`. */
function thin(ticks: number[], everyMs: number): number[] {
  const out: number[] = [];
  for (const t of ticks) if (out.length === 0 || t - out[out.length - 1]! >= everyMs) out.push(t);
  return out;
}

/** Run the page's engine over a recording: arm at the first tick, step every tick. */
function run(r: Replay, armed: StopAlert[]) {
  registerRoutePaths(r.path);
  const store: AnchorStore = new Map();
  let alerts = armed;
  const pings: (StopAlertPing & { t: number })[] = [];
  for (const t of r.ticks) {
    if (alerts.length === 0) break;
    const arrivals = computeUpcomingArrivals(
      [...new Set(alerts.map((a) => a.stopId))], r.busesAt(t), r.routeStops, r.stopCoords,
      r.segments, t, r.dwells, store,
    );
    const step = stepStopAlerts(alerts, arrivals, t);
    for (const p of step.pings) pings.push({ ...p, t });
    alerts = step.alerts;
  }
  return { pings, left: alerts };
}

// ── red-closing-bus.json ────────────────────────────────────────────────────
type ClosingPoll = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number | null; at_stop_id: number | null;
  at_stop_since: string | null; stationary_since: string;
};
const C = closing as unknown as {
  routeLabel: string; busRouteId: number; closingBus: string; boardStopId: number;
  arrivedAt: number; stopNames: Record<string, string>;
  routeStops: Record<string, number[]>; stopCoords: Record<string, LatLon>;
  routePath: Record<string, [number, number][]>;
  segments: SegmentTimes; dwells: DwellTimes;
  buses: Record<string, ClosingPoll[]>;
};
const closingCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(C.stopCoords)) closingCoords[Number(k)] = v;
const closingTicks = [...new Set(Object.values(C.buses).flatMap((ps) => ps.map((p) => p.t)))]
  .sort((a, b) => a - b);
function closingBusesAt(t: number): BusData[] {
  const out: Record<string, unknown>[] = [];
  for (const [busName, polls] of Object.entries(C.buses)) {
    let row: ClosingPoll | null = null;
    for (const p of polls) { if (p.t <= t) row = p; else break; }
    if (!row) continue;
    out.push({
      bus_id: 0, bus_name: busName, route_id: C.busRouteId,
      lat: row.lat, lon: row.lon, heading: row.heading,
      ...(row.last_stop_id != null ? { last_stop_id: row.last_stop_id } : {}),
      ...(row.at_stop_id != null ? { at_stop_id: row.at_stop_id, at_stop_since: row.at_stop_since } : {}),
      stationary_since: row.stationary_since,
    });
  }
  return out as unknown as BusData[];
}
const closingReplay = (ticks: number[]): Replay => ({
  label: "red-closing-bus", ticks, busesAt: closingBusesAt,
  routeStops: C.routeStops, stopCoords: closingCoords,
  segments: C.segments, dwells: C.dwells, path: C.routePath,
});

// ── red-layover-pass.json ───────────────────────────────────────────────────
const P = pass as unknown as {
  routeLabel: string; busName: string; busRouteId: number;
  stopNames: Record<string, string>;
  routeStops: Record<string, number[]>; stopCoords: Record<string, LatLon>;
  segments: SegmentTimes; dwells: DwellTimes;
  positions: { t: number; lat: number; lon: number; heading: number; last_stop_id?: number }[];
  arrivals: { stopId: number; arrivedAt: number; departedAt: number | null }[];
};
const passCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(P.stopCoords)) passCoords[Number(k)] = v;
function passBusAt(t: number): BusData[] {
  const p = [...P.positions].reverse().find((q) => q.t <= t) ?? P.positions[0]!;
  const at = P.arrivals.find((a) => a.arrivedAt <= t && (a.departedAt == null || t < a.departedAt));
  return [{
    bus_id: 1, bus_name: P.busName, route_id: P.busRouteId,
    lat: p.lat, lon: p.lon, heading: p.heading,
    last_stop_id: p.last_stop_id ?? undefined,
    ...(at ? { at_stop_id: at.stopId, at_stop_since: new Date(at.arrivedAt).toISOString().replace("Z", "") } : {}),
  } as BusData];
}
const redPath = (incidents as unknown as { routes: Record<string, { path: [number, number][] }> }).routes["3"]!.path;
const passReplay = (ticks: number[]): Replay => ({
  label: "red-layover-pass", ticks, busesAt: passBusAt,
  routeStops: P.routeStops, stopCoords: passCoords,
  segments: P.segments, dwells: P.dwells, path: { "3": redPath },
});
const passTicks = P.positions.map((p) => p.t);
const truthAt = (stopId: number, after: number) =>
  P.arrivals.find((a) => a.stopId === stopId && a.arrivedAt >= after)!.arrivedAt;

const arm = (stopId: number, stopName: string, leadMin: number, createdAt: number): StopAlert => ({
  routeId: "3", routeLabel: "Red", stopId, stopName, leadMin, createdAt,
});

afterEach(() => registerRoutePaths(null));

/**
 * THE BOUND ON WHEN "IS AT … NOW" MAY FIRE, from the true arrival the collector
 * recorded. Measured on these two recordings at both cadences and all three
 * lead times (2026-09-11): the arrival ping landed 25 s before to 20 s after the
 * recorded arrival. The window below is that plus one hidden-page poll (30 s)
 * of slack either way. It is here because the words say NOW: an estimator
 * change that fires it two minutes early would be a lie told on the lock
 * screen, and this is where that should fail, by name.
 */
const EARLIEST_BEFORE_TRUTH_MS = 60_000;
const LATEST_AFTER_TRUTH_MS = 50_000;

function assertOnePassOneAlert(
  pings: (StopAlertPing & { t: number })[],
  left: StopAlert[],
  truthMs: number,
  where: string,
  onlyBus?: string,
) {
  const arrivals = pings.filter((p) => p.kind === "arrival");
  const leads = pings.filter((p) => p.kind === "lead");
  expect(arrivals, `${where}: exactly one arrival ping`).toHaveLength(1);
  expect(leads.length, `${where}: at most one lead ping`).toBeLessThanOrEqual(1);
  expect(pings, `${where}: nothing but one lead and one arrival`).toHaveLength(leads.length + 1);
  // The arrival is the last thing said, and it disarms the alert.
  expect(pings[pings.length - 1]!.kind).toBe("arrival");
  expect(left, `${where}: disarmed after the arrival`).toHaveLength(0);
  const a = arrivals[0]!;
  expect(a.t - truthMs, `${where}: "now" fired ${(a.t - truthMs) / 1000}s from the recorded arrival`)
    .toBeGreaterThanOrEqual(-EARLIEST_BEFORE_TRUTH_MS);
  expect(a.t - truthMs).toBeLessThanOrEqual(LATEST_AFTER_TRUTH_MS);
  if (leads[0]) expect(leads[0].t).toBeLessThanOrEqual(a.t);
  if (onlyBus) {
    for (const p of pings) expect(p.busName.replace(/^#/, ""), `${where}: pinged about ${p.busName}`).toBe(onlyBus.replace(/^#/, ""));
  }
}

describe("three Red buses, one closing on Division / Prospect (red-closing-bus.json)", () => {
  for (const [cadence, ticks] of [["5 s", closingTicks], ["30 s (hidden page)", thin(closingTicks, 30_000)]] as const) {
    for (const lead of [1, 3, 5]) {
      it(`${cadence}, ${lead} min lead: one lead and one arrival, both about ${C.closingBus}, and never about the other two`, () => {
        const { pings, left } = run(closingReplay([...ticks]),
          [arm(C.boardStopId, C.stopNames[String(C.boardStopId)]!, lead, ticks[0]!)]);
        assertOnePassOneAlert(pings, left, C.arrivedAt, `${cadence}/${lead}`, C.closingBus);
        expect(pings[pings.length - 1]!.message).toBe("Red is at Division / Prospect now");
      });
    }
  }

  it("the lead ping names the minutes the row would print, in words, never 'm'", () => {
    const { pings } = run(closingReplay([...closingTicks]),
      [arm(C.boardStopId, "Division / Prospect", 5, closingTicks[0]!)]);
    const lead = pings.find((p) => p.kind === "lead")!;
    expect(lead.message).toMatch(/^Red reaches Division \/ Prospect (in about \d+ min|in less than a minute)$/);
  });
});

describe("#309 through the 344 Winchester layover (red-layover-pass.json)", () => {
  const start = passTicks[0]!;
  // The first arrival at each stop AFTER the layover, not the lap before it.
  const layoverLeft = P.arrivals.find((a) => a.stopId === 11)!.departedAt!;
  for (const [cadence, ticks] of [["15 s", passTicks], ["30 s (hidden page)", thin(passTicks, 30_000)]] as const) {
    for (const stopId of [48, 104]) {
      for (const lead of [1, 3, 5]) {
        it(`${cadence}, ${P.stopNames[String(stopId)]}, ${lead} min lead: at most one lead, one arrival at the kerb, disarmed`, () => {
          const { pings, left } = run(passReplay([...ticks]),
            [arm(stopId, P.stopNames[String(stopId)]!, lead, start)]);
          assertOnePassOneAlert(pings, left, truthAt(stopId, layoverLeft), `${cadence}/${stopId}/${lead}`);
        });
      }
    }
  }
});
