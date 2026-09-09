/** Post-lock risk diagnostics only; no model fitting or selection. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { analyticCellKey, analyticExperts, type AnalyticEpisode, type AnalyticFit } from "./analytic.js";
import { analyticMixture } from "./analytic-distribution.js";

const base = path.resolve("scripts/.eta-replay/overnight-2026-09-08");
const read = (p: string): any[] => (p.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(p)).toString() : fs.readFileSync(p, "utf8"))
  .trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
const results: any[] = [];
for (const day of ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"]) {
  const directory = path.join(base, "analytic", day === "2026-09-04" ? "remaining-objective-corrected" : "reserved-confirmation");
  const fit: AnalyticFit = JSON.parse(fs.readFileSync(path.join(directory, "fit.json"), "utf8"));
  const episodes: AnalyticEpisode[] = read(path.join(base, "dataset-v2", day, "episodes.jsonl.gz"));
  const groups = new Map<string, AnalyticEpisode[]>();
  for (const e of episodes) {
    const key = JSON.stringify([analyticCellKey(e), e.busKey]), a = groups.get(key) ?? [];
    a.push(e); groups.set(key, a);
  }
  for (const arm of ["duration", "stacked"] as const) {
    const forecasts = read(path.join(directory, `${day}-${arm}-shared.jsonl`));
    const pairs = new Map<string, ReturnType<typeof analyticExperts>>();
    const allVisits = new Set<string>(), cutoffVisits = new Set<string>(), zeroVisits = new Set<string>();
    const fallback: Record<string, number> = {}, examples: any[] = [];
    let cutoffs = 0, zeroForecasts = 0, quantileClampWithoutCutoff = 0, positiveTailTruthSec = 0;
    for (const f of forecasts) {
      const first = !allVisits.has(f.episodeId); allVisits.add(f.episodeId);
      const pinnedAt = f.issuedAt - f.elapsedSec * 1000;
      const query = { routeId: f.routeId, routePatternId: f.routePatternId, stopId: f.stopId, stopIndex: f.stopIndex,
        busKey: f.busKey, day, pinnedAt, issuedAt: f.issuedAt, standing: true };
      let pair = pairs.get(f.episodeId);
      if (!pair) {
        pair = analyticExperts(fit, query, groups.get(JSON.stringify([analyticCellKey(query), f.busKey])) ?? []);
        pairs.set(f.episodeId, pair);
      }
      if (first) {
        const cell = fit.cells[analyticCellKey(query)];
        const reason = !cell ? "unmeasured_or_unresolved" : !cell.phase ? "insufficient_phase_training" : !pair.phase
          ? "no_prior_confirmed_currentday_departure" : cell.weight <= 0 ? "learned_zero_weight" : "active_phase";
        fallback[reason] = (fallback[reason] ?? 0) + 1;
      }
      const total = arm === "stacked" && pair.phase ? analyticMixture(pair.duration, pair.phase, pair.weight) : pair.duration;
      const survival = 1 - total.cdf(f.elapsedSec);
      const zero = f.quantilesSec.every((x: number) => x <= 1e-8);
      if (survival <= 1e-9) { cutoffs++; cutoffVisits.add(f.episodeId); positiveTailTruthSec += f.actualSec; }
      if (zero) {
        zeroForecasts++; zeroVisits.add(f.episodeId);
        if (survival > 1e-9) quantileClampWithoutCutoff++;
        if (examples.length < 20) examples.push({ episodeId: f.episodeId, routeId: f.routeId, stopId: f.stopId,
          elapsedSec: f.elapsedSec, actualRemainingSec: f.actualSec, survival, phaseWeight: pair.weight });
      }
    }
    results.push({ day, arm, visits: allVisits.size, points: forecasts.length, survivalCutoffPoints: cutoffs,
      survivalCutoffVisits: cutoffVisits.size, allZeroQuantilePoints: zeroForecasts, allZeroQuantileVisits: zeroVisits.size,
      allZeroWithoutSurvivalCutoff: quantileClampWithoutCutoff, cutoffMeanActualRemainingSec: cutoffs ? positiveTailTruthSec / cutoffs : null,
      fallbackVisits: fallback, examples });
  }
}
const output = path.join(base, "analytic", "post-lock-risk-audit.json");
fs.writeFileSync(output, JSON.stringify({ purpose: "Post-lock risk measurement only; no fitting, model changes, or selection", results }, null, 2));
console.log(JSON.stringify({ output, results: results.map(({ examples, ...r }) => r) }, null, 2));
