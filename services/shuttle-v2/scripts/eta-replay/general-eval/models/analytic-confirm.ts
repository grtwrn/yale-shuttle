import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Episode } from "../contract.js";
import { ANALYTIC_OPTIONS, analyticCellKey, analyticDuration, fitAnalytic, predictAnalytic } from "./analytic.js";

/** Emit only. Scoring is a separate step after the prediction manifest exists. */
const root = process.cwd();
const artifacts = path.resolve(root, "scripts/.eta-replay/overnight-2026-09-08");
const dataset = path.join(artifacts, "dataset-v2");
const out = path.join(artifacts, "analytic", "reserved-confirmation");
const sha = (content: string | Buffer): string => crypto.createHash("sha256").update(content).digest("hex");
const lockFile = path.join(artifacts, "selection-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
if (lock.selectedFamily !== "analytic-phase-stack-v2" || lock.objective !== "remaining") throw new Error("Wrong locked family");
const sources = ["analytic.ts", "analytic-distribution.ts"];
const additiveRuntimeExports = "\n// Additive runtime boundary: exports the same fitted experts used above.\nexport { durationExpert as analyticDurationExpert, experts as analyticExperts };\n";
for (const source of sources) {
  const key = `services/shuttle-v2/scripts/eta-replay/general-eval/models/${source}`;
  // The integration adapter only adds named exports of existing helpers. Check
  // the selected body byte-for-byte; do not exempt any algorithm changes.
  const actual = fs.readFileSync(path.resolve(root, "../..", key), "utf8");
  const selected = source === "analytic.ts" && actual.endsWith(additiveRuntimeExports)
    ? actual.slice(0, -additiveRuntimeExports.length) : actual;
  if (sha(selected) !== lock.candidateHashes[key]) throw new Error(`Selected source changed: ${source}`);
}
if (sha(fs.readFileSync(path.join(dataset, "manifest.json"))) !== lock.datasetManifestSha256) throw new Error("Dataset changed since selection");
const trainDays: string[] = lock.refitDays;
const evalDays: string[] = [...lock.reservedConfirmationDays, ...lock.regressionDays];
const cutoff = Date.parse(`${trainDays.slice().sort().at(-1)}T04:00:00Z`) + 86_400_000;
const read = (day: string): Episode[] => zlib.gunzipSync(fs.readFileSync(path.join(dataset, day, "episodes.jsonl.gz")))
  .toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
fs.mkdirSync(out, { recursive: true });
const run = { startedAt: new Date().toISOString(), selectionLockSha256: sha(fs.readFileSync(lockFile)),
  datasetManifestSha256: lock.datasetManifestSha256, coreSourceSha256: Object.fromEntries(sources.map(f => [f,
    sha(fs.readFileSync(path.join(root, "scripts/eta-replay/general-eval/models", f)))])),
  runnerSha256: sha(fs.readFileSync(new URL(import.meta.url))), trainDays, evalDays, cutoff,
  options: { ...ANALYTIC_OPTIONS, weightObjective: "remaining" }, scoringPerformed: false };
fs.writeFileSync(path.join(out, "run-manifest.json"), JSON.stringify(run, null, 2));
const training = trainDays.flatMap(read), start = Date.now();
console.log(JSON.stringify({ phase: "fitting", rows: training.length, ...run }));
const fit = fitAnalytic(training, cutoff, "remaining"), fitSeconds = (Date.now() - start) / 1000;
const serializedFit = JSON.stringify(fit);
fs.writeFileSync(path.join(out, "fit.json"), serializedFit);
console.log(JSON.stringify({ phase: "fitted", fitSeconds, cells: Object.keys(fit.cells).length,
  peakResidentMiB: process.resourceUsage().maxRSS / 1024, fitBytes: Buffer.byteLength(serializedFit) }));
const levels = Array.from({ length: 19 }, (_, i) => (i + .5) / 19);
const files: Array<{ day: string; arm: string; path: string; sha256: string; points: number; episodes: number }> = [];
for (const day of evalDays) {
  const episodes = read(day), historyGroups = new Map<string, Episode[]>();
  for (const v of episodes) {
    const key = `${analyticCellKey(v)}:${v.busKey}`;
    const group = historyGroups.get(key) ?? []; group.push(v); historyGroups.set(key, group);
  }
  for (const arm of ["duration", "stacked"] as const) {
    const file = path.join(out, `${day}-${arm}-shared.jsonl`), fd = fs.openSync(file, "w");
    let points = 0, count = 0;
    for (const episode of episodes) {
      const duration = analyticDuration(episode);
      if (duration == null || episode.pinnedAt == null || episode.outcome !== "stopped") continue;
      const pinnedAt = episode.pinnedAt;
      const history = (historyGroups.get(`${analyticCellKey(episode)}:${episode.busKey}`) ?? [])
        .filter(v => v.knownAt != null && v.knownAt <= pinnedAt && v.id !== episode.id);
      for (let elapsed = 0; elapsed < Math.max(1, duration); elapsed += 30) {
        const issuedAt = pinnedAt + elapsed * 1000;
        const pred = predictAnalytic(fit, { routeId: episode.routeId, routePatternId: episode.routePatternId,
          stopId: episode.stopId, stopIndex: episode.stopIndex, busKey: episode.busKey, day: episode.day,
          pinnedAt, issuedAt, standing: true }, history, arm, levels);
        fs.writeSync(fd, JSON.stringify({ id: `${episode.id}@${issuedAt}`, episodeId: episode.id, issuedAt,
          day, routeId: episode.routeId, routePatternId: episode.routePatternId, stopId: episode.stopId,
          stopIndex: episode.stopIndex, busKey: episode.busKey, target: "remaining_stand", targetAt: episode.departedAt,
          actualSec: duration - elapsed, elapsedSec: elapsed, totalSec: duration, quantileLevels: levels,
          quantilesSec: pred.quantiles, phaseAvailable: pred.phaseAvailable,
          phaseWeightAtArrival: pred.phaseWeightAtArrival, phaseWeightNow: pred.phaseWeightNow }) + "\n");
        points++;
      }
      count++;
    }
    fs.closeSync(fd);
    files.push({ day, arm, path: file, sha256: sha(fs.readFileSync(file)), points, episodes: count });
    console.log(JSON.stringify({ phase: "emitted", day, arm, points, episodes: count }));
  }
}
fs.writeFileSync(path.join(out, "prediction-manifest.json"), JSON.stringify({ ...run,
  completedAt: new Date().toISOString(), fitSha256: sha(serializedFit), fitSeconds,
  totalSeconds: (Date.now() - start) / 1000, peakResidentMiB: process.resourceUsage().maxRSS / 1024,
  fitBytes: Buffer.byteLength(serializedFit), files }, null, 2));
console.log(JSON.stringify({ phase: "manifest-written", scoringPerformed: false, out }));
