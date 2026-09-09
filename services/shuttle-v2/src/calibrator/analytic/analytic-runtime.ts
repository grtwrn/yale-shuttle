import type { Dist } from "./dist.js";
import { analyticCellKey, analyticDurationExpert, analyticExperts, type AnalyticEpisode,
  type AnalyticFit, type AnalyticQuery } from "./analytic.js";
import { analyticMixture, analyticResidual, atomQuantiles, currentDistribution,
  type AnalyticDistribution } from "./analytic-distribution.js";

/** Exact legacy-prior wire format; interpolating its quantiles again changes the law. */
export interface AnalyticDurationWire {
  xs: number[];
  ps: number[];
  tail_hazard: number;
}

/** Optional general stop context. It contains no outcome of the current visit. */
export interface AnalyticRuntimeContext {
  route_id: number;
  route_pattern_id: string;
  canonical_stop_ids: number[];
  stop_id: number;
  stop_index: number;
  observed_visit_start_at: number;
  previous_departed_at: number;
  /** Latest confirmation among the departure references used for phase. */
  history_available_at: number;
  phase_slot_at: number;
  phase_error_q: number[];
  phase_weight: number;
  duration_dist: AnalyticDurationWire;
  fitted_at: number;
  valid_until: number;
}

export interface AnalyticRuntimeQuery {
  routeId: number;
  routePatternId: string;
  stopId: number;
  stopIndex: number;
  busKey: string;
  day: string;
  /** Exact client clock for the beginning of the observed current wait. */
  observedVisitStartMs: number;
  issuedAtMs: number;
  /** Caller must resolve the currently versioned canonical route pattern. */
  patternResolved: boolean;
  canonicalStopIds: readonly number[];
  /** Current service-day/context expiry, determined by the caller's calendar. */
  validUntilMs: number;
}

const historyKey = (v: Pick<AnalyticEpisode, "routeId" | "routePatternId" | "stopId" | "stopIndex" | "busKey" | "day">): string =>
  JSON.stringify([analyticCellKey(v), v.busKey, v.day]);

function queryForCore(query: AnalyticRuntimeQuery): AnalyticQuery {
  return { routeId: query.routeId, routePatternId: query.routePatternId, stopId: query.stopId,
    stopIndex: query.stopIndex, busKey: query.busKey, day: query.day,
    pinnedAt: query.observedVisitStartMs, issuedAt: query.issuedAtMs, standing: true };
}

function usable(query: AnalyticRuntimeQuery, fit: AnalyticFit): boolean {
  return query.patternResolved && Number.isInteger(query.stopIndex) && query.stopIndex >= 0
    && query.canonicalStopIds[query.stopIndex] === query.stopId
    && Number.isFinite(query.observedVisitStartMs) && Number.isFinite(query.issuedAtMs)
    && query.observedVisitStartMs <= query.issuedAtMs && fit.fittedAt <= query.observedVisitStartMs
    && Number.isFinite(query.validUntilMs) && query.issuedAtMs < query.validUntilMs;
}

/**
 * Loading a precomputed fit is cheap; fitAnalytic must run offline or in a worker.
 * History is a collector-version snapshot, with actual completion/availability
 * clocks. An anchor timestamp is not a substitute for a persisted knownAt.
 */
export class AnalyticRuntime {
  private version: string | number | undefined;
  private history = new Map<string, AnalyticEpisode[]>();

  constructor(readonly fit: AnalyticFit) {}

  replaceCompletedHistory(rows: readonly AnalyticEpisode[], version: string | number): void {
    if (this.version === version) return;
    const history = new Map<string, AnalyticEpisode[]>();
    for (const row of rows) {
      if (row.patternResolved === false || row.knownAt == null || row.departedAt == null) continue;
      const key = historyKey(row), group = history.get(key) ?? [];
      group.push(row); history.set(key, group);
    }
    this.history = history;
    this.version = version;
  }

  context(query: AnalyticRuntimeQuery): AnalyticRuntimeContext | null {
    if (!usable(query, this.fit)) return null;
    const key = analyticCellKey(query), cell = this.fit.cells[key];
    if (!cell?.phase || cell.weight <= 0) return null;
    const coreQuery = queryForCore(query);
    const history = this.history.get(historyKey(query)) ?? [];
    const pair = analyticExperts(this.fit, coreQuery, history);
    if (!pair.phase || pair.slot == null || pair.weight <= 0) return null;
    // Identical availability gate to the fitted expert, plus exact identity.
    const previous = history.filter(v => v.knownAt! <= query.observedVisitStartMs
      && v.anchoredAt < query.observedVisitStartMs && v.departedAt! < query.observedVisitStartMs
      && v.departedAt! >= v.anchoredAt && (v.outcome === "passed" || v.outcome === "stopped"));
    if (!previous.length) return null;
    const duration = analyticDurationExpert(this.fit, coreQuery);
    return { route_id: query.routeId, route_pattern_id: query.routePatternId,
      canonical_stop_ids: [...query.canonicalStopIds],
      stop_id: query.stopId, stop_index: query.stopIndex,
      observed_visit_start_at: query.observedVisitStartMs,
      previous_departed_at: Math.max(...previous.map(v => v.departedAt!)),
      history_available_at: Math.max(...previous.map(v => v.knownAt!)),
      phase_slot_at: pair.slot * 1000, phase_error_q: [...cell.phase.errors], phase_weight: pair.weight,
      duration_dist: { xs: Array.from(duration.xs), ps: Array.from(duration.ps), tail_hazard: duration.tailHazard },
      fitted_at: this.fit.fittedAt, valid_until: query.validUntilMs };
  }
}

/** Reference decoder used to verify the wire against the selected predictor. */
export function analyticRuntimeTotal(context: AnalyticRuntimeContext, observedVisitStartMs = context.observed_visit_start_at): AnalyticDistribution {
  const wire = context.duration_dist;
  const prior: Dist = { xs: Float64Array.from(wire.xs), ps: Float64Array.from(wire.ps), tailHazard: wire.tail_hazard };
  const phase = atomQuantiles(context.phase_error_q.map(error =>
    Math.max(0, context.phase_slot_at / 1000 + error - observedVisitStartMs / 1000)));
  return analyticMixture(currentDistribution(prior), phase, context.phase_weight);
}

export function analyticRuntimeRemaining(context: AnalyticRuntimeContext, issuedAtMs: number,
  observedVisitStartMs = context.observed_visit_start_at): (p: number) => number {
  return analyticResidual(analyticRuntimeTotal(context, observedVisitStartMs),
    Math.max(0, (issuedAtMs - observedVisitStartMs) / 1000));
}
