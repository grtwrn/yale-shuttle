import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DbBundle } from "../db/client.js";
import { StandingForecastPriorSchema, type BusPosition } from "../schema/api.js";
import { analyticCellKey, ANALYTIC_OPTIONS, type AnalyticFit } from "./analytic/analytic.js";
import { StandingForecastModel, STANDING_ALGORITHM, STANDING_FIT_POLICY, startStandingFitWorker,
  type StandingFitRequest, type StandingFitResult } from "./standingForecast.js";
import { readStandingEpisodes, standingDayBounds, standingPatternId, standingTrainingDates,
  type StandingRoutePattern } from "./standingForecastData.js";

const at = (day: string, hour = 12): number => Date.parse(`2026-09-${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const patterns: StandingRoutePattern[] = [{ routeId: 91, stopIds: [731, 732] }];
const patternId = standingPatternId(91, [731, 732]);
const opened: DbBundle[] = [], directories: string[] = [], models: StandingForecastModel[] = [];
afterEach(() => { for (const model of models.splice(0)) model.stop(); for (const db of opened.splice(0)) db.sqlite.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function database(file = false): DbBundle {
  const directory = file ? mkdtempSync(join(tmpdir(), "standing-forecast-")) : null;
  if (directory) directories.push(directory);
  const db = openDb(directory ? join(directory, "test.db") : ":memory:");
  migrate(db.db, { migrationsFolder: "./drizzle" }); opened.push(db); return db;
}
function row(sqlite: Database.Database, anchor: number, extra: {
  route?: number; stop?: number; index?: number; bus?: string; dep?: number; pin?: number; outcome?: string; known?: number;
} = {}): number {
  const route = extra.route ?? 91, stop = extra.stop ?? 731, index = extra.index ?? 0;
  const inserted = sqlite.prepare(`INSERT INTO stop_visits
    (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,departed_at,outcome,steps,rest_polls,shuffles,closest_m,dow,hour)
    VALUES (1,?,1,?,?,?,?,?,?,?,0,0,0,0,0,0)`).run(extra.bus ?? "vehicle", route, stop, index, anchor,
      extra.pin ?? anchor, extra.dep ?? anchor + 120_000, extra.outcome ?? "stopped");
  const id = Number(inserted.lastInsertRowid);
  if (extra.known != null) {
    const sequence = route === 91 ? [731, 732] : [801, 802], pid = standingPatternId(route, sequence);
    sqlite.prepare("INSERT INTO standing_forecast_patterns VALUES (?,?,?) ON CONFLICT(id) DO NOTHING").run(pid, route, JSON.stringify(sequence));
    sqlite.prepare("INSERT INTO standing_forecast_observations VALUES (?,?,?,0)").run(id, extra.known, pid);
  }
  return id;
}
function fit(fittedAt = at("08", 4)): AnalyticFit {
  return { version: "analytic-phase-stack-v2", fittedAt, options: { ...ANALYTIC_OPTIONS, weightObjective: "remaining" },
    cells: { [analyticCellKey({ routeId: 91, routePatternId: patternId, stopId: 731, stopIndex: 0 })]: {
      samples: [120, 180, 300, 450], q: [120, 120, 180, 180, 240, 300, 300, 450, 450, 450], n: 4,
      pStop: 1, stopCount: 4, visitCount: 4, phase: { periodSec: 3600, errors: [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60], n: 10 },
      weight: .5, evidence: { n: 10, numerator: 1, denominator: 2 } } } };
}
function result(model = fit()): StandingFitResult {
  return { fit: model, diagnostics: { read: 4, explicit: 4, legacyProxy: 0, unknownAvailability: 0,
    unresolvedPattern: 0, ambiguousIdentity: 0, trainingRows: 4, from: at("03", 4), cutoff: model.fittedAt,
    serviceDayCutoff: standingDayBounds(model.fittedAt)[0], trainingDates: [], completedAt: model.fittedAt + 100, elapsedMs: 100,
    readMs: 10, fitMs: 90, processPeakRssBytes: 0 } };
}
function cache(sqlite: Database.Database, model = fit(), algorithm = STANDING_ALGORITHM): void {
  sqlite.prepare("INSERT INTO standing_forecast_models VALUES (1,?,?,?,?,?)").run(algorithm, model.fittedAt,
    model.fittedAt, JSON.stringify(model), JSON.stringify(result(model).diagnostics));
}
function bus(start = at("08", 12)): BusPosition {
  return { busId: 1, busName: "vehicle", routeId: 91, lat: 41, lon: -72, heading: 0,
    lastStopId: 731, atStopId: 731, atStopSince: start, stationarySince: start,
    stationaryStopId: 731, collectedAt: start + 30_000 };
}
function model(db: DbBundle, options: ConstructorParameters<typeof StandingForecastModel>[1] = {}): StandingForecastModel {
  const instance = new StandingForecastModel(db.sqlite, options); models.push(instance); return instance;
}

describe("standing forecast history and service-date policy", () => {
  it("keeps the last two observed dates independently across weekends and holidays", () => {
    const { sqlite } = database();
    for (const day of ["03", "04"]) row(sqlite, at(day), { known: at(day) + 200_000 });
    for (const day of ["05", "06"]) row(sqlite, at(day), { route: 92, stop: 801, known: at(day) + 200_000 });
    row(sqlite, at("07"), { known: at("09") }); // Not known at the requested fit.
    const dates = standingTrainingDates(sqlite, at("08", 4), 30, 2, at("08", 10));
    expect(dates.map(d => [d.routeId, d.day])).toEqual([[91, "2026-09-03"], [91, "2026-09-04"], [92, "2026-09-05"], [92, "2026-09-06"]]);
    // No fitted count threshold: a real, known partial date is still a date.
    sqlite.prepare("UPDATE standing_forecast_observations SET known_at=? WHERE visit_id=5").run(at("07") + 200_000);
    expect(standingTrainingDates(sqlite, at("08", 4), 30, 2, at("08", 10)).filter(d => d.routeId === 91).map(d => d.day))
      .toEqual(["2026-09-04", "2026-09-07"]);
  });

  it("keeps legacy availability explicit and marks an entire mismatched route-date unresolved", () => {
    const { sqlite } = database();
    row(sqlite, at("04")); row(sqlite, at("04") + 300_000, { stop: 732, index: 1 });
    row(sqlite, at("04") + 600_000); row(sqlite, at("04") + 900_000, { stop: 999, index: 1 });
    const read = readStandingEpisodes(sqlite, patterns, at("04", 4), at("05", 4), "training", 20);
    expect(read.episodes[0]!.knownAt).toBe(at("04") + 720_000);
    expect(read.episodes.every(e => e.patternResolved === false)).toBe(true);
    expect(read.counts.legacyProxy).toBe(2);
    expect(() => readStandingEpisodes(sqlite, patterns, at("04", 4), at("05", 4), "training", 3)).toThrow(/exceeds 3/);
  });

  it("records actual insertion clocks and rejects patterns changed during the visit", () => {
    const db = database(), m = model(db, { autoFit: false }), start = at("08", 10);
    m.setPatterns(patterns, start);
    const id = row(db.sqlite, start + 10_000);
    m.recordVisits([{ id, busName: "vehicle", routeId: 91, stopId: 731, stopIndex: 0,
      anchoredAt: new Date(start + 10_000), pinnedAt: new Date(start + 10_000), departedAt: new Date(start + 130_000), outcome: "stopped" }], start + 300_000, patterns);
    expect(db.sqlite.prepare("SELECT known_at,pattern_id FROM standing_forecast_observations WHERE visit_id=?").get(id))
      .toEqual({ known_at: start + 300_000, pattern_id: patternId });
    const oldId = row(db.sqlite, start - 10_000);
    m.recordVisits([{ id: oldId, busName: "vehicle", routeId: 91, stopId: 731, stopIndex: 0,
      anchoredAt: new Date(start - 10_000), pinnedAt: new Date(start), departedAt: new Date(start + 100_000), outcome: "stopped" }], start + 300_000, patterns);
    expect(db.sqlite.prepare("SELECT pattern_id FROM standing_forecast_observations WHERE visit_id=?").get(oldId)).toEqual({ pattern_id: null });
    db.sqlite.prepare("DELETE FROM stop_visits WHERE id=?").run(id);
    expect(db.sqlite.prepare("SELECT 1 FROM standing_forecast_observations WHERE visit_id=?").get(id)).toBeUndefined();
  });

  it("uses exact ET day boundaries across daylight-saving changes", () => {
    const spring = standingDayBounds(Date.parse("2026-03-08T16:00:00Z")), autumn = standingDayBounds(Date.parse("2026-11-01T16:00:00Z"));
    expect(spring[1] - spring[0]).toBe(23 * 3600_000); expect(autumn[1] - autumn[0]).toBe(25 * 3600_000);
    expect(patternId).toBe(`91:${standingPatternId(91, [731, 732]).split(":")[1]}`);
  });
});

describe("cached generic server inference", () => {
  it("serves exact schema-valid occurrence context without query-time SQL or cross-bus history", () => {
    const db = database(); cache(db.sqlite); row(db.sqlite, at("08", 11), { known: at("08", 11) + 200_000 });
    const m = model(db, { autoFit: false }); m.refresh(at("08", 12) + 30_000, patterns);
    const spy = vi.spyOn(db.sqlite, "prepare");
    const context = m.contexts(bus(), at("08", 12) + 30_000)[0]!;
    expect(StandingForecastPriorSchema.parse(context)).toEqual(context);
    expect(context.route_id).toBe(91); expect(context.stop_index).toBe(0);
    expect(context.history_available_at).toBe(at("08", 11) + 200_000);
    expect(m.contexts({ ...bus(), busName: "different" }, at("08", 12) + 30_000)).toEqual([]);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    m.setPatterns([{ routeId: 91, stopIds: [732, 731] }], at("08", 12) + 40_000);
    expect(m.contexts(bus(), at("08", 12) + 40_000)).toEqual([]);
  });

  it("does not invent a pre-start availability clock for legacy rows recovered on boot", () => {
    const db = database(); cache(db.sqlite); row(db.sqlite, at("08", 11));
    const m = model(db, { autoFit: false }), boot = at("08", 12) + 30_000;
    m.refresh(boot, patterns);
    expect(m.contexts(bus(), boot)).toEqual([]);
    expect(m.contexts(bus(boot + 60_000), boot + 90_000)[0]!.history_available_at).toBe(boot);
  });

  it("falls back for a stale fit, a different algorithm or a fit newer than the visit", () => {
    const db = database(); cache(db.sqlite, fit(at("08", 13))); row(db.sqlite, at("08", 11), { known: at("08", 11) + 200_000 });
    const m = model(db, { autoFit: false }); m.refresh(at("08", 14), patterns);
    expect(m.contexts(bus(), at("08", 14))).toEqual([]);
    expect(m.contexts(bus(at("11", 12)), at("11", 12) + 30_000)).toEqual([]);
    db.sqlite.prepare("UPDATE standing_forecast_models SET algorithm='old-first-objective'").run();
    const old = model(db, { autoFit: false }); old.refresh(at("08", 14), patterns);
    expect(old.contexts(bus(at("08", 14)), at("08", 14) + 30_000)).toEqual([]);
  });
});

describe("off-thread fit lifecycle", () => {
  it("runs one job, caches a validated result, and retries a failed job only after the bound", async () => {
    const db = database();
    let reject: (error: Error) => void = () => {};
    const worker = vi.fn((_request: StandingFitRequest) => ({ promise: new Promise<StandingFitResult>((_resolve, no) => { reject = no; }), cancel: vi.fn() }));
    const m = model(db, { worker }), now = at("08", 10);
    m.refresh(now, patterns); m.refresh(now + 1000, patterns); expect(worker).toHaveBeenCalledTimes(1);
    reject(new Error("over row cap")); await new Promise(resolve => setImmediate(resolve));
    expect(m.status().lastError).toBe("over row cap");
    m.refresh(now + 2000, patterns); expect(worker).toHaveBeenCalledTimes(1);
    m.refresh(now + STANDING_FIT_POLICY.retryMs, patterns); expect(worker).toHaveBeenCalledTimes(2);
    reject(new Error("second failure")); await new Promise(resolve => setImmediate(resolve));
    m.refresh(now + 2 * STANDING_FIT_POLICY.retryMs, patterns); expect(worker).toHaveBeenCalledTimes(3);
    reject(new Error("third failure")); await new Promise(resolve => setImmediate(resolve));
    m.refresh(now + 3 * STANDING_FIT_POLICY.retryMs, patterns); expect(worker).toHaveBeenCalledTimes(3);
    m.stop();
  });

  it("persists successful fits with algorithm identity and does not refit the same service date", async () => {
    const db = database(), worker = vi.fn((request: StandingFitRequest) => ({ promise: Promise.resolve(result(fit(request.cutoff))), cancel() {} }));
    const m = model(db, { worker }), now = at("08", 10);
    m.refresh(now, patterns); await new Promise(resolve => setImmediate(resolve));
    expect(m.status().fittedAt).toBe(now); expect(m.status().fitting).toBe(false);
    m.refresh(now + 3600_000, patterns); expect(worker).toHaveBeenCalledTimes(1);
    expect(db.sqlite.prepare("SELECT algorithm FROM standing_forecast_models").get()).toEqual({ algorithm: STANDING_ALGORITHM });
    expect(model(db, { autoFit: false }).status().fittedAt).toBe(now);
  });

  it("keeps a current visit's initial law when a new background fit finishes", async () => {
    const db = database(); cache(db.sqlite, fit(at("07", 4)));
    row(db.sqlite, at("08", 11), { known: at("08", 11) + 200_000 });
    let finish: (result: StandingFitResult) => void = () => {};
    const worker = (request: StandingFitRequest) => ({ promise: new Promise<StandingFitResult>(yes => {
      finish = () => yes(result(fit(request.cutoff)));
    }), cancel() {} });
    const m = model(db, { worker }), now = at("08", 12), waiting = bus(now - 300_000);
    m.refresh(now, patterns);
    const before = m.contexts(waiting, now);
    expect(before).toHaveLength(1);
    finish(result()); await new Promise(resolve => setImmediate(resolve));
    expect(m.contexts(waiting, now + 30_000)).toEqual(before);
  });

  it("fits in a real worker while the main event loop continues, using only selected prior dates", async () => {
    const db = database(true), base = at("03", 11);
    for (let day = 0; day < 2; day++) for (let lap = 0; lap < 8; lap++) {
      const dep = base + day * 86400_000 + lap * 2700_000;
      row(db.sqlite, dep - 120_000 - lap * 10_000, { dep, known: dep + 30_000 });
    }
    const cutoff = at("05", 4);
    const job = startStandingFitWorker({ dbPath: db.sqlite.name, patterns, from: at("01", 4), cutoff,
      serviceDayCutoff: cutoff, observedAt: cutoff, maximumRows: 20, lookbackDays: 30, serviceDaysPerRoute: 2 });
    let settled = false; void job.promise.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
    const value = await job.promise;
    expect(value.fit.version).toBe("analytic-phase-stack-v2");
    expect(value.fit.options.weightObjective).toBe("remaining");
    expect(value.diagnostics.trainingRows).toBe(16);
    expect(value.diagnostics.trainingDates.map(d => d.day)).toEqual(["2026-09-03", "2026-09-04"]);
  }, 15_000);
});
