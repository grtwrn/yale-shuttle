/**
 * Baseline measurements for the ring-posterior estimator (plan Step 0), read-only:
 *   3. headway-to-leader vs stand at Red 344 Winchester (11) and Union Station N (121)
 *   4. Red per-stop stand / P(stop) and per-hop leg sample counts, pooled s/m
 *   5. arrivals-based `segments.travel_sec` medians for 11-146, 146-49, 49-48
 *
 *   REPLAY_DB=./store/snap.db node scripts/eta-replay/baseline-tables.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(process.env.REPLAY_DB ?? "./store/snap.db", { readonly: true });
const ROUTE = Number(process.env.ROUTE ?? 3);

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : "–";
const f2 = (x) => Number.isFinite(x) ? x.toFixed(2) : "–";
function fit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy), slope = sxy / sxx;
  return { n, r, r2: r * r, slope, intercept: my - slope * mx };
}
const hav = (a, b) => { const R = 6371000, d = Math.PI / 180, dl = (b.lat - a.lat) * d, dn = (b.lon - a.lon) * d; const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

const route = db.prepare("SELECT name, stops_json FROM routes WHERE id = ?").get(ROUTE);
const seq = JSON.parse(route.stops_json);
const stopName = Object.fromEntries(db.prepare("SELECT id, name FROM stops").all().map((s) => [s.id, s.name]));
const stopXY = Object.fromEntries(db.prepare("SELECT id, lat, lon FROM stops").all().map((s) => [s.id, s]));
const ends = db.prepare("SELECT min(anchored_at) a, max(anchored_at) b, count(*) n FROM stop_visits WHERE route_id = ?").get(ROUTE);
console.log(`route ${ROUTE} ${route.name}; stop_visits ${ends.n} rows ${new Date(ends.a).toISOString()} .. ${new Date(ends.b).toISOString()}\n`);

// ---- 3. headway to leader --------------------------------------------------
console.log("## 3. Headway-to-leader vs stand (stopped visits, departed_at not null)\n");
function headway(stopId, leaderMode) {
  const visits = db.prepare(`SELECT bus_name b, pinned_at p, arrived_at a, departed_at d, stand_sec s, hour h FROM stop_visits
     WHERE route_id = ? AND stop_id = ? AND outcome = 'stopped' AND departed_at IS NOT NULL ORDER BY departed_at`).all(ROUTE, stopId);
  const rows = [];
  for (const v of visits) {
    const t = v.p ?? v.a;
    if (t == null || v.s == null) continue;
    let lead = null;
    for (const u of visits) { if (u === v || u.d >= t) continue; if (leaderMode === "other" && u.b === v.b) continue; if (lead === null || u.d > lead) lead = u.d; }
    if (lead === null) continue;
    rows.push({ gap: (t - lead) / 1000, stand: v.s, hour: v.h });
  }
  return { visits: visits.length, rows };
}
for (const [stopId, mode] of [[11, "other"], [121, "other"], [11, "any"]]) {
  const { visits, rows } = headway(stopId, mode);
  const gaps = rows.map((r) => r.gap), stands = rows.map((r) => r.stand);
  const F = fit(gaps, stands);
  const H = fit(rows.map((r) => r.hour), stands);
  console.log(`### stop ${stopId} ${stopName[stopId]} — gap = pin − ${mode === "other" ? "leader (different bus_name)" : "previous departure (any bus)"} departure\n`);
  console.log(`stopped visits ${visits}, with a leader ${F.n}; gap min/p50/max ${f1(q(gaps, 0))}/${f1(q(gaps, .5))}/${f1(q(gaps, 1))} s; stand p50 ${f1(q(stands, .5))} s`);
  console.log(`stand ~ gap: Pearson r ${f2(F.r)}, R² ${f2(F.r2)}, slope ${(F.slope).toFixed(4)} s/s, intercept ${f1(F.intercept)} s`);
  console.log(`stand ~ hour: Pearson r ${f2(H.r)}, R² ${f2(H.r2)}`);
  const t1 = q(gaps, 1 / 3), t2 = q(gaps, 2 / 3);
  const terc = [rows.filter((r) => r.gap <= t1), rows.filter((r) => r.gap > t1 && r.gap <= t2), rows.filter((r) => r.gap > t2)];
  console.log(`| gap tercile | n | gap range (s) | stand p10 | p50 | p90 | mean |\n|---|---|---|---|---|---|---|`);
  terc.forEach((g, i) => { const s = g.map((r) => r.stand), gg = g.map((r) => r.gap); console.log(`| ${["short", "mid", "long"][i]} | ${g.length} | ${f1(q(gg, 0))}–${f1(q(gg, 1))} | ${f1(q(s, .1))} | ${f1(q(s, .5))} | ${f1(q(s, .9))} | ${f1(mean(s))} |`); });
  console.log(`verdict: R² ${f2(F.r2)} — headway ${F.r2 >= 0.2 ? "EXPLAINS a material share" : "does NOT explain a material share"} (threshold 0.2)\n`);
}

// ---- 4. sample counts ------------------------------------------------------
console.log("## 4. Red per-stop stand samples (stop_visits)\n");
console.log(`| # | stop | name | stopped | passed | other | P(stop) | stand p10 | p50 | p90 |\n|---|---|---|---|---|---|---|---|---|---|`);
const byStop = db.prepare(`SELECT stop_id, outcome, stand_sec FROM stop_visits WHERE route_id = ?`).all(ROUTE);
seq.forEach((sid, i) => {
  const v = byStop.filter((r) => r.stop_id === sid);
  const st = v.filter((r) => r.outcome === "stopped"), pa = v.filter((r) => r.outcome === "passed"), ot = v.length - st.length - pa.length;
  const s = st.map((r) => r.stand_sec).filter((x) => x != null);
  console.log(`| ${i} | ${sid} | ${stopName[sid]} | ${st.length} | ${pa.length} | ${ot} | ${v.length ? f2(st.length / v.length) : "–"} | ${f1(q(s, .1))} | ${f1(q(s, .5))} | ${f1(q(s, .9))} |`);
});
console.log("\n## 4b. Red per-hop legs (hops = 1)\n");
console.log(`| hop | chord m | n legs | leg p10 | p50 | p90 | drive p50 | hold mean | P(hold>0) | s/m p50 |\n|---|---|---|---|---|---|---|---|---|---|`);
const legs = db.prepare(`SELECT from_stop_id f, to_stop_id t, leg_sec l, drive_sec d, hold_sec h FROM legs WHERE route_id = ? AND hops = 1`).all(ROUTE);
const pooled = [];
seq.forEach((sid, i) => {
  const to = seq[(i + 1) % seq.length];
  const L = legs.filter((r) => r.f === sid && r.t === to);
  const chord = hav(stopXY[sid], stopXY[to]);
  const ls = L.map((r) => r.l), ds = L.map((r) => r.d), hs = L.map((r) => r.h);
  for (const x of ls) pooled.push(x / chord);
  console.log(`| ${sid}-${to} | ${chord.toFixed(0)} | ${L.length} | ${f1(q(ls, .1))} | ${f1(q(ls, .5))} | ${f1(q(ls, .9))} | ${f1(q(ds, .5))} | ${f1(hs.length ? mean(hs) : NaN)} | ${hs.length ? f2(hs.filter((x) => x > 0).length / hs.length) : "–"} | ${f2(q(ls, .5) / chord)} |`);
});
console.log(`\npooled seconds per chord metre (leg_sec / haversine, n=${pooled.length}): p10 ${f2(q(pooled, .1))}, p50 ${f2(q(pooled, .5))}, p90 ${f2(q(pooled, .9))}`);
const legEnds = db.prepare("SELECT min(departed_at) a, max(departed_at) b FROM legs WHERE route_id = ?").get(ROUTE);
console.log(`legs window ${new Date(legEnds.a).toISOString()} .. ${new Date(legEnds.b).toISOString()}`);

// ---- 5. arrivals-based segments cross-check ---------------------------------
console.log("\n## 5. `segments` (arrival-to-arrival) travel_sec, last 30 days\n");
const segMax = db.prepare("SELECT max(started_at) m FROM segments").get().m;
console.log(`| hop | n | travel p10 | p50 | p90 | mean |\n|---|---|---|---|---|---|`);
for (const [a, b] of [[11, 146], [146, 49], [49, 48]]) {
  const s = db.prepare(`SELECT travel_sec v FROM segments WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ? AND started_at >= ?`).all(ROUTE, a, b, segMax - 30 * 86_400_000).map((r) => r.v);
  console.log(`| ${a}-${b} | ${s.length} | ${f1(q(s, .1))} | ${f1(q(s, .5))} | ${f1(q(s, .9))} | ${f1(mean(s))} |`);
}
db.close();
