/** Requery frozen fits at repaired DEVELOPMENT pins. Historical inputs stay original. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { analyticCellKey, predictAnalytic, type AnalyticEpisode, type AnalyticFit } from "./analytic.js";

const root = path.resolve("scripts/.eta-replay/overnight-2026-09-08");
const day = "2026-09-04";
const rebuilt = path.resolve(process.env.REBUILT_LABELS ?? path.join(root, "label-rebuild-v1", day));
const out = path.resolve(process.env.REBUILT_COMPONENT_OUT ?? path.join(root, "rebuilt-component-development-v1"));
const original = path.join(root, "dataset-v2");
const fitPath = path.join(root, "analytic/remaining-objective-corrected/fit.json");
const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const read = (p: string): any[] => zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
if (fs.existsSync(path.join(out, "query-manifest.json"))) throw new Error("Refusing to overwrite a frozen repaired-query cohort");
const manifest = JSON.parse(fs.readFileSync(path.join(rebuilt, "manifest.json"), "utf8"));
if (manifest.day !== day) throw new Error("This repair comparison is DEVELOPMENT ONLY");
const fit: AnalyticFit = JSON.parse(fs.readFileSync(fitPath, "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "selection-lock.json"), "utf8"));
if (sha(fitPath) !== lock.candidateHashes["services/shuttle-v2/scripts/.eta-replay/overnight-2026-09-08/analytic/remaining-objective-corrected/fit.json"])
  throw new Error("Original selected development fit changed");
const episodes = read(path.join(rebuilt, "episodes.jsonl.gz"));
const history: AnalyticEpisode[] = read(path.join(original, day, "episodes.jsonl.gz"));
const groups = new Map<string, AnalyticEpisode[]>();
for (const v of history) { const key = JSON.stringify([analyticCellKey(v), v.busKey]), group = groups.get(key) ?? []; group.push(v); groups.set(key, group); }
const seenPatterns = new Set(Object.keys(fit.cells).map(k => decodeURIComponent(k.split(":")[1]!)));
const arms = ["duration", "stacked", "phase"] as const;
const levels = Array.from({ length: 19 }, (_, i) => (i + .5) / 19);
fs.mkdirSync(out, { recursive: true });
const registration = { registeredAt: new Date().toISOString(), day,
  purpose: "Descriptive reevaluation of frozen models after prediction-blind label repair; no ranking or reselection",
  queryMode: "Known-standing component grid at corrected causal pin, every30sec; not literal first client display",
  historyPolicy: "ORIGINAL dataset-v2 Sep4 previous completed visits and knownAt; never add rebuilt rows to history",
  trainingPolicy: "Unchanged Sep3 fitted artifacts and original frozen feature profiles; no refit",
  labelManifestPath: path.join(rebuilt, "manifest.json"), labelManifestSha256: sha(path.join(rebuilt, "manifest.json")),
  inputHashes: { rebuiltEpisodes: sha(path.join(rebuilt, "episodes.jsonl.gz")), originalHistory: sha(path.join(original, day, "episodes.jsonl.gz")),
    analyticFit: sha(fitPath), libraryProfiles: sha(path.join(root, "learned/dev-profiles.json")) },
  sources: Object.fromEntries(["analytic-rebuilt-components.ts", "analytic.ts", "analytic-distribution.ts"].map(f => [f, sha(path.join(import.meta.dirname, f))])),
  forecastArms: arms, quantileLevels: levels, scoringPerformed: false };
fs.writeFileSync(path.join(out, "registration.json"), JSON.stringify(registration, null, 2));
const queries = fs.openSync(path.join(out, "episode-queries.jsonl"), "w");
const labels = fs.openSync(path.join(out, "component-labels.jsonl"), "w");
const fds = Object.fromEntries(arms.map(a => [a, fs.openSync(path.join(out, `analytic-${a}.jsonl`), "w")])) as Record<typeof arms[number], number>;
const coverage: Record<string, number> = { sourceEpisodes: episodes.length, eligibleEpisodes: 0, points: 0, seenPatternEpisodes: 0, newPatternEpisodes: 0 };
for (const e of episodes) {
  if (e.labelStatus !== "complete" || e.leftCensored || e.initialRestCensored || e.rightCensored) { coverage.censored = (coverage.censored ?? 0) + 1; continue; }
  if (e.outcome !== "stopped" || e.pinnedAt == null || e.departedAt == null || e.departedAt < e.pinnedAt) { coverage.otherOutcome = (coverage.otherOutcome ?? 0) + 1; continue; }
  const total = (e.departedAt - e.pinnedAt) / 1000;
  const prior = (groups.get(JSON.stringify([analyticCellKey(e), e.busKey])) ?? [])
    .filter(p => p.knownAt != null && p.knownAt <= e.pinnedAt && p.departedAt != null && p.departedAt < e.pinnedAt);
  const patternSeen = seenPatterns.has(e.routePatternId);
  const query = { id: e.id, routeId: e.routeId, routePatternId: e.routePatternId, stopId: e.stopId, stopIndex: e.stopIndex,
    busKey: e.busKey, serviceDay: day, patternResolved: e.patternResolved, patternSeen,
    visitStartMs: e.pinnedAt, issuedAt: e.pinnedAt, priorDepartures: prior };
  fs.writeSync(queries, JSON.stringify(query) + "\n");
  coverage.eligibleEpisodes++; coverage[patternSeen ? "seenPatternEpisodes" : "newPatternEpisodes"]!++;
  for (let elapsed = 0; elapsed < Math.max(1, total); elapsed += 30) {
    const issuedAt = e.pinnedAt + elapsed * 1000;
    const label = { id: `${e.id}@${issuedAt}`, episodeId: e.id, issuedAt, day, routeId: e.routeId,
      routePatternId: e.routePatternId, stopId: e.stopId, stopIndex: e.stopIndex, busKey: e.busKey,
      patternResolved: e.patternResolved, patternSeen, elapsedSec: elapsed, totalSec: total,
      target: "remaining_stand", targetAt: e.departedAt, actualSec: total - elapsed };
    fs.writeSync(labels, JSON.stringify(label) + "\n");
    for (const arm of arms) {
      const prediction = predictAnalytic(fit, { ...query, pinnedAt: e.pinnedAt, day, issuedAt, standing: true }, prior, arm, levels);
      fs.writeSync(fds[arm], JSON.stringify({ ...label, quantileLevels: levels, quantilesSec: prediction.quantiles,
        phaseAvailable: prediction.phaseAvailable, phaseWeightAtArrival: prediction.phaseWeightAtArrival }) + "\n");
    }
    coverage.points++;
  }
}
fs.closeSync(queries); fs.closeSync(labels); for (const fd of Object.values(fds)) fs.closeSync(fd);
const files = ["episode-queries.jsonl", "component-labels.jsonl", ...arms.map(a => `analytic-${a}.jsonl`)];
fs.writeFileSync(path.join(out, "query-manifest.json"), JSON.stringify({ ...registration, completedAt: new Date().toISOString(), coverage,
  files: Object.fromEntries(files.map(f => [f, sha(path.join(out, f))])) }, null, 2));
console.log(JSON.stringify({ out, coverage, scoringPerformed: false }));
