/** Full-client replay attachment. Current-visit outcomes are never query features. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { TransitNetwork } from "../../../../src/network/TransitNetwork.js";
import type { AnalyticEpisode, AnalyticFit } from "./analytic.js";
import { AnalyticRuntime } from "./analytic-runtime.js";

const service = path.resolve(import.meta.dirname, "../../../..");
const source = process.env.SOURCE_ROOT ?? service;
const artifacts = path.join(service, "scripts/.eta-replay/overnight-2026-09-08");
const dataset = process.env.EVAL_DATASET ?? path.join(artifacts, "dataset-v2");
const day = process.env.EVAL_DAY ?? "2026-09-04";
const defaultFit = day === "2026-09-04" ? "remaining-objective-corrected" : "reserved-confirmation";
const fitPath = process.env.ANALYTIC_FIT ?? path.join(artifacts, "analytic", defaultFit, "fit.json");
const fit: AnalyticFit = JSON.parse(fs.readFileSync(fitPath, "utf8"));
if (fit.version !== "analytic-phase-stack-v2" || fit.options.weightObjective !== "remaining") throw new Error("Replay requires selected remaining-objective fit");
const history: AnalyticEpisode[] = zlib.gunzipSync(fs.readFileSync(path.join(dataset, day, "episodes.jsonl.gz")))
  .toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const runtime = new AnalyticRuntime(fit);
// The runtime groups stored history, but gates each row's knownAt at the
// server-observed visit start. No current episode is looked up or matched.
runtime.replaceCompletedHistory(history, `${day}:frozen-history`);
const { standingForecastsFor } = await import(`${source}/web/src/eta/standingForecast.ts`);
const { ROUTE_LISTS } = await import(`${source}/web/src/routes.ts`);
const routeConfigs = new Map<number, any>();
for (const cfg of ROUTE_LISTS) for (const id of cfg.busRouteIds) routeConfigs.set(id, cfg);
const patterns = new Map<number, { sequence: readonly number[]; patternId: string }>();
// These frozen September study dates are EDT. The live adapter receives its
// service-day expiry from the server calendar, rather than using this fixture.
const dayStart = Date.parse(`${day}T04:00:00Z`), validUntil = dayStart + 86_400_000;
const clock = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;
  const value = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(value) ? value : null;
};

export function attachContext(bus: any, t: number, options: { fitAt: number; network: TransitNetwork;
  contendedNames?: ReadonlySet<string> }): any {
  if (options.fitAt !== fit.fittedAt) throw new Error(`Replay table cutoff ${options.fitAt} differs from model ${fit.fittedAt}`);
  if (t < dayStart || t >= validUntil || options.contendedNames?.has(bus.bus_name)) return bus;
  const route = options.network.routes.get(Number(bus.route_id));
  if (!route) return bus;
  let pattern = patterns.get(route.id);
  if (!pattern || pattern.sequence !== route.stops) {
    pattern = { sequence: route.stops, patternId: `${route.id}:${crypto.createHash("sha256")
      .update(JSON.stringify([route.stops])).digest("hex").slice(0, 24)}` };
    patterns.set(route.id, pattern);
  }
  const observedVisitStartMs = Math.min(t, ...[clock(bus.at_stop_since), clock(bus.stationary_since)].filter((v): v is number => v != null));
  if (observedVisitStartMs > t) return bus;
  const contexts = route.stops.flatMap((stopId, stopIndex) => {
    const context = runtime.context({ routeId: route.id, routePatternId: pattern!.patternId,
      stopId, stopIndex, busKey: bus.bus_name, day, observedVisitStartMs, issuedAtMs: t,
      patternResolved: true, canonicalStopIds: route.stops, validUntilMs: validUntil });
    return context ? [context] : [];
  });
  return contexts.length ? { ...bus, standing_forecasts: contexts } : bus;
}

export function shownStand(bus: any, ring: any, payload: any, standing: any, t: number, original: (...args: any[]) => any): any {
  const cfg = routeConfigs.get(Number(bus.route_id));
  const routeDwells = payload.dwells[cfg?.routeIds[0] ?? String(bus.route_id)] ?? {};
  return original(routeDwells[standing.stopId], standing.standingSec, routeDwells, payload.dwells,
    { forecasts: standingForecastsFor(bus, ring, t), stopId: standing.stopId, stopIndex: standing.stopIndex, now: t });
}

export const analyticHookManifest = {
  fitPath, fitAt: fit.fittedAt, fitSha256: crypto.createHash("sha256").update(fs.readFileSync(fitPath)).digest("hex"),
  dataset, day, currentClock: "minimum valid server at_stop_since, stationary_since, and query clock; decoded again at browser rest origin",
  currentLabelFeatures: false, historyAvailability: "knownAt <= observed server visit start; exact canonical route pattern and occurrence",
};
