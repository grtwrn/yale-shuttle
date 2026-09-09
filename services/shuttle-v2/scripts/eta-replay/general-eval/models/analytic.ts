import { standQuantiles } from "../../../../src/calibrator/calibrator.js";
import type { Dist } from "../../../../web/src/eta/dist.js";
import { classPools, globalClassPools, poolsWithFallback, stopModel, type DwellLike } from "../../../../web/src/eta/tables.js";
import { analyticMixture, analyticResidual, atomQuantiles, currentDistribution, type AnalyticDistribution } from "./analytic-distribution.js";

/** Small adapter boundary; no production collector, route allowlist or future labels. */
export interface AnalyticEpisode {
  id: string | number;
  routeId: number;
  routePatternId: string;
  stopId: number;
  stopIndex: number;
  busKey: string;
  day: string;
  anchoredAt: number;
  pinnedAt: number | null;
  departedAt: number | null;
  knownAt: number | null;
  outcome: string;
  patternResolved?: boolean;
}

export interface AnalyticQuery {
  routeId: number;
  routePatternId: string;
  stopId: number;
  stopIndex: number;
  busKey: string;
  day: string;
  pinnedAt: number;
  issuedAt: number;
  /** False scores the unconditional visit duration, including passes at zero. */
  standing: boolean;
}

export const ANALYTIC_OPTIONS = Object.freeze({ minimumPhaseSamples: 3, weightPriorN: 8, integrationSamples: 32 });
export type AnalyticArm = "duration" | "phase" | "stacked";
export type AnalyticWeightObjective = "first" | "remaining";

interface PhaseFit { periodSec: number; errors: number[]; n: number }
interface WeightEvidence { n: number; numerator: number; denominator: number; points?: number; baseLoss?: number; selectedLoss?: number }
export interface AnalyticCell {
  /** Pinned samples retained to reconstruct production's pooled occurrence fallback. */
  samples: number[];
  q: number[];
  n: number;
  pStop: number;
  stopCount: number;
  visitCount: number;
  phase: PhaseFit | null;
  weight: number;
  evidence: WeightEvidence;
}
export interface AnalyticFit {
  version: "analytic-phase-stack-v1" | "analytic-phase-stack-v2";
  fittedAt: number;
  options: typeof ANALYTIC_OPTIONS & { weightObjective?: AnalyticWeightObjective };
  cells: Record<string, AnalyticCell>;
}
export interface AnalyticPrediction {
  quantiles: number[];
  phaseAvailable: boolean;
  phaseWeightAtArrival: number;
  phaseWeightNow: number;
  phaseSlot: number | null;
  historyN: number;
}

export const analyticCellKey = (v: Pick<AnalyticEpisode, "routeId" | "routePatternId" | "stopId" | "stopIndex">): string => `${v.routeId}:${encodeURIComponent(v.routePatternId)}:${v.stopId}:${v.stopIndex}`;
const median = (a: readonly number[]): number => {
  const b = [...a].sort((x, y) => x - y);
  return (b[Math.floor((b.length - 1) / 2)]! + b[Math.ceil((b.length - 1) / 2)]!) / 2;
};

export function analyticDuration(v: AnalyticEpisode): number | null {
  if (v.outcome === "passed") return 0;
  return v.outcome === "stopped" && v.pinnedAt != null && v.departedAt != null && v.departedAt >= v.pinnedAt
    ? (v.departedAt - v.pinnedAt) / 1000 : null;
}

function available(v: AnalyticEpisode, cutoff: number): boolean {
  return v.knownAt != null && v.knownAt <= cutoff && v.anchoredAt < cutoff
    && (v.departedAt == null || v.departedAt <= cutoff);
}

function departureKnown(v: AnalyticEpisode, cutoff: number): boolean {
  return available(v, cutoff) && v.departedAt != null && v.departedAt >= v.anchoredAt
    && (v.outcome === "passed" || v.outcome === "stopped");
}

function phaseSlot(departures: readonly number[], period: number): number {
  const latest = Math.max(...departures);
  return median(departures.map(d => d / 1000 + (Math.round((latest - d) / 1000 / period) + 1) * period));
}

function phaseFit(rows: readonly AnalyticEpisode[], cutoff: number): PhaseFit | null {
  const groups = new Map<string, AnalyticEpisode[]>();
  for (const row of rows) {
    const key = `${row.day}:${row.busKey}`;
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const periods: number[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.anchoredAt - b.anchoredAt);
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1]!, b = group[i]!;
      if (departureKnown(a, cutoff) && departureKnown(b, cutoff) && b.departedAt! > a.departedAt!) {
        periods.push((b.departedAt! - a.departedAt!) / 1000);
      }
    }
  }
  if (periods.length < ANALYTIC_OPTIONS.minimumPhaseSamples) return null;
  const periodSec = median(periods);
  const errors: number[] = [];
  for (const group of groups.values()) for (let i = 1; i < group.length; i++) {
    const row = group[i]!;
    if (!departureKnown(row, cutoff)) continue;
    const at = row.pinnedAt ?? row.anchoredAt;
    const prior = group.slice(0, i).filter(p => departureKnown(p, at)).map(p => p.departedAt!);
    if (prior.length) errors.push(row.departedAt! / 1000 - phaseSlot(prior, periodSec));
  }
  return errors.length >= ANALYTIC_OPTIONS.minimumPhaseSamples ? { periodSec, errors: standQuantiles(errors), n: errors.length } : null;
}

function grouped(rows: readonly AnalyticEpisode[]): Map<string, AnalyticEpisode[]> {
  const groups = new Map<string, AnalyticEpisode[]>();
  for (const row of rows) {
    const key = analyticCellKey(row), group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return groups;
}

function durationTables(cells: Readonly<Record<string, AnalyticCell>>): Record<string, Record<string, DwellLike>> {
  const out: Record<string, Record<string, DwellLike>> = {};
  const groups = new Map<string, Array<readonly [string, AnalyticCell]>>();
  for (const [key, cell] of Object.entries(cells)) {
    const parts = key.split(":"), route = parts.slice(0, 2).join(":"), stop = parts[2]!;
    const groupKey = `${route}:${stop}`, group = groups.get(groupKey) ?? [];
    group.push([key, cell]); groups.set(groupKey, group);
  }
  for (const [groupKey, group] of groups) {
    const parts = groupKey.split(":"), route = parts.slice(0, 2).join(":"), stop = parts[2]!;
    const values = group.flatMap(([, c]) => c.samples);
    const total = group.reduce((s, [, c]) => s + c.visitCount, 0), stopped = group.reduce((s, [, c]) => s + c.stopCount, 0);
    const routeTables = out[route] ??= {};
    routeTables[`@${stop}`] = { med: 0, n: values.length, q: standQuantiles(values).map(Math.round), qn: values.length, pstop: stopped / total };
    // Production serves both the pooled entry and one entry per occurrence.
    if (group.length > 1) for (const [key, cell] of group) {
      routeTables[key] = { med: 0, n: cell.n, q: cell.q, qn: cell.n, pstop: cell.pStop };
    }
  }
  return out;
}

const durationCache = new WeakMap<AnalyticFit, Map<string, Dist>>();
const tableCache = new WeakMap<AnalyticFit, ReturnType<typeof durationTables>>();
function durationExpert(fit: AnalyticFit, query: AnalyticQuery): Dist {
  const cached = durationCache.get(fit) ?? new Map<string, Dist>();
  durationCache.set(fit, cached);
  const key = analyticCellKey(query), found = cached.get(key);
  if (found) return found;
  const tables = tableCache.get(fit) ?? durationTables(fit.cells);
  tableCache.set(fit, tables);
  const route = tables[`${query.routeId}:${encodeURIComponent(query.routePatternId)}`] ?? {};
  const result = stopModel(route[key] ?? route[`@${query.stopId}`], poolsWithFallback(classPools(route), globalClassPools(tables))).stand;
  cached.set(key, result);
  return result;
}

/** Fits a causal snapshot. Weight learning is separate so OOF predictions cannot use their own outcomes. */
function snapshot(rows: readonly AnalyticEpisode[], cutoff: number, phaseKey?: string): AnalyticFit {
  const known = rows.filter(v => available(v, cutoff) && v.patternResolved !== false);
  const cells: Record<string, AnalyticCell> = {};
  for (const [key, group] of grouped(known)) {
    const values = group.filter(v => v.pinnedAt != null).map(analyticDuration).filter((n): n is number => n != null);
    if (!values.length) continue;
    const outcomes = group.filter(v => v.outcome === "passed" || v.outcome === "stopped");
    const stopCount = outcomes.filter(v => v.outcome === "stopped").length;
    cells[key] = { samples: values, q: standQuantiles(values).map(Math.round), n: values.length,
      pStop: stopCount / outcomes.length, stopCount, visitCount: outcomes.length,
      phase: phaseKey == null || phaseKey === key ? phaseFit(group, cutoff) : null,
      weight: 0, evidence: { n: 0, numerator: 0, denominator: 0 } };
  }
  return { version: "analytic-phase-stack-v1", fittedAt: cutoff, options: ANALYTIC_OPTIONS, cells };
}

function experts(fit: AnalyticFit, query: AnalyticQuery, current: readonly AnalyticEpisode[]): {
  duration: AnalyticDistribution; phase: AnalyticDistribution | null; slot: number | null; n: number; weight: number;
} {
  const key = analyticCellKey(query), cell = fit.cells[key];
  const duration = currentDistribution(durationExpert(fit, query));
  if (!cell?.phase) return { duration, phase: null, slot: null, n: 0, weight: 0 };
  const past = current.filter(v => analyticCellKey(v) === key && v.busKey === query.busKey && v.day === query.day
    && departureKnown(v, query.pinnedAt) && v.departedAt! < query.pinnedAt).map(v => v.departedAt!);
  if (!past.length) return { duration, phase: null, slot: null, n: 0, weight: 0 };
  const slot = phaseSlot(past, cell.phase.periodSec);
  const phase = atomQuantiles(cell.phase.errors.map(e => Math.max(0, slot + e - query.pinnedAt / 1000)));
  return { duration, phase, slot, n: past.length, weight: cell.weight };
}

/** Equal-weight quantile quadrature; arrays are already sorted. */
function within(a: readonly number[]): number {
  return 2 * a.reduce((s, x, i) => s + (2 * i - a.length + 1) * x, 0) / a.length ** 2;
}
function cross(a: readonly number[], b: readonly number[]): number {
  let j = 0, prefix = 0, total = 0;
  const sum = b.reduce((s, x) => s + x, 0);
  for (const x of a) {
    while (j < b.length && b[j]! <= x) { prefix += b[j]!; j++; }
    total += x * j - prefix + (sum - prefix) - x * (b.length - j);
  }
  return total / (a.length * b.length);
}
function crps(samples: readonly number[], truth: number): number {
  return samples.reduce((s, x) => s + Math.abs(x - truth), 0) / samples.length - within(samples) / 2;
}

/**
 * Each discovery visit is forecast from rows already completed at its arrival.
 * CRPS stacking is convex; eight zero-weight pseudo-visits shrink thin cells.
 */
export function fitAnalytic(rows: readonly AnalyticEpisode[], cutoff: number, weightObjective: AnalyticWeightObjective = "first"): AnalyticFit {
  const train = rows.filter(v => available(v, cutoff) && v.patternResolved !== false);
  const result = snapshot(train, cutoff);
  result.version = weightObjective === "remaining" ? "analytic-phase-stack-v2" : "analytic-phase-stack-v1";
  result.options = { ...ANALYTIC_OPTIONS, weightObjective };
  const evidence = new Map<string, WeightEvidence>();
  type ConditionalScore = { C0: number; C1: number; D: number; S0: number; S1: number; zeroLoss: number };
  const conditional = new Map<string, ConditionalScore[][]>();
  const visits = [...train].sort((a, b) => (a.pinnedAt ?? a.anchoredAt) - (b.pinnedAt ?? b.anchoredAt));
  for (const visit of visits) {
    const truth = analyticDuration(visit);
    if (truth == null || visit.pinnedAt == null) continue;
    if (weightObjective === "remaining" && visit.outcome !== "stopped") continue;
    const pinnedAt = visit.pinnedAt ?? visit.anchoredAt;
    const query: AnalyticQuery = { routeId: visit.routeId, routePatternId: visit.routePatternId,
      stopId: visit.stopId, stopIndex: visit.stopIndex, busKey: visit.busKey, day: visit.day,
      pinnedAt, issuedAt: pinnedAt, standing: false };
    const prior = snapshot(train, pinnedAt, analyticCellKey(visit));
    if (!prior.cells[analyticCellKey(visit)]?.phase) continue;
    const pair = experts(prior, query, train);
    if (!pair.phase) continue;
    const levels = Array.from({ length: ANALYTIC_OPTIONS.integrationSamples }, (_, i) => (i + 0.5) / ANALYTIC_OPTIONS.integrationSamples);
    if (weightObjective === "remaining") {
      const points: ConditionalScore[] = [];
      for (let elapsed = 0; elapsed < Math.max(1, truth); elapsed += 30) {
        const a = levels.map(analyticResidual(pair.duration, elapsed)), b = levels.map(analyticResidual(pair.phase, elapsed));
        points.push({ C0: crps(a, truth - elapsed), C1: crps(b, truth - elapsed),
          D: Math.max(0, cross(a, b) - within(a) / 2 - within(b) / 2),
          S0: 1 - pair.duration.cdf(elapsed), S1: 1 - pair.phase.cdf(elapsed), zeroLoss: truth - elapsed });
      }
      const key = analyticCellKey(visit), events = conditional.get(key) ?? [];
      events.push(points); conditional.set(key, events);
      continue;
    }
    const a = levels.map(p => pair.duration.quantile(p)), b = levels.map(p => pair.phase!.quantile(p));
    const distance = Math.max(0, cross(a, b) - within(a) / 2 - within(b) / 2);
    const key = analyticCellKey(visit), e = evidence.get(key) ?? { n: 0, numerator: 0, denominator: 0 };
    e.n++; e.numerator += crps(a, truth) - crps(b, truth) + distance; e.denominator += 2 * distance;
    evidence.set(key, e);
  }
  for (const [key, e] of evidence) {
    const cell = result.cells[key]!;
    const optimum = e.denominator > 0 ? Math.max(0, Math.min(1, e.numerator / e.denominator)) : 0;
    cell.weight = optimum * e.n / (e.n + ANALYTIC_OPTIONS.weightPriorN);
    cell.evidence = e;
  }
  // Conditioning makes the objective nonlinear in the arrival-time weight.
  // Solve the same scalar objective for every cell; no stop-specific gates.
  for (const [key, visits] of conditional) {
    const disagreement = visits.reduce((sum, points) => sum + points.reduce((s, p) => s + p.D, 0) / points.length, 0) / visits.length;
    const loss = (weight: number, penalized = true): number => {
      let total = 0;
      for (const points of visits) {
        let one = 0;
        for (const p of points) {
          const surviving = (1 - weight) * p.S0 + weight * p.S1;
          if (surviving <= 1e-9) { one += p.zeroLoss; continue; }
          const posterior = weight * p.S1 / surviving;
          one += p.C0 + posterior * (p.C1 - p.C0 - p.D) + posterior * posterior * p.D;
        }
        total += one / points.length;
      }
      return total + (penalized ? ANALYTIC_OPTIONS.weightPriorN * disagreement * weight * weight : 0);
    };
    let best = 0, bestLoss = loss(0);
    // Coarse global bracket, then numerical refinement; this grid is solver
    // precision rather than a candidate hyperparameter or a route rule.
    for (let i = 1; i <= 32; i++) { const value = loss(i / 32); if (value < bestLoss) { best = i / 32; bestLoss = value; } }
    let lo = Math.max(0, best - 1 / 32), hi = Math.min(1, best + 1 / 32);
    for (let i = 0; i < 28; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (loss(a) < loss(b)) hi = b; else lo = a;
    }
    const refined = (lo + hi) / 2;
    if (loss(refined) < bestLoss) best = refined;
    const cell = result.cells[key]!;
    cell.weight = best;
    cell.evidence = { n: visits.length, numerator: 0, denominator: 2 * disagreement * visits.length,
      points: visits.reduce((n, v) => n + v.length, 0), baseLoss: loss(0, false) / visits.length, selectedLoss: loss(best, false) / visits.length };
  }
  return result;
}

export function predictAnalytic(
  fit: AnalyticFit, query: AnalyticQuery, current: readonly AnalyticEpisode[],
  arm: AnalyticArm = "stacked", levels: readonly number[] = Array.from({ length: 99 }, (_, i) => (i + 1) / 100),
): AnalyticPrediction {
  const pair = experts(fit, query, current);
  const weight = !pair.phase || arm === "duration" ? 0 : arm === "phase" ? 1 : pair.weight;
  const total = weight === 0 ? pair.duration : analyticMixture(pair.duration, pair.phase!, weight);
  const elapsed = Math.max(0, (query.issuedAt - query.pinnedAt) / 1000);
  const sample = query.standing ? analyticResidual(total, elapsed) : (p: number) => total.quantile(p);
  const denominator = pair.phase ? (1 - weight) * (1 - pair.duration.cdf(elapsed)) + weight * (1 - pair.phase.cdf(elapsed)) : 1;
  return { quantiles: levels.map(sample), phaseAvailable: pair.phase != null, phaseWeightAtArrival: weight,
    phaseWeightNow: query.standing && pair.phase && denominator > 0 ? weight * (1 - pair.phase.cdf(elapsed)) / denominator : weight,
    phaseSlot: pair.slot, historyN: pair.n };
}

// Additive runtime boundary: exports the same fitted experts used above.
export { durationExpert as analyticDurationExpert, experts as analyticExperts };
