import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { fitAnalytic } from "./analytic/analytic.js";
import { readStandingEpisodes, standingTrainingDates } from "./standingForecastData.js";
import type { StandingFitRequest, StandingFitResult } from "./standingForecast.js";

const request = workerData as StandingFitRequest;
const started = Date.now();
try {
  const sqlite = new Database(request.dbPath, { readonly: true, fileMustExist: true });
  let read, dates;
  try {
    sqlite.pragma("busy_timeout = 5000");
    dates = standingTrainingDates(sqlite, request.serviceDayCutoff, request.lookbackDays, request.serviceDaysPerRoute, request.cutoff);
    read = readStandingEpisodes(sqlite, request.patterns, request.from, request.observedAt, "training", request.maximumRows, dates);
  } finally { sqlite.close(); }
  const rows = read.episodes.filter(v => v.anchoredAt < request.serviceDayCutoff);
  if (rows.length > request.maximumRows) throw new Error(`standing forecast training exceeds ${request.maximumRows} rows`);
  const readMs = Date.now() - started, fitStarted = Date.now();
  const fit = fitAnalytic(rows, request.cutoff, "remaining");
  const result: StandingFitResult = { fit, diagnostics: { ...read.counts, trainingRows: rows.length,
    from: request.from, cutoff: request.cutoff, serviceDayCutoff: request.serviceDayCutoff,
    trainingDates: dates, completedAt: Date.now(), elapsedMs: Date.now() - started,
    readMs, fitMs: Date.now() - fitStarted, processPeakRssBytes: process.resourceUsage().maxRSS * 1024 } };
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
