#!/usr/bin/env node
// Where do buses ACTUALLY stop?  (measurement only — nothing here ships)
//
// The map draws every stop where the operator publishes it, and a rider who has
// never taken the line walks to that dot. At some stops the bus reliably berths
// somewhere else — past the intersection, up the block, the far kerb — and the
// rider watches it go by. This measures the berth from evidence and decides, per
// stop, whether we know it well enough to draw a second dot.
//
// THE ESTIMATOR, and why it is not the mean of the fixes.
//
// The feed has a ~30 m deadband: a new coordinate is sent only once the bus has
// moved ~30 m. The last coordinate a bus sends before coming to rest was therefore
// taken somewhere in the 30 m BEHIND where it actually stopped. Averaging those
// fixes reports a berth ~15 m short of the truth at EVERY stop — a bias that would
// masquerade as "buses stop before the sign" network-wide.
//
// Every observation is at or behind the berth along the direction of travel, so
// the berth is the supremum of the along-path samples and a high quantile
// estimates it from below. We project each frozen fix onto the route's published
// polyline and work in signed along-path metres.
//
// The falsifiable claim: at a stop whose published dot is right, the observations
// span about [-30, 0] and their p90 sits near 0. Measured over 8,777 served
// visits the network medians are span 38.8 m and p90 +8.6 m — so the published
// coordinates are, in the main, correct, and the deadband story holds.
//
// THE DECISION RULE. A second dot is drawn only when the berth is a fact rather
// than a spread:
//   - >= MIN_N observations of the stop being served;
//   - a MODE WINDOW (the densest 40 m stretch) holding >= 75% of them, which is
//     what fails at a stop where buses genuinely stop in two places;
//   - the berth >= 35 m from the published dot — above everything the deadband
//     alone can produce, so we never redraw a stop on the strength of the sensor;
//   - and the berth is at least RIVAL_MARGIN times nearer its own stop than any
//     OTHER published stop. Five of the first twelve candidates failed this and it
//     is the rule that matters most: a berth sitting on the neighbouring stop is
//     not "the bus parks in the wrong place", it is a visit attributed to the wrong
//     half of a pair 30 m apart (the (N)/(S) invariant), and there is a dot there
//     already. Red's "130 Prospect (S)" berth is 13 m from Prospect / Sachem (N);
//     Green's "Orange / Bradley (S)" is 17 m from Orange / Trumbull.
//
// Reads the daily archive (~/shuttle-archive/<day>/) and a saved /api/buses for
// the polylines. Writes nothing but its own output file.
//
//   node scripts/berth-offsets.mjs --payload buses.json [--json out.json] [--stop N]

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIN_N = 20;            // visits before we claim to know a berth
const WINDOW_M = 40;         // the mode window: a bus length plus a little
const WINDOW_SHARE = 0.75;   // of the observations that must fall inside it
const MIN_BERTH_M = 35;      // above the feed's 30 m deadband, so the sensor alone cannot trip it
const RIVAL_MARGIN = 1.5;    // the berth must be this much nearer its own stop than any other

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE = join(process.env.HOME, "shuttle-archive");
const STOPS = JSON.parse(readFileSync(join(HERE, "../src/server/__fixtures__/stops.json"), "utf8"));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const R = 6371000, rad = (d) => (d * Math.PI) / 180, LAT0 = 41.31;
const MX = R * Math.cos(rad(LAT0)) * Math.PI / 180, MY = R * Math.PI / 180;
const xy = (la, lo) => [lo * MX, la * MY];
const dd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const quant = (xs, q) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const median = (xs) => quant(xs, 0.5);

function makePath(pts) {
  const P = pts.map(([a, b]) => xy(a, b)); const c = [0];
  for (let i = 1; i < P.length; i++) c.push(c[i - 1] + dd(P[i - 1], P[i]));
  return {
    total: c[c.length - 1],
    project(la, lo) {
      const p = xy(la, lo); let best = { s: 0, d: Infinity };
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = dd(p, [a[0] + t * vx, a[1] + t * vy]);
        if (d < best.d) best = { s: c[i - 1] + t * Math.sqrt(L2), d };
      }
      return best;
    },
    at(s) {
      const T = c[c.length - 1]; s = ((s % T) + T) % T;
      let i = 1; while (i < c.length - 1 && c[i] < s) i++;
      const a = P[i - 1], b = P[i], seg = c[i] - c[i - 1] || 1, t = (s - c[i - 1]) / seg;
      return { lat: +((a[1] + t * (b[1] - a[1])) / MY).toFixed(6), lon: +((a[0] + t * (b[0] - a[0])) / MX).toFixed(6) };
    },
  };
}

const rj = (p) => { if (!existsSync(p)) return [];
  const o = []; for (const l of execSync(`zcat ${JSON.stringify(p)}`, { maxBuffer: 1 << 30 }).toString().split("\n")) if (l) o.push(JSON.parse(l));
  return o; };

const payload = JSON.parse(readFileSync(arg("payload", "buses.json"), "utf8"));
const paths = new Map();
for (const [r, p] of Object.entries(payload.route_paths || {})) if (Array.isArray(p) && p.length > 1) paths.set(Number(r), makePath(p));

const dayList = arg("days", "") ? arg("days").split(",")
  : execSync(`ls -d ${ARCHIVE}/2026-* 2>/dev/null || true`).toString().trim().split("\n").filter(Boolean).map((p) => p.split("/").pop());

const obs = new Map();                       // "stop:route" -> observations
let visits = 0, stopped = 0, placed = 0;
for (const day of dayList) {
  const V = rj(join(ARCHIVE, day, "stop_visits.jsonl.gz")), POS = rj(join(ARCHIVE, day, "raw_positions.jsonl.gz"));
  if (!V.length || !POS.length) continue;
  const byBus = new Map();
  for (const p of POS) { if (!byBus.has(p.bus_name)) byBus.set(p.bus_name, []); byBus.get(p.bus_name).push(p); }
  for (const a of byBus.values()) a.sort((x, y) => x.collected_at - y.collected_at);
  for (const v of V) {
    visits++;
    if (v.outcome !== "stopped" || !v.pinned_at || !v.departed_at) continue;
    stopped++;
    const path = paths.get(v.route_id), arr = byBus.get(v.bus_name);
    if (!path || !arr) continue;
    const win = arr.filter((p) => p.collected_at >= v.pinned_at - 6000 && p.collected_at <= v.departed_at + 1000);
    if (win.length < 2) continue;
    // the coordinate the bus was frozen at just before it pulled away: its berth
    let cur = null, last = null;
    for (const p of win) {
      const k = `${p.lat},${p.lon}`;
      if (cur && cur.k === k) cur.end = p.collected_at;
      else { cur = { k, lat: p.lat, lon: p.lon, start: p.collected_at, end: p.collected_at }; last = cur; }
    }
    if (!last) continue;
    const pr = path.project(last.lat, last.lon);
    if (pr.d > 60) continue;                 // off this route's line: a yard, a detour
    const key = `${v.stop_id}:${v.route_id}`;
    if (!obs.has(key)) obs.set(key, []);
    obs.get(key).push({ s: pr.s, lat: last.lat, lon: last.lon, bus: v.bus_name, day });
    placed++;
  }
}

const stopById = new Map(STOPS.map((s) => [s.id, s]));
const rows = [];
for (const [key, ss] of obs) {
  const [stopId, routeId] = key.split(":").map(Number);
  const stop = stopById.get(stopId), path = paths.get(routeId);
  if (!stop || !path) continue;
  const s0 = path.project(stop.lat, stop.lon);
  if (s0.d > 60) continue;
  const half = path.total / 2;
  const pts = ss.map((o) => {
    let x = o.s - s0.s; while (x > half) x -= path.total; while (x < -half) x += path.total;
    return { off: x, lat: o.lat, lon: o.lon, bus: o.bus, day: o.day };
  }).filter((p) => Math.abs(p.off) < 250);
  if (pts.length < 10) continue;

  // the densest WINDOW_M stretch: slide the window over the sorted offsets
  const sorted = [...pts].sort((a, b) => a.off - b.off);
  let bi = 0, bj = 0;
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while (j < sorted.length && sorted[j].off - sorted[i].off <= WINDOW_M) j++;
    if (j - i > bj - bi) { bi = i; bj = j; }
  }
  const inWin = sorted.slice(bi, bj);
  const share = inWin.length / sorted.length;
  // the berth is the front of the in-window cloud (the deadband only ever lags)
  const berthOff = quant(inWin.map((p) => p.off), 0.9);
  const berthPt = path.at(s0.s + berthOff);
  let rival = null;
  for (const other of STOPS) {
    if (other.id === stopId) continue;
    const d = Math.hypot((other.lon - berthPt.lon) * MX, (other.lat - berthPt.lat) * MY);
    if (!rival || d < rival.d) rival = { d, name: other.name, id: other.id };
  }
  const ownD = Math.abs(berthOff);
  const clearOfRivals = !rival || rival.d > ownD * RIVAL_MARGIN;
  const qualifies = pts.length >= MIN_N && share >= WINDOW_SHARE
    && ownD >= MIN_BERTH_M && clearOfRivals;
  rows.push({
    stopId, routeId, name: stop.name, n: pts.length,
    published: { lat: stop.lat, lon: stop.lon },
    berth: berthPt,
    rival: rival ? { id: rival.id, name: rival.name, m: +rival.d.toFixed(0) } : null,
    clearOfRivals,
    berthOffM: +berthOff.toFixed(1),
    windowShare: +share.toFixed(2),
    windowLoM: +inWin[0].off.toFixed(1),
    windowHiM: +inWin[inWin.length - 1].off.toFixed(1),
    spanM: +(quant(pts.map((p) => p.off), 0.9) - quant(pts.map((p) => p.off), 0.1)).toFixed(1),
    qualifies,
    observations: pts.map((p) => ({ off: +p.off.toFixed(1), lat: p.lat, lon: p.lon, day: p.day, bus: p.bus })),
  });
}
rows.sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || Math.abs(b.berthOffM) - Math.abs(a.berthOffM));

const only = arg("stop", "");
const shown = only ? rows.filter((r) => String(r.stopId) === only) : rows;
console.log(`days ${dayList.join(",")} | visits ${visits} | served ${stopped} | berth observed ${placed}`);
console.log(`cells with >=10 observations: ${rows.length}   QUALIFYING: ${rows.filter((r) => r.qualifies).length}\n`);
console.log("  berth  window(share)      span    n   stop / nearest rival stop");
for (const r of shown.slice(0, 40))
  console.log(
    `${(r.qualifies ? "* " : "  ") + String(r.berthOffM).padStart(6)}m  ${String(r.windowLoM).padStart(6)}..${String(r.windowHiM).padEnd(6)} ${String(r.windowShare).padStart(4)}  ${String(r.spanM).padStart(6)}m ${String(r.n).padStart(4)}   ${r.name} [${r.stopId}] r${r.routeId}` +
    (r.rival && !r.clearOfRivals ? `   << ${r.rival.m} m from ${r.rival.name}` : "")
  );
const all = rows.map((r) => r.berthOffM);
console.log(`\nnetwork: berth-offset median ${median(all).toFixed(1)} m, span median ${median(rows.map((r) => r.spanM)).toFixed(1)} m`);
console.log(`(deadband alone predicts ~0 m and ~30 m — the published coordinates are broadly right)`);
const out = arg("json", "");
if (out) { writeFileSync(out, JSON.stringify(rows, null, 2)); console.log(`\nwrote ${out}`); }
