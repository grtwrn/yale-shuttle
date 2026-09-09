/** Offline-only instrumentation. No client file is modified. Node >= 22.15 + --import tsx. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

// This pins the actual guards duplicated by classifyLookup below. A source change
// needs a reviewed audit update; it must never quietly turn a no-op into a pass.
export const SUPPORTED_SOURCE_SHA256 = "21e2b56a3d2d101f463b8e24634c708ce210bbf04ade573c5d3a0a79e9b08be1";
const GLOBAL = "__riderSimStandingAudit";
const sha = source => createHash("sha256").update(source).digest("hex");
const count = (out, key) => { out[key] = (out[key] ?? 0) + 1; };

export function classifyLookup(contexts, stopIndex, visitStartMs) {
  const p = contexts?.get(stopIndex)?.prior;
  if (!p) return [contexts == null ? "missing_context_map" : contexts.size ? "no_context_for_occurrence" : "empty_context_map"];
  const reasons = [];
  if (typeof visitStartMs !== "number" || !Number.isFinite(visitStartMs)) reasons.push("invalid_visit_start");
  if (p.previous_departed_at >= visitStartMs) reasons.push("previous_departure_not_before_start");
  if (p.history_available_at > visitStartMs) reasons.push("history_after_start");
  if (p.fitted_at > visitStartMs) reasons.push("fit_after_start");
  if (visitStartMs >= p.valid_until) reasons.push("expired_at_start");
  return reasons;
}

export function instrumentSource(transformed, rawSource) {
  if (sha(rawSource) !== SUPPORTED_SOURCE_SHA256) throw new Error("Standing audit source hash changed; review guards and update the offline audit before scoring");
  const prefix = `globalThis.${GLOBAL}`;
  const replacements = [
    ["function standingForecastsFor(bus,ring,now){", `function standingForecastsFor(bus,ring,now){${prefix}.reading(bus,ring,now);`],
    ["return EMPTY;const out=", `return ${prefix}.readEnd(EMPTY,bus,ring,now,true);const out=`],
    ["out.set(p.stop_index,", `${prefix}.validated(p);out.set(p.stop_index,`],
    ["return out}__name(standingForecastsFor", `return ${prefix}.readEnd(out,bus,ring,now,false)}__name(standingForecastsFor`],
    ["function forecastForStand(contexts,stopIndex,visitStartMs){", `function forecastForStand(contexts,stopIndex,visitStartMs){${prefix}.lookup(contexts,stopIndex,visitStartMs);`],
    ["const phase=atomQuantiles(", `${prefix}.hit();const phase=atomQuantiles(`],
  ];
  for (const [from, to] of replacements) {
    if (transformed.split(from).length !== 2) throw new Error(`Standing audit transform guard failed: ${from}`);
    transformed = transformed.replace(from, to);
  }
  return transformed;
}

export function createAudit() {
  const maps = new WeakMap();
  const payloads = new WeakMap();
  const sampledCells = new Set(), sampledAtStopCells = new Set();
  let pendingHit = null;
  const report = {
    schemaVersion: 1, observationalOnly: true, source: null,
    countingUnit: "function invocations, including repeated cohort/planner calls; not independent buses or visits",
    readCalls: 0, offeredContexts: 0, validatedInsertions: 0, acceptedContexts: 0,
    acceptedByOccurrence: {}, lookupCalls: 0, realLookupHits: 0, expectedLookupHits: 0,
    rejectionReasons: {}, rejectionCombinations: {}, lookupByOccurrence: {}, hitByOccurrence: {},
    samples: {}, firstHits: [], firstAtStopHits: [],
  };
  const hooks = {
    observeBus(bus, now) {
      if (Array.isArray(bus.standing_forecasts)) payloads.set(bus.standing_forecasts, { bus, now });
    },
    reading(bus) {
      report.readCalls++;
      report.offeredContexts += Array.isArray(bus.standing_forecasts) ? bus.standing_forecasts.length : 0;
    },
    validated() { report.validatedInsertions++; },
    readEnd(map, bus, ring, now, sharedEmpty) {
      // EMPTY is shared by the client: this is its most recent reader metadata,
      // rather than a claim that an empty map has a persistent vehicle identity.
      const observed = Array.isArray(bus.standing_forecasts) ? payloads.get(bus.standing_forecasts) : null;
      const payload = observed?.bus ?? bus;
      maps.set(map, { bus: payload.bus_name ?? null, routeId: ring.routeId, now, sharedEmpty,
        payloadObservedAt: observed?.now ?? now,
        payload: Object.fromEntries(["bus_id", "bus_name", "route_id", "at_stop_id", "at_stop_since",
          "stationary_since", "last_moved_at", "lat", "lon"].filter(k => payload[k] !== undefined).map(k => [k, payload[k]])) });
      report.acceptedContexts += map.size;
      for (const { prior: p } of map.values()) count(report.acceptedByOccurrence, `${p.route_id}:${p.stop_id}:${p.stop_index}`);
      return map;
    },
    lookup(contexts, stopIndex, visitStartMs) {
      report.lookupCalls++;
      const meta = contexts && maps.get(contexts);
      const p = contexts?.get(stopIndex)?.prior;
      const occurrence = p ? `${p.route_id}:${p.stop_id}:${stopIndex}` : `${meta?.routeId ?? "unknown"}:unknown:${stopIndex}`;
      count(report.lookupByOccurrence, occurrence);
      const reasons = classifyLookup(contexts, stopIndex, visitStartMs);
      pendingHit = null;
      const sample = () => ({ ...meta, stopIndex, visitStartMs,
        availableIndices: contexts ? [...contexts.keys()] : [],
        context: p ? { stop_id: p.stop_id, phase_weight: p.phase_weight,
          observed_visit_start_at: p.observed_visit_start_at, previous_departed_at: p.previous_departed_at,
          history_available_at: p.history_available_at, fitted_at: p.fitted_at, valid_until: p.valid_until } : null,
        caller: new Error().stack?.split("\n").slice(3, 6).map(line => line.trim()),
      });
      if (!reasons.length) {
        report.expectedLookupHits++;
        const first = !sampledCells.has(occurrence) && report.firstHits.length < 12;
        // Keep one example where the server also reports this stop. Repeated
        // planner calls at the first poll must not crowd later stops out.
        const atStop = meta?.payload?.at_stop_id === p.stop_id
          && !sampledAtStopCells.has(occurrence) && report.firstAtStopHits.length < 12;
        pendingHit = { occurrence, phaseWeight: p.phase_weight, first, atStop, sample: first || atStop ? sample() : null };
      } else {
        for (const reason of reasons) count(report.rejectionReasons, reason);
        const combination = reasons.join("+"); count(report.rejectionCombinations, combination);
        const key = `${occurrence}:${combination}`;
        if (!report.samples[key] && Object.keys(report.samples).length < 100) report.samples[key] = sample();
      }
    },
    hit() {
      if (!pendingHit || !(pendingHit.phaseWeight > 0)) throw new Error("Standing audit positive-weight lookup accounting failed");
      report.realLookupHits++;
      count(report.hitByOccurrence, pendingHit.occurrence);
      if (pendingHit.first) { sampledCells.add(pendingHit.occurrence); report.firstHits.push(pendingHit.sample); }
      if (pendingHit.atStop) { sampledAtStopCells.add(pendingHit.occurrence); report.firstAtStopHits.push(pendingHit.sample); }
      pendingHit = null;
    },
  };
  return { report, hooks };
}

export function activationCheck(report, { expected = false, allowUnused = false, requiredCells = [] } = {}) {
  if (!report.source) return { ok: false, status: "audit_source_not_loaded" };
  if (report.expectedLookupHits !== report.realLookupHits) return { ok: false, status: "audit_accounting_mismatch" };
  const missingCells = requiredCells.filter(cell => !(report.hitByOccurrence[cell] > 0));
  if (missingCells.length) return { ok: false, status: "required_cells_unused", missingCells };
  if (expected && report.realLookupHits === 0) return { ok: allowUnused, status: allowUnused ? "unused_diagnostic_only" : "candidate_unused" };
  return { ok: true, status: expected ? "positive_weight_lookup_observed" : "baseline_or_diagnostic" };
}

export function installStandingAudit(clientRoot, outputPath) {
  if (typeof nodeModule.registerHooks !== "function") throw new Error("Standing audit requires Node >=22.15 and --import tsx");
  if (globalThis[GLOBAL]) throw new Error("Standing audit already installed");
  if (fs.existsSync(outputPath)) throw new Error(`Standing audit output already exists: ${outputPath}`);
  const file = path.join(clientRoot, "web/src/eta/standingForecast.ts");
  const url = pathToFileURL(file).href;
  const rawSource = fs.readFileSync(file);
  if (sha(rawSource) !== SUPPORTED_SOURCE_SHA256) throw new Error("Standing audit unsupported client source hash; refusing to score without verified activation counters");
  const { report, hooks } = createAudit();
  globalThis[GLOBAL] = hooks;
  let flushed = false;
  nodeModule.registerHooks({ load(loadedUrl, context, nextLoad) {
    const result = nextLoad(loadedUrl, context);
    if (loadedUrl !== url) return result;
    if (sha(fs.readFileSync(file)) !== sha(rawSource)) throw new Error("Standing audit client source changed between installation and import");
    const source = instrumentSource(String(result.source), rawSource);
    report.source = { file, sha256: sha(rawSource), transformedSha256: sha(String(result.source)), node: process.version };
    return { ...result, source };
  } });
  const flush = () => {
    report.hitAccountingMatches = report.expectedLookupHits === report.realLookupHits;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    flushed = true;
  };
  process.once("exit", code => {
    if (!flushed) { report.incomplete = true; report.exitCode = code; flush(); }
  });
  return { report, observeBus: hooks.observeBus, finish(options) { report.activation = activationCheck(report, options); flush(); return report.activation; } };
}
