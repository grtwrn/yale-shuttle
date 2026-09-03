/**
 * DEPARTURE TRACE: replay one captured bus through production and through the
 * corroborated anchor, side by side, around a real departure.
 *
 * The operator's constraint is absolute: "it can go 5->1 if it leaves early."
 * The aggregate departure-lag figure says the gate is transparent (p50 and p90
 * both 0 s); this is the named case behind it, printed poll by poll so the
 * claim can be checked by eye rather than believed.
 *
 *   BUS=#309 FROM=21:18 TO=21:30 npx tsx scripts/eta-replay/trace-departure.ts
 *
 * The operator's rule, which replaces "reduce jump magnitude" as the goal:
 *
 *   "it can go 5->1 if it leaves early. but if it is jitter we need a fix."
 *
 * A 5 min -> 1 min collapse is CORRECT when the bus really did pull out early;
 * suppressing it withholds information a rider standing at a stop needs. The
 * defect is a change that no event in the world caused.
 *
 * So every jump >= JUMP_BIG_SEC is asked one question: between these two
 * polls, did anything actually happen to this bus?
 *
 *   arrival/departure   the detector logged an arrival, or the at-stop flag
 *                       flipped -- a real event, the ETA SHOULD move
 *   moved >= 100 m      the bus covered real ground
 *   moved < 100 m       it twitched. The feed's 30 m deadband means the
 *                       smallest reportable move is ~30 m, and no 30-90 m
 *                       twitch justifies a five-minute swing. Disproportionate.
 *   fix identical       the coordinate did not change AT ALL. Nothing happened.
 *                       This is jitter with no defence.
 *
 * The last two are the population to suppress. The first two must be left
 * alone, which is why an indiscriminate rate limiter was rejected: it cannot
 * tell them apart.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/jitter-classify.ts
 */
import fs from "node:fs";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
} from "./common.js";
import {
  planTracks,
  stepMany,
  type BusObservation,
  type BusState,
} from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { fmtMin } from "../../web/src/format";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_ID_LABEL, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";
import { pruneAnchors, type AnchorStore } from "../../web/src/anchorGate";


const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const AT_STOP_MAX_M = 75;
/** A jump this big is the operator's complaint rather than ordinary noise. */
const JUMP_BIG_SEC = Number(process.env.JUMP_BIG_SEC ?? 300);
/** Ignore pairs of polls further apart than this (feed gap, not a jump). */
const MAX_POLL_GAP_MS = 20_000;
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const CAPTURE = process.env.CAPTURE ?? `${process.env.HOME}/shuttle-captures/positions-20260903.jsonl`;
const BUS = process.env.BUS ?? "#309";
const hhmm = (v: string | undefined, d: string) => (v ?? d).split(":").map(Number);
const [fh, fm] = hhmm(process.env.FROM, "21:18");
const [th, tm] = hhmm(process.env.TO, "21:30");
const pos = fs.readFileSync(CAPTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((r: any) => r.bus_name === BUS)
  .map((r: any) => ({ i: r.bus_id, b: r.bus_name, r: r.route_id, lat: r.lat, lon: r.lon, h: r.heading, l: r.last_stop_id, t: r.collected_at }))
  .filter((r: PosRow) => {
    const d = new Date(r.t);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= fh * 60 + fm && mins <= th * 60 + tm;
  })
  .sort((a: PosRow, b: PosRow) => a.t - b.t) as PosRow[];
if (pos.length === 0) throw new Error(`no capture rows for ${BUS} in the window`);
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

// -- served payload (segments + dwells), time-travelled per hour --------------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const segCache = new Map<string, SegmentTimes>();
function segmentsAt(t: number): SegmentTimes {
  const bs = calibCache.bucketStart(t);
  let p = segCache.get(String(bs));
  if (!p) {
    const bc = calibCache.get(bs);
    const st: SegmentTimes = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(String(bs), (p = st));
  }
  return p;
}
interface DwellGroup { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(`SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
              WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`)
    .all(rawStart - DWELL_WINDOW_MS - 3_600_000, rawEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, Array<{ a: number; d: number; dow: number; hour: number }>>();
  for (const x of rows) {
    const k = `${x.r}:${x.s}`;
    let l = tmp.get(k);
    if (!l) tmp.set(k, (l = []));
    l.push(x);
  }
  for (const [k, l] of tmp) dwellGroups.set(k, {
    at: Float64Array.from(l.map((x) => x.a)), done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
    sec: Float64Array.from(l.map((x) => x.d)), dow: Int8Array.from(l.map((x) => x.dow)), hour: Int8Array.from(l.map((x) => x.hour)),
  });
}
function pct(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellCache = new Map<string, DwellTimes>();
function dwellsAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellCache.get(String(start));
  if (hit) return hit;
  const d = new Date(start);
  const dow = d.getDay();
  const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
  const out: DwellTimes = {};
  for (const [key, g] of dwellGroups) {
    const [rid, sid] = key.split(":");
    const all: number[] = [];
    const win: number[] = [];
    for (let i = 0; i < g.at.length; i++) {
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (!all.length) continue;
    const low = all.length >= DWELL_LOW_MIN_SAMPLES ? pct(all, DWELL_LOW_QUANTILE) : undefined;
    const src = win.length ? win : all;
    const med = median(src);
    const stat = { med, sd: Math.max(pct(src, 0.9) - med, 5), n: win.length, ...(low !== undefined ? { low: Math.min(low, med) } : {}) };
    (out[rid!] ||= {})[sid!] = stat;
  }
  dwellCache.set(String(start), out);
  return out;
}

// -- polls ---------------------------------------------------------------------
const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = [];
  let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) {
      if (cur.length) polls.push(cur);
      cur = [];
      curAt = p.t;
    }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}
log(`polls ${polls.length}`);

// -- truth, for the accuracy guard rail ---------------------------------------
interface DetEv { s: number; t: number }
const detSeq = new Map<string, DetEv[]>();
{
  const rows = db.prepare(`SELECT bus_name b, stop_id s, arrived_at t FROM arrivals
                           WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(rawStart - 3_600_000, rawEnd + 45 * 60_000) as Array<{ b: string; s: number; t: number }>;
  for (const a of rows) {
    let l = detSeq.get(a.b);
    if (!l) detSeq.set(a.b, (l = []));
    l.push({ s: a.s, t: a.t });
  }
}
/** Next time this bus reaches this stop after t, or null. */
function nextArrival(busName: string, stopId: number, t: number): number | null {
  const seq = detSeq.get(busName);
  if (!seq) return null;
  let lo = 0, hi = seq.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (seq[m]!.t <= t) lo = m + 1; else hi = m; }
  for (let i = lo; i < seq.length; i++) {
    if (seq[i]!.t - t > 45 * 60_000) return null;
    if (seq[i]!.s === stopId) return seq[i]!.t;
  }
  return null;
}




// -- trace ---------------------------------------------------------------------
import { gateAnchor, type AnchorStore } from "../../web/src/anchorGate";

const store: AnchorStore = new Map();
const states = new Map<string, BusState>();
const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(pos[0]!.r))!;
const stops = mergedRouteStops(cfg, net.routeStops);
log(`${BUS} on ${cfg.label}: ${pos.length} rows, ${fmtEt(pos[0]!.t)} .. ${fmtEt(pos[pos.length - 1]!.t)} ET`);

let prevAt: number | null | undefined;
const rows: string[] = [];
for (const o of pos) {
  const obs = [{ busId: o.i, busName: o.b, routeId: o.r, lat: o.lat, lon: o.lon, heading: o.h, lastStopId: o.l, collectedAt: o.t }];
  const plan = planTracks(obs);
  stepMany(network, states, obs, plan);
  const st = states.get(plan.keys.get(o.i) ?? o.b);
  const dwellingForMs = st ? o.t - st.enteredAt : 0;
  const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
  const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
  const bus: BusData = {
    bus_id: o.i, bus_name: o.b, route_id: o.r, lat: o.lat, lon: o.lon, heading: o.h,
    last_stop_id: o.l as number, stationary: at != null,
    ...(at ? { at_stop_id: at.id, at_stop_since: new Date(at.since).toISOString().replace(/Z$/, "") } : {}),
  };
  const segs = segmentsAt(o.t);
  const dw = dwellsAt(o.t);
  const raw = findRouteAnchor(bus, stops, net.stopCoords);
  const g = gateAnchor(store, `${cfg.label}|${o.b}`, raw, bus, o.t, stops.length);
  const target = stops[(g.index + 1) % stops.length]!;
  const pick = (arr: any[]) => { const f = arr.filter((a) => a.stopId === target).sort((a, b) => a.eta - b.eta); return f[0]?.eta ?? NaN; };
  const shipped = pick(computeUpcomingArrivals([target], [bus], net.routeStops, net.stopCoords, segs, o.t, dw));
  const gated = pick(computeUpcomingArrivals([target], [bus], net.routeStops, net.stopCoords, segs, o.t, dw, store));
  const departed = prevAt !== undefined && prevAt !== null && at === null;
  prevAt = at ? at.id : null;
  rows.push(
    `${fmtEt(o.t).slice(11)}  atStop=${String(at ? at.id : "-").padStart(4)}  raw=${String(raw).padStart(3)} gated=${String(g.index).padStart(3)} ${String(g.released ?? "HELD").padEnd(19)}` +
    ` shipped=${fmtMin(shipped).padStart(7)} gate=${fmtMin(gated).padStart(7)}  d=${String(Math.round(gated - shipped)).padStart(5)}s` +
    (departed ? "   <<< DEPARTED" : ""),
  );
}
console.log(rows.join("\n"));
const held = rows.filter((r) => r.includes("HELD")).length;
console.log(`\npolls ${rows.length}, anchor held on ${held} (${Math.round((100 * held) / rows.length)}%)`);
