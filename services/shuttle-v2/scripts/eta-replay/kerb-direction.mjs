/**
 * DIRECTION along the ring as the discriminator the step size cannot be —
 * measured, and refused. The record is docs/eta-ring-posterior.md,
 * "Direction along the ring: measured (2026-09-11)".
 *
 * The question. A standing bus that publishes a fresh fix has either departed
 * or shuffled at the kerb, and filter.ts charges the pooled (beyond-rest)
 * departure evidence to both — the standing trough at its source (#246).
 * `P_DEPART_ON_FRESH_IN_REST` alone fails the accuracy gate (a genuine
 * departure's first step is inside the rest radius too, #246) and charging it
 * from the second fresh fix is inert (#247). The step size cannot separate the
 * two classes: 32 m at the median either way. This asks whether the DIRECTION
 * can — a bus that has genuinely pulled out steps FORWARD along the published
 * line; a bus shuffling at the kerb should not.
 *
 * Population and truth are `measure2`'s (the #246 measurement), unchanged, so
 * its split reproduces as a self-check: a fresh fix while the detector still
 * says standing is a SHUFFLE, the first fresh fix after `departed_at`
 * (verified == `last_at_rest_at`) is the DEPARTURE. What is added is WHERE the
 * fix went — the displacement projected onto the published line's own forward
 * direction at the bus's position, and the signed angle to that tangent.
 *
 * Geometry comes from the replay database (`routes.path_json` + `stops`), the
 * same published line the ring is built on; projection is planar in local
 * metres about each route's first path point, which for a 30 m displacement in
 * New Haven is exact to under a millimetre. The layover class is taken from
 * the archive's own stands (median `stand_sec` per (route, stop) >= 120 s), so
 * the script needs no served payload.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap.db ROUTES=3,1 \
 *     node scripts/eta-replay/kerb-direction.mjs 2026-09-03 .. 2026-09-09
 */
import fs from "node:fs"; import zlib from "node:zlib"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ARCH = process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive");
const DB = process.env.REPLAY_DB;
const days = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const ROUTES = (process.env.ROUTES ?? "3,1").split(",").map(Number);
/** filter.ts REST_RADIUS_M — the runtime discriminator this rule would sit beside. */
const REST = 125;
/** A poll, not a feed gap. */
const MAX_DT = 15_000;
if (!DB || !days.length) {
  console.error("REPLAY_DB=<snapshot.db> node scripts/eta-replay/kerb-direction.mjs <day> [day …]");
  process.exit(2);
}

const hav = (a, b) => { const R = 6371000, k = Math.PI / 180; const dLa = (b.lat - a.lat) * k, dLo = (b.lon - a.lon) * k;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const rows = (d, t) => { const f = path.join(ARCH, d, `${t}.jsonl.gz`); return fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

const db = new Database(DB, { readonly: true });
const NAME = new Map(), PATHS = new Map();
for (const r of db.prepare("SELECT id, short_name, path_json FROM routes").all()) {
  NAME.set(r.id, r.short_name ?? String(r.id));
  try { PATHS.set(r.id, JSON.parse(r.path_json)); } catch { /* a route with no line is skipped below */ }
}
const COORD = new Map();
for (const s of db.prepare("SELECT id, lat, lon FROM stops").all()) COORD.set(s.id, { lat: s.lat, lon: s.lon });
db.close();

/** The route's polyline in local metres, with cumulative length and unit tangents. */
function prepPath(routeId) {
  const raw = PATHS.get(routeId);
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const pts = raw.map((p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : { lat: p.lat, lon: p.lon }));
  const lat0 = pts[0].lat, lon0 = pts[0].lon, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const xy = pts.map((p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }));
  const cum = [0], tan = [], len = [];
  for (let i = 0; i + 1 < xy.length; i++) {
    const dx = xy[i + 1].x - xy[i].x, dy = xy[i + 1].y - xy[i].y, L = Math.hypot(dx, dy) || 1e-9;
    len.push(L); tan.push({ x: dx / L, y: dy / L }); cum.push(cum[i] + L);
  }
  return { xy, cum, tan, len, loop: cum[cum.length - 1], toXY: (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }) };
}
/** Nearest point on the line: along-track metres, perpendicular distance, that segment's tangent. */
function project(P, pt) {
  const q = P.toXY(pt);
  let best = { d2: Infinity, along: 0, tan: P.tan[0] };
  for (let i = 0; i + 1 < P.xy.length; i++) {
    const a = P.xy[i], t = P.tan[i];
    const s = Math.max(0, Math.min(P.len[i], (q.x - a.x) * t.x + (q.y - a.y) * t.y));
    const d2 = (q.x - (a.x + t.x * s)) ** 2 + (q.y - (a.y + t.y * s)) ** 2;
    if (d2 < best.d2) best = { d2, along: P.cum[i] + s, tan: t };
  }
  return { along: best.along, perp: Math.sqrt(best.d2), tan: best.tan, q };
}
/** Signed along-line displacement, the loop's wrap resolved to the branch nearest zero. */
function forwardM(P, a, b) {
  let d = b.along - a.along;
  if (d > P.loop / 2) d -= P.loop;
  if (d < -P.loop / 2) d += P.loop;
  return d;
}

const obs = []; const standSecs = new Map();
let visits = 0, standPolls = 0;
for (const day of days) {
  const V = rows(day, "stop_visits").filter((v) => ROUTES.includes(v.route_id));
  const byBus = new Map();
  for (const r of rows(day, "raw_positions").filter((r) => ROUTES.includes(r.route_id))) {
    if (!byBus.has(r.bus_name)) byBus.set(r.bus_name, []); byBus.get(r.bus_name).push(r);
  }
  for (const l of byBus.values()) l.sort((a, b) => a.collected_at - b.collected_at);
  for (const v of V) {
    if (v.outcome !== "stopped" || !v.departed_at || !v.pinned_at) continue;
    const key = `${v.route_id}:${v.stop_id}`;
    if (!standSecs.has(key)) standSecs.set(key, []);
    standSecs.get(key).push(v.stand_sec ?? (v.departed_at - v.pinned_at) / 1000);
    const stop = COORD.get(v.stop_id), track = byBus.get(v.bus_name), P = prepPath(v.route_id);
    if (!stop || !track || !P || !(v.departed_at > v.pinned_at)) continue;
    const seg = track.filter((r) => r.collected_at >= v.pinned_at - 1000 && r.collected_at <= v.departed_at + 180_000);
    if (seg.length < 3) continue;
    visits++;
    const rest = { lat: seg[0].lat, lon: seg[0].lon };
    let prev = seg[0], sawDep = false, nth = 0;
    for (let i = 1; i < seg.length; i++) {
      const r = seg[i], dt = r.collected_at - prev.collected_at;
      const fresh = r.lat !== prev.lat || r.lon !== prev.lon;
      if (r.collected_at <= v.departed_at && dt <= MAX_DT) standPolls++;
      if (!fresh) { prev = r; continue; }
      const isDep = r.collected_at > v.departed_at;
      if (isDep && sawDep) break;
      if (dt <= MAX_DT) {
        const pa = project(P, prev), pb = project(P, r);
        const dx = pb.q.x - pa.q.x, dy = pb.q.y - pa.q.y;
        obs.push({
          kind: isDep ? "dep" : "shuffle", day, route: v.route_id, stop: v.stop_id, bus: v.bus_name,
          visit: `${v.route_id}|${day}|${v.bus_name}|${v.stop_id}|${v.pinned_at}`, nth: ++nth,
          inRest: hav(rest, r) <= REST, stood: (r.collected_at - v.pinned_at) / 1000,
          stepM: hav(prev, r), fwd: forwardM(P, pa, pb),
          ang: Math.atan2(pa.tan.x * dy - pa.tan.y * dx, dx * pa.tan.x + dy * pa.tan.y) * 180 / Math.PI,
          perp: pa.perp,
        });
      }
      if (isDep) { sawDep = true; break; }
      prev = r;
    }
  }
}
/** A layover by the archive's own stands, so no served payload is needed. */
const medOf = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const isLayover = (o) => medOf(standSecs.get(`${o.route}:${o.stop}`) ?? []) >= 120;

const dep = (p) => p.filter((o) => o.kind === "dep").length;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "  —  ");
const cell = (p) => `${String(p.length).padStart(5)} / ${String(dep(p)).padStart(4)} / ${pct(dep(p), p.length).padStart(7)}`;
const firstInRest = (pop) => { const seen = new Set(), out = [];
  for (const o of pop) { if (seen.has(o.visit)) continue; seen.add(o.visit); out.push(o); } return out; };
const BANDS = [["<= 0", (o) => o.fwd <= 0], ["0-10", (o) => o.fwd > 0 && o.fwd <= 10], ["10-20", (o) => o.fwd > 10 && o.fwd <= 20],
  ["20-30", (o) => o.fwd > 20 && o.fwd <= 30], [">= 30", (o) => o.fwd > 30]];
const ANG = [["0-30", 0, 30], ["30-60", 30, 60], ["60-90", 60, 90], ["90-120", 90, 120], ["120-180", 120, 181]];
const arms = (pop) => [...ROUTES.map((r) => [NAME.get(r) ?? r, pop.filter((o) => o.route === r)]), ["pooled", pop]];
function block(title, pop) {
  console.log(`\n=== ${title} ===`);
  console.log(`${"band".padEnd(22)} | ` + arms(pop).map(([n]) => `${String(n)}: n / dep / P(dep)`).join("  |  "));
  for (const [lbl, sel] of BANDS) console.log(`  forward ${lbl.padEnd(13)} | ` + arms(pop).map(([, p]) => cell(p.filter(sel))).join("  |  "));
  for (const [lbl, lo, hi] of ANG) console.log(`  |angle| ${(lbl + " deg").padEnd(13)} | ` + arms(pop).map(([, p]) => cell(p.filter((o) => Math.abs(o.ang) >= lo && Math.abs(o.ang) < hi))).join("  |  "));
  console.log(`  ${"ALL".padEnd(20)} | ` + arms(pop).map(([, p]) => cell(p)).join("  |  "));
  const back = pop.filter((o) => o.fwd <= 0), fwd = pop.filter((o) => o.fwd > 0);
  console.log(`  a rule that keeps full evidence on a FORWARD step weakens ${back.length} rows (${pct(back.length, pop.length)}): `
    + `${pct(dep(back), dep(pop))} of departures withheld against ${pct(back.length - dep(back), pop.length - dep(pop))} of shuffles corrected`);
  console.log(`  its inverse (weaken the forward step) weakens ${fwd.length} rows (${pct(fwd.length, pop.length)}): `
    + `${pct(dep(fwd), dep(pop))} of departures withheld against ${pct(fwd.length - dep(fwd), pop.length - dep(pop))} of shuffles corrected`);
}

console.log(`days ${days.join(",")}  routes ${ROUTES.map((r) => `${r} (${NAME.get(r) ?? "?"})`).join(", ")}`);
console.log(`visits ${visits}  standing polls ${standPolls}  fresh fixes ${obs.length}`);
const inRest = obs.filter((o) => o.inRest);
console.log(`\nself-check, the #246 split (every in-rest fresh fix vs beyond the rest radius):`);
for (const [n, p] of arms(obs)) console.log(`  ${String(n).padEnd(10)} in-rest ${cell(p.filter((o) => o.inRest))}   beyond ${cell(p.filter((o) => !o.inRest))}`);
block("EVERY in-rest fresh fix", inRest);
block("FIRST in-rest fresh fix of each rest — the trough poll", firstInRest(inRest));
block("FIRST in-rest fresh fix, layover stops (archive stand median >= 120 s)", firstInRest(inRest).filter(isLayover));
block("FIRST in-rest fresh fix, first minute of the stand", firstInRest(inRest).filter((o) => o.stood < 60));
const F = firstInRest(inRest), D = F.filter((o) => o.kind === "dep"), S = F.filter((o) => o.kind !== "dep");
console.log(`\nat the trough poll, departures vs shuffles (p50):`);
console.log(`  step        ${medOf(D.map((o) => o.stepM)).toFixed(0)} m   vs ${medOf(S.map((o) => o.stepM)).toFixed(0)} m`);
console.log(`  |forward|   ${medOf(D.map((o) => Math.abs(o.fwd))).toFixed(0)} m   vs ${medOf(S.map((o) => Math.abs(o.fwd))).toFixed(0)} m`);
console.log(`  perp to line ${medOf(D.map((o) => o.perp)).toFixed(0)} m  vs ${medOf(S.map((o) => o.perp)).toFixed(0)} m`);
if (process.env.OBS_OUT) { fs.writeFileSync(process.env.OBS_OUT, obs.map((o) => JSON.stringify(o)).join("\n") + "\n"); console.log(`\nwrote ${process.env.OBS_OUT} (${obs.length} rows)`); }
