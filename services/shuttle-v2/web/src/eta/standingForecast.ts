import type { Ring } from "./ring";
import type { Dist } from "./dist";
import { analyticMixture, analyticResidual, atomQuantiles, currentDistribution,
  type AnalyticDistribution } from "./standingDistribution";

/** One fitted occurrence's prior, with the bus's already completed departures. */
export interface StandingForecastPrior {
  route_id: number;
  route_pattern_id: string;
  canonical_stop_ids: number[];
  stop_id: number;
  stop_index: number;
  observed_visit_start_at: number;
  previous_departed_at: number;
  history_available_at: number;
  phase_slot_at: number;
  phase_error_q: number[];
  phase_weight: number;
  duration_dist: { xs: number[]; ps: number[]; tail_hazard: number };
  fitted_at: number;
  valid_until: number;
}

export interface StandingForecast {
  readonly prior: StandingForecastPrior;
  readonly duration: Dist;
}
export type StandingForecasts = ReadonlyMap<number, StandingForecast>;
export interface CurrentStandForecast {
  readonly visitStartMs: number;
  readonly total: AnalyticDistribution;
}
const EMPTY: StandingForecasts = new Map();
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const timestamp = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x > 0;
const sorted = (a: unknown, min: number, max = Infinity): a is number[] => Array.isArray(a)
  && a.length > 0 && a.every((x, i) => finite(x) && x >= min && x <= max && (!i || x >= a[i - 1]));

/** A topology change, stale context, or malformed payload leaves the normal tables in use. */
export function standingForecastsFor(
  bus: { route_id: number | string; standing_forecasts?: unknown },
  ring: Pick<Ring, "routeId" | "stops" | "N">,
  now: number,
): StandingForecasts {
  if (!Array.isArray(bus.standing_forecasts) || !finite(now)) return EMPTY;
  const out = new Map<number, StandingForecast>();
  const duplicated = new Set<number>();
  for (const raw of bus.standing_forecasts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const p = raw as StandingForecastPrior;
    const d = p.duration_dist;
    if (p.route_id !== Number(bus.route_id) || p.route_id !== Number(ring.routeId)
      || typeof p.route_pattern_id !== "string" || !p.route_pattern_id.length
      || !Array.isArray(p.canonical_stop_ids) || p.canonical_stop_ids.length !== ring.N
      || !p.canonical_stop_ids.every((id, i) => id === ring.stops[i])
      || !Number.isSafeInteger(p.stop_index) || p.stop_index < 0 || p.stop_index >= ring.N
      || ring.stops[p.stop_index] !== p.stop_id
      || !timestamp(p.previous_departed_at) || p.previous_departed_at >= now
      || !timestamp(p.history_available_at) || p.history_available_at > now
      || !timestamp(p.observed_visit_start_at) || p.observed_visit_start_at > now
      || !timestamp(p.fitted_at) || p.fitted_at > now
      || !timestamp(p.valid_until) || p.valid_until <= now || !finite(p.phase_slot_at)
      || !finite(p.phase_weight) || p.phase_weight <= 0 || p.phase_weight > 1
      || !sorted(p.phase_error_q, -Infinity) || p.phase_error_q.length < 3
      || !d || !sorted(d.xs, 0) || !sorted(d.ps, 0, 1 - 1e-6)
      || d.xs.length !== d.ps.length || d.xs.some((x, i) => i > 0 && x <= d.xs[i - 1]!)
      || !finite(d.tail_hazard) || d.tail_hazard < 1 / 1800 || d.tail_hazard > 1 / 5) continue;
    if (out.has(p.stop_index) || duplicated.has(p.stop_index)) {
      out.delete(p.stop_index); duplicated.add(p.stop_index); continue;
    }
    out.set(p.stop_index, { prior: p, duration: {
      xs: Float64Array.from(d.xs), ps: Float64Array.from(d.ps), tailHazard: d.tail_hazard,
    } });
  }
  return out;
}

/** Freeze the total-duration law to the same observed arrival clock as the filter. */
export function forecastForStand(
  contexts: StandingForecasts | null | undefined, stopIndex: number, visitStartMs: number,
): CurrentStandForecast | null {
  const context = contexts?.get(stopIndex), p = context?.prior;
  if (!context || !p || !finite(visitStartMs) || p.previous_departed_at >= visitStartMs
    || p.history_available_at > visitStartMs
    || p.fitted_at > visitStartMs || visitStartMs >= p.valid_until) return null;
  const phase = atomQuantiles(p.phase_error_q.map(e => Math.max(0, p.phase_slot_at / 1000 + e - visitStartMs / 1000)));
  return { visitStartMs, total: analyticMixture(currentDistribution(context.duration), phase, p.phase_weight) };
}

export function standingRemaining(context: CurrentStandForecast, now: number): (p: number) => number {
  return analyticResidual(context.total, Math.max(0, (now - context.visitStartMs) / 1000));
}

export function standingTotalAtArrival(context: CurrentStandForecast): number {
  // The bus is known to be standing even at elapsed zero: exclude pass-through mass.
  return analyticResidual(context.total, 0)(0.5);
}

/** Finite-poll departure probability includes atoms at a learned release time. */
export function standingDepartureProbability(context: CurrentStandForecast, now: number, seconds: number): number {
  const r = Math.max(0, (now - context.visitStartMs) / 1000);
  const s = 1 - context.total.cdf(r);
  if (s <= 1e-9) return 1;
  return Math.max(0, Math.min(1, (context.total.cdf(r + Math.max(0, seconds)) - context.total.cdf(r)) / s));
}
