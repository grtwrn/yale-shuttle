/** Causal runtime features, matching learned_runtime.py without episode-label lookup. */
export interface LearnedPriorDeparture {
  routeId: number; routePatternId: string; stopId: number; stopIndex: number;
  busKey: string; day: string; pinnedAt: number | null; departedAt: number | null;
  knownAt: number | null; outcome: string; patternResolved?: boolean;
}

export interface LearnedStandQuery {
  routeId: number; routePatternId: string; stopId: number; stopIndex: number;
  busKey: string; issuedAt: number; visitStartMs: number; serviceDay?: string;
  patternResolved?: boolean; priorDepartures?: readonly LearnedPriorDeparture[];
}

export interface LearnedProfiles {
  training_days: string[]; fit_cutoff: number; model_sha256: string;
  profiles: Record<string, (number | null)[]>;
}

const localTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function priorDuration(row: LearnedPriorDeparture): number | null {
  if (row.pinnedAt === null) return null;
  if (row.outcome === "passed") return 0;
  if (row.outcome !== "stopped" || row.departedAt === null) return null;
  const duration = (row.departedAt - row.pinnedAt) / 1000;
  return duration >= 0 ? duration : null;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

export function learnedFeatures(query: LearnedStandQuery, profiles: LearnedProfiles): number[] {
  const start = query.visitStartMs, issued = query.issuedAt;
  if (!Number.isFinite(start) || !Number.isFinite(issued) || issued < start) throw new Error("Invalid observed rest clock");
  if (start < profiles.fit_cutoff) throw new Error("Profile training cutoff is after this visit began");
  const parts = Object.fromEntries(localTime.formatToParts(start).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
  const angle = 2 * Math.PI * hour / 24;
  const basic = [query.routeId, query.stopId, query.patternResolved === false ? NaN : query.stopIndex,
    Math.sin(angle), Math.cos(angle), (issued - start) / 1000];
  const key = JSON.stringify([query.routePatternId, query.stopId, query.stopIndex]);
  const summary = (profiles.profiles[key] ?? [null, null, 0, null, null, 0]).map(x => x === null ? NaN : x);
  const day = query.serviceDay ?? `${parts.year}-${parts.month}-${parts.day}`;
  const prior = (query.priorDepartures ?? []).filter(row => row.busKey === query.busKey &&
    row.routeId === query.routeId && row.routePatternId === query.routePatternId &&
    row.stopId === query.stopId && row.stopIndex === query.stopIndex && row.day === day &&
    row.patternResolved !== false && priorDuration(row) !== null && row.departedAt !== null &&
    row.departedAt < start && (row.knownAt ?? Infinity) <= start).sort((a, b) => a.departedAt! - b.departedAt!);
  let away = NaN, slack = NaN, previousHold = NaN;
  if (prior.length) {
    const latest = prior[prior.length - 1]!.departedAt!;
    away = (start - latest) / 1000;
    previousHold = priorDuration(prior[prior.length - 1]!)!;
    const period = summary[3]!;
    if (Number.isFinite(period) && period > 0) {
      slack = median(prior.map(row => row.departedAt! / 1000 +
        (Math.floor((latest - row.departedAt!) / 1000 / period + .5) + 1) * period)) - start / 1000;
    }
  }
  return [...basic, ...summary, away, slack, prior.length, previousHold];
}
