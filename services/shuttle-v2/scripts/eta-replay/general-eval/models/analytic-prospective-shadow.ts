/** Prospective query log: forecasts are written now; outcomes are joined later. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { AnalyticRuntime } from "./analytic-runtime.js";
import type { AnalyticEpisode, AnalyticFit } from "./analytic.js";

const service = path.resolve(import.meta.dirname, "../../../..");
const source = process.env.SOURCE_ROOT ?? service;
const artifacts = path.join(service, "scripts/.eta-replay/overnight-2026-09-08");
const captureRoot = process.env.PROSPECTIVE_CAPTURE_DIR ?? path.join(artifacts, "prospective");
const out = process.env.SHADOW_OUT ?? path.join(captureRoot, "shadow");
const endpoint = process.env.SHADOW_ENDPOINT ?? "https://yale-shuttle.fly.dev/api/buses";
const interval = Number(process.env.SHADOW_INTERVAL_MS ?? 5000);
const until = Date.parse(process.env.SHADOW_UNTIL ?? "2026-09-09T14:00:00Z");
const operationalFile = process.env.SHADOW_OPERATIONAL_ARM ?? path.join(out, "operational-arm.json");
const sha = (x: string | Buffer): string => crypto.createHash("sha256").update(x).digest("hex");
fs.mkdirSync(path.join(out, "tables"), { recursive: true });
const lock = path.join(out, "writer.lock");
try { fs.mkdirSync(lock); } catch { throw new Error(`Another shadow writer may own ${lock}`); }
fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
process.on("exit", () => fs.rmSync(lock, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(0)); process.on("SIGTERM", () => process.exit(0));
const { computeUpcomingArrivals, shownStandSec } = await import(`${source}/web/src/arrivals.ts`);
const { registerRoutePaths } = await import(`${source}/web/src/anchor.ts`);
const { ringForBus } = await import(`${source}/web/src/eta/index.ts`);
const { resolveStandingStop } = await import(`${source}/web/src/liveAnchor.ts`);
const { standingForecastsFor } = await import(`${source}/web/src/eta/standingForecast.ts`);
const { ROUTE_LISTS } = await import(`${source}/web/src/routes.ts`);
const { applyModelParams } = await import(`${source}/web/src/eta/params.ts`);
const configs = new Map<number, any>();
for (const cfg of ROUTE_LISTS) for (const id of cfg.busRouteIds) configs.set(id, cfg);
const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (t: number): string => etDate.format(t);
const parseClock = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(t) ? t : null;
};
const append = (file: string, rows: any[]): void => {
  if (rows.length) fs.appendFileSync(path.join(out, file), zlib.gzipSync(rows.map(r => JSON.stringify(r)).join("\n") + "\n"));
};
type Arm = { id: string; policy: string; fit: AnalyticFit | null; modelSha: string | null; runtime: AnalyticRuntime | null; store: Map<any, any>; served: boolean };
const arms: Arm[] = [
  { id: "baseline-production-live", policy: "captured production tables; supplied contexts removed", fit: null, modelSha: null, runtime: null, store: new Map(), served: false },
  { id: "actual-served-context", policy: "exact supplied standing_forecasts retained; no locally reconstructed history", fit: null, modelSha: null, runtime: null, store: new Map(), served: true },
];
function addArm(file: string, label: string, policy: string): void {
  const bytes = fs.readFileSync(file), parsed = JSON.parse(bytes.toString()), fit: AnalyticFit = parsed.fit ?? parsed;
  if (fit.version !== "analytic-phase-stack-v2" || fit.options.weightObjective !== "remaining") throw new Error("Wrong prospective fit family");
  const modelSha = sha(bytes), id = `${label}:${modelSha.slice(0, 12)}`;
  if (arms.some(a => a.id === id)) return;
  arms.push({ id, policy, fit, modelSha, runtime: new AnalyticRuntime(fit), store: new Map(), served: false });
  fs.appendFileSync(path.join(out, "arm-registry.jsonl"), JSON.stringify({ registeredAt: Date.now(), id, policy, modelSha,
    fitAt: fit.fittedAt, file, sourceManifest: "writer-manifest.json", fitProvenance: parsed.fit ? Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== "fit")) : null }) + "\n");
}
addArm(path.join(artifacts, "analytic/reserved-confirmation/fit.json"), "analytic-frozen-sep3-4", "selected fit held fixed; model age explicit");
const sourceFiles = ["arrivals.ts", "eta/index.ts", "eta/arrival.ts", "eta/filter.ts", "eta/standingForecast.ts", "eta/standingDistribution.ts"];
const manifest = { startedAt: Date.now(), pid: process.pid, endpoint, intervalMs: interval, until,
  storedEveryPolls: 6, standingFirstObservationStoredImmediately: true, outcomeFields: false,
  sourceFiles: Object.fromEntries(sourceFiles.map(f => [f, sha(fs.readFileSync(path.join(source, "web/src", f)))])),
  modelSourceFiles: Object.fromEntries(["analytic.ts", "analytic-distribution.ts", "analytic-runtime.ts"].map(f => [f, sha(fs.readFileSync(path.join(import.meta.dirname, f)))])),
  writerSha: sha(fs.readFileSync(new URL(import.meta.url))), fitPolicy: "fixed selected fit; separately registered operational arms only",
  historyPolicy: "first observedBy of each completed row version in already captured archives; never earlier inferred availability" };
fs.writeFileSync(path.join(out, "writer-manifest.json"), JSON.stringify(manifest, null, 2));

const seenCaptures = new Set<string>(), rawHistory = new Map<string, { raw: any; knownAt: number; fingerprint: string }>();
let historyVersion = 0;
function ingestCapturedHistory(): void {
  for (const name of fs.readdirSync(captureRoot).filter(n => /^\d{4}-\d\d-\d\dT/.test(n)).sort()) {
    if (seenCaptures.has(name)) continue;
    const dir = path.join(captureRoot, name), file = path.join(dir, "manifest.json");
    if (!fs.existsSync(file)) continue;
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const item of meta.files ?? []) if (item.file.endsWith("-stop_visits.jsonl.gz")) {
      const rows = zlib.gunzipSync(fs.readFileSync(path.join(dir, item.file))).toString().trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
      for (const raw of rows) {
        const key = `${raw.route_id}:${raw.bus_name}:${raw.stop_index}:${raw.anchored_at}`;
        const fingerprint = sha(JSON.stringify(raw)), previous = rawHistory.get(key);
        if (!previous || previous.fingerprint !== fingerprint) rawHistory.set(key, { raw, fingerprint, knownAt: item.observedBy });
      }
    }
    seenCaptures.add(name); historyVersion++;
  }
}

let historyModelVersion = "", cachedHistory: AnalyticEpisode[] = [];
function historyFor(patterns: Map<number, { id: string; stops: number[] }>): AnalyticEpisode[] {
  const version = `${historyVersion}:${JSON.stringify([...patterns].map(([id, p]) => [id, p.id]))}`;
  if (version === historyModelVersion) return cachedHistory;
  const disputed = new Set<string>();
  for (const { raw } of rawHistory.values()) if (patterns.get(raw.route_id)?.stops[raw.stop_index] !== raw.stop_id)
    disputed.add(`${dayOf(raw.anchored_at)}:${raw.route_id}`);
  cachedHistory = [...rawHistory].flatMap(([id, { raw, knownAt }]) => {
    const pattern = patterns.get(raw.route_id), day = dayOf(raw.anchored_at);
    if (!pattern || disputed.has(`${day}:${raw.route_id}`)) return [];
    return [{ id, routeId: raw.route_id, routePatternId: pattern.id, stopId: raw.stop_id, stopIndex: raw.stop_index,
      busKey: raw.bus_name, day, anchoredAt: raw.anchored_at, pinnedAt: raw.pinned_at ?? null,
      departedAt: raw.departed_at ?? null, knownAt, outcome: raw.outcome, patternResolved: true }];
  });
  historyModelVersion = version;
  return cachedHistory;
}

let polls = 0, records = 0, failures = 0, lastTables = "";
const lastBusFix = new Map<string, number>(), firstStands = new Set<string>();
async function poll(): Promise<void> {
  const started = Date.now();
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Public buses HTTP ${response.status}`);
  const payload = await response.json() as any, t = Date.now(), day = dayOf(t);
  registerRoutePaths(payload.route_paths); if (payload.model_params) applyModelParams(payload.model_params);
  const { buses, ...tables } = payload, tableBytes = JSON.stringify(tables), tableSha = sha(tableBytes);
  if (tableSha !== lastTables) {
    const file = path.join(out, "tables", `${tableSha}.json.gz`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, zlib.gzipSync(tableBytes));
    lastTables = tableSha;
  }
  append("inputs.jsonl.gz", [{ observedAt: t, tableSha, buses }]);
  ingestCapturedHistory();
  if (fs.existsSync(operationalFile)) {
    const extra = JSON.parse(fs.readFileSync(operationalFile, "utf8"));
    addArm(extra.fitPath, extra.id ?? "analytic-operational", extra.policy ?? "daily prior-two-completed-service-days refit");
  }
  const patterns = new Map<number, { id: string; stops: number[] }>();
  for (const [id, seq] of Object.entries(payload.routes)) {
    const ring = ringForBus({ route_id: id }, seq, payload.stop_coords);
    if (ring) patterns.set(Number(id), { id: `${id}:${sha(JSON.stringify([ring.stops])).slice(0, 24)}`, stops: ring.stops });
  }
  const history = historyFor(patterns);
  for (const arm of arms) arm.runtime?.replaceCompletedHistory(history, historyModelVersion);
  const counts = new Map<string, number>();
  for (const bus of buses) counts.set(bus.bus_name, (counts.get(bus.bus_name) ?? 0) + 1);
  const forecasts: any[] = [], stands: any[] = [];
  let freshBuses = 0, contexts = 0;
  for (const rawBus of buses) {
    const key = `${rawBus.route_id}:${rawBus.bus_name}`, fixAt = parseClock(rawBus.seen_at);
    if (fixAt == null || t - fixAt > 30_000 || fixAt > t + 5000 || counts.get(rawBus.bus_name)! > 1) continue;
    if ((lastBusFix.get(key) ?? 0) >= fixAt) continue;
    lastBusFix.set(key, fixAt); freshBuses++;
    const seq = payload.routes[String(rawBus.route_id)], pattern = patterns.get(Number(rawBus.route_id)), cfg = configs.get(Number(rawBus.route_id));
    if (!seq || !pattern || !cfg) continue;
    const observedStart = Math.min(t, ...[parseClock(rawBus.at_stop_since), parseClock(rawBus.stationary_since)].filter((v): v is number => v != null));
    // This one-day prospective run ends before the EDT date changes.
    const expiry = Date.parse(`${day}T04:00:00Z`) + 86_400_000;
    for (const arm of arms) {
      const bus = { ...rawBus }; if (!arm.served) delete bus.standing_forecasts; delete bus.terminal_departure;
      if (arm.runtime) {
        bus.standing_forecasts = pattern.stops.flatMap((stopId, stopIndex) => {
          const c = arm.runtime!.context({ routeId: Number(bus.route_id), routePatternId: pattern.id, stopId, stopIndex,
            busKey: bus.bus_name, day, observedVisitStartMs: observedStart, issuedAtMs: t,
            patternResolved: true, canonicalStopIds: pattern.stops, validUntilMs: expiry });
          return c ? [c] : [];
        });
        contexts += bus.standing_forecasts.length;
      }
      const predictions = computeUpcomingArrivals([...new Set(seq)], [bus], payload.routes, payload.stop_coords,
        payload.segments, t, payload.dwells, arm.store);
      const ring = ringForBus(bus, seq, payload.stop_coords);
      const servedContexts = arm.served && Array.isArray(bus.standing_forecasts) ? bus.standing_forecasts : [];
      const servedFitAt = servedContexts.length && servedContexts.every((c: any) => c.fitted_at === servedContexts[0].fitted_at) ? servedContexts[0].fitted_at : null;
      const modelFitAt = arm.fit?.fittedAt ?? servedFitAt;
      const common = { recordedAt: Date.now(), issuedAt: t, fixAt, day, arm: arm.id,
        modelSha: arm.modelSha, servedContextSha: arm.served ? sha(JSON.stringify(servedContexts)) : null,
        modelFitAt, modelAgeSec: modelFitAt != null ? (t - modelFitAt) / 1000 : null,
        tableSha, routeId: Number(bus.route_id), routePatternId: pattern.id, busKey: bus.bus_name, busId: bus.bus_id };
      if (polls % 6 === 0) for (const p of predictions) if (p.stopsAhead >= 1 && p.stopsAhead <= 5)
        forecasts.push({ ...common, id: `${arm.id}:${key}:${t}:${p.stopId}:${p.stopsAhead}`, target: "future_stop",
          stopId: p.stopId, stopsAhead: p.stopsAhead, intervalKind: "published_conformal_bounds", quantileLevels: [.1, .5, .9], quantilesSec: [p.low, p.eta, p.high] });
      const standing = resolveStandingStop(bus, cfg, payload.routes, payload.stop_coords, t, arm.store);
      if (standing && ring) {
        const standStart = t - standing.standingSec * 1000, standKey = `${arm.id}:${key}:${standing.stopId}:${Math.round(standStart)}`;
        const first = !firstStands.has(standKey); firstStands.add(standKey);
        if (first || polls % 6 === 0) {
          const routeDwells = payload.dwells[cfg.routeIds[0]] ?? {};
          const shown = shownStandSec(routeDwells[standing.stopId], standing.standingSec, routeDwells, payload.dwells,
            { forecasts: standingForecastsFor(bus, ring, t), stopId: standing.stopId, stopIndex: standing.stopIndex, now: t });
          stands.push({ ...common, id: `${arm.id}:${key}:${t}:${standing.stopId}`, stopId: standing.stopId, stopIndex: standing.stopIndex,
            firstObserved: first, observedVisitStartMs: standStart, elapsedSec: standing.standingSec, shown,
            contextCount: bus.standing_forecasts?.length ?? 0 });
        }
      }
    }
  }
  append("forecasts.jsonl.gz", forecasts); append("stands.jsonl.gz", stands);
  records += forecasts.length + stands.length; polls++;
  const status = { at: Date.now(), pid: process.pid, polls, records, failures, freshBuses, contexts,
    historyRows: history.length, arms: arms.map(a => a.id), pollMs: Date.now() - started, until };
  fs.writeFileSync(path.join(out, "status.json"), JSON.stringify(status, null, 2));
  if (polls % 12 === 1) console.log(JSON.stringify(status));
}

while (Date.now() < until) {
  const start = Date.now();
  try { await poll(); } catch (e) { failures++; fs.appendFileSync(path.join(out, "errors.jsonl"), JSON.stringify({ at: Date.now(), error: String(e) }) + "\n"); console.error(String(e)); }
  if (process.argv.includes("--once")) break;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(interval - (Date.now() - start), until - Date.now()))));
}
