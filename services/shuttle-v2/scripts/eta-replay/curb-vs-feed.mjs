/**
 * IS THE 45 m CURB RULE TELLING THE TRUTH ON THIS LINE?
 *
 * rider-sim's ground truth used to be geometry alone: a bus inside 45 m of a
 * stop had arrived. `CLAUDE.md`'s own invariant kills that — "stops that are
 * metres apart can be many stops apart in sequence" — and on Red, 2026-09-04,
 * 27% of curb visits were a bus serving the twin across the road (130 Prospect
 * (N)/(S) are ~10 m apart at sequence positions 11 and 20). `lib.ts`
 * corroborates every curb visit against the feed's own `last_stop_id` now.
 *
 * This script is how that was measured and how it is re-measured on another
 * line or another day. It prints, per stop:
 *
 *   - curb visits, and how many the feed does NOT corroborate (drive-bys)
 *   - "the feed says it served S" events, and how many had the bus inside 45 m
 *     of S's published coordinate — a stop scoring low here is MIS-SITED, and
 *     the curb rule loses its genuine arrivals rather than inventing them
 *
 *   ROUTE=3 CAPTURE=~/shuttle-captures/cap-et-0904.jsonl REPLAY_DB=./store/snap.db \
 *     node scripts/eta-replay/curb-vs-feed.mjs
 */
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ROUTE = Number(process.env.ROUTE ?? 3);
const DB = process.env.REPLAY_DB ?? "./store/snap.db";
const CAP = (process.env.CAPTURE ?? "").replace(/^~/, process.env.HOME ?? "~");
if (!CAP) { console.error("CAPTURE=<positions jsonl> is required"); process.exit(2); }

const ARRIVAL_M = 45, REARM_M = 120, SERVED_BEFORE_MS = 120_000, SERVED_AFTER_MS = 300_000;

const db = new Database(path.resolve(DB), { readonly: true });
const stops = Object.fromEntries(db.prepare("SELECT id,name,lat,lon FROM stops").all().map((s) => [s.id, s]));
const route = db.prepare("SELECT id,name,stops_json FROM routes WHERE id=?").get(ROUTE);
if (!route) { console.error(`route ${ROUTE} is not in ${DB}`); process.exit(2); }
const seq = JSON.parse(route.stops_json);
const idxOf = new Map(seq.map((s, i) => [s, i]));

const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const track = new Map();
for await (const line of readline.createInterface({ input: fs.createReadStream(CAP) })) {
  if (!line) continue;
  let p; try { p = JSON.parse(line); } catch { continue; }
  if (p.route_id !== ROUTE) continue;
  const k = String(p.bus_name).replace(/^#/, "");
  let a = track.get(k); if (!a) track.set(k, (a = []));
  a.push({ t: p.collected_at, lat: p.lat, lon: p.lon, l: p.last_stop_id ?? null });
}
for (const a of track.values()) a.sort((x, y) => x.t - y.t);

const per = Object.fromEntries(seq.map((s) => [s, { curb: 0, driveBy: 0, served: 0, servedInside45: 0, mins: [] }]));
for (const [, a] of track) {
  const flips = [];
  let prev = null, seen = false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    if (p.l == null) continue;
    if (seen && p.l !== prev) flips.push({ t: p.t, stop: p.l, i });
    seen = true; prev = p.l;
  }
  const open = new Map();
  for (const p of a) for (const sid of seq) {
    const d = hav(p, stops[sid]);
    if (!open.has(sid) && d <= ARRIVAL_M) {
      open.set(sid, true);
      per[sid].curb++;
      if (!flips.some((f) => f.stop === sid && f.t >= p.t - SERVED_BEFORE_MS && f.t <= p.t + SERVED_AFTER_MS)) per[sid].driveBy++;
    } else if (open.has(sid) && d > REARM_M) open.delete(sid);
  }
  for (const f of flips) {
    if (!idxOf.has(f.stop)) continue;
    let min = Infinity;
    for (let j = f.i; j >= 0 && a[j].t > f.t - SERVED_AFTER_MS; j--) min = Math.min(min, hav(a[j], stops[f.stop]));
    for (let j = f.i; j < a.length && a[j].t < f.t + SERVED_AFTER_MS; j++) min = Math.min(min, hav(a[j], stops[f.stop]));
    per[f.stop].served++;
    if (min <= ARRIVAL_M) per[f.stop].servedInside45++;
    per[f.stop].mins.push(min);
  }
}
const q = (x, p) => { if (!x.length) return null; const s = x.slice().sort((a, b) => a - b); return Math.round(s[Math.floor(s.length * p)]); };
let curb = 0, drive = 0;
console.log(`${route.name} (route ${ROUTE}), ${track.size} buses, ${path.basename(CAP)}\n`);
console.log(`${"idx".padStart(4)} ${"stop".padEnd(28)} ${"curb".padStart(5)} ${"driveBy".padStart(8)} ${"served".padStart(7)} ${"in45m".padStart(6)} ${"minD p50".padStart(9)}`);
for (const sid of seq) {
  const v = per[sid]; curb += v.curb; drive += v.driveBy;
  console.log(`${String(idxOf.get(sid)).padStart(4)} ${`${stops[sid].name} (${sid})`.padEnd(28)} ${String(v.curb).padStart(5)} ${String(v.driveBy).padStart(8)} ${String(v.served).padStart(7)} ${String(v.servedInside45).padStart(6)} ${String(q(v.mins, 0.5) ?? "-").padStart(9)}`);
}
console.log(`\ncurb visits ${curb}; not corroborated by the feed ${drive} (${((drive / curb) * 100).toFixed(1)}%)`);
console.log("a stop whose 'in45m' is far below its 'served' count is MIS-SITED: the published coordinate is not where the bus stands.");
