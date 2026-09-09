/** Collector-owned, general standing forecast: cached inference and off-thread fitting. */
import type Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BusPosition } from "../schema/api.js";
import type { AnalyticEpisode, AnalyticFit } from "./analytic/analytic.js";
import { AnalyticRuntime, type AnalyticRuntimeContext } from "./analytic/analytic-runtime.js";
import { readStandingEpisodes, standingDayBounds, standingDayOf, standingPatternId,
  type StandingRoutePattern, type StandingTrainingDate } from "./standingForecastData.js";

export type StandingForecastContext = AnalyticRuntimeContext;
/** Operational policy, distinct from the fixed-day discovery/confirmation experiment. */
export const STANDING_FIT_POLICY = Object.freeze({ lookbackDays: 30, serviceDaysPerRoute: 2,
  maximumRows: 20_000, retryMs: 15 * 60_000, maximumFitAgeMs: 48 * 3600_000,
  workerTimeoutMs: 30 * 60_000, maximumAttemptsPerDay: 3 });
const algorithmHash = createHash("sha256");
for (const name of ["analytic/analytic.ts", "analytic/analytic-distribution.ts", "analytic/dist.ts", "analytic/durationTables.ts", "calibrator.ts", "shrinkage.ts"]) {
  algorithmHash.update(readFileSync(new URL(name, import.meta.url)));
}
algorithmHash.update(JSON.stringify({ availabilityPolicy: "new-exact-legacy-two-later-anchors-plus-120s-v1",
  selectionPolicy: "last-completed-observed-service-dates-per-route-v1",
  lookbackDays: STANDING_FIT_POLICY.lookbackDays, serviceDaysPerRoute: STANDING_FIT_POLICY.serviceDaysPerRoute }));
export const STANDING_ALGORITHM = `analytic-phase-stack-v2:remaining:${algorithmHash.digest("hex")}`;

export interface StandingFitRequest {
  dbPath: string; patterns: StandingRoutePattern[]; from: number; cutoff: number; serviceDayCutoff: number;
  observedAt: number; maximumRows: number; lookbackDays: number; serviceDaysPerRoute: number;
}
export interface StandingFitResult {
  fit: AnalyticFit;
  diagnostics: { read: number; explicit: number; legacyProxy: number; unknownAvailability: number;
    unresolvedPattern: number; ambiguousIdentity: number; trainingRows: number; from: number; cutoff: number;
    serviceDayCutoff: number; trainingDates: StandingTrainingDate[]; completedAt: number; elapsedMs: number;
    readMs: number; fitMs: number; processPeakRssBytes: number };
}
export interface StandingFitJob { promise: Promise<StandingFitResult>; cancel(): void }
export interface StandingForecastOptions {
  autoFit?: boolean;
  worker?: (request: StandingFitRequest) => StandingFitJob;
  onUpdate?: () => void;
  log?: (event: string, details: Record<string, unknown>) => void;
}
interface ObservedVisit {
  id: number; busName: string; routeId: number; stopId: number; stopIndex: number;
  anchoredAt: Date; pinnedAt: Date | null; departedAt: Date | null; outcome: string;
}

/** A worker can be terminated without leaving a fit promise or request pending. */
export function startStandingFitWorker(request: StandingFitRequest): StandingFitJob {
  const worker = new Worker(new URL("./standingForecast.worker.mjs", import.meta.url), {
    workerData: request, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  let finished = false;
  let rejectJob: (reason: Error) => void = () => {};
  const promise = new Promise<StandingFitResult>((resolve, reject) => {
    rejectJob = reject;
    worker.once("message", (message: { ok: boolean; result?: StandingFitResult; error?: string }) => {
      finished = true;
      if (message.ok && message.result) resolve(message.result); else reject(new Error(message.error ?? "standing fit worker failed"));
    });
    worker.once("error", error => { finished = true; reject(error); });
    worker.once("exit", code => { if (!finished) { finished = true; reject(new Error(`standing fit worker exited ${code}`)); } });
  });
  worker.unref();
  return { promise, cancel() {
    if (!finished) { finished = true; rejectJob(new Error("standing fit worker cancelled")); }
    void worker.terminate();
  } };
}

function validFit(value: unknown): value is AnalyticFit {
  if (!value || typeof value !== "object") return false;
  const fit = value as AnalyticFit;
  if (fit.version !== "analytic-phase-stack-v2" || fit.options?.weightObjective !== "remaining" ||
    !Number.isFinite(fit.fittedAt) || !fit.cells || typeof fit.cells !== "object") return false;
  return Object.values(fit.cells).every(cell => Number.isFinite(cell.weight) && cell.weight >= 0 && cell.weight <= 1 &&
    Array.isArray(cell.samples) && cell.samples.every(Number.isFinite) && Array.isArray(cell.q) && cell.q.every(Number.isFinite) &&
    Number.isFinite(cell.n) && Number.isFinite(cell.pStop) && Number.isFinite(cell.stopCount) && Number.isFinite(cell.visitCount) &&
    (!cell.phase || (Number.isFinite(cell.phase.periodSec) && cell.phase.periodSec > 0 &&
      Array.isArray(cell.phase.errors) && cell.phase.errors.length >= 3 && cell.phase.errors.every(Number.isFinite))));
}

export class StandingForecastModel {
  private runtime: AnalyticRuntime | null = null;
  private patterns = new Map<number, StandingRoutePattern & { id: string; since: number }>();
  private history: AnalyticEpisode[] = [];
  private historyDay: number | null = null;
  private historyVersion = 0;
  private completedDay: number | null = null;
  private attemptsDay: number | null = null;
  private attempts = 0;
  private activeJob: StandingFitJob | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private nextAttemptAt = 0;
  private stopped = false;
  private lastError: string | null = null;
  private diagnostics: StandingFitResult["diagnostics"] | null = null;
  private heldContexts = new Map<string, StandingForecastContext>();

  constructor(private readonly sqlite: Database.Database, private readonly options: StandingForecastOptions = {}) {
    const cached = sqlite.prepare("SELECT algorithm,model,diagnostics FROM standing_forecast_models WHERE id=1")
      .get() as { algorithm: string; model: string; diagnostics: string } | undefined;
    if (cached?.algorithm === STANDING_ALGORITHM) {
      try {
        const fit: unknown = JSON.parse(cached.model);
        if (validFit(fit)) {
          this.runtime = new AnalyticRuntime(fit);
          this.diagnostics = JSON.parse(cached.diagnostics) as StandingFitResult["diagnostics"];
          this.completedDay = this.diagnostics.serviceDayCutoff;
        }
      } catch { this.lastError = "invalid cached standing fit"; }
    }
  }

  setPatterns(patterns: readonly StandingRoutePattern[], now: number): void {
    const next = new Map<number, StandingRoutePattern & { id: string; since: number }>();
    for (const pattern of patterns) {
      const id = standingPatternId(pattern.routeId, pattern.stopIds), previous = this.patterns.get(pattern.routeId);
      next.set(pattern.routeId, { routeId: pattern.routeId, stopIds: [...pattern.stopIds], id,
        since: previous?.id === id ? previous.since : now });
    }
    this.patterns = next;
  }

  /** Startup/day rollover hydration only; request-time inference never reads SQLite. */
  refresh(now: number, patterns: readonly StandingRoutePattern[]): void {
    if (this.stopped) return;
    this.setPatterns(patterns, now);
    const [day] = standingDayBounds(now);
    if (this.attemptsDay !== day) { this.attemptsDay = day; this.attempts = 0; }
    if (this.historyDay !== day) {
      try {
        this.history = readStandingEpisodes(this.sqlite, patterns, day, now, "live", STANDING_FIT_POLICY.maximumRows).episodes;
      } catch (error) {
        this.history = []; this.logFailure("standing_forecast.history_failed", error);
      }
      this.historyDay = day; this.historyVersion++; this.heldContexts.clear();
    }
    if (this.options.autoFit === false || this.activeJob || this.completedDay === day || now < this.nextAttemptAt || this.attempts >= STANDING_FIT_POLICY.maximumAttemptsPerDay) return;
    if (this.sqlite.name === ":memory:" && !this.options.worker) return;
    let from = day;
    for (let i = 0; i < STANDING_FIT_POLICY.lookbackDays; i++) from = standingDayBounds(from - 1)[0];
    const request: StandingFitRequest = { dbPath: this.sqlite.name, patterns: [...this.patterns.values()].map(p => ({ routeId: p.routeId, stopIds: p.stopIds })),
      from, cutoff: now, serviceDayCutoff: day, observedAt: now, maximumRows: STANDING_FIT_POLICY.maximumRows,
      lookbackDays: STANDING_FIT_POLICY.lookbackDays, serviceDaysPerRoute: STANDING_FIT_POLICY.serviceDaysPerRoute };
    this.nextAttemptAt = now + STANDING_FIT_POLICY.retryMs;
    this.attempts++;
    try {
      const job = (this.options.worker ?? startStandingFitWorker)(request);
      this.activeJob = job;
      this.timeout = setTimeout(() => job.cancel(), STANDING_FIT_POLICY.workerTimeoutMs); this.timeout.unref();
      this.options.log?.("standing_forecast.fit_started", { cutoff: now, serviceDayCutoff: day, attempt: this.attempts, policy: STANDING_FIT_POLICY });
      void job.promise.then(result => {
        if (this.stopped || this.activeJob !== job) return;
        if (!validFit(result.fit) || result.fit.fittedAt !== request.cutoff || result.diagnostics.serviceDayCutoff !== day) throw new Error("invalid standing fit result");
        this.sqlite.prepare(`INSERT INTO standing_forecast_models (id,algorithm,fitted_at,created_at,model,diagnostics)
          VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET algorithm=excluded.algorithm,
          fitted_at=excluded.fitted_at,created_at=excluded.created_at,model=excluded.model,diagnostics=excluded.diagnostics`)
          .run(STANDING_ALGORITHM, result.fit.fittedAt, Date.now(), JSON.stringify(result.fit), JSON.stringify(result.diagnostics));
        this.runtime = new AnalyticRuntime(result.fit); this.diagnostics = result.diagnostics;
        this.completedDay = day; this.lastError = null;
        this.options.onUpdate?.();
        this.options.log?.("standing_forecast.fitted", { ...result.diagnostics, cells: Object.keys(result.fit.cells).length });
      }).catch(error => { if (!this.stopped) this.logFailure("standing_forecast.fit_failed", error); })
        .finally(() => { if (this.activeJob === job) { this.activeJob = null; if (this.timeout) clearTimeout(this.timeout); this.timeout = null; } });
    } catch (error) { this.logFailure("standing_forecast.fit_failed", error); }
  }

  /** Called after the collector's actual insert, with its returned row IDs. */
  recordVisits(visits: readonly ObservedVisit[], now: number, patterns: readonly StandingRoutePattern[], ambiguousNames: ReadonlySet<string> = new Set()): void {
    this.setPatterns(patterns, now);
    const patternStmt = this.sqlite.prepare("INSERT INTO standing_forecast_patterns (id,route_id,stop_ids) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING");
    const observationStmt = this.sqlite.prepare("INSERT INTO standing_forecast_observations (visit_id,known_at,pattern_id,identity_ambiguous) VALUES (?,?,?,?)");
    const added: AnalyticEpisode[] = [];
    this.sqlite.transaction(() => {
      for (const visit of visits) {
        const pattern = this.patterns.get(visit.routeId), anchor = visit.anchoredAt.getTime();
        const resolved = pattern && anchor >= pattern.since && pattern.stopIds[visit.stopIndex] === visit.stopId;
        if (resolved) patternStmt.run(pattern.id, visit.routeId, JSON.stringify(pattern.stopIds));
        const ambiguous = ambiguousNames.has(visit.busName);
        observationStmt.run(visit.id, now, resolved ? pattern.id : null, Number(ambiguous));
        added.push({ id: visit.id, routeId: visit.routeId, routePatternId: resolved ? pattern.id : `${visit.routeId}:unresolved`,
          stopId: visit.stopId, stopIndex: visit.stopIndex, busKey: visit.busName, day: standingDayOf(anchor),
          anchoredAt: anchor, pinnedAt: visit.pinnedAt?.getTime() ?? null, departedAt: visit.departedAt?.getTime() ?? null,
          knownAt: now, outcome: visit.outcome, patternResolved: Boolean(resolved) && !ambiguous });
      }
    })();
    const day = standingDayBounds(now)[0];
    this.history = this.history.filter(v => v.anchoredAt >= day);
    this.history.push(...added.filter(v => v.anchoredAt >= day)); this.historyVersion++;
    if (this.history.length > STANDING_FIT_POLICY.maximumRows) {
      this.history = []; this.logFailure("standing_forecast.history_failed", new Error("live history row limit exceeded"));
    }
  }

  /** Same route/pattern/occurrence law for every bus; identity contention is gated by the caller. */
  contexts(bus: BusPosition, now: number): StandingForecastContext[] {
    if (!this.runtime || now < this.runtime.fit.fittedAt || now - this.runtime.fit.fittedAt >= STANDING_FIT_POLICY.maximumFitAgeMs) return [];
    const pattern = this.patterns.get(bus.routeId);
    if (!pattern) return [];
    this.runtime.replaceCompletedHistory(this.history, this.historyVersion);
    const [day, until] = standingDayBounds(now);
    const start = Math.min(now, ...[bus.atStopSince, bus.stationarySince].filter((v): v is number => v != null && Number.isFinite(v)));
    const output: StandingForecastContext[] = [];
    for (let stopIndex = 0; stopIndex < pattern.stopIds.length; stopIndex++) {
      const stopId = pattern.stopIds[stopIndex]!;
      const key = JSON.stringify([bus.busName, pattern.id, stopIndex, start]);
      const held = this.heldContexts.get(key);
      if (held && now < held.valid_until && held.fitted_at <= start) { output.push(held); continue; }
      const context = this.runtime.context({ routeId: bus.routeId, routePatternId: pattern.id,
        stopId, stopIndex, busKey: bus.busName, day: standingDayOf(start), observedVisitStartMs: start,
        issuedAtMs: now, patternResolved: pattern.stopIds[stopIndex] === stopId,
        canonicalStopIds: pattern.stopIds, validUntilMs: Math.min(until, this.runtime.fit.fittedAt + STANDING_FIT_POLICY.maximumFitAgeMs) });
      if (context) {
        output.push(context);
        if (start >= day && (bus.atStopId === stopId || bus.stationaryStopId === stopId)) this.heldContexts.set(key, context);
      }
    }
    for (const [key, context] of this.heldContexts) if (context.valid_until <= now) this.heldContexts.delete(key);
    while (this.heldContexts.size > 1000) this.heldContexts.delete(this.heldContexts.keys().next().value!);
    return output;
  }

  status(): Record<string, unknown> {
    return { algorithm: STANDING_ALGORITHM, policy: STANDING_FIT_POLICY, fitting: this.activeJob != null,
      fittedAt: this.runtime?.fit.fittedAt ?? null, attempts: this.attempts, attemptsDay: this.attemptsDay,
      diagnostics: this.diagnostics, lastError: this.lastError };
  }
  stop(): void { this.stopped = true; this.activeJob?.cancel(); this.activeJob = null; if (this.timeout) clearTimeout(this.timeout); this.timeout = null; }
  private logFailure(event: string, error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.options.log?.(event, { error: this.lastError });
  }
}
