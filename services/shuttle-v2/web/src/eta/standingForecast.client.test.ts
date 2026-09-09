import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRoutePaths } from "../anchor";
import { computeUpcomingArrivals, shownStandSec, type DwellTimes, type SegmentTimes } from "../arrivals";
import { anchorKeyFor, resolveStandingStop } from "../liveAnchor";
import type { BusData } from "../map-data";
import { ROUTE_LISTS } from "../routes";
import { fromQuantiles } from "./dist";
import type { Belief } from "./filter";
import { ringForBus, type AnchorStore } from "./index";
import * as forecastModule from "./standingForecast";
import type { StandingForecastPrior } from "./standingForecast";
import { buildTables } from "./tables";

// Simple traced geometry keeps this a client-wiring regression. No production
// route definitions are patched: the payload supplies the sequence and path.
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
let segmentsForTest: SegmentTimes;

function prior(releaseSec = 600, overrides: Partial<StandingForecastPrior> = {}): StandingForecastPrior {
  const duration = fromQuantiles(HOLD);
  return {
    route_id: 3, route_pattern_id: "client-wiring-fixture", canonical_stop_ids: STOPS,
    stop_id: 11, stop_index: 0, observed_visit_start_at: START,
    previous_departed_at: START - 3_600_000, history_available_at: START - 3_500_000,
    phase_slot_at: START + releaseSec * 1000, phase_error_q: Array(10).fill(0), phase_weight: 1,
    duration_dist: { xs: [...duration.xs], ps: [...duration.ps], tail_hazard: duration.tailHazard },
    fitted_at: START - 86_400_000, valid_until: START + 86_400_000, ...overrides,
  };
}

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
  const forecasts = forecastModule.standingForecastsFor(payload, ring, now);
  const shown = standing ? shownStandSec(dwells["3"]!["11"], standing.standingSec, dwells["3"]!, dwells, {
    forecasts, stopId: standing.stopId, stopIndex: standing.stopIndex, now,
  }) : null;
  return { arrivals, standing, shown, belief: store.get(KEY)!.belief!, ring };
}

function movingMass(belief: Belief): number {
  return belief.p.slice(belief.p.length / 2).reduce((sum, mass) => sum + mass, 0);
}

beforeEach(() => {
  registerRoutePaths({ "3": PATH });
  // Each case represents a separate payload/calibration lifecycle. The ring
  // profile must be installed from this case's tables, not a prior case's.
  segmentsForTest = structuredClone(SEGMENTS);
});
afterEach(() => { vi.restoreAllMocks(); registerRoutePaths(null); });

describe("standing forecasts through the actual rider client", () => {
  it("actively changes a standing bus's downstream ETA and matching pause display", () => {
    const lookup = vi.spyOn(forecastModule, "forecastForStand");
    const candidateStore: AnchorStore = new Map();
    const baselineStore: AnchorStore = new Map();
    const context = prior();
    let candidate = poll(candidateStore, context, 30);
    let baseline = poll(baselineStore, undefined, 30);
    const initialTotal = candidate.shown!.typicalSec!;
    for (let elapsed = 35; elapsed <= 180; elapsed += 5) {
      candidate = poll(candidateStore, context, elapsed);
      baseline = poll(baselineStore, undefined, elapsed);
    }
    expect(candidate.standing).toMatchObject({ stopId: 11, stopIndex: 0, standingSec: 180 });
    expect(candidate.belief.rested).toBe(true);
    expect(candidate.belief.restStop).toBe(0);
    expect(movingMass(candidate.belief)).toBeLessThan(0.1);
    expect(candidate.arrivals.find((a) => a.stopId === 11)?.eta).toBe(0);
    expect(lookup.mock.results.some((result) => result.type === "return" && result.value !== null)).toBe(true);
    expect(initialTotal).toBeCloseTo(600, 4);
    expect(candidate.shown!.typicalSec).toBeCloseTo(initialTotal, 4);
    expect(candidate.shown!.sec).toBeCloseTo(420, 4);
    const candidateEta = candidate.arrivals.find((a) => a.stopId === 48)!.eta;
    const baselineEta = baseline.arrivals.find((a) => a.stopId === 48)!.eta;
    expect(candidateEta).toBeGreaterThan(baselineEta + 150);
    // The remaining hold is billed once, then the independently supplied drive.
    expect(candidateEta - candidate.shown!.sec).toBeGreaterThan(90);
    expect(candidateEta - candidate.shown!.sec).toBeLessThan(180);
  });

  it("uses the contextual release probability in a fresh-fix departure transition", () => {
    const hazard = vi.spyOn(forecastModule, "standingDepartureProbability");
    const releasingStore: AnchorStore = new Map();
    const holdingStore: AnchorStore = new Map();
    const releasing = prior(600);
    const holding = prior(900);
    for (let elapsed = 565; elapsed <= 595; elapsed += 5) {
      const release = poll(releasingStore, releasing, elapsed);
      const hold = poll(holdingStore, holding, elapsed);
      expect(release.standing?.stopId).toBe(11);
      expect(hold.standing?.stopId).toBe(11);
    }
    const released = poll(releasingStore, releasing, 600, 35);
    const stillHeld = poll(holdingStore, holding, 600, 35);
    expect(hazard.mock.calls.length).toBeGreaterThan(0);
    expect(hazard.mock.results.some((result) => result.type === "return" && result.value > 0.9)).toBe(true);
    expect(movingMass(released.belief)).toBeGreaterThan(movingMass(stillHeld.belief) + 0.3);
  });

  it("supplies the pause range from the same contextual law as its remaining median", () => {
    const store: AnchorStore = new Map();
    const context = prior(600, { phase_error_q: [-180, -120, -60, -30, 0, 30, 60, 120, 180, 240] });
    const early = poll(store, context, 30);
    let result = early;
    for (let elapsed = 35; elapsed <= 180; elapsed += 5) result = poll(store, context, elapsed);
    expect(result.standing).toMatchObject({ stopIndex: 0, standingSec: 180 });
    const now = START + 180_000;
    const contexts = forecastModule.standingForecastsFor(bus(context), result.ring, now);
    const forecast = forecastModule.forecastForStand(contexts, 0, result.belief.restSince)!;
    const remaining = forecastModule.standingRemaining(forecast, now);
    expect(result.shown!.soonSec).toBeCloseTo(remaining(0.1), 8);
    expect(result.shown!.sec).toBeCloseTo(remaining(0.5), 8);
    expect(result.shown!.lateSec).toBeCloseTo(remaining(0.9), 8);
    expect(result.shown!.soonSec!).toBeLessThan(result.shown!.sec);
    expect(result.shown!.lateSec!).toBeGreaterThan(result.shown!.sec);
    expect(result.shown!.lateSec! - result.shown!.soonSec!).toBeGreaterThan(120);
    expect(result.shown!.typicalSec).toBeCloseTo(early.shown!.typicalSec!, 8);
  });

  it("does not mistake an accepted prior for another occurrence for current-stand coverage", () => {
    const lookup = vi.spyOn(forecastModule, "forecastForStand");
    const unrelatedStore: AnchorStore = new Map();
    const baselineStore: AnchorStore = new Map();
    const unrelated = prior(600, { stop_id: 48, stop_index: 1 });
    let result = poll(unrelatedStore, unrelated, 30);
    let baseline = poll(baselineStore, undefined, 30);
    for (let elapsed = 35; elapsed <= 60; elapsed += 5) {
      result = poll(unrelatedStore, unrelated, elapsed);
      baseline = poll(baselineStore, undefined, elapsed);
    }
    expect(forecastModule.standingForecastsFor(bus(unrelated), result.ring, START + 60_000).size).toBe(1);
    expect(result.standing?.stopIndex).toBe(0);
    expect(lookup.mock.calls.some((call) => call[1] === 0)).toBe(true);
    expect(lookup.mock.results.every((call) => call.type === "return" && call.value === null)).toBe(true);
    expect(result.arrivals).toEqual(baseline.arrivals);
    expect(result.shown).toEqual(baseline.shown);
  });

  it("does not add a second standing term to legacy arrival-to-arrival hops", () => {
    const legacySegments: SegmentTimes = { "3": Object.fromEntries(Object.entries(SEGMENTS["3"]!).map(([key, value]) => [key, {
      avg: value.avg, sd: 30, n: value.n,
    }])) };
    const legacyDwells: DwellTimes = { "3": Object.fromEntries(Object.entries(DWELLS["3"]!).map(([key, value]) => [key, {
      med: value.med, sd: value.sd, n: value.n,
    }])) };
    const options = { segments: legacySegments, dwells: legacyDwells };
    const candidateStore: AnchorStore = new Map(), baselineStore: AnchorStore = new Map();
    const context = prior();
    let candidate = poll(candidateStore, context, 30, 0, options);
    let baseline = poll(baselineStore, undefined, 30, 0, options);
    for (let elapsed = 35; elapsed <= 60; elapsed += 5) {
      candidate = poll(candidateStore, context, elapsed, 0, options);
      baseline = poll(baselineStore, undefined, elapsed, 0, options);
    }
    expect(candidate.standing?.stopIndex).toBe(0);
    const contexts = forecastModule.standingForecastsFor(bus(context), candidate.ring, START + 60_000);
    expect(contexts.size).toBe(1);
    expect(forecastModule.forecastForStand(contexts, 0, candidate.belief.restSince)).not.toBeNull();
    expect(buildTables(STOPS, COORDS, legacySegments["3"]!, legacyDwells["3"]!, candidate.ring).hops[0]!.includesStand).toBe(true);
    expect(candidate.arrivals).toEqual(baseline.arrivals);
    // An old dwell median contains driving and cannot support a pause chip.
    expect(candidate.shown).toBeNull();
    expect(baseline.shown).toBeNull();
  });

  it.each([
    { label: "uses earlier client origin when history predates both clocks", historyAt: START - 3_500_000, active: true },
    { label: "rejects history available only after the client rest began", historyAt: START + 30_000, active: false },
  ])("$label", ({ historyAt, active }) => {
    const candidateStore: AnchorStore = new Map(), baselineStore: AnchorStore = new Map();
    // First observe the rest before the server's clock resets. The client
    // correctly retains its earlier origin through the later same-place poll.
    for (let elapsed = 30; elapsed <= 175; elapsed += 5) {
      poll(candidateStore, undefined, elapsed);
      poll(baselineStore, undefined, elapsed);
    }
    const serverStart = START + 60_000;
    const context = prior(600, { observed_visit_start_at: serverStart, history_available_at: historyAt });
    const candidate = poll(candidateStore, context, 180, 0, { serverStart });
    const baseline = poll(baselineStore, undefined, 180, 0, { serverStart });
    expect(candidate.belief.serverSince).toBe(serverStart);
    expect(candidate.belief.restSince).toBe(START);
    expect(candidate.standing).toMatchObject({ stopIndex: 0, standingSec: 180 });
    const contexts = forecastModule.standingForecastsFor(bus(context, 0, serverStart), candidate.ring, START + 180_000);
    expect(contexts.size).toBe(1);
    const applied = forecastModule.forecastForStand(contexts, 0, candidate.belief.restSince);
    if (active) {
      expect(applied).not.toBeNull();
      expect(candidate.shown!.typicalSec).toBeCloseTo(600, 4);
      expect(candidate.shown!.sec).toBeCloseTo(420, 4);
      expect(candidate.arrivals.find((a) => a.stopId === 48)!.eta)
        .toBeGreaterThan(baseline.arrivals.find((a) => a.stopId === 48)!.eta + 150);
    } else {
      expect(applied).toBeNull();
      expect(candidate.arrivals).toEqual(baseline.arrivals);
      expect(candidate.shown).toEqual(baseline.shown);
    }
  });
});
