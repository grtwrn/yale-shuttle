/**
 * Is the rebuilt payload the one production served? Compare an arm's traced
 * `shown` against `predictions_log` rows for the same (bus, stop, instant)
 * from the archived day, within 15 s — the log's own bucket.
 *
 * Use the arm whose served tables MATCH what production served that day: for
 * route 13 on 2026-09-10 that is the WITHHELD arm, because the lap fits for
 * Blue Night did not ship until 2026-09-12 00:5x ET.
 *
 *   DATA=../../.eta-replay/postlap node fidelity.mjs lay-arch-r13-2026-09-10-off13.json pred-2026-09-10.json 13
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.DATA ?? ".";
const [arm, predFile, routeArg] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(path.join(DIR, arm), "utf8"));
const P = JSON.parse(fs.readFileSync(path.join(DIR, predFile), "utf8")).filter((r) => String(r.route_id) === String(routeArg));
const stops = JSON.parse(fs.readFileSync(path.join(DIR, "buses_now.json"), "utf8")).routes[String(routeArg)];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

// Index the replay's rows by bus + stop id, sorted by instant.
const by = new Map();
for (const r of A.rows) {
  const k = `${r.bus.replace(/^#/, "")}|${stops[r.stopIdx]}`;
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(r);
}
for (const l of by.values()) l.sort((x, y) => x.t - y.t);
const diffs = [], surf = new Map();
for (const p of P) {
  const k = `${String(p.bus_name).replace(/^#/, "")}|${p.to_stop_id}`;
  const l = by.get(k); if (!l) continue;
  let best = null;
  for (const r of l) { const d = Math.abs(r.t - p.predicted_at); if (d <= 15000 && (!best || d < Math.abs(best.t - p.predicted_at))) best = r; }
  if (!best) continue;
  diffs.push(best.shown - p.predicted_sec);
  surf.set(p.surface, (surf.get(p.surface) ?? 0) + 1);
}
const f0 = (x) => Number.isFinite(x) ? x.toFixed(0) : "-";
console.log(`${arm} vs ${predFile} route ${routeArg}: ${P.length} logged rider rows, ${diffs.length} paired to a replayed row ${JSON.stringify([...surf])}`);
if (diffs.length) console.log(`  replay - logged: median ${f0(q(diffs, 0.5))} s, p10 ${f0(q(diffs, 0.1))}, p90 ${f0(q(diffs, 0.9))}, within 30 s ${(100 * diffs.filter((d) => Math.abs(d) <= 30).length / diffs.length).toFixed(1)}%`);
