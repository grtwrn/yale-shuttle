/** Selected model only: corrected-label reserved confirmation, with no refit. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { analyticCellKey, predictAnalytic, type AnalyticEpisode, type AnalyticFit } from "./analytic.js";

const root = path.resolve("scripts/.eta-replay/overnight-2026-09-08");
const original = path.join(root, "dataset-v2");
const labelsRoot = path.join(root, "label-rebuild-client-v1");
const out = path.join(root, "analytic/repaired-reserved-confirmation-v1");
const sha = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");
const hashFile = (file: string): string => sha(fs.readFileSync(file));
const read = (file: string): any[] => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
const lockFile = path.join(root, "selection-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
if (lock.selectedFamily !== "analytic-phase-stack-v2" || lock.objective !== "remaining") throw new Error("Wrong selected family");
const days: string[] = lock.reservedConfirmationDays;
if (JSON.stringify(days) !== JSON.stringify(["2026-09-05", "2026-09-06", "2026-09-07"])) throw new Error("Unexpected reserved cohort");
const additiveExports = "\n// Additive runtime boundary: exports the same fitted experts used above.\nexport { durationExpert as analyticDurationExpert, experts as analyticExperts };\n";
const sources: Record<string, string> = {};
for (const name of ["analytic.ts", "analytic-distribution.ts"]) {
  const actual = fs.readFileSync(path.join(import.meta.dirname, name), "utf8");
  const selected = name === "analytic.ts" && actual.endsWith(additiveExports) ? actual.slice(0, -additiveExports.length) : actual;
  if (sha(selected) !== lock.candidateHashes[`services/shuttle-v2/scripts/eta-replay/general-eval/models/${name}`]) throw new Error(`Selected algorithm changed: ${name}`);
  sources[name] = sha(actual);
}
if (hashFile(path.join(original, "manifest.json")) !== lock.datasetManifestSha256) throw new Error("Original history dataset changed");
const originalManifestPath = path.join(root, "analytic/reserved-confirmation/prediction-manifest.json");
const oldManifest = JSON.parse(fs.readFileSync(originalManifestPath, "utf8"));
const fitPath = path.join(root, "analytic/reserved-confirmation/fit.json");
if (hashFile(fitPath) !== oldManifest.fitSha256 || oldManifest.selectionLockSha256 !== hashFile(lockFile)) throw new Error("Frozen confirmation fit provenance changed");
const fit: AnalyticFit = JSON.parse(fs.readFileSync(fitPath, "utf8"));
if (fit.version !== "analytic-phase-stack-v2" || fit.options.weightObjective !== "remaining") throw new Error("Wrong fitted law");
if (fs.existsSync(out)) throw new Error("Refusing to overwrite repaired confirmation");
const inputManifests = days.map(day => {
  const manifestFile = path.join(labelsRoot, day, "manifest.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const labelFile = path.join(labelsRoot, day, "episodes.jsonl.gz");
  if (m.day !== day || hashFile(labelFile) !== m.outputs.find((x: any) => x.name === "episodes.jsonl.gz")?.sha256) throw new Error("Rebuilt label manifest mismatch");
  if (m.sourceHashes["scripts/eta-replay/general-eval/rebuild-labels.ts"] !== "dbbb08f78f2b3e22cf70f07c7d2474a4d14aaba00c77117c238a2f3fd76f9b16") throw new Error("Unexpected label rule");
  return { day, labelFile, labelSha256: hashFile(labelFile), manifestFile, manifestSha256: hashFile(manifestFile),
    historyFile: path.join(original, day, "episodes.jsonl.gz"), historySha256: hashFile(path.join(original, day, "episodes.jsonl.gz")),
    topologySha256: m.topologySha256, networkSourceSha256: m.networkSourceSha256 };
});
if (new Set(inputManifests.map(m => m.topologySha256)).size !== 1) throw new Error("Mixed client geometries");
fs.mkdirSync(out, { recursive: true });
const levels = Array.from({ length: 19 }, (_, i) => (i + .5) / 19);
const registration = { registeredAt: new Date().toISOString(), selectedFamily: lock.selectedFamily,
  selectionLockFile: lockFile, selectionLockSha256: hashFile(lockFile), selectedAt: lock.selectedAt,
  originalRefitManifestSha256: hashFile(originalManifestPath), fitPath, fitSha256: hashFile(fitPath), fittedAt: fit.fittedAt,
  sources, runnerSha256: hashFile(new URL(import.meta.url).pathname), inputs: inputManifests, days,
  trainingChanged: false, historicalFeaturesChanged: false, modelSelectionPerformed: false, scoringPerformed: false,
  policy: { arms: ["duration", "stacked"], quantileLevels: levels, strideSec: 30, standingAtInitial: true,
    queryClock: "Current corrected causal pin; original knownAt/departure history available before this pin only",
    target: "Reconstructed departure minus issue time; complete stopped visits only; all censoring preserved in coverage",
    geometry: "Exact original client replay geometry; no remapping to trained patterns; seen/new patterns reported",
    scoring: "Shared scorer, equal episodes, 1800sec horizon; original initial-query keys chosen before exclusion", bootstrapReplicates: 2000,
    scope: "Selected model reserved confirmation only; no library arms, tuning, reselection, or training-label repair" } };
fs.writeFileSync(path.join(out, "registration.json"), JSON.stringify(registration, null, 2));
fs.copyFileSync(lockFile, path.join(out, "selection-lock.json"));
const seenPatterns = new Set(Object.keys(fit.cells).map(k => decodeURIComponent(k.split(":")[1]!)));
const combined = Object.fromEntries(["duration", "stacked"].map(a => [a, fs.openSync(path.join(out, `reserved-${a}.jsonl`), "w")])) as Record<string, number>;
const files: any[] = [], coverage: any[] = [];
for (const input of inputManifests) {
  const day = input.day;
  const episodes = read(input.labelFile);
  const groups = new Map<string, AnalyticEpisode[]>();
  for (const row of read(input.historyFile)) {
    const key = JSON.stringify([analyticCellKey(row), row.busKey]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const fds = Object.fromEntries(["duration", "stacked"].map(a => [a, fs.openSync(path.join(out, `${day}-${a}.jsonl`), "w")])) as Record<string, number>;
  const c: Record<string, number | string> = { day, inputEpisodes: episodes.length, censored: 0, otherOutcome: 0, stoppedEpisodes: 0, points: 0, seenPatternEpisodes: 0, newPatternEpisodes: 0, phaseAvailableEpisodes: 0 };
  for (const e of episodes) {
    if (e.labelStatus !== "complete" || e.leftCensored || e.initialRestCensored || e.rightCensored) { c.censored = Number(c.censored) + 1; continue; }
    if (e.outcome !== "stopped" || e.pinnedAt == null || e.departedAt == null || e.departedAt < e.pinnedAt) { c.otherOutcome = Number(c.otherOutcome) + 1; continue; }
    const total = (e.departedAt - e.pinnedAt) / 1000;
    const history = (groups.get(JSON.stringify([analyticCellKey(e), e.busKey])) ?? []).filter(p => p.knownAt != null && p.knownAt <= e.pinnedAt && p.departedAt != null && p.departedAt < e.pinnedAt);
    const patternSeen = seenPatterns.has(e.routePatternId);
    const countKey = patternSeen ? "seenPatternEpisodes" : "newPatternEpisodes";
    c[countKey] = Number(c[countKey]) + 1; c.stoppedEpisodes = Number(c.stoppedEpisodes) + 1;
    for (let elapsed = 0; elapsed < Math.max(1, total); elapsed += 30) {
      const issuedAt = e.pinnedAt + elapsed * 1000;
      const common = { id: `${e.id}@${issuedAt}`, episodeId: e.id, day, routeId: e.routeId, routePatternId: e.routePatternId,
        stopId: e.stopId, stopIndex: e.stopIndex, busKey: e.busKey, patternResolved: e.patternResolved, patternSeen,
        issuedAt, elapsedSec: elapsed, totalSec: total, target: "remaining_stand", targetAt: e.departedAt, actualSec: (e.departedAt - issuedAt) / 1000 };
      for (const arm of ["duration", "stacked"] as const) {
        const pred = predictAnalytic(fit, { ...common, pinnedAt: e.pinnedAt, standing: true }, history, arm, levels);
        const record = JSON.stringify({ ...common, quantileLevels: levels, quantilesSec: pred.quantiles, phaseAvailable: pred.phaseAvailable,
          phaseWeightAtArrival: pred.phaseWeightAtArrival, phaseWeightNow: pred.phaseWeightNow }) + "\n";
        fs.writeSync(fds[arm]!, record); fs.writeSync(combined[arm]!, record);
        if (arm === "stacked" && elapsed === 0 && pred.phaseAvailable) c.phaseAvailableEpisodes = Number(c.phaseAvailableEpisodes) + 1;
      }
      c.points = Number(c.points) + 1;
    }
  }
  for (const [arm, fd] of Object.entries(fds)) { fs.closeSync(fd); const file = path.join(out, `${day}-${arm}.jsonl`); files.push({ day, arm, file, sha256: hashFile(file) }); }
  coverage.push(c); console.log(JSON.stringify({ phase: "emitted", ...c }));
}
for (const [arm, fd] of Object.entries(combined)) { fs.closeSync(fd); const file = path.join(out, `reserved-${arm}.jsonl`); files.push({ day: "reserved-combined", arm, file, sha256: hashFile(file) }); }
fs.writeFileSync(path.join(out, "prediction-manifest.json"), JSON.stringify({ ...registration, completedAt: new Date().toISOString(), coverage, files }, null, 2));
console.log(JSON.stringify({ phase: "manifest-written", out, scoringPerformed: false }));
