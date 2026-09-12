/**
 * Summarise and PAIR the arms of `layover.ts`, row by row.
 *
 * Both arms replay the same polls with the same truth, so a row pairs on
 * (instant, bus, stop) and a difference is the covariate, not the day.
 *
 * A "layover rest" can be read two ways and they are NOT the same on every
 * line, so both are printed:
 *   arrivals — `arrived_at -> departed_at`, which is ANCHOR RESIDENCE time
 *              (CLAUDE.md: `arrivals.dwell_sec` is not standing time);
 *   visit    — `stop_visits.pinned_at -> departed_at`, which is the span the
 *              served stand table `q` is measured from.
 * On Red they agree (344 Winchester is a real layover on the marker). On Blue
 * Night they do not: Peabody Museum shows an 8-minute arrivals span with a
 * served `q50` of 0 s and `pstop` 0.54, i.e. the bus is often rolling through.
 *
 *   DATA=../../.eta-replay/postlap node summarise.mjs arch-r13-2026-09-10.tsv \
 *     lay-arch-r13-2026-09-10-off13.json lay-arch-r13-2026-09-10-on.json
 *
 * The FIRST arm named is the baseline; each later one is compared against it.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DATA ?? ".";
const REST_MIN = Number(process.env.REST_MIN ?? 300);
const [tsv, ...armFiles] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(path.join(DIR, "buses_now.json"), "utf8"));
const arms = armFiles.map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));
const seq = payload.routes[String(arms[0].route)];
const name = (sid) => String(payload.stop_names?.[sid] ?? sid);

/** stop_visits spans, per bus and stop, for the visit-based rest length. */
const visits = new Map();
for (const l of fs.readFileSync(path.join(DIR, tsv), "utf8").split("\n")) {
  if (!l || l[1] !== "\t" || l[0] !== "V") continue;
  const v = JSON.parse(l.slice(2));
  if (v.pinned_at == null) continue;
  const k = `${String(v.bus_name).replace(/^#/, "")}|${v.stop_id}`;
  if (!visits.has(k)) visits.set(k, []);
  visits.get(k).push(v);
}
for (const l of visits.values()) l.sort((a, b) => a.pinned_at - b.pinned_at);
function visitSpan(bus, stopId, at) {
  const l = visits.get(`${String(bus).replace(/^#/, "")}|${stopId}`); if (!l) return NaN;
  for (const v of l) {
    const end = v.departed_at ?? at;
    if (v.pinned_at - 120e3 <= at && at <= end + 120e3) return (end - v.pinned_at) / 1000;
  }
  return NaN;
}
for (const a of arms) for (const r of a.rows) {
  r.arrSpan = r.standEnd != null && r.standStart != null ? (r.standEnd - r.standStart) / 1000 : NaN;
  r.visSpan = r.clampAt >= 0 ? visitSpan(r.bus, seq[r.clampAt], r.t) : NaN;
}
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f0 = (x) => Number.isFinite(x) ? x.toFixed(0) : "-";
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : "-";
const key = (r) => `${r.t}|${r.bus}|${r.stopIdx}`;

function stats(rs) {
  const errs = rs.map((r) => r.shown - r.actual);
  const pos = rs.filter((r) => r.actual > r.shown);
  const sumR = pos.reduce((x, r) => x + Math.max(0, r.mixture - r.shown), 0);
  const sumT = pos.reduce((x, r) => x + (r.actual - r.shown), 0);
  return {
    n: rs.length, rests: new Set(rs.map((r) => `${r.bus}|${r.clampAt}|${r.since}`)).size,
    signed: q(errs, 0.5), abs: q(errs.map(Math.abs), 0.5),
    wait120: 100 * errs.filter((e) => e <= -120).length / Math.max(1, rs.length),
    early120: 100 * errs.filter((e) => e >= 120).length / Math.max(1, rs.length),
    ratchet: 100 * sumR / Math.max(1, sumT), est: 100 * (sumT - sumR) / Math.max(1, sumT),
    medDef: q(pos.map((r) => r.actual - r.shown), 0.5),
    medRatchet: q(pos.map((r) => Math.max(0, r.mixture - r.shown)), 0.5),
    medEst: q(pos.map((r) => Math.max(0, r.actual - r.mixture)), 0.5),
    lapF: q(rs.map((r) => r.lapF), 0.5), resid: q(rs.map((r) => r.residualMed), 0.5),
  };
}
function row(label, s) {
  console.log(`${label.padEnd(40)} | ${String(s.n).padStart(5)} ${String(s.rests).padStart(3)} | ${f0(s.signed).padStart(6)} ${f0(s.abs).padStart(5)} | ${f1(s.wait120).padStart(5)}% ${f1(s.early120).padStart(5)}% | ${f1(s.ratchet).padStart(5)}% ${f1(s.est).padStart(5)}% | ${f0(s.medDef).padStart(4)} ${f0(s.medRatchet).padStart(4)} ${f0(s.medEst).padStart(4)} | ${f1(s.lapF)} ${f0(s.resid).padStart(4)}`);
}
const HEAD = `${"".padEnd(40)} |     n rst | signed  |err| | wait   early | ratch   est  | mDef mRat mEst | lapF resid`;

// Pair every arm to the first on (t, bus, stop) so a difference is the arm.
const base = arms[0];
const maps = arms.map((a) => new Map(a.rows.map((r) => [key(r), r])));
const shared = base.rows.filter((r) => maps.every((m) => m.has(key(r)))).map((r) => key(r));
console.log(`\n#### ${tsv}: arms ${arms.map((a) => a.tag).join(" | ")} — ${shared.length} rows priced in every arm (base ${base.rows.length})`);
const filters = [
  ["all standing rows", () => true],
  [`arrivals span >= ${REST_MIN}s`, (r) => r.arrSpan >= REST_MIN],
  [`visit span >= ${REST_MIN}s`, (r) => r.visSpan >= REST_MIN],
];
const cells = [...new Set(base.rows.map((r) => r.clampAt))].sort((a, b) => a - b);
for (const [flabel, f] of filters) {
  console.log(`\n--- ${flabel}`);
  console.log(HEAD);
  for (let i = 0; i < arms.length; i++) {
    const rs = shared.map((k) => maps[i].get(k)).filter((r) => f(maps[0].get(key(r))));
    if (rs.length) row(`[${arms[i].tag}] route ${base.route} all cells`, stats(rs));
  }
  for (const c of cells) {
    for (let i = 0; i < arms.length; i++) {
      const rs = shared.map((k) => maps[i].get(k)).filter((r) => r.clampAt === c && f(maps[0].get(key(r))));
      if (rs.length) row(`[${arms[i].tag}]   ${base.route}:${seq[c]} ${name(seq[c]).slice(0, 16)}`, stats(rs));
    }
  }
}
// How much of any move is the covariate: rows the arms priced differently.
if (arms.length > 1) {
  console.log(`\n--- identical rows, base [${arms[0].tag}] vs each arm (a covariate that changes nothing cannot have moved a number)`);
  for (let i = 1; i < arms.length; i++) {
    const same = shared.filter((k) => Math.abs(maps[0].get(k).shown - maps[i].get(k).shown) < 0.5).length;
    const d = shared.map((k) => maps[i].get(k).shown - maps[0].get(k).shown).filter((x) => Math.abs(x) >= 0.5);
    console.log(`[${arms[i].tag}] identical ${(100 * same / shared.length).toFixed(1)}% of ${shared.length}; where it differs (n ${d.length}) median ${f0(q(d, 0.5))} s, p10 ${f0(q(d, 0.1))}, p90 ${f0(q(d, 0.9))}`);
  }
}
