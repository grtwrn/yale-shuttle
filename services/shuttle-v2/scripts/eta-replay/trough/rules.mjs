/**
 * Display rules, scored OFFLINE against one replay.
 *
 * The #119 ceiling changes only the number a row SHOWS — never the belief, the
 * tables or the mixture — so every candidate rule is a function of the traced
 * per-poll fields (`decompose.ts`), and master, the candidate and any variant
 * can be scored from ONE replay instead of one replay each. The `on` arm of the
 * replay is then a CHECK on this arithmetic, not the measurement itself.
 *
 *   DATA=../../.eta-replay/trough node rules.mjs 2026-09-04 2026-09-10 2026-09-11
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DATA ?? ".";
const days = process.argv.slice(2);
const SURE = 0.8; // LEAD_SWITCH_MASS
const gone = (r) => r.leadMass - r.standMass;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (a, f) => (100 * a.filter(f).length / Math.max(1, a.length)).toFixed(1);
const f0 = (x) => Number.isFinite(x) ? x.toFixed(0) : "-";

/** master: every poll may lower the ceiling. */
function master(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) { c = Math.min(c, r.mixture); out.push(c); }
  return out;
}
/** C — only a poll SURE the rest continues may write the ceiling; every poll shows min(ceiling, mixture). */
function ruleC(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) {
    const shown = Math.min(c, r.mixture);
    if (r.standMass >= SURE) c = shown;
    out.push(shown);
  }
  return out;
}
/** D — as C, and an UNSURE poll shows the ceiling it may not write (so the shown number still never climbs). */
function ruleD(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) {
    if (r.standMass >= SURE) { c = Math.min(c, r.mixture); out.push(c); }
    else out.push(Math.min(c, Number.isFinite(c) ? c : r.mixture));
  }
  return out;
}
/**
 * The gate can be read two ways, and they differ on a poll whose mass is
 * simply SPREAD (a fresh rest, a cold belief) rather than split between
 * standing and departed:
 *   sureStand — the rest's own mass carries LEAD_SWITCH_MASS of the cluster;
 *   sureGone  — the DEPARTURE hypothesis (the cluster's mass not standing at
 *               the rest) is under 1 - LEAD_SWITCH_MASS. This is the one the
 *               defect names: it blocks only a poll that half-believes the bus
 *               has left.
 */
function ruleCG(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) { const shown = Math.min(c, r.mixture); if (gone(r) <= 1 - SURE) c = shown; out.push(shown); }
  return out;
}
function ruleDG(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) {
    if (gone(r) <= 1 - SURE) { c = Math.min(c, r.mixture); out.push(c); }
    else out.push(Number.isFinite(c) ? c : r.mixture);
  }
  return out;
}
/**
 * B — the ceiling is the running minimum of the STANDING variant's own price,
 * and the row shows `min(ceiling, mixture)` as always. No gate and no new
 * constant: #119's ceiling is a statement about the STAND ("the remaining
 * stand may not grow because time has passed"), so it is measured on the
 * stand's own price rather than on a mixture that also carries the hypothesis
 * that the stand is over.
 */
function ruleB(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) { c = Math.min(c, Number.isFinite(r.standing) ? r.standing : r.mixture); out.push(Math.min(c, r.mixture)); }
  return out;
}
/**
 * R — the stand's own ceiling (B), non-increasing between two polls that agree
 * the bus is standing, and free to recover on the poll after a departure
 * hypothesis is withdrawn. So B's per-poll wobble is suppressed and the one
 * recovery that matters is kept.
 */
function ruleR(rs) {
  let c = Infinity, shown = Infinity, prevUnsure = true; const out = [];
  for (const r of rs) {
    c = Math.min(c, Number.isFinite(r.standing) ? r.standing : r.mixture);
    const base = Math.min(c, r.mixture);
    shown = prevUnsure ? base : Math.min(base, shown);
    prevUnsure = gone(r) > 1 - SURE;
    out.push(shown);
  }
  return out;
}
/** DG', an unsure poll holds the last SHOWN number (never the raw ceiling). */
/**
 * H — what `arrival.ts` now DOES: a poll with a live departure hypothesis shows
 * the ceiling and writes nothing; every other poll is master. (`DG` above is
 * the same rule with no ceiling written before the first sure poll, which is
 * the one place the two can differ.)
 */
function ruleH(rs) {
  let c = Infinity; const out = [];
  for (const r of rs) {
    if (Number.isFinite(c) && gone(r) > 1 - SURE) { out.push(c); continue; }
    c = Math.min(c, r.mixture); out.push(c);
  }
  return out;
}
const RULES = { master, H: ruleH, B: ruleB, C: ruleC, D: ruleD, CG: ruleCG, DG: ruleDG, R: ruleR };

const rests = [];
for (const d of days) {
  const rows = JSON.parse(fs.readFileSync(path.join(DIR, `dec-arch-${d}-off.json`), "utf8")).rows;
  const byRest = new Map();
  for (const r of rows) { const k = `${d}|${r.bus}|${r.clampAt}|${r.since}`; if (!byRest.has(k)) byRest.set(k, []); byRest.get(k).push(r); }
  for (const [k, rs] of byRest) {
    rs.sort((a, b) => a.t - b.t);
    rests.push({ key: k, day: d, rows: rs, durSec: (rs[rs.length - 1].t - rs[0].t) / 1000 });
  }
}
const LONG = rests.filter((x) => x.durSec >= 300 && x.rows[0].mixture < 1200);
console.log(`rests: ${rests.length} total, ${LONG.length} lasting >= 300 s within sight of the target stop\n`);

function score(name, sel, label) {
  const per = {};
  for (const [rn, fn] of Object.entries(RULES)) {
    const errs = [], rises = [], deltas = [];
    let changed = 0, rows = 0, risesBig = 0, restsWithBig = 0, restsWithAny = 0, maxRise = 0;
    for (const x of sel) {
      const shown = fn(x.rows), base = master(x.rows);
      let big = false, any = false;
      for (let i = 0; i < x.rows.length; i++) {
        const r = x.rows[i];
        rows++;
        if (Math.abs(shown[i] - base[i]) > 0.5) changed++;
        if (r.actual !== undefined) errs.push(shown[i] - r.actual);
        if (i > 0 && shown[i] > shown[i - 1] + 0.5) {
          const rise = shown[i] - shown[i - 1];
          rises.push(rise); any = true; maxRise = Math.max(maxRise, rise);
          if (rise >= 180) { risesBig++; big = true; }
        }
        deltas.push(shown[i] - base[i]);
      }
      if (big) restsWithBig++;
      if (any) restsWithAny++;
    }
    per[rn] = { errs, rows, changed, rises, risesBig, restsWithBig, restsWithAny, maxRise, n: sel.length };
  }
  console.log(`## ${label} — ${sel.length} rests, ${per.master.rows} rows`);
  console.log(`rule   | n     medSigned medAbs  waitsLonger>=120 busBeat>=120 | rises/rest rises>=180 rests w/ >=180 maxRise | rows changed`);
  for (const [rn, p] of Object.entries(per)) {
    console.log(`${rn.padEnd(6)} | ${String(p.errs.length).padStart(5)} ${f0(q(p.errs, .5)).padStart(9)} ${f0(q(p.errs.map(Math.abs), .5)).padStart(6)} ${pct(p.errs, (e) => e <= -120).padStart(15)}% ${pct(p.errs, (e) => e >= 120).padStart(11)}% | ${(p.rises.length / Math.max(1, p.n)).toFixed(2).padStart(10)} ${String(p.risesBig).padStart(10)} ${String(p.restsWithBig).padStart(14)} ${f0(p.maxRise).padStart(7)} | ${(100 * p.changed / Math.max(1, p.rows)).toFixed(1)}%`);
  }
  console.log();
}
// CHECK: the replayed `on` arm must equal ruleC computed offline, row for row.
for (const d of days) {
  let on;
  try { on = JSON.parse(fs.readFileSync(path.join(DIR, `dec-arch-${d}-on.json`), "utf8")).rows; } catch { continue; }
  const key = (r) => `${r.t}|${r.bus}|${r.stopIdx}|${r.occurrence}`;
  const m = new Map(on.map((r) => [key(r), r]));
  let n = 0, bad = 0, worst = 0;
  for (const x of rests.filter((x) => x.day === d)) {
    const c = ruleH(x.rows);
    for (let i = 0; i < x.rows.length; i++) {
      const o = m.get(key(x.rows[i])); if (!o) continue;
      n++; const dd = Math.abs(o.shown - c[i]); if (dd > 1.5) { bad++; worst = Math.max(worst, dd); }
    }
  }
  console.log(`check ${d}: ruleH offline vs the replayed on arm — ${n} rows paired, ${bad} disagree (worst ${f0(worst)} s)`);
}
console.log();
score("long", LONG, "rests >= 300 s in sight of the target (the layovers)");
score("all", rests, "every rest priced from the target stops");
// per-rest, the candidate against master
console.log(`per rest (>= 300 s): day bus start | stand | master medErr -> C -> D | rises>=180 C/D | max rise C/D`);
const et = (t) => new Date(t - 4 * 3600e3).toISOString().slice(11, 19);
for (const x of LONG) {
  const b = master(x.rows), c = ruleC(x.rows), d = ruleD(x.rows);
  const e = (arr) => f0(q(x.rows.map((r, i) => r.actual === undefined ? NaN : arr[i] - r.actual).filter(Number.isFinite), .5));
  const bigs = (arr) => { let n = 0, m = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i - 1] + 0.5) { m = Math.max(m, arr[i] - arr[i - 1]); if (arr[i] - arr[i - 1] >= 180) n++; } return [n, m]; };
  const [bc, mc] = bigs(c), [bd, md] = bigs(d);
  const stand = x.rows[0].standEnd && x.rows[0].standStart ? (x.rows[0].standEnd - x.rows[0].standStart) / 1000 : NaN;
  console.log(`${x.day} ${x.rows[0].bus} ${et(x.rows[0].t)} | ${f0(stand).padStart(5)} | ${e(b).padStart(5)} -> ${e(c).padStart(5)} -> ${e(d).padStart(5)} | ${bc}/${bd} | ${f0(mc).padStart(4)}/${f0(md).padStart(4)}`);
}
// the departure: how stale is D on the polls after the rest's last SURE poll
let tail = [];
for (const x of rests) {
  let lastSure = -1;
  for (let i = 0; i < x.rows.length; i++) if (x.rows[i].standMass >= SURE) lastSure = i;
  tail.push(x.rows.length - 1 - lastSure);
}
// THE DEPARTURE: how many polls pass between the MIXTURE falling by >=120 s
// below what was shown and the shown number following it down. Master is 0 by
// construction (it shows the mixture whenever the mixture is the minimum).
console.log(`\ndeparture latency (polls between the mixture dropping >=120 s under the shown number and the shown number following):`);
for (const [rn, fn] of Object.entries(RULES)) {
  const lat = []; let never = 0;
  for (const x of rests) {
    const shown = fn(x.rows);
    for (let i = 0; i < x.rows.length; i++) {
      if (shown[i] - x.rows[i].mixture < 120) continue;
      let j = i; while (j < x.rows.length && shown[j] - x.rows[j].mixture >= 120) j++;
      if (j >= x.rows.length) { never++; lat.push(x.rows.length - i); } else lat.push(j - i);
      break;
    }
  }
  console.log(`  ${rn.padEnd(6)} episodes ${String(lat.length).padStart(4)}  median ${f0(q(lat, .5))} p90 ${f0(q(lat, .9))} max ${f0(Math.max(0, ...lat))} polls; never caught up in ${never}`);
}
console.log(`\npolls after a rest's last SURE poll (what rule D shows from the ceiling rather than the mixture): median ${f0(q(tail, .5))} p90 ${f0(q(tail, .9))} max ${f0(Math.max(...tail))} (5 s a poll)`);
