import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";

import { analyticCellKey, ANALYTIC_OPTIONS, type AnalyticFit } from "../../../src/calibrator/analytic/analytic.js";
import { StandingForecastModel, STANDING_ALGORITHM, type StandingFitResult } from "../../../src/calibrator/standingForecast.js";
import { standingDayBounds, standingPatternId } from "../../../src/calibrator/standingForecastData.js";
import { openDb, type DbBundle } from "../../../src/db/client.js";
import type { BusPosition } from "../../../src/schema/api.js";
import { registerRoutePaths } from "../anchor";
import { computeUpcomingArrivals, shownStandSec, type DwellTimes, type SegmentTimes } from "../arrivals";
import { anchorKeyFor, resolveStandingStop } from "../liveAnchor";
import type { BusData } from "../map-data";
import { ROUTE_LISTS } from "../routes";
import { ringForBus, standingForecastsForBelief, type AnchorStore } from "./index";
import { forecastForStand, standingForecastsFor, standingRemaining, standingTotalAtArrival,
  type StandingForecastPrior } from "./standingForecast";

// A real server model and the actual rider client share this synthetic route.
// No recorded outcomes, production database, or background fitting is required.
const START = Date.parse("2026-09-04T12:00:00Z");
const STOPS = [11, 48, 72, 121];
const COORDS = {
  11: { lat: 41.31, lon: -72.93 },
  48: { lat: 41.31, lon: -72.93 + 900 / 83_500 },
  72: { lat: 41.31 + 450 / 111_195, lon: -72.93 + 900 / 83_500 },
  121: { lat: 41.31 + 450 / 111_195, lon: -72.93 },
};
const PATH = [...STOPS, STOPS[0]!].map((id) => {
  const point = COORDS[id as keyof typeof COORDS];
  return [point.lat, point.lon] as [number, number];
});
const ROUTE_STOPS = { "3": STOPS };
const ROUTE = ROUTE_LISTS.find((route) => route.busRouteIds.includes(3))!;
const KEY = anchorKeyFor(ROUTE.label, "#40");
const HOLD = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];
const ORDINARY = [0, 12, 15, 18, 22, 26, 31, 40, 55, 90];
const DWELLS: DwellTimes = { "3": Object.fromEntries(STOPS.map((stop) => [String(stop), {
  med: stop === 11 ? 333 : 26, sd: 30, n: 100, q: stop === 11 ? HOLD : ORDINARY, qn: 100,
}])) };
const SEGMENTS: SegmentTimes = { "3": Object.fromEntries(STOPS.map((stop, i) => {
  const sec = i % 2 === 0 ? 128 : 64;
  return [`${stop}-${STOPS[(i + 1) % STOPS.length]}`, {
    avg: sec + 60, n: 100, drive: sec, driveN: 100, dqn: 100,
    dq: [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.35, 1.6].map((f) => sec * f),
  }];
})) };
const segmentsForTest = structuredClone(SEGMENTS);
function bus(context: StandingForecastPrior | undefined, movedM = 0, serverStart = START): BusData {
  return {
    bus_id: 1, bus_name: "#40", route_id: 3, heading: 90,
    lat: COORDS[11].lat, lon: COORDS[11].lon + movedM / 83_500,
    last_stop_id: 11, at_stop_id: 11,
    stationary_since: new Date(serverStart).toISOString(), at_stop_since: new Date(serverStart).toISOString(),
    last_moved_at: new Date(START).toISOString(),
    ...(context ? { standing_forecasts: [context] } : {}),
  };
}

function poll(
  store: AnchorStore, context: StandingForecastPrior | undefined, elapsedSec: number, movedM = 0,
  options: { serverStart?: number; segments?: SegmentTimes; dwells?: DwellTimes } = {},
) {
  const payload = bus(context, movedM, options.serverStart);
  const now = START + elapsedSec * 1000;
  const segments = options.segments ?? segmentsForTest;
  const dwells = options.dwells ?? DWELLS;
  // The same entry point used by rider boards, followed by the pause chip's
  // own shared-belief lookup, all on the same payload object and store.
  const arrivals = computeUpcomingArrivals([11, 48], [payload], ROUTE_STOPS, COORDS, segments, now, dwells, store);
  const standing = resolveStandingStop(payload, ROUTE, ROUTE_STOPS, COORDS, now, store);
  const ring = ringForBus(payload, STOPS, COORDS)!;
  const forecasts = standingForecastsForBelief(store, KEY, payload, ring, now);
  const shown = standing ? shownStandSec(dwells["3"]!["11"], standing.standingSec, dwells["3"]!, dwells, {
    forecasts, stopId: standing.stopId, stopIndex: standing.stopIndex, now,
  }) : null;
  return { arrivals, standing, shown, belief: store.get(KEY)!.belief!, ring };
}

const PATTERN_ID = standingPatternId(3, STOPS);
const PATTERNS = [{ routeId: 3, stopIds: STOPS }];

function fit(fittedAt: number): AnalyticFit {
  const key = analyticCellKey({ routeId: 3, routePatternId: PATTERN_ID, stopId: 11, stopIndex: 0 });
  return {
    version: "analytic-phase-stack-v2", fittedAt,
    options: { ...ANALYTIC_OPTIONS, weightObjective: "remaining" },
    cells: {
      [key]: {
        samples: [120, 180, 300, 450],
        q: [120, 120, 180, 180, 240, 300, 300, 450, 450, 450], n: 4,
        pStop: 1, stopCount: 4, visitCount: 4,
        phase: { periodSec: 3600, errors: [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60], n: 10 },
        weight: 1, evidence: { n: 10, numerator: 1, denominator: 1 },
      },
    },
  };
}

function completedFit(model: AnalyticFit): StandingFitResult {
  return {
    fit: model,
    diagnostics: {
      read: 4, explicit: 4, legacyProxy: 0, unknownAvailability: 0,
      unresolvedPattern: 0, ambiguousIdentity: 0, trainingRows: 4,
      from: START - 2 * 86_400_000, cutoff: model.fittedAt,
      serviceDayCutoff: standingDayBounds(model.fittedAt)[0], trainingDates: [],
      completedAt: model.fittedAt + 100, elapsedMs: 100,
      readMs: 10, fitMs: 90, processPeakRssBytes: 0,
    },
  };
}

function seedDatabase({ sqlite }: DbBundle): void {
  const previousFit = fit(START - 86_400_000);
  sqlite.prepare("INSERT INTO standing_forecast_models VALUES (1,?,?,?,?,?)")
    .run(STANDING_ALGORITHM, previousFit.fittedAt, previousFit.fittedAt,
      JSON.stringify(previousFit), JSON.stringify(completedFit(previousFit).diagnostics));

  // The same bus's prior departure is confirmed well before the current hold.
  const departedAt = START - 3_000_000;
  const anchoredAt = departedAt - 120_000;
  const inserted = sqlite.prepare(`INSERT INTO stop_visits
    (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,
     departed_at,outcome,steps,rest_polls,shuffles,closest_m,dow,hour)
    VALUES (1,'#40',1,3,11,0,?,?,?,'stopped',0,0,0,0,0,0)`)
    .run(anchoredAt, anchoredAt, departedAt);
  sqlite.prepare("INSERT INTO standing_forecast_patterns VALUES (?,?,?)")
    .run(PATTERN_ID, 3, JSON.stringify(STOPS));
  sqlite.prepare("INSERT INTO standing_forecast_observations VALUES (?,?,?,0)")
    .run(Number(inserted.lastInsertRowid), departedAt + 200_000, PATTERN_ID);
}

function serverBus(start: number, now: number): BusPosition {
  return {
    busId: 1, busName: "#40", routeId: 3,
    lat: COORDS[11].lat, lon: COORDS[11].lon, heading: 90,
    lastStopId: 11, atStopId: 11, atStopSince: start,
    stationarySince: start, stationaryStopId: 11, collectedAt: now,
  };
}

it("preserves the hazard, ETA and pause law when the server clock resets after a fit refresh", async () => {
  const db = openDb(":memory:");
  let model: StandingForecastModel | undefined;
  try {
    migrate(db.db, { migrationsFolder: "./drizzle" });
    seedDatabase(db);
    let finishFit = () => {};
    model = new StandingForecastModel(db.sqlite, {
      worker(request) {
        return {
          promise: new Promise<StandingFitResult>((resolve) => {
            finishFit = () => resolve(completedFit(fit(request.cutoff)));
          }),
          cancel() {},
        };
      },
    });
    registerRoutePaths({ "3": PATH });
    const store: AnchorStore = new Map(), control: AnchorStore = new Map();
    model.refresh(START + 30_000, PATTERNS);
    const previous = model.contexts(serverBus(START, START + 30_000), START + 30_000)[0]!;
    expect(previous).toBeDefined();
    const first = poll(store, previous, 30);
    poll(control, previous, 30);
    for (let elapsed = 35; elapsed <= 175; elapsed += 5) {
      poll(store, previous, elapsed);
      poll(control, previous, elapsed);
    }

    finishFit();
    await new Promise((resolve) => setImmediate(resolve));
    const now = START + 180_000;
    // The server already preserves its law when its own clock is unchanged.
    expect(model.contexts(serverBus(START, now), now)[0]).toEqual(previous);
    const serverStart = START + 60_000;
    const replacement = model.contexts(serverBus(serverStart, now), now)[0]!;
    expect(replacement.fitted_at).toBe(START + 30_000);

    // A fresh ten-metre shuffle exercises the filter's departure hazard as
    // well as downstream pricing and the pause display's shared context.
    const actual = poll(store, replacement, 180, 10, { serverStart });
    const expected = poll(control, previous, 180, 10, { serverStart });
    expect(actual.belief.restSince).toBe(START);
    expect(actual.belief.serverSince).toBe(serverStart);
    const payload = bus(replacement, 10, serverStart);
    const raw = standingForecastsFor(payload, actual.ring, now);
    // Retention must not weaken the fit-before-arrival guard on a new prior.
    expect(forecastForStand(raw, 0, actual.belief.restSince)).toBeNull();
    const bound = standingForecastsForBelief(store, KEY, payload, actual.ring, now);
    expect(bound.get(0)!.prior.fitted_at).toBe(previous.fitted_at);

    const priorMap = standingForecastsFor(bus(previous, 10, serverStart), actual.ring, now);
    const law = forecastForStand(priorMap, 0, actual.belief.restSince)!;
    expect(law).not.toBeNull();
    expect(actual.shown!.typicalSec).toBe(standingTotalAtArrival(law));
    expect(actual.shown!.sec).toBe(standingRemaining(law, now)(0.5));
    expect(actual.belief.p).toEqual(expected.belief.p);
    expect(actual.arrivals).toEqual(expected.arrivals);
    expect(actual.shown).toEqual(expected.shown);
    expect(actual.shown!.typicalSec).toBe(first.shown!.typicalSec);
  } finally {
    model?.stop();
    db.sqlite.close();
    registerRoutePaths(null);
  }
});
