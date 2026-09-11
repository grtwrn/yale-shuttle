/**
 * Q2 (analysis) — ours vs upstream on the SAME (bus, stop, moment), and the
 * incremental information in upstream's number.
 *
 * Reads the rows `upstream-eta-align.ts` wrote (one per upstream prediction,
 * with our estimator's answer at the same poll and one truth for both) and:
 *
 *   1. coverage — where each arm has an answer at all;
 *   2. the paired error table, both arms, by TRUE horizon (the time the bus
 *      actually took — the only bucketing that is symmetric between two
 *      predictors), by route and by day; the correlation of the two errors,
 *      and how often upstream is the closer of the two;
 *   3. the increment — per bucket of upstream's promised horizon: the
 *      in-sample partial R² of upstream given ours (T ~ a + b·O vs
 *      T ~ a + b·O + c·U) and the OUT-OF-SAMPLE error of the best linear
 *      blend, fitted on one day and scored on another, against ours alone
 *      and against ours re-calibrated on the same fit day (so a gain that is
 *      really a bias correction is not credited to upstream);
 *   4. σ(h) — the spread of upstream's error by horizon, raw and after ours is
 *      partialled out, which is what a likelihood term would need.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York npx tsx scripts/eta-replay/upstream-eta-blend.ts
 *
 * Env: FILES (comma-separated JSONL, default the three days under REPLAY_OUT),
 *      TRUTH=det|prox (default det), ROUTES / EXCLUDE_ROUTES (comma-separated
 *      route ids — e.g. EXCLUDE_ROUTES=9,18 scores only the routes the ring
 *      estimator prices; Green and the grocery lines are the legacy
 *      arithmetic), TAG (suffix on the output names).
 */
import fs from "node:fs";
import path from "node:path";
import { HORIZONS, OUT_DIR, errStats, mdTable, openDb, quantile, r1, r2, r0, routeNames, writeJson, writeText } from "./upstream-eta-common.js";

const TRUTH = (process.env.TRUTH ?? "det") as "det" | "prox";
const files = (process.env.FILES ?? ["0904", "0905", "0906"].map((d) => path.join(OUT_DIR, `ours-${d}.jsonl`)).join(",")).split(",").filter((f) => fs.existsSync(f.trim()));
interface Row { id: number; day: string; bus: string; routeId: number; stopId: number; at: number; t: number; upSec: number; upHorizon: string; our: number | null; ourLow: number | null; ourHigh: number | null; ourWhy: string | null; atStop: boolean; moved: boolean; kind: string; det: number | null; prox: number | null; vanishedAt: number | null }
const ROUTES = process.env.ROUTES ? new Set(process.env.ROUTES.split(",").map(Number)) : null;
const EXCLUDE = new Set((process.env.EXCLUDE_ROUTES ?? "").split(",").filter(Boolean).map(Number));
const TAG = process.env.TAG ? `-${process.env.TAG}` : "";
const rows: Row[] = files.flatMap((f) => fs.readFileSync(f.trim(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row)).filter((r) => (!ROUTES || ROUTES.has(r.routeId)) && !EXCLUDE.has(r.routeId));
const names = routeNames(openDb());

interface P { day: string; routeId: number; horizon: string; upHorizon: string; U: number; O: number; T: number; TO: number; eU: number; eO: number; inside: boolean; upInside: boolean; atStop: boolean; moved: boolean }
const pairs: P[] = [];
for (const r of rows) {
  const truth = r[TRUTH];
  if (r.kind !== "arrived" || truth === null || r.our === null) continue;
  const T = (truth - r.at) / 1000; // actual seconds from upstream's instant
  const TO = (truth - r.t) / 1000; // actual seconds from our poll
  const h = T < 120 ? "0-2 min" : T < 300 ? "2-5 min" : T < 600 ? "5-10 min" : T < 1800 ? "10-30 min" : "30-45 min";
  pairs.push({ day: r.day, routeId: r.routeId, horizon: h, upHorizon: r.upHorizon, U: r.upSec, O: r.our, T, TO, eU: r.upSec - T, eO: r.our - TO, inside: r.ourLow! <= TO && TO <= r.ourHigh!, upInside: r.ourLow! <= r.upSec - (r.t - r.at) / 1000 && r.upSec - (r.t - r.at) / 1000 <= r.ourHigh!, atStop: r.atStop, moved: r.moved });
}
const TRUTH_H = ["0-2 min", "2-5 min", "5-10 min", "10-30 min", "30-45 min"];

// -- 1. coverage ------------------------------------------------------------------
const cov = { rows: rows.length, already: 0, missing: 0, missingVanished: 0, arrived: 0, ourNull: 0, ourNullBy: {} as Record<string, number>, paired: pairs.length };
for (const r of rows) {
  if (r.kind === "already") cov.already++;
  else if (r.kind === "missing") { cov.missing++; if (r.vanishedAt !== null) cov.missingVanished++; }
  else cov.arrived++;
  if (r.our === null) { cov.ourNull++; cov.ourNullBy[r.ourWhy ?? "?"] = (cov.ourNullBy[r.ourWhy ?? "?"] ?? 0) + 1; }
}
// Upstream's accuracy where WE had nothing (the coverage upstream would add).
const oursMissingUp = rows.filter((r) => r.kind === "arrived" && r.our === null && r[TRUTH] !== null).map((r) => r.upSec - (r[TRUTH]! - r.at) / 1000);

// -- 2. paired tables ---------------------------------------------------------------
function corr(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
const header = ["slice", "pairs", "arm", "signed p10", "signed p50", "signed p90", "|err| p50", "|err| p90", "≤60 s", "≤120 s", "opt ≥120 s", "pes ≥120 s", "corr(errors)", "upstream closer", "truth in our 10–90", "upstream in our 10–90"];
function pairRows(label: string, sel: readonly P[]): (string | number)[][] {
  const su = errStats(sel.map((p) => p.eU)), so = errStats(sel.map((p) => p.eO));
  const c = corr(sel.map((p) => p.eU), sel.map((p) => p.eO));
  const closer = sel.filter((p) => Math.abs(p.eU) < Math.abs(p.eO)).length;
  const inside = sel.filter((p) => p.inside).length, upInside = sel.filter((p) => p.upInside).length;
  const pc = (x: number) => (sel.length ? `${r1((100 * x) / sel.length)}%` : "–");
  const line = (arm: string, s: typeof su, extra: (string | number)[]) => [label, sel.length, arm, r0(s.p10), r0(s.p50), r0(s.p90), r0(s.absP50), r0(s.absP90), `${r1(s.within60)}%`, `${r1(s.within120)}%`, `${r1(s.opt120)}%`, `${r1(s.pes120)}%`, ...extra];
  return [line("upstream", su, [r2(c), pc(closer), pc(inside), pc(upInside)]), line("ours", so, ["", "", "", ""])];
}
const byTruthH = TRUTH_H.flatMap((h) => pairRows(h, pairs.filter((p) => p.horizon === h)));
byTruthH.push(...pairRows("all", pairs));
const byUpH = HORIZONS.flatMap((h) => pairRows(`promised ${h.label}`, pairs.filter((p) => p.upHorizon === h.label)));
const routes = [...new Set(pairs.map((p) => p.routeId))].sort((a, b) => a - b);
const byRoute = routes.flatMap((r) => pairRows(`${names.get(r)} (${r})`, pairs.filter((p) => p.routeId === r)));
const days = [...new Set(pairs.map((p) => p.day))].sort();
const byDay = days.flatMap((d) => pairRows(d, pairs.filter((p) => p.day === d)));
const byState = [...pairRows("bus at a stop (detector)", pairs.filter((p) => p.atStop)), ...pairRows("bus moving", pairs.filter((p) => !p.atStop))];

// -- 3. the increment ----------------------------------------------------------------
/** OLS for y ~ 1 + X (X columns). Returns coefficients. */
function ols(X: number[][], y: number[]): number[] {
  const n = X.length, k = X[0]!.length + 1;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const x = [1, ...X[i]!];
    for (let p = 0; p < k; p++) { b[p]! += x[p]! * y[i]!; for (let q = 0; q < k; q++) A[p]![q]! += x[p]! * x[q]!; }
  }
  // Gaussian elimination
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!]; [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c || A[c]![c] === 0) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let q = c; q < k; q++) A[r]![q]! -= f * A[c]![q]!;
      b[r]! -= f * b[c]!;
    }
  }
  return b.map((v, i) => (A[i]![i] ? v / A[i]![i]! : 0));
}
const predict = (coef: number[], x: number[]) => coef[0]! + x.reduce((s, v, i) => s + coef[i + 1]! * v, 0);
const sse = (errs: number[]) => errs.reduce((s, e) => s + e * e, 0);
const rmse = (errs: number[]) => Math.sqrt(sse(errs) / Math.max(1, errs.length));
interface Fit { n: number; coefO: number[]; coefOU: number[]; coefU: number[]; partialR2: number; r2O: number; r2OU: number; r2U: number }
function fit(sel: readonly P[]): Fit | null {
  if (sel.length < 50) return null;
  const y = sel.map((p) => p.T);
  const coefO = ols(sel.map((p) => [p.O]), y), coefOU = ols(sel.map((p) => [p.O, p.U]), y), coefU = ols(sel.map((p) => [p.U]), y);
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const sO = sse(sel.map((p, i) => predict(coefO, [p.O]) - y[i]!)), sOU = sse(sel.map((p, i) => predict(coefOU, [p.O, p.U]) - y[i]!)), sU = sse(sel.map((p, i) => predict(coefU, [p.U]) - y[i]!));
  return { n: sel.length, coefO, coefOU, coefU, partialR2: 1 - sOU / sO, r2O: 1 - sO / sst, r2OU: 1 - sOU / sst, r2U: 1 - sU / sst };
}
const fitHeader = ["bucket (upstream's promise)", "fit day", "n fit", "R² ours", "R² upstream", "R² both", "partial R² of upstream | ours", "blend weights (a + b·ours + c·upstream)"];
const scoreHeader = ["bucket (upstream's promise)", "fit → score", "n score", "ours raw: |err| p50 / RMSE / bias", "ours recalibrated", "blend", "upstream raw", "upstream recalibrated", "blend gain vs the better of raw / recalibrated ours (|err| p50)", "shrink w (fit day)", "shrink blend ours + w·(upstream − ours)", "shrink gain vs raw ours"];
const fitRows: (string | number)[][] = [], scoreRows: (string | number)[][] = [];
const buckets = [...HORIZONS.map((h) => h.label), "all"];
const folds: Array<[string, string]> = [];
for (const a of days) for (const b of days) if (a !== b) folds.push([a, b]);
const gains: Record<string, number[]> = {};
const shrinkGains: Record<string, number[]> = {};
const shrinkW: Record<string, number[]> = {};
for (const bk of buckets) {
  const inB = (p: P) => bk === "all" || p.upHorizon === bk;
  for (const d of days) {
    const f = fit(pairs.filter((p) => p.day === d && inB(p)));
    if (!f) continue;
    fitRows.push([bk, d, f.n, r2(f.r2O), r2(f.r2U), r2(f.r2OU), r2(f.partialR2), `${r0(f.coefOU[0]!)} + ${r2(f.coefOU[1]!)}·O + ${r2(f.coefOU[2]!)}·U`]);
  }
  for (const [a, b] of folds) {
    const f = fit(pairs.filter((p) => p.day === a && inB(p)));
    const test = pairs.filter((p) => p.day === b && inB(p));
    if (!f || test.length < 50) continue;
    const e = (g: (p: P) => number) => test.map((p) => g(p) - p.T);
    const eRaw = e((p) => p.O), eRec = e((p) => predict(f.coefO, [p.O])), eBl = e((p) => predict(f.coefOU, [p.O, p.U])), eU = e((p) => p.U), eUr = e((p) => predict(f.coefU, [p.U]));
    const st = (errs: number[]) => { const s = errStats(errs); return `${r0(s.absP50)} / ${r0(rmse(errs))} / ${r0(s.mean)}`; };
    const gain = Math.min(errStats(eRec).absP50, errStats(eRaw).absP50) - errStats(eBl).absP50;
    (gains[bk] ??= []).push(gain);
    // One-parameter shrink toward upstream: T − O ≈ w·(U − O), no intercept.
    // Immune to the day-to-day route mix that an intercept + slope absorbs,
    // and it is the form a likelihood term would take (w = the posterior
    // weight of upstream's number).
    const fitSel = pairs.filter((p) => p.day === a && inB(p));
    let num = 0, den = 0;
    for (const p of fitSel) { const d = p.U - p.O; num += d * (p.T - p.O); den += d * d; }
    const w = den ? num / den : 0;
    const eSh = e((p) => p.O + w * (p.U - p.O));
    const sGain = errStats(eRaw).absP50 - errStats(eSh).absP50;
    (shrinkGains[bk] ??= []).push(sGain);
    (shrinkW[bk] ??= []).push(w);
    scoreRows.push([bk, `${a} → ${b}`, test.length, st(eRaw), st(eRec), st(eBl), st(eU), st(eUr), `${gain >= 0 ? "+" : ""}${r0(gain)} s`, r2(w), st(eSh), `${sGain >= 0 ? "+" : ""}${r0(sGain)} s`]);
  }
}

// Per-route folds, all buckets pooled — the routes the model is weakest on are where an increment would show.
const routeFoldHeader = ["route", "fit → score", "n score", "ours raw |err| p50", "ours recalibrated", "blend", "upstream raw", "blend gain vs better ours (s)", "shrink w", "shrink blend", "shrink gain vs raw (s)", "partial R² (fit day)"];
const routeFoldRows: (string | number)[][] = [];
for (const r of routes) {
  for (const [a, b] of folds) {
    const f = fit(pairs.filter((p) => p.day === a && p.routeId === r));
    const test = pairs.filter((p) => p.day === b && p.routeId === r);
    if (!f || test.length < 50) continue;
    const e = (g: (p: P) => number) => test.map((p) => g(p) - p.T);
    const raw = errStats(e((p) => p.O)).absP50, rec = errStats(e((p) => predict(f.coefO, [p.O]))).absP50, bl = errStats(e((p) => predict(f.coefOU, [p.O, p.U]))).absP50, u = errStats(e((p) => p.U)).absP50;
    let num = 0, den = 0;
    for (const p of pairs.filter((p) => p.day === a && p.routeId === r)) { const d = p.U - p.O; num += d * (p.T - p.O); den += d * d; }
    const w = den ? num / den : 0;
    const sh = errStats(e((p) => p.O + w * (p.U - p.O))).absP50;
    const g = Math.min(raw, rec) - bl;
    routeFoldRows.push([`${names.get(r)} (${r})`, `${a} → ${b}`, test.length, r0(raw), r0(rec), r0(bl), r0(u), `${g >= 0 ? "+" : ""}${r0(g)}`, r2(w), r0(sh), `${raw - sh >= 0 ? "+" : ""}${r0(raw - sh)}`, r2(f.partialR2)]);
  }
}

// -- 4. σ(h) ----------------------------------------------------------------------------
const sigHeader = ["bucket (upstream's promise)", "n", "σ of upstream's error (SD)", "robust σ (1.4826·MAD)", "σ of upstream's error after ours is partialled out", "corr(errors)", "σ of OUR error (SD)", "robust σ of our error"];
const sigRows = HORIZONS.map((h) => {
  const sel = pairs.filter((p) => p.upHorizon === h.label);
  if (sel.length < 50) return [h.label, sel.length, "–", "–", "–", "–", "–"];
  const eU = sel.map((p) => p.eU);
  const m = eU.reduce((s, v) => s + v, 0) / eU.length;
  const sd = Math.sqrt(eU.reduce((s, v) => s + (v - m) ** 2, 0) / eU.length);
  const med = quantile([...eU].sort((a, b) => a - b), 0.5);
  const mad = quantile(eU.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5) * 1.4826;
  const coef = ols(sel.map((p) => [p.eO]), eU);
  const res = sel.map((p) => p.eU - predict(coef, [p.eO]));
  const rm = res.reduce((s, v) => s + v, 0) / res.length;
  const rsd = Math.sqrt(res.reduce((s, v) => s + (v - rm) ** 2, 0) / res.length);
  const eO = sel.map((p) => p.eO);
  const mo = eO.reduce((s, v) => s + v, 0) / eO.length;
  const sdO = Math.sqrt(eO.reduce((s, v) => s + (v - mo) ** 2, 0) / eO.length);
  const medO = quantile([...eO].sort((a, b) => a - b), 0.5);
  const madO = quantile(eO.map((v) => Math.abs(v - medO)).sort((a, b) => a - b), 0.5) * 1.4826;
  return [h.label, sel.length, r0(sd), r0(mad), r0(rsd), r2(corr(eU, eO)), r0(sdO), r0(madO)];
});

const md = [
  `# Q2 — ours vs upstream at the same moments (truth: ${TRUTH === "det" ? "detector" : "proximity"}${ROUTES ? `; routes ${[...ROUTES].join(",")}` : ""}${EXCLUDE.size ? `; excluding routes ${[...EXCLUDE].join(",")}` : ""})`,
  ``,
  `Files: ${files.map((f) => path.basename(f)).join(", ")}. Rows = upstream predictions; a PAIR is a row where the bus's arrival was detected within 45 min and our client priced the same stop at the nearest poll (≤ 12.5 s away). Error = predicted − actual, negative = optimistic; each arm's actual is measured from its own instant. Upstream is whole minutes (±30 s rounding).`,
  ``,
  `## Coverage`,
  ``,
  mdTable(["upstream rows", "bus already there", "did not arrive (vanished)", "arrived", "ours had no number", "…by reason", "pairs"], [[cov.rows, cov.already, `${cov.missing} (${cov.missingVanished})`, cov.arrived, cov.ourNull, Object.entries(cov.ourNullBy).map(([k, v]) => `${k} ${v}`).join(", "), cov.paired]]),
  ``,
  `Where WE had no number and the bus did arrive (${oursMissingUp.length} rows): upstream's |err| p50 ${r0(errStats(oursMissingUp).absP50)} s, signed p50 ${r0(errStats(oursMissingUp).p50)} s.`,
  ``,
  `## Paired errors — by TRUE horizon (how long the bus actually took)`,
  ``,
  mdTable(header, byTruthH),
  ``,
  `## Paired errors — by upstream's promised horizon (the Q1 bucketing; conditions on upstream's own number, so it flatters neither arm evenly)`,
  ``,
  mdTable(header, byUpH),
  ``,
  `## Paired errors — by route`,
  ``,
  mdTable(header, byRoute),
  ``,
  `## Paired errors — by day, and by bus state`,
  ``,
  mdTable(header, [...byDay, ...byState]),
  ``,
  `## The increment — in-sample fits per day (T = actual seconds; O = ours; U = upstream)`,
  ``,
  mdTable(fitHeader, fitRows),
  ``,
  `## The increment — fitted on one day, scored on another (never the same day)`,
  ``,
  `"recalibrated" = a + b·O fitted on the fit day; "blend" = a + b·O + c·U on the fit day; "shrink" = O + w·(U − O) with w fitted on the fit day (no intercept — the form a likelihood term takes, and immune to the day-to-day route mix an intercept absorbs). Gains are on the score day, against the better of raw and recalibrated ours (full blend) or raw ours (shrink). |err| p50 / RMSE / mean signed, seconds.`,
  ``,
  mdTable(scoreHeader, scoreRows),
  ``,
  mdTable(["bucket", "folds", "full blend: median gain vs better ours (s)", "range", "shrink blend: median gain vs raw ours (s)", "range", "shrink w: median", "range"], buckets.map((bk) => { const g = (gains[bk] ?? []).sort((a, b) => a - b); const sg = (shrinkGains[bk] ?? []).sort((a, b) => a - b); const w = (shrinkW[bk] ?? []).sort((a, b) => a - b); const rng = (x: number[], f: (v: number) => string) => (x.length ? `${f(x[0]!)} .. ${f(x[x.length - 1]!)}` : "–"); return [bk, g.length, g.length ? r0(quantile(g, 0.5)) : "–", rng(g, r0), sg.length ? r0(quantile(sg, 0.5)) : "–", rng(sg, r0), w.length ? r2(quantile(w, 0.5)) : "–", rng(w, r2)]; })),
  ``,
  `## The increment — per route, fitted on one day and scored on another (all horizons pooled)`,
  ``,
  mdTable(routeFoldHeader, routeFoldRows),
  ``,
  `## σ(h) — what a likelihood term on upstream's number would carry`,
  ``,
  mdTable(sigHeader, sigRows),
  ``,
].join("\n");
writeText(`blend-${TRUTH}${TAG}.md`, md);
writeJson(`blend-${TRUTH}${TAG}.json`, { coverage: cov, pairs: pairs.length, gains, byTruthHorizon: Object.fromEntries(TRUTH_H.map((h) => { const s = pairs.filter((p) => p.horizon === h); return [h, { n: s.length, upstream: errStats(s.map((p) => p.eU)), ours: errStats(s.map((p) => p.eO)), corr: corr(s.map((p) => p.eU), s.map((p) => p.eO)) }]; })), all: { upstream: errStats(pairs.map((p) => p.eU)), ours: errStats(pairs.map((p) => p.eO)), corr: corr(pairs.map((p) => p.eU), pairs.map((p) => p.eO)) } });
console.log(md);
