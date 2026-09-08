/**
 * DOES `last_stop_id` SAY WHICH SIDE OF A STOP THE BUS IS ON?
 *
 * The cold start's whole problem is tense: a bus inside a stop's zone is
 * either about to reach it or has just driven past it, and one frame of the
 * payload has to say which. `last_stop_id` is documented as the last stop
 * PASSED, so on the face of it it answers exactly that question. This
 * measures whether it does, against the trajectory itself.
 *
 * Truth is the bus's own path, not the ring and not the feed's flags. Inside
 * each episode (a contiguous run of frames whose nearest stop is the same
 * one) the closest approach is found; frames before it are APPROACHING, after
 * it PAST, and the plateau within `PLATEAU_M` of the minimum is AT — the
 * frames where the bus is level with the stop and neither word applies.
 *
 * Two candidate discriminators are scored on those frames:
 *   FEED   `last_stop_id` == this stop  (upstream says the stop is behind)
 *   GEOM   the fix's nearest ring cell is downstream of the stop's own cell
 *
 * A third section scores the field nobody in the model reads, `heading`,
 * against the ring's own local bearing. That one answers a DIFFERENT question
 * — not which side of a stop the bus is on but which way it is pointing, which
 * is what tells two passes over one kerb apart (Pink's Quigley Inbound and
 * Outbound; PR #175).
 *
 *   TZ=America/New_York PAYLOAD=store/buses.json \
 *     POSITIONS=a.jsonl,b.jsonl npx tsx scripts/eta-replay/last-stop-direction.ts
 */
import fs from "node:fs";
import zlib from "node:zlib";

import { registerRoutePaths } from "../../web/src/anchor";
import { ringForBus } from "../../web/src/eta";
import { distancesTo, forwardCells, NEAR_STOP_M, type Ring } from "../../web/src/eta/ring";
import { haversineMeters, type LatLon } from "../../web/src/geo";

/** Frames within this of the closest approach are AT the stop: neither tense. */
const PLATEAU_M = Number(process.env.PLATEAU_M ?? 5);
/** Only frames this close to a stop matter — the zone where a stand is believed. */
const ZONE_M = Number(process.env.ZONE_M ?? NEAR_STOP_M);
/** A gap longer than this breaks an episode (a feed dropout is not one pass). */
const GAP_MS = 120_000;
/** Upstream quantises position; a jump under this is the same fix. */
const MOVED_M = 8;

const payload = JSON.parse(fs.readFileSync(process.env.PAYLOAD ?? "store/buses.json", "utf8"));
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(payload.stop_coords)) stopCoords[Number(k)] = v as LatLon;
const routeStops: Record<string, number[]> = {};
for (const [rid, o] of Object.entries<Record<string, number>>(payload.routes)) {
  routeStops[rid] = Object.keys(o).sort((a, b) => Number(a) - Number(b)).map((k) => o[k]!);
}
registerRoutePaths(payload.route_paths);
const routeName: Record<string, string> = {};
for (const b of payload.buses ?? []) routeName[String(b.route_id)] = b.route_short_name ?? b.route ?? "";

const rows: any[] = [];
for (const f of (process.env.POSITIONS ?? "").split(",").filter(Boolean)) {
  const raw = f.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(f)).toString("utf8") : fs.readFileSync(f, "utf8");
  // The captures are appended by concurrent writers and carry the odd torn
  // line; the archive's own dumps do not. Skip what does not parse.
  let torn = 0;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { torn++; }
  }
  if (torn) console.error(`${f}: skipped ${torn} torn lines`);
}
const byBus = new Map<string, any[]>();
for (const p of rows) {
  const k = `${p.bus_name}|${p.route_id}`;
  if (!byBus.has(k)) byBus.set(k, []);
  byBus.get(k)!.push(p);
}

type Cls = "APPROACH" | "AT" | "PAST";
interface Cell { n: number; feed: number; geom: number; both: number; neither: number; feedPrev: number }
const blank = (): Cell => ({ n: 0, feed: 0, geom: 0, both: 0, neither: 0, feedPrev: 0 });
const pooled: Record<Cls, Cell> = { APPROACH: blank(), AT: blank(), PAST: blank() };
const byRoute = new Map<string, Record<Cls, Cell>>();
const movingPooled: Record<Cls, Cell> = { APPROACH: blank(), AT: blank(), PAST: blank() };
/** Metres past the closest approach at which `last_stop_id` first names the stop. */
const flipM: number[] = [];
const flipNever: number[] = [];

/** The nearest ring cell to a fix, searched near the stop's own cell. */
function nearestCellNear(ring: Ring, fix: LatLon, around: number, span = 60): number {
  let best = around, bd = Infinity;
  for (let k = -span; k <= span; k++) {
    const c = ((around + k) % ring.C + ring.C) % ring.C;
    const d = haversineMeters(fix, { lat: ring.lat[c]!, lon: ring.lon[c]! });
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

for (const [key, series] of byBus) {
  const [, rid] = key.split("|") as [string, string];
  const stops = routeStops[rid];
  if (!stops || stops.length < 2) continue;
  const ring = ringForBus({ route_id: Number(rid) }, stops, stopCoords);
  if (!ring) continue;
  const N = ring.N;
  const stopPt: LatLon[] = [];
  for (let i = 0; i < N; i++) { const c = ring.stopCell[i]!; stopPt.push({ lat: ring.lat[c]!, lon: ring.lon[c]! }); }
  series.sort((a, b) => a.collected_at - b.collected_at);

  // Nearest stop + distance per frame, and whether the fix moved.
  const near: number[] = [], dist: number[] = [], moved: boolean[] = [];
  for (let j = 0; j < series.length; j++) {
    const o = series[j]!;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) { const d = haversineMeters(o, stopPt[i]!); if (d < bd) { bd = d; bi = i; } }
    near.push(bi); dist.push(bd);
    moved.push(j === 0 ? true : haversineMeters(series[j - 1]!, o) > MOVED_M);
  }

  // Episodes: a run of frames with the same nearest stop and no long gap.
  let s = 0;
  while (s < series.length) {
    let e = s;
    while (e + 1 < series.length && near[e + 1] === near[s]
      && series[e + 1]!.collected_at - series[e]!.collected_at <= GAP_MS) e++;
    const i = near[s]!;
    const sid = ring.stops[i]!, prevSid = ring.stops[(i - 1 + N) % N]!;
    let dmin = Infinity;
    for (let j = s; j <= e; j++) dmin = Math.min(dmin, dist[j]!);
    let lo = s, hi = e;
    while (lo <= e && dist[lo]! > dmin + PLATEAU_M) lo++;
    while (hi >= s && dist[hi]! > dmin + PLATEAU_M) hi--;
    let flipped = false;
    for (let j = s; j <= e; j++) {
      if (dist[j]! > ZONE_M) continue;
      const cls: Cls = j < lo ? "APPROACH" : j > hi ? "PAST" : "AT";
      const o = series[j]!;
      const feed = o.last_stop_id === sid;
      const cell = nearestCellNear(ring, o, ring.stopCell[i]!);
      const fwd = forwardCells(ring, ring.stopCell[i]!, cell);
      const geom = fwd > 0 && fwd < ring.C / 2;
      const rec = (t: Record<Cls, Cell>) => {
        const c = t[cls];
        c.n++;
        if (feed) c.feed++;
        if (geom) c.geom++;
        if (feed && geom) c.both++;
        if (!feed && !geom) c.neither++;
        if (o.last_stop_id === prevSid) c.feedPrev++;
      };
      rec(pooled);
      if (!byRoute.has(rid)) byRoute.set(rid, { APPROACH: blank(), AT: blank(), PAST: blank() });
      rec(byRoute.get(rid)!);
      if (moved[j]) rec(movingPooled);
      if (cls === "PAST" && !flipped && feed) {
        flipped = true;
        // how far past the closest approach the flip happened
        let m = 0;
        for (let k = hi + 1; k <= j; k++) m += haversineMeters(series[k - 1]!, series[k]!);
        flipM.push(m);
      }
    }
    if (!flipped && hi < e) flipNever.push(1);
    s = e + 1;
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const line = (name: string, c: Cell) =>
  `  ${name.padEnd(9)} n=${String(c.n).padStart(7)}   last_stop==stop ${pct(c.feed, c.n).padStart(7)}`
  + `   ==previous ${pct(c.feedPrev, c.n).padStart(7)}   ring says past ${pct(c.geom, c.n).padStart(7)}`
  + `   both ${pct(c.both, c.n).padStart(7)}   neither ${pct(c.neither, c.n).padStart(7)}`;

console.log(`frames within ${ZONE_M} m of a stop, plateau ${PLATEAU_M} m\n`);
console.log("POOLED, every frame");
for (const k of ["APPROACH", "AT", "PAST"] as Cls[]) console.log(line(k, pooled[k]));
console.log("\nPOOLED, frames whose fix MOVED (a bus that is not standing)");
for (const k of ["APPROACH", "AT", "PAST"] as Cls[]) console.log(line(k, movingPooled[k]));

// The posterior a cold belief would actually use.
const post = (pred: (c: Cell) => number) => {
  const a = pred(pooled.APPROACH), t = pred(pooled.AT), p = pred(pooled.PAST);
  return { a, t, p, tot: a + t + p };
};
for (const [name, f] of [["last_stop_id == this stop", (c: Cell) => c.feed],
  ["ring cell downstream", (c: Cell) => c.geom],
  ["both", (c: Cell) => c.both],
  ["neither", (c: Cell) => c.neither]] as [string, (c: Cell) => number][]) {
  const r = post(f);
  console.log(`\nP(class | ${name}):  APPROACH ${pct(r.a, r.tot)}   AT ${pct(r.t, r.tot)}   PAST ${pct(r.p, r.tot)}   (n=${r.tot})`);
}

console.log(`\nlast_stop_id flips a median ${flipM.length ? [...flipM].sort((x, y) => x - y)[Math.floor(flipM.length / 2)]!.toFixed(0) : "-"} m past the closest approach`
  + `  (n=${flipM.length}; ${flipNever.length} passes left the zone without it flipping)`);

console.log("\nBY ROUTE (P(last_stop==stop) | approach / at / past, and n past)");
for (const rid of [...byRoute.keys()].sort()) {
  const t = byRoute.get(rid)!;
  console.log(`  route ${rid.padEnd(4)}${(routeName[rid] ?? "").padEnd(16)}`
    + `${pct(t.APPROACH.feed, t.APPROACH.n).padStart(8)}${pct(t.AT.feed, t.AT.n).padStart(8)}${pct(t.PAST.feed, t.PAST.n).padStart(8)}`
    + `   n ${String(t.APPROACH.n).padStart(6)} ${String(t.AT.n).padStart(6)} ${String(t.PAST.n).padStart(6)}`);
}

// ── heading: which way is the bus pointing? ─────────────────────────────────
//
// Not used by the estimator at all today. The question it answers is not this
// script's main one — it says nothing about which side of a stop the bus is on
// — but it is the only field that separates two passes over ONE kerb, which is
// the other half of the same defect: Pink #124, 2026-09-04, 44 m from Quigley
// Stadium Outbound at 15:31:16 heading 158-192 degrees (southbound), and
// serving that same marker at 15:46:48 heading 337-339 (northbound). Fifteen
// minutes apart, 180 degrees apart, and the ring alone cannot tell them apart.
{
  const toRad = Math.PI / 180;
  const bearing = (a: LatLon, b: LatLon): number => {
    const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
    const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad)
      - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
    return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
  };
  const angle = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const moved: number[] = [], repeated: number[] = [];
  for (const [key, series] of byBus) {
    const [, rid] = key.split("|") as [string, string];
    const stops = routeStops[rid];
    if (!stops || stops.length < 2) continue;
    const ring = ringForBus({ route_id: Number(rid) }, stops, stopCoords);
    if (!ring) continue;
    series.sort((a, b) => a.collected_at - b.collected_at);
    let prev: any = null;
    for (const o of series) {
      const wasMoving = prev !== null && haversineMeters(prev, o) > MOVED_M;
      prev = o;
      if (o.heading === null || o.heading === undefined) continue;
      const d = distancesTo(ring, o);
      let bc = 0, bd = Infinity;
      for (let c = 0; c < ring.C; c++) if (d[c]! < bd) { bd = d[c]!; bc = c; }
      if (bd > 40) continue;  // only fixes clearly on the published line
      const nxt = (bc + 1) % ring.C;
      const e = angle(Number(o.heading), bearing({ lat: ring.lat[bc]!, lon: ring.lon[bc]! }, { lat: ring.lat[nxt]!, lon: ring.lon[nxt]! }));
      (wasMoving ? moved : repeated).push(e);
    }
  }
  const qq = (a: number[], p: number) => { const s2 = [...a].sort((x, y) => x - y); return s2[Math.floor(p * (s2.length - 1))] ?? NaN; };
  const within = (a: number[], lim: number) => pct(a.filter((x) => x <= lim).length, a.length);
  console.log("\nHEADING against the ring's own bearing at the fix's cell (fixes within 40 m of the line)");
  for (const [name, a] of [["fix moved", moved], ["fix repeated", repeated]] as [string, number[]][]) {
    console.log(`  ${name.padEnd(13)} n=${String(a.length).padStart(7)}  p50 ${qq(a, 0.5).toFixed(0)}deg  p90 ${qq(a, 0.9).toFixed(0)}deg`
      + `   within 45deg ${within(a, 45).padStart(7)}   REVERSED (>=135deg) ${pct(a.filter((x) => x >= 135).length, a.length).padStart(7)}`);
  }
  console.log("  The reversed tail is where the nearest cell is the WRONG branch of a fold:");
  console.log("  the heading is the evidence that would pick the right pass, and nothing reads it.");
}
