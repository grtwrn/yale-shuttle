/**
 * Phase 1 — does a bus's holding DEFICIT so far predict extra holding ahead?
 *
 * Pure `arrivals` analysis: no ETA arithmetic, no segment stats. For every
 * arrival in a bus's chain, compare the dwell it actually took against the
 * dwell the calibrator would have served at that instant (14-day window,
 * dow + hour±1 median, exactly computeDwellStats), then ask whether the ratio
 * over the previous P stops predicts the ratio over the next N.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=... npx tsx scripts/eta-replay/hold-signal.ts
 */
import fs from "node:fs";

import { DAY_MS, OUT_DIR, fmtEt, loadNet } from "./common.js";
import { median, percentile } from "../../src/calibrator/shrinkage.js";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const PREV = Number(process.env.PREV ?? 3);
const NEXT = Number(process.env.NEXT ?? 2);
const EVAL_DAYS = Number(process.env.EVAL_DAYS ?? 30);
const MAX_GAP_MS = 45 * 60_000;
const MAX_HOP = 5;

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
log(`eval window ${fmtEt(evalStart)} .. ${fmtEt(evalEnd)} ET`);

// -- Time-travelled dwell stats (calibrator.loadDwellGroups + computeDwellStats) --
interface DwellGroup {
  at: Float64Array;
  done: Float64Array;
  sec: Float64Array;
  dow: Int8Array;
  hour: Int8Array;
}
const dwellGroups = new Map<string, DwellGroup>();
{
  const rows = db
    .prepare(
      `SELECT route_id r, stop_id s, arrived_at a, dwell_sec d, dow, hour FROM arrivals
       WHERE dwell_sec IS NOT NULL AND arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at`,
    )
    .all(evalStart - DWELL_WINDOW_MS - 3_600_000, evalEnd) as Array<{
    r: number; s: number; a: number; d: number; dow: number; hour: number;
  }>;
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
  log(`dwell groups ${dwellGroups.size} from ${rows.length} rows`);
}

export interface DwellServed { med: number; low: number | undefined }
const dwellCache = new Map<string, DwellServed>();
const BUCKET_MS = 3_600_000;
export function dwellAt(routeId: number, stopId: number, t: number): DwellServed {
  const start = Math.floor(t / BUCKET_MS) * BUCKET_MS;
  const key = `${start}|${routeId}:${stopId}`;
  const hit = dwellCache.get(key);
  if (hit) return hit;
  const g = dwellGroups.get(`${routeId}:${stopId}`);
  let out: DwellServed = { med: 15, low: undefined }; // getDwellStats fallback
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

// -- Chains -------------------------------------------------------------------
// Same block rules as eta-replay.ts: per (route, bus_name), break on a 45-min
// gap or an implausible hop, collapse same-position re-anchors.
interface Node { pos: number; stop: number; t: number; dwell: number | null }
const chains: Array<{ route: number; nodes: Node[] }> = [];
{
  const rows = db
    .prepare(
      `SELECT bus_name b, bus_id i, route_id r, stop_id s, arrived_at t, dwell_sec d FROM arrivals
       WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY route_id, bus_name, arrived_at, id`,
    )
    .all(evalStart, evalEnd) as Array<{ b: string; i: number; r: number; s: number; t: number; d: number | null }>;
  log(`arrivals ${rows.length}`);
  let curKey = "";
  let route = -1;
  let N = 0;
  let nodes: Node[] = [];
  let cur: Node | null = null;
  const end = () => {
    if (nodes.length) chains.push({ route, nodes });
    nodes = [];
    cur = null;
  };
  const start = (a: (typeof rows)[number], positions: readonly number[]) => {
    if (positions.length !== 1) return;
    cur = { pos: positions[0]!, stop: a.s, t: a.t, dwell: a.d };
    nodes = [cur];
  };
  for (const a of rows) {
    const key = `${a.r}|${a.b}`;
    if (key !== curKey) {
      end();
      curKey = key;
      route = a.r;
      N = network.routeLength(a.r);
    }
    const positions = network.positionsOnRoute(a.r, a.s);
    if (positions.length === 0 || N === 0) { end(); continue; }
    if (!cur) { start(a, positions); continue; }
    if (a.t - cur.t > MAX_GAP_MS) { end(); start(a, positions); continue; }
    const cands: number[] = [];
    for (const p of positions) {
      const dd = (p - cur.pos + N) % N;
      if (dd <= MAX_HOP && dd * 2 < N) cands.push(dd);
    }
    let d: number;
    if (cands.length === 0) { end(); start(a, positions); continue; }
    if (cands.length === 1) d = cands[0]!;
    else {
      const near = cands.filter((x) => x <= 2);
      if (near.length !== 1) { end(); continue; }
      d = near[0]!;
    }
    if (d === 0) { cur.dwell = a.d; continue; } // re-anchor at the same position
    const nd: Node = { pos: (cur.pos + d) % N, stop: a.s, t: a.t, dwell: a.d };
    nodes.push(nd);
    cur = nd;
  }
  end();
  log(`chains ${chains.length}, nodes ${chains.reduce((s, c) => s + c.nodes.length, 0)}`);
}

// -- Observations -------------------------------------------------------------
interface Obs {
  route: number;
  t: number;
  prevAct: number; prevExp: number;
  nextAct: number; nextExp: number;
  /** low-quantile price of the next N holds (what the board bills today) */
  nextLow: number;
  /** identity of the stops in the "next" window, for the within-stops control */
  nextKey: string;
  layoverAhead: boolean;
}
const obs: Obs[] = [];
for (const c of chains) {
  const n = c.nodes;
  for (let j = PREV; j + NEXT < n.length; j++) {
    let prevAct = 0, prevExp = 0, ok = true;
    for (let m = j - PREV; m < j; m++) {
      const nd = n[m]!;
      if (nd.dwell === null) { ok = false; break; }
      prevAct += nd.dwell;
      prevExp += dwellAt(c.route, nd.stop, nd.t).med;
    }
    if (!ok || prevExp <= 0) continue;
    let nextAct = 0, nextExp = 0, nextLow = 0, layover = false;
    const keys: string[] = [];
    for (let m = j; m < j + NEXT; m++) {
      const nd = n[m]!;
      if (nd.dwell === null) { ok = false; break; }
      const s = dwellAt(c.route, nd.stop, nd.t);
      nextAct += nd.dwell;
      nextExp += s.med;
      nextLow += s.low ?? s.med;
      if (s.med >= 180) layover = true;
      keys.push(String(nd.stop));
    }
    if (!ok || nextExp <= 0) continue;
    obs.push({
      route: c.route,
      t: n[j]!.t,
      prevAct, prevExp, nextAct, nextExp, nextLow,
      nextKey: `${c.route}|${keys.join(",")}`,
      layoverAhead: layover,
    });
  }
}
log(`observations ${obs.length}`);

// -- Tables -------------------------------------------------------------------
const BUCKETS: Array<[string, number, number]> = [
  ["0-0.5x", 0, 0.5],
  ["0.5-1x", 0.5, 1],
  ["1-1.5x", 1, 1.5],
  ["1.5-2.5x", 1.5, 2.5],
  ["2.5-5x", 2.5, 5],
  ["5x+", 5, Infinity],
];
const bucketOf = (r: number) => BUCKETS.findIndex(([, lo, hi]) => r >= lo && r < hi);

// Within-stops control: the mean excess (actual − expected, seconds) for the
// same stops ahead, over ALL observations. Subtracting it removes "which stops
// are in the window" — the obvious confound, since a bus that has held little
// is a bus that has not reached its layover yet.
const keyStats = new Map<string, { n: number; excess: number; ratio: number }>();
for (const o of obs) {
  let k = keyStats.get(o.nextKey);
  if (!k) keyStats.set(o.nextKey, (k = { n: 0, excess: 0, ratio: 0 }));
  k.n++;
  k.excess += o.nextAct - o.nextExp;
  k.ratio += o.nextAct / o.nextExp;
}

function table(rows: Obs[], label: string) {
  const out: any[] = [];
  for (let b = 0; b < BUCKETS.length; b++) {
    const sel = rows.filter((o) => bucketOf(o.prevAct / o.prevExp) === b);
    if (sel.length === 0) { out.push({ bucket: BUCKETS[b]![0], n: 0 }); continue; }
    const ratios = sel.map((o) => o.nextAct / o.nextExp);
    const excess = sel.map((o) => o.nextAct - o.nextExp);
    const deMeaned = sel.map((o) => {
      const k = keyStats.get(o.nextKey)!;
      return o.nextAct - o.nextExp - k.excess / k.n;
    });
    const vsLow = sel.map((o) => o.nextAct - o.nextLow);
    out.push({
      bucket: BUCKETS[b]![0],
      n: sel.length,
      meanRatio: r2(mean(ratios)),
      medianRatio: r2(median(ratios)),
      meanExcessSec: r1(mean(excess)),
      medianExcessSec: r1(median(excess)),
      // the control: same stops ahead, deviation from what those stops usually do
      meanExcessDeMeanedSec: r1(mean(deMeaned)),
      medianExcessDeMeanedSec: r1(median(deMeaned)),
      // how far the board's own price (p35 for an unstarted hold) undershoots
      meanUnderPricedSec: r1(mean(vsLow)),
      medianUnderPricedSec: r1(median(vsLow)),
      layoverAheadShare: r2(sel.filter((o) => o.layoverAhead).length / sel.length),
    });
  }
  return { label, n: rows.length, rows: out };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

const ROUTE_NAME = (r: number) => net.routeById.get(r)?.name ?? String(r);
const busiest = [...new Set(obs.map((o) => o.route))]
  .map((r) => [r, obs.filter((o) => o.route === r).length] as const)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .map(([r]) => r);

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i]! - mx, b = ys[i]! - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy);
}
const prevR = obs.map((o) => o.prevAct / o.prevExp);
const nextR = obs.map((o) => o.nextAct / o.nextExp);
const nextExcessDeMeaned = obs.map((o) => { const k = keyStats.get(o.nextKey)!; return o.nextAct - o.nextExp - k.excess / k.n; });
const correlations = {
  prevRatio_vs_nextRatio: r2(corr(prevR, nextR)),
  prevRatio_vs_nextExcessDeMeanedSec: r2(corr(prevR, nextExcessDeMeaned)),
  prevRatioClamped5_vs_nextRatioClamped5: r2(corr(prevR.map((x) => Math.min(x, 5)), nextR.map((x) => Math.min(x, 5)))),
};
console.error("correlations", JSON.stringify(correlations));

const result = {
  correlations,
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(evalStart), end: fmtEt(evalEnd), prev: PREV, next: NEXT },
  observations: obs.length,
  all: table(obs, `all (prev ${PREV}, next ${NEXT})`),
  layoverAhead: table(obs.filter((o) => o.layoverAhead), "a layover (median hold >= 180 s) is in the next window"),
  noLayoverAhead: table(obs.filter((o) => !o.layoverAhead), "ordinary stops only ahead"),
  byRoute: Object.fromEntries(busiest.map((r) => [ROUTE_NAME(r), table(obs.filter((o) => o.route === r), ROUTE_NAME(r))])),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const name = process.env.OUT_NAME ?? "hold-signal";
fs.writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
log(`wrote ${OUT_DIR}/${name}.json`);
