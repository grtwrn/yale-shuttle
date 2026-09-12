#!/usr/bin/env node
/**
 * Coverage and width of the client's own 10-90 band, from a gps-replay
 * `PAIRS_OUT` file that carries `dn` (the drive floor, arrival.ts `departNow`).
 *
 *   node scripts/eta-replay/band-coverage.mjs pairs.jsonl [--w '{"0-2":1,...}']
 *        [--floor none|dn|fl|sl] [--truth det|prox] [--routes 3,1] [--fit]
 *        [--min-shown-min 3]
 *
 * The band is scored exactly as `eta/arrival.ts` builds it: widened about the
 * shown number by the per-horizon factor (`widenBand`), then — with
 * `--floor dn` / `--floor fl` — its low end floored at `departNow` / at the
 * rest-less chain's q10 (`lowFloor`), neither of which the client applies
 * (the measurement in arrival.ts `lowFloor` is why) — or, with `--floor sl`,
 * at the card's own STANDING floor (`sl`, etaBand.ts `standingLowFloor`:
 * departNow + the shortest stand left; null for a moving bus). `--fit` prints, per
 * horizon, the factor the ceil((n+1)·0.8)-th pair needs (reestimate-lib.mjs
 * `conformalFit`), under the same floor, so a factor fitted here is one the
 * client would reproduce.
 *
 * Rows: per route (and pooled) × horizon (by the SHOWN eta, the scorecard's
 * buckets) × standing (feed `atStop`) / moving. Columns: n, coverage %, early
 * % (truth before low), late %, median width s, median shown-width in whole
 * minutes, and the share of rows whose displayed width reaches
 * `--min-shown-min` (what the display rule would print as a range).
 */
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const W = JSON.parse(opt("--w", '{"0-2":1,"2-5":1,"5-10":1,"10-30":1}'));
const FLOOR = opt("--floor", "none");
const TRUTH = opt("--truth", "det");
const ROUTES = opt("--routes", "3,1").split(",").map(Number);
const FIT = args.includes("--fit");
const BY_WIDTH = args.includes("--by-width");
/**
 * `--by-margin`: bucket by the PRINTED MARGIN, `high - eta` after widening —
 * the quantity a "by HH:MM" promise actually gates on (etaBand.ts
 * `arriveByClock`), as opposed to `--by-width`'s `high - low`. They are
 * adjacent questions and only this one answers "how often is the promise
 * late, among the rows where the promise is even printed". Prints both the
 * per-bucket rows and the CUMULATIVE `>=T` rows, which are the decision table
 * for choosing T.
 */
const BY_MARGIN = args.includes("--by-margin");
const MIN_SHOWN = Number(opt("--min-shown-min", "3"));
const H = ["0-2", "2-5", "5-10", "10-30"];

function horizonOf(sec) {
  if (!(sec <= 1800)) return null;
  const m = sec / 60;
  return m < 2 ? "0-2" : m < 5 ? "2-5" : m < 10 ? "5-10" : "10-30";
}
const fmtMinN = (s) => (s < 10 ? 0 : s < 60 ? 0.5 : Math.floor(s / 60));

function band(p, w) {
  let low = p.eta - (p.eta - p.low) * w, high = p.eta + (p.high - p.eta) * w;
  if (FLOOR === "dn") low = Math.max(low, p.dn);
  if (FLOOR === "fl") low = Math.max(low, p.fl);
  if (FLOOR === "sl" && p.sl != null) low = Math.max(low, p.sl);
  low = Math.min(low, p.eta); high = Math.max(high, p.eta);
  return [low, high];
}

const med = (v) => { if (!v.length) return null; const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
const pc = (x, n) => (n ? (100 * x / n).toFixed(1) : "-");
const order = [...ROUTES.map(String), "pooled"];

const cells = new Map();
const cell = (route, h, mode) => {
  const key = `${route}|${h}|${mode}`;
  let c = cells.get(key);
  if (!c) cells.set(key, (c = { route, h, mode, n: 0, inside: 0, early: 0, late: 0, beatsDn: 0, etaBelowDn: 0, widths: [], shown: [], need: [] }));
  return c;
};

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const p = JSON.parse(line);
  const a = p[TRUTH];
  if (a == null) continue;
  if (p.dn == null || (FLOOR === "fl" && p.fl == null)) throw new Error("pairs file has no `dn`/`fl` — replay with the departNow/lowFloor writer");
  const h = horizonOf(p.eta);
  if (!h) continue;
  const routes = ROUTES.includes(p.r) ? [String(p.r), "pooled"] : ["pooled"];
  const mode = p.atStop ? "standing" : "moving";
  const [low, high] = band(p, W[h] ?? 1);
  // The factor this pair NEEDS (conformal), under the floor.
  let need;
  if (a > p.eta) need = p.high > p.eta ? (a - p.eta) / (p.high - p.eta) : Infinity;
  else if (a < p.eta) {
    if ((FLOOR === "dn" && a < p.dn) || (FLOOR === "fl" && a < p.fl) || (FLOOR === "sl" && p.sl != null && a < p.sl)) need = Infinity;
    else need = p.low < p.eta ? (p.eta - a) / (p.eta - p.low) : Infinity;
  } else need = 0;
  for (const r of routes) for (const m of [mode, "all"]) {
    const c = cell(r, h, m);
    c.n++;
    if (a < low) c.early++; else if (a > high) c.late++; else c.inside++;
    if (a < p.dn) c.beatsDn++;
    if (p.eta < p.dn - 0.5) c.etaBelowDn++;
    c.widths.push(high - low);
    c.shown.push(fmtMinN(high) - fmtMinN(low));
    c.need.push(need);
  }
  if (BY_MARGIN) {
    const marginSec = Math.max(0, high - p.eta);
    const b = Math.min(8, Math.floor(marginSec / 60));
    for (const r of routes) for (const m of [mode, "all"]) {
      const c = cell(r, `margin=${b}`, m);
      c.n++; if (a < low) c.early++; else if (a > high) c.late++; else c.inside++;
      c.widths.push(high - low); c.shown.push(fmtMinN(high) - fmtMinN(low)); c.need.push(need);
      // Cumulative: every threshold this pair would clear.
      for (let T = 1; T <= 8; T++) {
        if (b < T) continue;
        const cc = cell(r, `ge${T}`, m);
        cc.n++; if (a < low) cc.early++; else if (a > high) cc.late++; else cc.inside++;
        cc.widths.push(high - low); cc.shown.push(fmtMinN(high) - fmtMinN(low)); cc.need.push(need);
      }
    }
  }
  if (BY_WIDTH) {
    const shown = fmtMinN(high) - fmtMinN(low);
    const wb = shown < 1 ? "<1" : shown < 2 ? "1" : shown < 3 ? "2" : shown < 4 ? "3" : shown < 6 ? "4-5" : "6+";
    for (const r of routes) {
      const c = cell(r, "width=" + wb, mode);
      c.n++; if (a < low) c.early++; else if (a > high) c.late++; else c.inside++;
      c.widths.push(high - low); c.shown.push(shown); c.need.push(need);
    }
  }
}
if (BY_MARGIN) {
  console.log(`late share by PRINTED MARGIN (high - eta, after widening) — the gate a "by" promise uses, ${FLOOR}:`);
  for (const r of order) for (const b of [0, 1, 2, 3, 4, 5, 6, 7, 8]) for (const m of ["all"]) {
    const c = cells.get(`${r}|margin=${b}|${m}`);
    if (!c) continue;
    console.log(`  ${r.padEnd(7)} margin ${String(b).padEnd(2)}${b === 8 ? "+" : " "} ${m.padEnd(9)} n=${String(c.n).padStart(6)}  late ${pc(c.late, c.n).padStart(5)}%  cover ${pc(c.inside, c.n).padStart(5)}%`);
  }
  console.log(`\nCUMULATIVE — late share among pairs the promise WOULD print at margin >= T:`);
  for (const r of order) for (let T = 1; T <= 8; T++) for (const m of ["all"]) {
    const c = cells.get(`${r}|ge${T}|${m}`);
    if (!c) continue;
    console.log(`  ${r.padEnd(7)} >=${T}min ${m.padEnd(9)} n=${String(c.n).padStart(6)}  late ${pc(c.late, c.n).padStart(5)}%  cover ${pc(c.inside, c.n).padStart(5)}%`);
  }
}
if (BY_WIDTH) {
  console.log(`coverage by DISPLAYED width (whole minutes between the two printed ends), ${FLOOR}:`);
  for (const r of order) for (const wb of ["<1", "1", "2", "3", "4-5", "6+"]) for (const m of ["standing", "moving"]) {
    const c = cells.get(`${r}|width=${wb}|${m}`);
    if (!c) continue;
    console.log(`  ${r.padEnd(7)} width ${wb.padEnd(4)} ${m.padEnd(9)} n=${String(c.n).padStart(6)}  cover ${pc(c.inside, c.n).padStart(5)}%  early ${pc(c.early, c.n).padStart(5)}%  late ${pc(c.late, c.n).padStart(5)}%`);
  }
}

console.log(`file ${file}  truth ${TRUTH}  floor ${FLOOR}  w ${JSON.stringify(W)}`);
console.log(`route   horizon  mode      n      cover%  early%  late%  beatsDn%  eta<dn%  medW(s)  medShown(min)  >=${MIN_SHOWN}min%`);
for (const r of order) for (const h of H) for (const m of ["standing", "moving", "all"]) {
  const c = cells.get(`${r}|${h}|${m}`);
  if (!c) continue;
  const share = pc(c.shown.filter((x) => x >= MIN_SHOWN).length, c.n);
  console.log(`${r.padEnd(7)} ${h.padEnd(8)} ${m.padEnd(9)} ${String(c.n).padStart(6)}  ${pc(c.inside, c.n).padStart(6)}  ${pc(c.early, c.n).padStart(6)}  ${pc(c.late, c.n).padStart(5)}  ${pc(c.beatsDn, c.n).padStart(8)}  ${pc(c.etaBelowDn, c.n).padStart(7)}  ${String(Math.round(med(c.widths))).padStart(7)}  ${String(med(c.shown)).padStart(13)}  ${share.padStart(8)}`);
}
if (FIT) {
  console.log(`\nconformal factor to reach 80% (floor ${FLOOR}), per route x horizon over all modes:`);
  for (const r of order) for (const h of H) {
    const c = cells.get(`${r}|${h}|all`);
    if (!c) continue;
    const v = [...c.need].sort((x, y) => x - y);
    const k = Math.min(v.length - 1, Math.ceil((v.length + 1) * 0.8) - 1);
    const inf = v.filter((x) => !Number.isFinite(x)).length;
    console.log(`  ${r.padEnd(7)} ${h.padEnd(6)} w=${Number.isFinite(v[k]) ? v[k].toFixed(3) : "inf"}  n=${v.length}  infinite=${inf} (${pc(inf, v.length)}%)`);
  }
}
