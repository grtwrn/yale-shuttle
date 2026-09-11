/** Export saved evidence only: no fitting, inference, database writes, or network. */
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { STOP_STUDY_MAX_BYTES, validateStopStudy, type StopStudy, type StopStudyVisit,
  type StopStudyPrediction } from "../../src/schema/stop-study.js";

const DayInput = z.object({
  episodes: z.string(), recordedEpisodes: z.string().optional(), matches: z.string().optional(),
  baselineStands: z.string(), candidateStands: z.string(),
  baselineEtas: z.string().optional(), candidateEtas: z.string().optional(),
  positions: z.string().optional(), manifests: z.array(z.string()).default([]),
}).strict().refine(d => Boolean(d.baselineEtas) === Boolean(d.candidateEtas), "Supply both ETA arms");
const Config = z.object({
  title: z.string().max(500), topology: z.string().optional(), days: z.array(DayInput).min(1).max(366),
  forecastIntervalSec: z.number().finite().nonnegative().default(30),
  positionIntervalSec: z.number().finite().nonnegative().default(5),
  modelLabels: z.object({ baseline: z.string().max(500), candidate: z.string().max(500) }).strict().optional(),
  context: z.object({ cohort: z.string().max(500), training: z.string().max(500), comparison: z.string().max(500) }).strict().optional(),
  arrivalTargetStopId: z.number().int().nonnegative().optional(),
}).strict();
type Row = Record<string, any>;

async function* rows(path: string): AsyncGenerator<Row> {
  const stream = createReadStream(path), input = path.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (line.length > 1_000_000) throw new Error(`Oversized row in ${basename(path)}:${lineNo}`);
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid row in ${basename(path)}:${lineNo}`);
      yield value as Row;
    }
  } finally { lines.close(); input.destroy(); stream.destroy(); }
}
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nullableTime(value: unknown): number | null { return finite(value) ? value : null; }
function unique<T>(map: Map<string, T>, key: string, value: T, label: string): void {
  if (map.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
  map.set(key, value);
}
function queryKey(row: Row): string { return `${row.episodeId}:${row.issuedAt}`; }
function increment(counts: Record<string, number>, key: string, amount = 1): void { counts[key] = (counts[key] ?? 0) + amount; }

export async function exportStudy(configPath: string, generatedAt = Date.now()): Promise<StopStudy> {
  const config = Config.parse(JSON.parse(await readFile(configPath, "utf8")));
  const pathFor = (name: string) => resolve(dirname(configPath), name);
  const inputs: StopStudy["provenance"]["inputs"] = [];
  const counts: Record<string, number> = {}, sourceHashes: Record<string, string> = {};
  const warnings = [
    "Saved forecasts are replay evidence, not a live prediction service.",
    "Standing rows are the saved associated-display subset; absence is not a zero wait or proof of no display.",
    "Recorded pins are shown only for uniquely matched original episodes. Unresolved matches remain missing.",
    `Downstream ETA uses paired ${config.arrivalTargetStopId === undefined ? "next-served physical arrivals" : `physical arrivals at selected stop ${config.arrivalTargetStopId}`} linked by explicit currentVisitId; interval bounds are saved display bounds, not a full distribution.`,
  ];
  const readInput = async (role: string, name: string) => {
    const path = pathFor(name); inputs.push({ role, name: basename(path), sha256: await sha256(path) }); return path;
  };
  await readInput("export_config", configPath);
  let topology: Row = {};
  if (config.topology) topology = JSON.parse(await readFile(await readInput("names_and_coordinates", config.topology), "utf8"));
  const routeNames = new Map<number, Row>((topology.routes ?? []).map((r: Row) => [r.id, r]));
  const stopNames = new Map<number, Row>((topology.stops ?? []).map((s: Row) => [s.id, s]));
  const visits = new Map<string, StopStudyVisit>();
  const positionTracks = new Map<string, NonNullable<StopStudy["positionTracks"]>[number]>();
  const pendingPositions = new Map<string, NonNullable<StopStudyVisit["positions"]>[number]>();

  for (const input of config.days) {
    const dayVisits = new Map<string, StopStudyVisit>(), recorded = new Map<string, Row>();
    if (input.recordedEpisodes) for await (const row of rows(await readInput("recorded_episodes", input.recordedEpisodes)))
      unique(recorded, String(row.id), row, "recorded episode");
    const originalByRebuilt = new Map<string, Row>();
    if (input.matches) for await (const row of rows(await readInput("episode_matches", input.matches))) {
      increment(counts, `originalMatches_${row.status}`);
      if (row.status !== "matched" || !row.reconstructedEpisodeId) continue;
      const original = recorded.get(row.originalEpisodeId);
      if (!original) { increment(counts, "matchedOriginalMissing"); continue; }
      unique(originalByRebuilt, row.reconstructedEpisodeId, original, "reconstructed-to-original match");
    }
    for await (const row of rows(await readInput("reconstructed_episodes", input.episodes))) {
      const original = originalByRebuilt.get(row.id), complete = row.labelStatus === "complete";
      const pin = nullableTime(row.pinnedAt), departure = nullableTime(row.departedAt);
      const actual = complete && !row.leftCensored && !row.rightCensored && pin !== null && departure !== null && departure >= pin && row.outcome === "stopped"
        ? (departure - pin) / 1000 : null;
      const qualityNotes: string[] = [];
      if (!complete) qualityNotes.push(`Censored: ${row.censorReason ?? "unspecified"}`);
      if (!original) qualityNotes.push("No unique recorded-visit match");
      if (!row.patternResolved) qualityNotes.push("Unresolved route occurrence");
      if (row.leftCensored) qualityNotes.push("Start of stand was not fully observed");
      if (original && (original.routeId !== row.routeId || original.stopId !== row.stopId || original.stopIndex !== row.stopIndex || original.busKey !== row.busKey))
        throw new Error(`Original match identity differs for ${row.id}`);
      const visit: StopStudyVisit = {
        id: row.id, day: row.day, routeId: row.routeId, routePatternId: row.routePatternId,
        stopId: row.stopId, stopIndex: row.stopIndex, busId: row.busId, busKey: row.busKey, busName: row.busKey,
        anchoredAt: row.anchoredAt, pinnedAt: pin, recordedPinnedAt: nullableTime(original?.pinnedAt),
        arrivedAt: nullableTime(row.arrivedAt), departedAt: departure,
        recordedStandSec: original && finite(original.arrivedAt) && finite(original.departedAt) && original.departedAt >= original.arrivedAt
          ? (original.departedAt - original.arrivedAt) / 1000 : null,
        pinnedStandSec: actual, outcome: row.outcome, how: row.how ?? null, confidence: row.confidence ?? null,
        qualityNotes, previousDepartureAt: null, loopSec: null,
        labelStatus: complete ? "complete" : "censored", leftCensored: Boolean(row.leftCensored), rightCensored: Boolean(row.rightCensored),
        originalEpisodeId: original?.id ?? null, predictions: [],
      };
      unique(visits, visit.id, visit, "reconstructed episode"); dayVisits.set(visit.id, visit);
      increment(counts, complete ? "completeVisits" : "censoredVisits");
    }

    const display = { baseline: new Map<string, Row>(), candidate: new Map<string, Row>() };
    const first = { baseline: new Map<string, number>(), candidate: new Map<string, number>() };
    for (const arm of ["baseline", "candidate"] as const) {
      const path = await readInput(`${arm}_standing_forecasts`, arm === "baseline" ? input.baselineStands : input.candidateStands);
      for await (const row of rows(path)) {
        increment(counts, `${arm}DisplayRows`);
        const visit = dayVisits.get(row.episodeId);
        if (!visit) { increment(counts, `${arm}DisplayMissingVisit`); continue; }
        if (row.routeId !== visit.routeId || row.stopId !== visit.stopId || row.busKey !== visit.busKey || !finite(row.issuedAt) || !finite(row.elapsedSec))
          throw new Error(`Display identity/clock differs for ${row.id}`);
        unique(display[arm], queryKey(row), row, `${arm} display query`);
        first[arm].set(visit.id, Math.min(first[arm].get(visit.id) ?? Infinity, row.issuedAt));
      }
    }
    const paired = [...display.baseline.entries()].filter(([key, left]) => {
      const right = display.candidate.get(key);
      if (!right) return false;
      if (left.id !== right.id || left.stopIndex !== right.stopIndex || left.labelStopIndex !== right.labelStopIndex)
        throw new Error(`Paired display identity differs: ${key}`);
      return true;
    }).sort((a, b) => a[1].issuedAt - b[1].issuedAt || a[0].localeCompare(b[0]));
    increment(counts, "pairedDisplayQueries", paired.length);
    increment(counts, "baselineUnpairedDisplayQueries", display.baseline.size - paired.length);
    increment(counts, "candidateUnpairedDisplayQueries", display.candidate.size - paired.length);
    const keptKeys = new Set<string>(), last = new Map<string, number>();
    for (const [key, row] of paired) {
      const prior = last.get(row.episodeId);
      if (prior !== undefined && row.issuedAt - prior < config.forecastIntervalSec * 1000) continue;
      last.set(row.episodeId, row.issuedAt); keptKeys.add(key);
      for (const arm of ["baseline", "candidate"] as const) {
        const saved = display[arm].get(key)!, visit = dayVisits.get(saved.episodeId)!;
        const prediction: StopStudyPrediction = {
          model: config.modelLabels?.[arm] ?? arm, arm, issuedAt: saved.issuedAt, target: "departure", targetStopId: saved.stopId,
          predictedTotalSec: saved.shown.typicalSec, predictedRemainingSec: saved.shown.remaining ? saved.shown.sec : null,
          actualRemainingSec: visit.departedAt === null ? null : (visit.departedAt - saved.issuedAt) / 1000,
          displayKind: saved.shown.remaining ? "remaining" : "total", displaySec: saved.shown.sec,
          observedStartAt: saved.issuedAt - saved.elapsedSec * 1000,
          firstCapturedDisplay: saved.issuedAt === first[arm].get(visit.id), occurrenceAgreement: saved.occurrenceAgreement === true,
        };
        if (!prediction.occurrenceAgreement && !visit.qualityNotes.includes("Saved display occurrence disagrees with label"))
          visit.qualityNotes.push("Saved display occurrence disagrees with label");
        visit.predictions.push(prediction);
      }
    }
    increment(counts, "exportedDisplayQueries", keptKeys.size);

    if (input.baselineEtas && input.candidateEtas) {
      const eta = { baseline: new Map<string, Row | null>(), candidate: new Map<string, Row | null>() };
      for (const arm of ["baseline", "candidate"] as const) {
        const file = await readInput(`${arm}_paired_arrival_forecasts`, arm === "baseline" ? input.baselineEtas : input.candidateEtas);
        for await (const row of rows(file)) {
          increment(counts, `${arm}EtaRowsRead`);
          if (!row.currentVisitId || (config.arrivalTargetStopId === undefined ? row.servedOccurrencesAhead !== 1
            : row.stopId !== config.arrivalTargetStopId || !finite(row.servedOccurrencesAhead) || row.servedOccurrencesAhead < 1)) continue;
          const key = `${row.currentVisitId}:${row.issuedAt}`;
          if (!keptKeys.has(key)) continue;
          const visit = dayVisits.get(row.currentVisitId)!;
          if (row.routeId !== visit.routeId || row.busKey !== visit.busKey || row.currentStopId !== visit.stopId) {
            increment(counts, `${arm}EtaIdentityMismatch`); continue;
          }
          if (eta[arm].has(key)) { eta[arm].set(key, null); increment(counts, `${arm}EtaAmbiguous`); }
          else eta[arm].set(key, row);
        }
      }
      for (const key of keptKeys) {
        const left = eta.baseline.get(key), right = eta.candidate.get(key);
        if (!left || !right || left.targetArrivalId !== right.targetArrivalId || left.targetAt !== right.targetAt || left.stopId !== right.stopId || left.stopIndex !== right.stopIndex) {
          increment(counts, "displayQueriesWithoutPairedArrival"); continue;
        }
        const visit = dayVisits.get(left.currentVisitId)!;
        for (const arm of ["baseline", "candidate"] as const) {
          const saved = eta[arm].get(key)!;
          const prediction = visit.predictions.find(p => p.issuedAt === saved.issuedAt && p.arm === arm)!;
          prediction.downstream = { targetStopId: saved.stopId, targetStopIndex: saved.stopIndex, targetArrivalId: saved.targetArrivalId,
            targetAt: saved.targetAt, quantileLevels: saved.quantileLevels, quantilesSec: saved.quantilesSec, actualRemainingSec: saved.actualSec };
        }
        increment(counts, "displayQueriesWithPairedArrival");
      }
    }
    if (input.positions) {
      const eligible = new Set([...dayVisits.values()].map(v => `${v.routeId}:${v.busId}:${v.busKey}`));
      const touchedTracks = new Set<string>();
      for await (const row of rows(await readInput("observed_positions", input.positions))) {
        increment(counts, "positionRowsRead");
        const key = `${row.route_id}:${row.bus_id}:${row.bus_name}`;
        if (!eligible.has(key)) continue;
        let track = positionTracks.get(key);
        if (!track) { track = { routeId: row.route_id, busId: row.bus_id, busKey: row.bus_name, positions: [] }; positionTracks.set(key, track); }
        const points = track.positions, prior = pendingPositions.get(key);
        if (prior && row.collected_at <= prior.at) throw new Error(`Nonmonotonic or duplicate GPS fix ${key}:${row.collected_at}`);
        const point = { at: row.collected_at, lat: row.lat, lon: row.lon, busId: row.bus_id, distanceM: null,
          gapSec: prior ? (row.collected_at - prior.at) / 1000 : null };
        pendingPositions.set(key, point); touchedTracks.add(key);
        const gap = point.gapSec !== null && point.gapSec > 30;
        if (gap && prior && points.at(-1)?.at !== prior.at) points.push(prior);
        if (!points.length || gap || point.at - points.at(-1)!.at >= config.positionIntervalSec * 1000) points.push(point);
      }
      for (const key of touchedTracks) {
        const point = pendingPositions.get(key)!;
        const points = positionTracks.get(key)!.positions;
        if (point && point.at !== points.at(-1)?.at) points.push(point);
      }
    }
    for (const name of input.manifests) {
      const manifest = JSON.parse(await readFile(await readInput("source_manifest", name), "utf8"));
      for (const [path, hash] of Object.entries(manifest.sourceHashes ?? {}))
        if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) sourceHashes[`${basename(name)}:${path}`] = hash;
    }
  }
  const ordered = [...visits.values()].sort((a, b) => a.anchoredAt - b.anchoredAt || a.id.localeCompare(b.id));
  const previous = new Map<string, number>();
  for (const visit of ordered) {
    const key = `${visit.day}:${visit.routeId}:${visit.routePatternId}:${visit.stopId}:${visit.stopIndex}:${visit.busKey}`, prior = previous.get(key);
    if (prior !== undefined && prior < visit.anchoredAt) {
      visit.previousDepartureAt = prior;
      if (visit.departedAt !== null) visit.loopSec = (visit.departedAt - prior) / 1000;
    }
    if (visit.departedAt !== null && visit.labelStatus === "complete" && !visit.leftCensored && !visit.rightCensored && visit.outcome === "stopped") previous.set(key, visit.departedAt);
    visit.predictions.sort((a, b) => a.issuedAt - b.issuedAt || a.arm.localeCompare(b.arm));
  }
  for (const path of [fileURLToPath(import.meta.url), fileURLToPath(new URL("../../src/schema/stop-study.ts", import.meta.url))])
    sourceHashes[`exporter:${basename(path)}`] = await sha256(path);
  const usedRouteIds = [...new Set(ordered.map(v => v.routeId))].sort((a, b) => a - b);
  const usedStopIds = [...new Set(ordered.flatMap(v => [v.stopId, ...v.predictions.flatMap(p => p.downstream ? [p.downstream.targetStopId] : [])]))].sort((a, b) => a - b);
  counts.exportedPositionRows = [...positionTracks.values()].reduce((n, track) => n + track.positions.length, 0);
  const study = validateStopStudy({ schemaVersion: 1, source: "saved_study", title: config.title, generatedAt, timezone: "America/New_York",
    days: [...new Set(ordered.map(v => v.day))].sort(),
    routes: usedRouteIds.map(routeId => { const name = routeNames.get(routeId)?.name ?? `Route ${routeId}`; return { routeId, name, shortName: name.split(" - ")[0] }; }),
    stops: usedStopIds.map(stopId => { const stop = stopNames.get(stopId); return { stopId, name: stop?.name ?? `Stop ${stopId}`, lat: stop?.lat ?? null, lon: stop?.lon ?? null }; }),
    visits: ordered, positionTracks: [...positionTracks.values()], provenance: { exporterVersion: "stop-study-v1", inputs, sourceHashes, counts, warnings,
      ...(config.context ? { context: config.context } : {}),
      arrivalSelection: { kind: config.arrivalTargetStopId === undefined ? "next_served" : "target_stop", targetStopId: config.arrivalTargetStopId ?? null },
      sampling: { forecastIntervalSec: config.forecastIntervalSec, positionIntervalSec: config.days.some(d => d.positions) ? config.positionIntervalSec : null,
        pairedQueriesOnly: true, firstPairedDisplayPreserved: true,
        description: "Joint baseline/candidate timestamps; first common row per visit, then minimum interval. firstCapturedDisplay identifies the original per-arm first before pairing. GPS first/last fixes and both edges of gaps over30s retained; gapSec measures raw adjacent fixes." } } });
  if (Buffer.byteLength(JSON.stringify(study)) > STOP_STUDY_MAX_BYTES) throw new Error("Export exceeds 25 MiB; select fewer days or increase the disclosed sampling interval");
  return study;
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" }, out: { type: "string" } }, strict: true });
  if (!values.config || !values.out) throw new Error("Usage: node --import tsx scripts/stop-data/export-study.ts --config inputs.json --out study.json");
  const study = await exportStudy(resolve(values.config));
  await writeFile(resolve(values.out), JSON.stringify(study), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output: resolve(values.out), visits: study.visits.length, ...study.provenance.counts }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
