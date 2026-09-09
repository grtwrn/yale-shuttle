import type { StopDataVisit } from "../../../src/schema/stop-data";

export const TIMEZONE = "America/New_York";
const clockFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit" });
const preciseFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", second: "2-digit" });
export const clock = (at: number) => clockFormat.format(at);
export const preciseClock = (at: number | null) => at === null ? "Unavailable" : preciseFormat.format(at);
export const minutes = (sec: number | null) => sec === null || !Number.isFinite(sec) ? "—" : `${(sec / 60).toFixed(1)} min`;
export function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const index = (sorted.length-1) * fraction, lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi]-sorted[lo]) * (index-lo);
}
export function observedStand(visit: StopDataVisit): number | null {
  if (("labelStatus" in visit && visit.labelStatus !== "complete") ||
    ("leftCensored" in visit && visit.leftCensored) || ("rightCensored" in visit && visit.rightCensored)) return null;
  return visit.outcome === "stopped" && visit.pinnedAt !== null && visit.departedAt !== null && visit.departedAt >= visit.pinnedAt
    ? (visit.departedAt-visit.pinnedAt)/1000 : null;
}
export interface ComparisonPoint {
  visitId: string; issuedAt: number; model: string;
  totalSec: number | null; remainingSec: number | null;
  /** True only when this is the original first captured display for the arm. */
  first: boolean;
}
/** Pair exact query clocks before aggregation; each visit gets equal weight. */
export function compareModels(visits: StopDataVisit[], forecasts: ComparisonPoint[], arms: string[]) {
  const byId = new Map(visits.map(v => [v.id, v]));
  const pairs = new Map<string, Map<string, ComparisonPoint>>();
  for (const p of forecasts) {
    if (!byId.has(p.visitId) || !arms.includes(p.model)) continue;
    const key = `${p.visitId}/${p.issuedAt}`;
    const pair = pairs.get(key) ?? new Map();
    // Duplicate arm/query records cannot become extra evidence.
    if (pair.has(p.model)) throw new Error("Duplicate forecast at the same visit and query time.");
    pair.set(p.model, p); pairs.set(key, pair);
  }
  return arms.map(model => {
    const firstErrors: number[] = [], remainingByVisit = new Map<string, number[]>();
    let pairedQueries = 0;
    for (const pair of pairs.values()) {
      if (!arms.every(a => pair.has(a))) continue;
      const p = pair.get(model)!; const v = byId.get(p.visitId)!;
      const total = observedStand(v);
      if (total === null || v.pinnedAt === null || v.departedAt === null || p.issuedAt < v.pinnedAt || p.issuedAt >= v.departedAt) continue;
      if (arms.every(a => pair.get(a)!.first && pair.get(a)!.totalSec !== null)) firstErrors.push(p.totalSec! - total);
      if (arms.every(a => pair.get(a)!.remainingSec !== null)) {
        const errors = remainingByVisit.get(v.id) ?? [];
        errors.push(p.remainingSec! - (v.departedAt-p.issuedAt)/1000);
        remainingByVisit.set(v.id, errors); pairedQueries++;
      }
    }
    const mean = (xs: number[]) => xs.length ? xs.reduce((s,n) => s+n,0)/xs.length : null;
    const abs = (xs: number[]) => xs.map(Math.abs);
    return { model, firstCount: firstErrors.length, firstMae: mean(abs(firstErrors)),
      firstBias: mean(firstErrors), underTwoMin: firstErrors.filter(e => e < -120).length,
      overTwoMin: firstErrors.filter(e => e > 120).length,
      remainingVisits: remainingByVisit.size, pairedQueries,
      remainingMae: mean([...remainingByVisit.values()].map(xs => mean(abs(xs))!)) };
  });
}
