/** Prediction-blind audit of historical labels using the production reducers. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { TransitNetwork } from "../../../src/network/TransitNetwork.js";
import { distanceMeters } from "../../../src/network/geo.js";
import { planTracks, MAX_HANDOFF_JUMP_M, MAX_HANDOFF_SPEED_MPS, type BusObservation, type BusState } from "../../../src/collector/detector.js";
import { closePass, stepManyWithVisits, type StopVisitEvent, type VisitState } from "../../../src/collector/departure.js";
import type { Episode, Position } from "./contract.js";

export const LABEL_REBUILD_RULE = Object.freeze({ version: "production-reducer-label-audit-v1",
  maximumGapMs: 30_000, departureMatchMs: 30_000, pinRadiusM: 75,
  initialRestMs: 14_000, initialRestReleaseM: 150,
  matching: "same bus/route/canonical pattern/occurrence; mutual unique departure within 30 seconds",
  cohort: "all reconstructed visits; original matching is diagnostic only",
  identity: "global duplicate fleet names break and censor every affected track",
  leftCensoring: "initial fix inside event stop's 75m radius without a prior 150m release, pin at track start, or initial >=14s frozen run not yet followed by a 150m departure",
  rightCensoring: "gap, ambiguity, track break, end of capture, or no confirmed departure",
  features: "no forecasts, fitted models, or original visit outcomes enter the reducer" });
const sha = (bytes: string | Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");
const ident = (value: unknown): string => sha(JSON.stringify(value)).slice(0, 24);
const patternId = (route: number, stops: readonly number[]): string => `${route}:${ident([stops])}`;
const cellKey = (v: { busKey: string; routeId: number; routePatternId: string; stopId: number; stopIndex: number }): string =>
  JSON.stringify([v.busKey, v.routeId, v.routePatternId, v.stopId, v.stopIndex]);

export interface RebuiltEpisode extends Omit<Episode, "availabilityKind" | "sourceVisitId"> {
  availabilityKind: "causal_reducer_emission";
  sourceVisitId: null;
  canonicalStopIds: number[];
  trackId: string;
  trackStartAt: number;
  emittedAt: number;
  rawOutcome: string;
  how: string | null;
  confidence: number | null;
  labelStatus: "complete" | "censored";
  leftCensored: boolean;
  initialRestCensored: boolean;
  rightCensored: boolean;
  censorReason: string | null;
}
interface Track {
  id: string; startAt: number; last: BusObservation; initial: BusObservation;
  initialFirstMovedAt: number | null; initialRestConfirmed: boolean; initialRestReleasedAt: number | null;
  initialInsideStops: Map<number, number | null>;
}
export interface RebuildResult { episodes: RebuiltEpisode[]; counts: Record<string, number> }

export function rebuildLabels(network: TransitNetwork, positions: readonly Position[], day: string): RebuildResult {
  const states = new Map<string, BusState>(), visits = new Map<string, VisitState>(), tracks = new Map<string, Track>();
  const output: RebuiltEpisode[] = [];
  const counts: Record<string, number> = { positions: positions.length, tracks: 0, gapBreaks: 0,
    routeBreaks: 0, identityBreaks: 0, ambiguousPollRows: 0, missingGeometry: 0, nonmonotonicRows: 0, completed: 0, censored: 0 };
  function emit(event: StopVisitEvent, track: Track, now: number, forcedReason: string | null = null): void {
    const route = network.routes.get(event.routeId), sequence = route?.stops ?? [];
    const resolved = sequence[event.stopIndex] === event.stopId;
    const insideRelease = track.initialInsideStops.get(event.stopId);
    const left = event.pinnedAt != null && (event.pinnedAt <= track.startAt ||
      (insideRelease !== undefined && (insideRelease === null || event.pinnedAt < insideRelease)));
    const initialRestCensored = track.initialRestConfirmed && event.pinnedAt != null &&
      (track.initialRestReleasedAt == null || event.pinnedAt < track.initialRestReleasedAt);
    const right = forcedReason != null || event.how === "gap" || event.departedAt == null;
    const validDuration = event.pinnedAt != null && event.departedAt != null && event.departedAt >= event.pinnedAt;
    const complete = resolved && !left && !initialRestCensored && !right && validDuration;
    const id = ident([day, event.busName, event.routeId, sequence, event.stopIndex, event.anchoredAt, event.pinnedAt, event.departedAt, track.id]);
    const reason = forcedReason ?? (!resolved ? "unresolved_pattern" : left ? "initial_inside_pin" :
      initialRestCensored ? "initial_rest" : event.how === "gap" ? "unconfirmed_gap_departure" :
      event.departedAt == null ? "no_departure" : !validDuration ? "no_pinned_duration" : null);
    const nextIndex = sequence.length ? (event.stopIndex + 1) % sequence.length : null;
    output.push({ id, routeId: event.routeId, routePatternId: patternId(event.routeId, sequence),
      stopId: event.stopId, stopIndex: event.stopIndex, busKey: event.busName, busId: event.busId,
      day, split: day === "2026-09-03" ? "train" : day === "2026-09-04" ? "validation" : day === "2026-09-08" ? "regression" : "reserved_confirmation",
      patternResolved: resolved, anchoredAt: event.anchoredAt, pinnedAt: event.pinnedAt,
      arrivedAt: event.arrivedAt, departedAt: event.departedAt,
      outcome: complete ? event.outcome : "unresolved", rawOutcome: event.outcome,
      knownAt: now, availabilityKind: "causal_reducer_emission", observedBy: now,
      nextStopId: nextIndex == null ? null : sequence[nextIndex] ?? null, nextStopIndex: nextIndex,
      nextPhysicalArrivalAt: null, nextPhysicalArrivalKnownAt: null, nextPhysicalArrivalId: null,
      targetCensoring: event.departedAt == null ? "no_departure" : "no_observed_crossing", sourceVisitId: null,
      canonicalStopIds: [...sequence], trackId: track.id, trackStartAt: track.startAt, emittedAt: now,
      how: event.how, confidence: event.confidence, labelStatus: complete ? "complete" : "censored",
      leftCensored: left, initialRestCensored, rightCensored: right, censorReason: reason });
    counts[complete ? "completed" : "censored"]!++;
  }
  function close(name: string, reason: string, now: number): void {
    const previous = visits.get(name), track = tracks.get(name);
    if (previous && track) for (const event of closePass(previous, track.last.collectedAt).events)
      if (event.kind === "visit") emit(event, track, now, reason);
    visits.delete(name); states.delete(name); tracks.delete(name);
  }
  let i = 0;
  while (i < positions.length) {
    const t = positions[i]!.collected_at;
    const poll: BusObservation[] = [];
    while (i < positions.length && positions[i]!.collected_at === t) {
      const p = positions[i++]!;
      poll.push({ busId: p.bus_id, busName: p.bus_name, routeId: p.route_id, lat: p.lat, lon: p.lon,
        heading: p.heading ?? 0, lastStopId: p.last_stop_id, collectedAt: t });
    }
    const plan = planTracks(poll);
    for (const name of plan.contendedNames) close(name, "ambiguous_identity", t);
    for (const obs of poll) {
      if (plan.contendedNames.has(obs.busName)) { counts.ambiguousPollRows!++; continue; }
      let track = tracks.get(obs.busName);
      if (track && t <= track.last.collectedAt) { counts.nonmonotonicRows!++; continue; }
      if (track && t - track.last.collectedAt > LABEL_REBUILD_RULE.maximumGapMs) {
        close(obs.busName, "observation_gap", t); counts.gapBreaks!++; track = undefined;
      } else if (track && track.last.routeId !== obs.routeId) {
        close(obs.busName, "route_change", t); counts.routeBreaks!++; track = undefined;
      } else if (track && track.last.busId !== obs.busId) {
        const jump = distanceMeters(track.last, obs), seconds = (t - track.last.collectedAt) / 1000;
        if (jump > MAX_HANDOFF_JUMP_M && jump > seconds * MAX_HANDOFF_SPEED_MPS) {
          close(obs.busName, "discontinuous_identity_handoff", t); counts.identityBreaks!++; track = undefined;
        }
      }
      if (!network.routes.has(obs.routeId)) { counts.missingGeometry!++; continue; }
      if (!track) {
        track = { id: ident([day, obs.busName, obs.routeId, obs.busId, t]), startAt: t, last: obs, initial: obs,
          initialFirstMovedAt: null, initialRestConfirmed: false, initialRestReleasedAt: null,
          initialInsideStops: new Map(network.routes.get(obs.routeId)!.stops
            .filter(id => { const stop = network.stops.get(id); return stop && distanceMeters(obs, stop) <= LABEL_REBUILD_RULE.pinRadiusM; })
            .map(id => [id, null])) };
        tracks.set(obs.busName, track); counts.tracks!++;
      } else {
        if (track.initialFirstMovedAt == null && (obs.lat !== track.initial.lat || obs.lon !== track.initial.lon)) track.initialFirstMovedAt = t;
        if (track.initialFirstMovedAt == null && t - track.startAt >= LABEL_REBUILD_RULE.initialRestMs) track.initialRestConfirmed = true;
        if (track.initialRestReleasedAt == null && distanceMeters(obs, track.initial) >= LABEL_REBUILD_RULE.initialRestReleaseM) track.initialRestReleasedAt = t;
        for (const [id, released] of track.initialInsideStops) {
          const stop = network.stops.get(id);
          if (released === null && stop && distanceMeters(obs, stop) >= LABEL_REBUILD_RULE.initialRestReleaseM) track.initialInsideStops.set(id, t);
        }
      }
      const result = stepManyWithVisits(network, states, visits, [obs]);
      for (const event of result.visits) if (event.kind === "visit") emit(event, track, t);
      track.last = obs;
    }
  }
  for (const [name, track] of tracks) close(name, "end_of_capture", track.last.collectedAt);
  output.sort((a, b) => a.anchoredAt - b.anchoredAt || a.id.localeCompare(b.id));
  return { episodes: output, counts };
}

export interface LabelMatch {
  originalEpisodeId: string;
  status: "matched" | "unmatched" | "ambiguous" | "unresolved_original";
  reconstructedEpisodeId: string | null;
  candidateIds: string[];
  departureDifferenceSec: number | null;
  pinnedDifferenceSec: number | null;
}
export function matchLabels(original: readonly Episode[], rebuilt: readonly RebuiltEpisode[]): LabelMatch[] {
  const groups = new Map<string, RebuiltEpisode[]>();
  for (const row of rebuilt) if (row.labelStatus === "complete" && row.departedAt != null) {
    const key = cellKey(row), group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const candidates = new Map<string, RebuiltEpisode[]>(), reverse = new Map<string, number>();
  for (const row of original) {
    const choices = row.patternResolved && row.departedAt != null ? (groups.get(cellKey(row)) ?? [])
      .filter(r => Math.abs(r.departedAt! - row.departedAt!) <= LABEL_REBUILD_RULE.departureMatchMs) : [];
    candidates.set(row.id, choices);
    for (const candidate of choices) reverse.set(candidate.id, (reverse.get(candidate.id) ?? 0) + 1);
  }
  return original.map(row => {
    const choices = candidates.get(row.id) ?? [], match = choices.length === 1 && reverse.get(choices[0]!.id) === 1 ? choices[0]! : null;
    return { originalEpisodeId: row.id,
      status: !row.patternResolved || row.departedAt == null ? "unresolved_original" : match ? "matched" : choices.length ? "ambiguous" : "unmatched",
      reconstructedEpisodeId: match?.id ?? null, candidateIds: choices.map(c => c.id),
      departureDifferenceSec: match ? (match.departedAt! - row.departedAt!) / 1000 : null,
      pinnedDifferenceSec: match && row.pinnedAt != null ? (match.pinnedAt! - row.pinnedAt) / 1000 : null };
  });
}

function readJsonl<T>(file: string): T[] {
  return zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function writeJsonl(file: string, rows: readonly unknown[]): void {
  fs.writeFileSync(file, zlib.gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"), { flag: "wx" });
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { dataset: { type: "string" }, out: { type: "string" },
    days: { type: "string" }, "network-db": { type: "string" } } });
  const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataset = path.resolve(values.dataset ?? path.join(service, "scripts/.eta-replay/overnight-2026-09-08/dataset-v2"));
  const out = path.resolve(values.out ?? path.join(service, "scripts/.eta-replay/overnight-2026-09-08/label-rebuild-v1"));
  const days = (values.days ?? "2026-09-04").split(",");
  const topologyFile = path.join(dataset, "topology.json"), topology = JSON.parse(fs.readFileSync(topologyFile, "utf8"));
  const networkSource = values["network-db"] ? path.resolve(values["network-db"]) : topologyFile;
  let network: TransitNetwork;
  if (values["network-db"]) {
    const db = new Database(networkSource, { readonly: true, fileMustExist: true });
    try {
      const stops = db.prepare("SELECT id,name,lat,lon FROM stops").all() as any[];
      const routes = (db.prepare("SELECT id,name,short_name,color,stops_json,path_json FROM routes").all() as any[])
        .map(r => ({ id: r.id, name: r.name, shortName: r.short_name, color: r.color,
          stops: JSON.parse(r.stops_json), ...(r.path_json ? { path: JSON.parse(r.path_json) } : {}) }));
      network = TransitNetwork.build(stops, routes);
    } finally { db.close(); }
  } else network = TransitNetwork.build(topology.stops, topology.routes.map((r: any) => ({ ...r, shortName: r.name, color: "#000000" })));
  const sourceFiles = ["scripts/eta-replay/general-eval/rebuild-labels.ts", "src/collector/detector.ts", "src/collector/departure.ts",
    "src/network/TransitNetwork.ts", "src/network/geo.ts", "src/network/alignStops.ts", "src/network/legs.ts",
    "package-lock.json", "node_modules/kdbush/index.js"];
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(service, file)))]));
  const networkPatterns = [...network.routes.values()].map(r => ({ routeId: r.id, stopIds: [...r.stops], patternId: patternId(r.id, r.stops) }));
  fs.mkdirSync(out, { recursive: true });
  const lock = { frozenAt: new Date().toISOString(), rule: LABEL_REBUILD_RULE, sourceHashes,
    topologyFile, topologySha256: sha(fs.readFileSync(topologyFile)), networkSource,
    networkSourceSha256: sha(fs.readFileSync(networkSource)), networkPatterns,
    inputFiles: days.flatMap(day => ["positions", "episodes"].map(name => {
      const file = path.join(dataset, day, `${name}.jsonl.gz`); return { file, sha256: sha(fs.readFileSync(file)) };
    })), modelInputsRead: false, predictionInputsRead: false };
  const lockFile = path.join(out, `lock-${days.join("_")}.json`);
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n", { flag: "wx" });
  for (const day of days) {
    const started = Date.now(), directory = path.join(out, day);
    if (fs.existsSync(directory)) throw new Error(`Refusing to overwrite ${directory}`);
    const positions = readJsonl<Position>(path.join(dataset, day, "positions.jsonl.gz"));
    const original = readJsonl<Episode>(path.join(dataset, day, "episodes.jsonl.gz"));
    const rebuilt = rebuildLabels(network, positions, day), matches = matchLabels(original, rebuilt.episodes);
    const matchedIds = new Set(matches.flatMap(m => m.reconstructedEpisodeId ? [m.reconstructedEpisodeId] : []));
    const byRoute: Record<number, Record<string, number>> = {};
    for (const row of rebuilt.episodes) {
      const tally = byRoute[row.routeId] ??= { complete: 0, censored: 0, completeUnmatchedOriginal: 0 };
      tally[row.labelStatus]!++;
      if (row.labelStatus === "complete" && !matchedIds.has(row.id)) tally.completeUnmatchedOriginal!++;
    }
    const summary = { ...rebuilt.counts, originalEpisodes: original.length,
      matches: Object.fromEntries(["matched", "unmatched", "ambiguous", "unresolved_original"].map(s => [s, matches.filter(m => m.status === s).length])),
      shiftedPinsOver30s: matches.filter(m => m.pinnedDifferenceSec != null && Math.abs(m.pinnedDifferenceSec) > 30).length,
      earlierPinsOver120s: matches.filter(m => m.pinnedDifferenceSec != null && m.pinnedDifferenceSec < -120).length,
      byRoute, elapsedMs: Date.now() - started };
    fs.mkdirSync(directory);
    writeJsonl(path.join(directory, "episodes.jsonl.gz"), rebuilt.episodes);
    writeJsonl(path.join(directory, "matches.jsonl.gz"), matches);
    fs.writeFileSync(path.join(directory, "audit.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
    const manifest = { day, createdAt: new Date().toISOString(), lockFile, lockSha256: sha(fs.readFileSync(lockFile)),
      sourceHashes, topologySha256: lock.topologySha256, networkSource, networkSourceSha256: lock.networkSourceSha256,
      inputs: lock.inputFiles.filter(f => f.file.includes(`/${day}/`)),
      outputs: ["episodes.jsonl.gz", "matches.jsonl.gz", "audit.json"].map(name => ({ name, sha256: sha(fs.readFileSync(path.join(directory, name))) })),
      originalDatasetUnchanged: true, originalModelHistoryUnchanged: true, ...summary };
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ day, out: directory, ...summary }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
