import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { Episode } from "../contract.js";
import { ANALYTIC_OPTIONS, analyticCellKey, analyticDuration, fitAnalytic, predictAnalytic, type AnalyticArm, type AnalyticQuery, type AnalyticWeightObjective } from "./analytic.js";

const root = process.cwd(); // services/shuttle-v2
const artifactRoot = path.resolve(root, "scripts/.eta-replay/overnight-2026-09-08");
const dataset = path.join(artifactRoot, "dataset");
const trainingDays = (process.env.ANALYTIC_TRAIN_DAYS ?? "2026-09-03").split(",");
const evaluationDays = (process.env.ANALYTIC_EVAL_DAYS ?? "2026-09-04").split(",");
const weightObjective = (process.env.ANALYTIC_WEIGHT_OBJECTIVE ?? "first") as AnalyticWeightObjective;
if (!["first", "remaining"].includes(weightObjective)) throw new Error("Unknown weight objective.");
if (trainingDays.some(d => !["2026-09-03", "2026-09-04"].includes(d))) throw new Error("Training is restricted to the discovery/development days.");
if (evaluationDays.some(d => !["2026-09-04", "2026-09-08"].includes(d))) throw new Error("This development runner never opens reserved confirmation labels.");
const cutoff = Date.parse(`${trainingDays.slice().sort().at(-1)}T04:00:00Z`) + 86_400_000;
const out = path.resolve(process.env.ANALYTIC_OUT ?? path.join(artifactRoot, "analytic", `train-${trainingDays.join("+")}`));
fs.mkdirSync(out, { recursive: true });
const read = (day: string): Episode[] => zlib.gunzipSync(fs.readFileSync(path.join(dataset, day, "episodes.jsonl.gz")))
  .toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Episode);
const training = trainingDays.flatMap(read);
const sourceFiles = ["analytic.ts", "analytic-distribution.ts", "analytic-eval.ts"];
const sourceHash = crypto.createHash("sha256").update(sourceFiles.map(f => fs.readFileSync(path.join(root, "scripts/eta-replay/general-eval/models", f))).join("\n")).digest("hex");
const datasetHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dataset, "manifest.json"))).digest("hex");
console.log(JSON.stringify({ phase: "fitting", trainingDays, rows: training.length, cutoff, options: { ...ANALYTIC_OPTIONS, weightObjective }, sourceHash, datasetHash }));
const start = Date.now();
const fit = process.env.ANALYTIC_FIT ? JSON.parse(fs.readFileSync(process.env.ANALYTIC_FIT, "utf8")) as ReturnType<typeof fitAnalytic> : fitAnalytic(training, cutoff, weightObjective);
if (fit.fittedAt !== cutoff) throw new Error("Reused fit has the wrong training cutoff.");
fs.writeFileSync(path.join(out, "fit.json"), JSON.stringify(fit));
const weights = Object.entries(fit.cells).map(([cell, v]) => ({ cell, n: v.n, phaseN: v.phase?.n ?? 0, weight: v.weight, evidenceN: v.evidence.n }));
fs.writeFileSync(path.join(out, "weights.json"), JSON.stringify(weights, null, 2));
console.log(JSON.stringify({ phase: "fitted", seconds: (Date.now() - start) / 1000, cells: weights.length,
  phaseCells: weights.filter(c => c.phaseN > 0).length, nonzeroWeights: weights.filter(c => c.weight > 0).length }));

const arms: AnalyticArm[] = ["duration", "phase", "stacked"];
// Identical to the learned challenger: 19 midpoint levels, every 30 seconds.
const levels = Array.from({ length: 19 }, (_, i) => (i + 0.5) / 19);
const average = (a: readonly number[]): number => a.reduce((s, n) => s + n, 0) / Math.max(1, a.length);
const percentile = (a: readonly number[], p: number): number => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), rank = (b.length - 1) * p;
  return b[Math.floor(rank)]! + (b[Math.ceil(rank)]! - b[Math.floor(rank)]!) * (rank % 1);
};
type Score = { mae: number; bias: number; crps: number; optimistic120: number; pessimistic120: number; coverage80: number };
function score(q: readonly number[], truth: number): Score {
  const at = (p: number): number => {
    const rank = p * q.length - 0.5, lo = Math.max(0, Math.min(q.length - 1, Math.floor(rank))), hi = Math.max(0, Math.min(q.length - 1, Math.ceil(rank)));
    return q[lo]! + (q[hi]! - q[lo]!) * Math.max(0, rank - lo);
  };
  const err = at(0.5) - truth;
  return { mae: Math.abs(err), bias: err,
    crps: average(q.map((x, i) => 2 * Math.max(levels[i]! * (truth - x), (levels[i]! - 1) * (truth - x)))),
    optimistic120: err < -120 ? 1 : 0, pessimistic120: err > 120 ? 1 : 0,
    coverage80: truth >= at(0.1) && truth <= at(0.9) ? 1 : 0 };
}
function meanScores(rows: Score[]): Score {
  return Object.fromEntries(Object.keys(rows[0] ?? { mae: 0, bias: 0, crps: 0, optimistic120: 0, pessimistic120: 0, coverage80: 0 })
    .map(k => [k, average(rows.map(row => row[k as keyof Score]))])) as Score;
}
type VisitScore = { id: string; routeId: number; cell: string; day: string; busKey: string; duration: number;
  eligible: boolean; weight: number; first: Record<AnalyticArm, Score>; standing: Record<AnalyticArm, Score> | null;
  firstStandingTotal: Record<AnalyticArm, Score> | null; points: number };
function summary(rows: VisitScore[]): Record<string, unknown> {
  const out: Record<string, unknown> = { visits: rows.length, phaseEligible: rows.filter(r => r.eligible).length,
    nonzeroWeight: rows.filter(r => r.weight > 0).length, standingVisits: rows.filter(r => r.standing).length };
  for (const mode of ["first", "standing", "firstStandingTotal"] as const) {
    out[mode] = Object.fromEntries(arms.map(arm => {
      const scores = rows.flatMap(r => r[mode] ? [r[mode]![arm]] : []);
      return [arm, { ...meanScores(scores), p90Abs: percentile(scores.map(r => r.mae), 0.9) }];
    }));
  }
  return out;
}

const metrics: Record<string, unknown> = {};
for (const day of evaluationDays) {
  const episodes = read(day), rows: VisitScore[] = [];
  const historyGroups = new Map<string, Episode[]>();
  for (const v of episodes) {
    const key = `${analyticCellKey(v)}:${v.busKey}`;
    const group = historyGroups.get(key) ?? []; group.push(v); historyGroups.set(key, group);
  }
  const predictionFile = fs.openSync(path.join(out, `${day}-predictions.jsonl`), "w");
  const sharedFiles = Object.fromEntries(arms.map(arm => [arm, fs.openSync(path.join(out, `${day}-${arm}-shared.jsonl`), "w")])) as Record<AnalyticArm, number>;
  let invalid = 0, unpinned = 0, patternUnresolved = 0;
  const pollScores: Record<AnalyticArm, Score[]> = { duration: [], phase: [], stacked: [] };
  for (const episode of episodes) {
    const duration = analyticDuration(episode);
    if (episode.patternResolved === false) patternUnresolved++;
    if (duration == null) { invalid++; continue; }
    if (episode.pinnedAt == null) { unpinned++; continue; }
    const pinnedAt = episode.pinnedAt;
    const history = (historyGroups.get(`${analyticCellKey(episode)}:${episode.busKey}`) ?? [])
      .filter(v => v.knownAt != null && v.knownAt <= pinnedAt && v.id !== episode.id);
    const query: AnalyticQuery = { routeId: episode.routeId, routePatternId: episode.routePatternId,
      stopId: episode.stopId, stopIndex: episode.stopIndex, busKey: episode.busKey, day: episode.day,
      pinnedAt, issuedAt: pinnedAt, standing: false };
    const record: VisitScore = { id: episode.id, routeId: episode.routeId, cell: analyticCellKey(episode), day, busKey: episode.busKey,
      duration, eligible: false, weight: 0, first: {} as Record<AnalyticArm, Score>, standing: null, firstStandingTotal: null, points: 0 };
    for (const arm of arms) {
      const pred = predictAnalytic(fit, query, history, arm, levels);
      record.first[arm] = score(pred.quantiles, duration); record.eligible ||= pred.phaseAvailable;
      if (arm === "stacked") record.weight = pred.phaseWeightAtArrival;
      fs.writeSync(predictionFile, JSON.stringify({ episodeId: episode.id, arm, mode: "first", issuedAt: pinnedAt, query,
        quantileLevels: levels, quantilesSec: pred.quantiles, targetDepartureAt: episode.departedAt,
        truthDurationSec: duration, phaseAvailable: pred.phaseAvailable, phaseWeightAtArrival: pred.phaseWeightAtArrival }) + "\n");
    }
    if (episode.outcome === "stopped") {
      const byArm: Record<AnalyticArm, Score[]> = { duration: [], phase: [], stacked: [] };
      record.firstStandingTotal = {} as Record<AnalyticArm, Score>;
      for (let elapsed = 0; elapsed < Math.max(1, duration); elapsed += 30) {
        const issuedAt = pinnedAt + elapsed * 1000;
        for (const arm of arms) {
          const pred = predictAnalytic(fit, { ...query, issuedAt, standing: true }, history, arm, levels);
          const row = score(pred.quantiles, duration - elapsed);
          byArm[arm].push(row); pollScores[arm].push(row);
          if (elapsed === 0) record.firstStandingTotal[arm] = row;
          fs.writeSync(sharedFiles[arm], JSON.stringify({ id: `${episode.id}@${issuedAt}`, episodeId: episode.id, issuedAt,
            day, routeId: episode.routeId, routePatternId: episode.routePatternId, stopId: episode.stopId,
            stopIndex: episode.stopIndex, busKey: episode.busKey, target: "remaining_stand", targetAt: episode.departedAt,
            actualSec: duration - elapsed, elapsedSec: elapsed, totalSec: duration, quantileLevels: levels,
            quantilesSec: pred.quantiles, phaseAvailable: pred.phaseAvailable, phaseWeightAtArrival: pred.phaseWeightAtArrival }) + "\n");
          fs.writeSync(predictionFile, JSON.stringify({ episodeId: episode.id, arm, mode: "standing", issuedAt,
            quantileLevels: levels, quantilesSec: pred.quantiles, targetDepartureAt: episode.departedAt,
            truthRemainingSec: duration - elapsed, phaseAvailable: pred.phaseAvailable,
            phaseWeightAtArrival: pred.phaseWeightAtArrival, phaseWeightNow: pred.phaseWeightNow }) + "\n");
        }
        record.points++;
      }
      record.standing = Object.fromEntries(arms.map(arm => [arm, meanScores(byArm[arm])])) as Record<AnalyticArm, Score>;
    }
    rows.push(record);
  }
  fs.closeSync(predictionFile);
  for (const fd of Object.values(sharedFiles)) fs.closeSync(fd);
  const byRoute = Object.fromEntries([...new Set(rows.map(r => r.routeId))].map(route => [route, summary(rows.filter(r => r.routeId === route))]));
  const byCell = Object.fromEntries([...new Set(rows.map(r => r.cell))].map(cell => [cell, summary(rows.filter(r => r.cell === cell))]));
  metrics[day] = { coverage: { sourceEpisodes: episodes.length, invalid, unpinned, patternUnresolved }, all: summary(rows), byRoute, byCell,
    longStands: summary(rows.filter(r => r.duration >= 300)), fallback: summary(rows.filter(r => !r.eligible)),
    pollWeighted: Object.fromEntries(arms.map(arm => [arm, { points: pollScores[arm].length, ...meanScores(pollScores[arm]) }])) };
  fs.writeFileSync(path.join(out, `${day}-visit-scores.json`), JSON.stringify(rows));
  console.log(JSON.stringify({ phase: "scored", day, ...(metrics[day] as { all: unknown; coverage: Record<string, number> }).coverage,
    all: (metrics[day] as { all: unknown }).all }));
}
fs.writeFileSync(path.join(out, "metrics.json"), JSON.stringify({ trainingDays, evaluationDays, sourceHash, datasetHash,
  options: fit.options, elapsedSeconds: (Date.now() - start) / 1000, metrics }, null, 2));
