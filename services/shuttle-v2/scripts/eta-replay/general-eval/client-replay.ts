/** Actual rider-facing replay; future labels are used only after forecasts exist. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { productionTables } from "./production-tables.js";

const service = path.resolve(import.meta.dirname, "../../..");
const source = process.env.SOURCE_ROOT ?? service;
const dataset = process.env.EVAL_DATASET ?? path.join(service, "scripts/.eta-replay/overnight-2026-09-08/dataset-v2");
const day = process.env.EVAL_DAY ?? "2026-09-04";
const output = process.env.EVAL_OUT ?? path.join(service, `scripts/.eta-replay/overnight-2026-09-08/client-${day}.jsonl.gz`);
const cutoff = Date.parse(process.env.EVAL_FIT_AT ?? "2026-09-04T04:00:00Z");
const stride = Number(process.env.POLL_STRIDE ?? 6);
const cold = process.env.COMPARE_COLD === "1";
const startWall = Date.now();
const parameterFile = process.env.MODEL_PARAMS;
const parameterBytes = parameterFile ? fs.readFileSync(parameterFile) : null;
const parameterSet = parameterBytes ? JSON.parse(parameterBytes.toString()) : null;
const parameters = parameterBytes ? { file: parameterFile,
  sha256: crypto.createHash("sha256").update(parameterBytes).digest("hex"), value: parameterSet }
  : { kind: "compiled defaults" };
const sourceFiles = ["web/src/arrivals.ts", "web/src/liveAnchor.ts", "web/src/eta/index.ts",
  "web/src/eta/arrival.ts", "web/src/eta/filter.ts", "web/src/eta/ring.ts", "web/src/eta/tables.ts",
  "web/src/eta/dist.ts", "web/src/eta/params.ts", "web/src/eta/standingForecast.ts",
  "web/src/eta/standingDistribution.ts", "src/collector/detector.ts", "src/calibrator/calibrator.ts"];
const sourceHashes = Object.fromEntries(sourceFiles.filter(file => fs.existsSync(path.join(source, file)))
  .map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex")]));
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(process.env.EVAL_DB ?? "/home/gwarren/yale-shuttle-wt/loop34/services/shuttle-v2/scripts/.reestimate/replay-2026-09-06.db", { readonly: true });
const read = (file: string): any[] => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const { computeUpcomingArrivals, shownStandSec } = await import(`${source}/web/src/arrivals.ts`);
const { registerRoutePaths } = await import(`${source}/web/src/anchor.ts`);
const { ringForBus } = await import(`${source}/web/src/eta/index.ts`);
const { anchorKeyFor, resolveStandingStop } = await import(`${source}/web/src/liveAnchor.ts`);
const { ROUTE_LISTS } = await import(`${source}/web/src/routes.ts`);
const { planTracks, stepMany } = await import(`${source}/src/collector/detector.ts`);
const { distanceMeters } = await import(`${source}/src/network/geo.ts`);
const { applyModelParams } = await import(`${source}/web/src/eta/params.ts`);
const hook = process.env.CONTEXT_HOOK ? await import(path.resolve(process.env.CONTEXT_HOOK)) : null;
const fitted = productionTables(db, cutoff);
const payload = fitted.payload as any;
const networkPatterns = [...fitted.network.routes.values()].map(route => ({ routeId: route.id,
  stopIds: [...route.stops], patternId: `${route.id}:${crypto.createHash("sha256")
    .update(JSON.stringify([route.stops])).digest("hex").slice(0, 24)}` }));
if (parameterSet && !applyModelParams(parameterSet)) throw new Error("Model parameters rejected");
registerRoutePaths(payload.route_paths);
const positions = read(path.join(dataset, day, "positions.jsonl.gz")).slice(0, process.env.MAX_POSITIONS ? Number(process.env.MAX_POSITIONS) : undefined);
const physical = read(path.join(dataset, day, "physical-arrivals.jsonl.gz"));
// A separately audited label repair may change scoring clocks. It must not
// change the hook's historical features, calibration inputs, or predictions.
const episodeLabelPath = process.env.EVAL_LABEL_EPISODES ?? path.join(dataset, day, "episodes.jsonl.gz");
const episodes = read(episodeLabelPath);
const episodeLabels = { path: episodeLabelPath,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(episodeLabelPath)).digest("hex"),
  scoringOnly: true, runtimeHistoryDataset: dataset };
const targets = new Map<string, any[]>(), holds = new Map<string, any[]>();
for (const a of physical) { const key = `${a.routeId}:${a.busKey}:${a.stopId}`, group = targets.get(key) ?? []; group.push(a); targets.set(key, group); }
for (const e of episodes) { const key = `${e.routeId}:${e.busKey}`, group = holds.get(key) ?? []; group.push(e); holds.set(key, group); }
for (const group of targets.values()) group.sort((a, b) => a.arrivedAt - b.arrivedAt);
for (const group of holds.values()) group.sort((a, b) => a.anchoredAt - b.anchoredAt);
const trackStarts = new Map<string, number>(), lastSeen = new Map<string, number>();
const store = new Map(), states = new Map();
const rows: any[] = [], standRows: any[] = [], unlabelledStandRows: any[] = [];
let rowCount = 0, standRowCount = 0, unlabelledStandRowCount = 0;
fs.mkdirSync(path.dirname(output), { recursive: true });
const standOutput = output.replace(/\.jsonl\.gz$/, ".stands.jsonl.gz");
const unlabelledStandOutput = output.replace(/\.jsonl\.gz$/, ".unlabelled-stands.jsonl.gz");
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite replay: ${output}`);
fs.writeFileSync(output, ""); fs.writeFileSync(standOutput, ""); fs.writeFileSync(unlabelledStandOutput, "");
function flush() {
  for (const [file, batch] of [[output, rows], [standOutput, standRows], [unlabelledStandOutput, unlabelledStandRows]] as const) {
    if (batch.length) fs.appendFileSync(file, zlib.gzipSync(batch.map(row => JSON.stringify(row)).join("\n") + "\n"));
  }
  rowCount += rows.length; standRowCount += standRows.length; unlabelledStandRowCount += unlabelledStandRows.length;
  rows.length = 0; standRows.length = 0; unlabelledStandRows.length = 0;
}
const cfgs = new Map<number, any>();
for (const cfg of ROUTE_LISTS) for (const id of cfg.busRouteIds) cfgs.set(id, cfg);
const iso = (t: number) => new Date(t).toISOString().replace(/Z$/, "");
let i = 0, pollIndex = 0, queryCount = 0, missingGeometry = 0, censoredTargets = 0;
while (i < positions.length) {
  const t = positions[i]!.collected_at, poll: any[] = [];
  while (i < positions.length && positions[i]!.collected_at === t) {
    const p = positions[i++]!;
    poll.push({ busId: p.bus_id, busName: p.bus_name, routeId: p.route_id, lat: p.lat, lon: p.lon, heading: p.heading, lastStopId: p.last_stop_id, collectedAt: t });
  }
  const plan = planTracks(poll); stepMany(fitted.network, states, poll, plan);
  const score = pollIndex++ % stride === 0;
  for (const p of poll) {
    const cfg = cfgs.get(p.routeId); if (!cfg) continue;
    const state: any = states.get(plan.keys.get(p.busId) ?? p.busName);
    const candidate = state && t - state.enteredAt >= 15_000 ? fitted.network.stops.get(state.nearestStopId) : null;
    const at = state && candidate && distanceMeters(p, candidate) <= 75 ? { id: state.nearestStopId, since: state.stationarySince } : null;
    const key = `${p.routeId}:${p.busName}`;
    const previous = lastSeen.get(key);
    if (previous === undefined || t - previous > 30_000) trackStarts.set(key, t);
    lastSeen.set(key, t);
    let bus: any = { bus_id: p.busId, bus_name: p.busName, route_id: p.routeId, lat: p.lat, lon: p.lon,
      heading: p.heading, last_stop_id: p.lastStopId, stationary: at !== null, seen_at: iso(t),
      ...(at ? { at_stop_id: at.id, at_stop_since: iso(at.since) } : {}),
      ...(state ? { stationary_since: iso(state.stationarySince), last_moved_at: iso(state.lastMovedAt) } : {}) };
    if (hook) bus = await hook.attachContext(bus, t, { fitAt: cutoff, network: fitted.network, contendedNames: plan.contendedNames });
    const stops = payload.routes[String(p.routeId)];
    if (!stops) { missingGeometry++; continue; }
    const ring = ringForBus(bus, stops, payload.stop_coords);
    if (!ring) { missingGeometry++; continue; }
    // Query every feed poll, including display-floor updates. Only score storage is thinned.
    const warmForecasts = computeUpcomingArrivals([...new Set(stops)] as number[], [bus], payload.routes, payload.stop_coords, payload.segments, t, payload.dwells, store);
    if (!score) continue;
    queryCount++;
    const arms: Array<[string, Map<any, any>]> = [["warm", store], ...(cold ? [["cold", new Map()] as [string, Map<any, any>]] : [])];
    // Forecast from the actual client first. Target matching below cannot influence this call.
    for (const [arm, memory] of arms) {
      const forecasts = arm === "warm" ? warmForecasts : computeUpcomingArrivals([...new Set(stops)] as number[], [bus], payload.routes, payload.stop_coords, payload.segments, t, payload.dwells, memory);
      const first = new Map<number, any>();
      for (const forecast of forecasts) if (!first.has(forecast.stopId)) first.set(forecast.stopId, forecast);
      const currentEpisode = (holds.get(key) ?? []).find(e => e.pinnedAt != null && e.departedAt != null && e.pinnedAt <= t && t < e.departedAt && e.outcome === "stopped");
      for (const [sid, forecast] of first) {
        const choices = targets.get(`${key}:${sid}`) ?? [];
        let lo = 0, hi = choices.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (choices[mid]!.arrivedAt <= t) lo = mid + 1; else hi = mid; }
        const target = choices[lo];
        if (!target || target.arrivedAt - t > 1_800_000) continue;
        if (target.trackStartAt == null || t < target.trackStartAt) { censoredTargets++; continue; }
        const leadEpisode = currentEpisode?.id ?? `${key}:moving:${target.trackSegmentId}:${sid}:${target.id}`;
        rows.push({ id: `${key}:${t}:${sid}`, episodeId: leadEpisode, arm, issuedAt: t, day, routeId: p.routeId,
          routePatternId: target.routePatternId, busKey: p.busName, stopId: sid,
          stopIndex: target.stopIndices.length === 1 ? target.stopIndices[0] : -1,
          target: "physical_arrival", targetAt: target.arrivedAt, targetArrivalId: target.id, targetArrivalAt: target.arrivedAt,
          quantileLevels: [0.1, 0.5, 0.9], quantilesSec: [forecast.low, forecast.eta, forecast.high],
          actualSec: (target.arrivedAt - t) / 1000, stopsAhead: forecast.stopsAhead,
          currentStopId: currentEpisode?.stopId ?? null, currentVisitId: currentEpisode?.id ?? null,
          currentStandSec: currentEpisode ? (currentEpisode.departedAt - currentEpisode.pinnedAt) / 1000 : null,
          trackingAgeSec: (t - (trackStarts.get(key) ?? t)) / 1000 });
      }
      const standing = resolveStandingStop(bus, cfg, payload.routes, payload.stop_coords, t, memory);
      if (standing) {
        const shown = hook?.shownStand ? hook.shownStand(bus, ring, payload, standing, t, shownStandSec) : shownStandSec(payload.dwells[cfg.routeIds[0]]?.[standing.stopId], standing.standingSec, payload.dwells[cfg.routeIds[0]], payload.dwells);
        // Preserve every issued stand display independently of future labels.
        // A historically late pin must not erase what an early rider saw.
        unlabelledStandRows.push({ id: `${key}:${t}:${standing.stopId}`, arm, issuedAt: t, routeId: p.routeId,
          stopId: standing.stopId, stopIndex: standing.stopIndex, busKey: p.busName,
          elapsedSec: standing.standingSec, shown });
        if (currentEpisode?.stopId === standing.stopId) standRows.push({ id: `${key}:${t}:${standing.stopId}`, episodeId: currentEpisode.id, arm, issuedAt: t, routeId: p.routeId,
          stopId: standing.stopId, busKey: p.busName, elapsedSec: standing.standingSec, shown,
          actualTotalSec: (currentEpisode.departedAt - currentEpisode.pinnedAt) / 1000 });
      }
    }
  }
  if (rows.length >= 5000 || standRows.length >= 5000 || unlabelledStandRows.length >= 5000) flush();
  if (pollIndex % 2000 === 0) console.error(JSON.stringify({ day, polls: pollIndex, positions: i, rows: rowCount + rows.length, elapsedSec: Math.round((Date.now() - startWall) / 1000) }));
}
flush();
const summary = { source, dataset, day, cutoff, stride, cold, hook: process.env.CONTEXT_HOOK ?? null,
  startedAt: new Date(startWall).toISOString(), sourceHashes, model: hook?.analyticHookManifest ?? null,
  parameters,
  episodeLabels,
  networkPatterns,
  rows: rowCount, standRows: standRowCount, unlabelledStandRows: unlabelledStandRowCount, queryCount, missingGeometry, censoredTargets,
  availability: fitted.availability, elapsedSec: (Date.now() - startWall) / 1000 };
fs.writeFileSync(output.replace(/\.jsonl\.gz$/, ".manifest.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
