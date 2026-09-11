/**
 * Phase 2 — score the UNSTARTED-DWELL price against real arrivals.
 *
 * Same chains and the same time-travelled segment calibration as
 * eta-replay.ts, but the estimator under test is the one PR #40 shipped:
 * for a hop whose from-stop the bus has NOT reached yet, the dwell baked into
 * the segment is re-priced from the median to the low quantile (p35).
 *
 * Modes
 *   preP40     no re-pricing (the served segment average, dwell at its median)
 *   prod       today: p35 for every hop after the first
 *   catchupMed a bus whose holding over the previous 3 stops is far BELOW
 *              expected keeps the median price (the discount is withheld)
 *   catchupHalf same, but the discount is only halved
 *   oracleDef  the same withholding with a perfect (impossible) deficit signal
 *
 *   cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=... npx tsx scripts/eta-replay/dwell-quantile-replay.ts
 */
import fs from "node:fs";

import {
  DAY_MS,
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  metricsOf,
  routeAdjacency,
  serveRoute,
  type AdjEntry,
  type ServedRoute,
} from "./common.js";
import { median, percentile } from "../../src/calibrator/shrinkage.js";
import { distanceMeters } from "../../src/network/geo.js";
import { ROUTE_ID_LABEL } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const EVAL_DAYS = Number(process.env.EVAL_DAYS ?? 30);
const MAX_K = 5;
const MAX_HOP = 5;
const MAX_GAP_MS = 45 * 60_000;
const PREV = Number(process.env.PREV ?? 3);
const MIN_HOP_SEC = 30; // arrivals.ts

// calibrator.ts
const DWELL_WINDOW_MS = 14 * DAY_MS;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;

const net = loadNet();
const { db, network } = net;

const evalEnd = (db.prepare("SELECT MAX(arrived_at) m FROM arrivals").get() as { m: number }).m;
const evalStart = process.env.EVAL_START
  ? new Date(process.env.EVAL_START.replace(" ", "T")).getTime()
  : evalEnd - EVAL_DAYS * DAY_MS;
// The detector was rewritten 2026-08-31 13:00 ET; arrivals before it carry
// twin-stop flicker (docs/eta-accuracy.md).
const CLEAN_FROM = new Date("2026-08-31T13:00").getTime();
log(`eval window ${fmtEt(evalStart)} .. ${fmtEt(evalEnd)} ET`);

const samples = loadSamples(net, evalStart - SEGMENT_WINDOW_MS - 3_600_000, evalEnd);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
log(`segments ${samples.rows} rows / ${samples.groups.length} groups`);

// -- Time-travelled dwell stats ------------------------------------------------
interface DwellGroup { at: Float64Array; done: Float64Array; sec: Float64Array; dow: Int8Array; hour: Int8Array }
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(
      `SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
       WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`,
    )
    .all(evalStart - DWELL_WINDOW_MS - 3_600_000, evalEnd) as Array<{ r: number; s: number; a: number; d: number; dow: number; hour: number }>;
  const tmp = new Map<string, typeof rows>();
  for (const x of rows) {
    const k = `${x.r}:${x.s}`;
    let l = tmp.get(k);
    if (!l) tmp.set(k, (l = []));
    l.push(x);
  }
  for (const [k, l] of tmp) {
    dwellGroups.set(k, {
      at: Float64Array.from(l.map((x) => x.a)),
      done: Float64Array.from(l.map((x) => x.a + x.d * 1000)),
      sec: Float64Array.from(l.map((x) => x.d)),
      dow: Int8Array.from(l.map((x) => x.dow)),
      hour: Int8Array.from(l.map((x) => x.hour)),
    });
  }
}
interface DwellServed { med: number; low: number | undefined }
const dwellCache = new Map<string, DwellServed>();
function dwellAt(routeId: number, stopId: number, t: number): DwellServed {
  const start = calibCache.bucketStart(t);
  const key = `${start}|${routeId}:${stopId}`;
  const hit = dwellCache.get(key);
  if (hit) return hit;
  const g = dwellGroups.get(`${routeId}:${stopId}`);
  let out: DwellServed = { med: 15, low: undefined };
  if (g) {
    const d = new Date(start);
    const dow = d.getDay();
    const hours = new Set([(d.getHours() + 23) % 24, d.getHours(), (d.getHours() + 1) % 24]);
    const all: number[] = [];
    const win: number[] = [];
    for (let i = 0; i < g.at.length; i++) {
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (all.length) {
      const low = all.length >= DWELL_LOW_MIN_SAMPLES ? percentile(all, DWELL_LOW_QUANTILE) : undefined;
      const med = win.length ? median(win) : median(all);
      out = { med, low: low === undefined ? undefined : Math.min(low, med) };
    }
  }
  dwellCache.set(key, out);
  return out;
}

// -- Chains --------------------------------------------------------------------
interface Node { pos: number; stop: number; t: number; dwell: number | null }
const chains: Array<{ route: number; nodes: Node[] }> = [];
{
  const rows = db
    .prepare(
      `SELECT bus_name b, route_id r, stop_id s, arrived_at t, dwell_sec d FROM arrivals
       WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY route_id, bus_name, arrived_at, id`,
    )
    .all(evalStart, evalEnd) as Array<{ b: string; r: number; s: number; t: number; d: number | null }>;
  let curKey = "";
  let route = -1;
  let N = 0;
  let nodes: Node[] = [];
  let cur: Node | null = null;
  const end = () => { if (nodes.length) chains.push({ route, nodes }); nodes = []; cur = null; };
  const start = (a: (typeof rows)[number], positions: readonly number[]) => {
    if (positions.length !== 1) return;
    cur = { pos: positions[0]!, stop: a.s, t: a.t, dwell: a.d };
    nodes = [cur];
  };
  for (const a of rows) {
    const key = `${a.r}|${a.b}`;
    if (key !== curKey) { end(); curKey = key; route = a.r; N = network.routeLength(a.r); }
    const positions = network.positionsOnRoute(a.r, a.s);
    if (positions.length === 0 || N === 0) { end(); continue; }
    if (!cur) { start(a, positions); continue; }
    if (a.t - cur.t > MAX_GAP_MS) { end(); start(a, positions); continue; }
    const cands: number[] = [];
    for (const p of positions) {
      const dd = (p - cur.pos + N) % N;
      if (dd <= MAX_HOP && dd * 2 < N) cands.push(dd);
    }
    if (cands.length === 0) { end(); start(a, positions); continue; }
    let d: number;
    if (cands.length === 1) d = cands[0]!;
    else {
      const near = cands.filter((x) => x <= 2);
      if (near.length !== 1) { end(); continue; }
      d = near[0]!;
    }
    if (d === 0) { cur.dwell = a.d; continue; }
    const nd: Node = { pos: (cur.pos + d) % N, stop: a.s, t: a.t, dwell: a.d };
    nodes.push(nd);
    cur = nd;
  }
  end();
  log(`chains ${chains.length}, nodes ${chains.reduce((s, c) => s + c.nodes.length, 0)}`);
}

const chordByRoute = new Map<number, Float64Array>();
for (const r of net.routes) {
  const N = r.stops.length;
  const c = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = net.stopById.get(r.stops[i]!);
    const b = net.stopById.get(r.stops[(i + 1) % N]!);
    c[i] = a && b ? distanceMeters(a, b) : 0;
  }
  chordByRoute.set(r.id, c);
}

// -- Modes ---------------------------------------------------------------------
const MODES = ["preP40", "prod", "prodFixed", "catchupMed", "catchupFixed", "catchupFixedWide", "oracleDef", "oracleFixed"] as const;
type Mode = (typeof MODES)[number];
/** Deficit threshold: prev-3 holding below this multiple of expected. */
const DEFICIT = 0.5;
const DEFICIT_WIDE = 1.0;

interface Pair { k: number; route: number; t: number; actual: number; prevRatio: number; layoverAhead: boolean; err: Record<Mode, number> }
const pairs: Pair[] = [];
const servedCache = new Map<string, ServedRoute>();
function served(bucketStart: number, route: number): ServedRoute {
  const key = `${bucketStart}|${route}`;
  let s = servedCache.get(key);
  if (!s) { s = serveRoute(adjByRoute.get(route)!, calibCache.get(bucketStart).byName.base); servedCache.set(key, s); }
  return s;
}

let originCount = 0;
let nextLog = 0;
for (const c of chains) {
  const n = c.nodes;
  const adj = adjByRoute.get(c.route);
  if (!adj) continue;
  const N = adj.length;
  const chord = chordByRoute.get(c.route)!;
  for (let j = PREV; j < n.length - 1; j++) {
    // deficit signal from the PREVIOUS PREV stops (all must have a dwell)
    let prevAct = 0, prevExp = 0, ok = true;
    for (let m = j - PREV; m < j; m++) {
      const nd = n[m]!;
      if (nd.dwell === null) { ok = false; break; }
      prevAct += nd.dwell;
      prevExp += dwellAt(c.route, nd.stop, nd.t).med;
    }
    if (!ok || prevExp <= 0) continue;
    const prevRatio = prevAct / prevExp;
    const o = n[j]!;
    const bucketStart = calibCache.bucketStart(o.t);
    const sv = served(bucketStart, c.route);
    originCount++;

    // hop values under each mode
    const cum: Record<Mode, number> = { preP40: 0, prod: 0, prodFixed: 0, catchupMed: 0, catchupFixed: 0, catchupFixedWide: 0, oracleDef: 0, oracleFixed: 0 };
    let layoverAhead = false;
    // pairs for this origin, indexed by cumulative hops
    const wanted = new Map<number, number>(); // k -> actual sec
    {
      let cumHops = 0;
      for (let m = j + 1; m < n.length; m++) {
        const step = (n[m]!.pos - n[m - 1]!.pos + N) % N;
        cumHops += step === 0 ? 1 : step;
        if (cumHops > MAX_K) break;
        let meters = 0;
        for (let h = 0; h < cumHops; h++) meters += chord[(o.pos + h) % N]!;
        const actual = (n[m]!.t - o.t) / 1000;
        if (actual <= 0 || meters / actual > 22) continue; // same plausibility rule as the calibrator
        wanted.set(cumHops, actual);
      }
    }
    if (wanted.size === 0) continue;

    // the ORACLE deficit: did the bus actually go on to hold more than expected?
    let futAct = 0, futExp = 0;
    for (let m = j; m < Math.min(n.length, j + 2); m++) {
      const nd = n[m]!;
      if (nd.dwell === null) { futAct = 0; futExp = 0; break; }
      futAct += nd.dwell;
      futExp += dwellAt(c.route, nd.stop, nd.t).med;
    }
    const oracleWithhold = futExp > 0 && futAct > futExp;

    const withhold = prevRatio < DEFICIT;
    const withholdWide = prevRatio < DEFICIT_WIDE;

    for (let k = 1; k <= MAX_K; k++) {
      const pi = (o.pos + k - 1) % N;
      const base = sv.clientA[pi]!;
      let repriced = base;   // today: max(30, base - med) + low
      let fixed = base;      // the same intent, expressed as a discount: base - (med - low)
      if (k > 1) {
        const d = dwellAt(c.route, adj[pi]!.from, o.t);
        if (d.low !== undefined && d.low < d.med) {
          repriced = Math.max(MIN_HOP_SEC, base - d.med) + d.low;
          fixed = Math.max(MIN_HOP_SEC, base - (d.med - d.low));
          if (d.med >= 180) layoverAhead = true;
        }
      }
      cum.preP40 += base;
      cum.prod += repriced;
      cum.prodFixed += fixed;
      cum.catchupMed += withhold ? base : repriced;
      cum.catchupFixed += withhold ? base : fixed;
      cum.catchupFixedWide += withholdWide ? base : fixed;
      cum.oracleDef += oracleWithhold ? base : repriced;
      cum.oracleFixed += oracleWithhold ? base : fixed;
      const actual = wanted.get(k);
      if (actual === undefined) continue;
      pairs.push({
        k, route: c.route, t: o.t, actual, prevRatio, layoverAhead,
        err: Object.fromEntries(MODES.map((m) => [m, cum[m] - actual])) as Record<Mode, number>,
      });
    }
  }
  if (originCount >= nextLog) { log(`origins ${originCount}, pairs ${pairs.length}`); nextLog = originCount + 50000; }
}
log(`origins ${originCount}, pairs ${pairs.length}`);

// -- Scoring -------------------------------------------------------------------
function score(sel: Pair[], mode: Mode) {
  const errs = sel.map((p) => p.err[mode]);
  const m = metricsOf(errs);
  return {
    n: m.n,
    medianAbsSec: m.medianAbsSec,
    meanSignedSec: m.meanSignedSec,
    medianSignedSec: m.medianSignedSec,
    // >2 min in each direction, the way PR #40 framed the trade
    pessimisticOver120: r3(errs.filter((e) => e > 120).length / (errs.length || 1)),
    optimisticUnder120: r3(errs.filter((e) => e < -120).length / (errs.length || 1)),
  };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function block(sel: Pair[], label: string) {
  return { label, n: sel.length, ...Object.fromEntries(MODES.map((m) => [m, score(sel, m)])) };
}

const clean = pairs.filter((p) => p.t >= CLEAN_FROM);
const BUCKETS: Array<[string, number, number]> = [
  ["0-0.5x", 0, 0.5],
  ["0.5-1x", 0.5, 1],
  ["1-1.5x", 1, 1.5],
  ["1.5-2.5x", 1.5, 2.5],
  ["2.5x+", 2.5, Infinity],
];
function byBucket(sel: Pair[]) {
  return Object.fromEntries(BUCKETS.map(([name, lo, hi]) => [name, block(sel.filter((p) => p.prevRatio >= lo && p.prevRatio < hi), name)]));
}
const routeName = (r: number) => `${ROUTE_ID_LABEL[r] ?? "?"} (${net.routeById.get(r)?.name ?? r})`;
const busiest = [...new Set(pairs.map((p) => p.route))]
  .map((r) => [r, pairs.filter((p) => p.route === r).length] as const)
  .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r]) => r);

const result = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(evalStart), end: fmtEt(evalEnd), cleanFrom: fmtEt(CLEAN_FROM), prev: PREV, deficit: DEFICIT },
  origins: originCount,
  pairs: pairs.length,
  overall: block(pairs, "all pairs, 30 d"),
  overallClean: block(clean, "all pairs, clean window"),
  byBucket: byBucket(pairs),
  byBucketClean: byBucket(clean),
  deficitLayoverAhead: block(pairs.filter((p) => p.prevRatio < DEFICIT && p.layoverAhead), "deficit AND a rest ahead"),
  layoverAhead: block(pairs.filter((p) => p.layoverAhead), "a rest ahead (any bus)"),
  byRoute: Object.fromEntries(busiest.map((r) => [routeName(r), block(pairs.filter((p) => p.route === r), routeName(r))])),
  byHops: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, block(pairs.filter((p) => p.k === k), `k=${k}`)])),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const name = process.env.OUT_NAME ?? "dwell-quantile";
fs.writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
log(`wrote ${OUT_DIR}/${name}.json`);
