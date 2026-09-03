/**
 * ETA error budget: what would a PERFECT estimate of each ingredient be worth?
 *
 * Runs the real `computeUpcomingArrivals` (not a replica — the replica inside
 * gps-replay.ts is three commits stale) once per hop boundary, with the served
 * segment table doctored so that one ingredient is oracular and the rest stay
 * calibrated. The drop in error is that ingredient's share of the budget.
 *
 *   shipped        what riders get
 *   oracleHop1     perfect time to the NEXT stop only; everything after it
 *                  calibrated. Upper bound for any filter over the bus's
 *                  current position and speed: such a filter cannot know
 *                  anything about hop 2 onward that calibration does not.
 *   oracleHop1Drive  perfect DRIVING time on the current hop only, with dwell
 *                  and hold calibrated everywhere. This is the honest ceiling
 *                  for a motion model -- physics cannot tell you how long a
 *                  driver chooses to stand at a stop.
 *   oracleStanding perfect dwell + hold on every hop, calibrated driving
 *   oracleDriving  perfect driving on every hop, calibrated dwell + hold
 *   oracleAllHops  perfect hop times (anchor still the client's)
 *
 * Truth is the detector's own arrival (the anchor switch), because that is the
 * exact quantity hop times sum to — using the 50 m proximity truth instead
 * would add a ~25 s definitional offset to every oracle and muddy the
 * comparison. The shipped row is also scored on the proximity truth so it can
 * be lined up with docs/eta-accuracy.md.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/eta-budget.ts
 */
import fs from "node:fs";

import {
  OUT_DIR,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  metricsOf,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  SEGMENT_WINDOW_MS,
  type AdjEntry,
  type ServedRoute,
} from "./common.js";
import {
  planTracks,
  stepMany,
  type BusObservation,
  type BusState,
  type SegmentEvent,
} from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { computeUpcomingArrivals, type SegmentTimes } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_ID_LABEL, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const MAX_K = 5;
const STILL_RADIUS_M = Number(process.env.STILL_RADIUS_M ?? 25);
const MIN_STILL_S = Number(process.env.MIN_STILL_S ?? 15);
const AT_STOP_MAX_M = 75;
const MATCH_MS = 45 * 60_000;
const ENTER_M = 50;
const EXIT_M = 120;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db
  .prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
            FROM raw_positions ORDER BY collected_at, id`)
  .all() as PosRow[];
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

const trackByName = new Map<string, PosRow[]>();
for (const p of pos) {
  let l = trackByName.get(p.b);
  if (!l) trackByName.set(p.b, (l = []));
  l.push(p);
}
// -- stillness (same definition as hop-anatomy.ts) -----------------------------
const stillByName = new Map<string, Uint8Array>();
for (const [name, track] of trackByName) {
  const n = track.length;
  const still = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let j = i;
    while (j + 1 < n) {
      if (track[j + 1]!.t - track[j]!.t > 60_000) break;
      if (distanceMeters(track[i]!, track[j + 1]!) > STILL_RADIUS_M) break;
      j++;
    }
    if (track[j]!.t - track[i]!.t >= MIN_STILL_S * 1000) for (let k = i; k <= j; k++) still[k] = 1;
  }
  stillByName.set(name, still);
}

// -- detector replay: hops + the bus state at each hop boundary ----------------
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
const segEvents: SegmentEvent[] = [];
/** bus state (anchor index, at-stop) captured at each poll, by "name|t". */
const stateAt = new Map<string, { idx: number; atStopId: number | null; atStopSince: number | null }>();
{
  const states = new Map<string, BusState>();
  for (const poll of polls) {
    const plan = planTracks(poll);
    for (const e of stepMany(network, states, poll, plan)) if (e.kind === "segment") segEvents.push(e);
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      if (!st) continue;
      const dwellingForMs = o.collectedAt - st.enteredAt;
      const cand = dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const at = cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
      stateAt.set(`${o.busName}|${o.collectedAt}`, { idx: st.nearestIndex, atStopId: at ? at.id : null, atStopSince: at ? at.since : null });
    }
  }
}
log(`segment events ${segEvents.length}`);

// -- classify each hop ---------------------------------------------------------
interface Hop { key: string; routeId: number; from: number; to: number; busName: string; tA: number; tB: number; hopSec: number; dwell: number; hold: number; drive: number }
const hopsByBus = new Map<string, Hop[]>();
const allHops: Hop[] = [];
for (const ev of segEvents) {
  const track = trackByName.get(ev.busName);
  const origin = net.stopById.get(ev.fromStopId);
  if (!track || !origin) continue;
  const still = stillByName.get(ev.busName)!;
  const tA = ev.startedAt;
  const tB = tA + ev.travelSec * 1000;
  let s = 0;
  while (s < track.length && track[s]!.t < tA) s++;
  let e = s;
  while (e < track.length && track[e]!.t <= tB) e++;
  if (e - s < 2) continue;
  let dwell = 0, hold = 0, drive = 0, unknown = 0;
  for (let i = s; i + 1 < e; i++) {
    const dt = (track[i + 1]!.t - track[i]!.t) / 1000;
    if (dt > 60) { unknown += dt; continue; }
    if (still[i] !== 1) drive += dt;
    else if (distanceMeters(track[i]!, origin) <= AT_STOP_MAX_M) dwell += dt;
    else hold += dt;
  }
  if (unknown > 0.1 * ev.travelSec) continue;
  const measured = dwell + hold + drive + unknown;
  if (measured > 0) {
    const scale = ev.travelSec / measured;
    if (scale > 0.5 && scale < 2) { dwell *= scale; hold *= scale; drive *= scale; }
  }
  const hop: Hop = { key: `${ev.routeId}:${ev.fromStopId}:${ev.toStopId}`, routeId: ev.routeId, from: ev.fromStopId, to: ev.toStopId, busName: ev.busName, tA, tB, hopSec: ev.travelSec, dwell, hold, drive };
  allHops.push(hop);
  let l = hopsByBus.get(ev.busName);
  if (!l) hopsByBus.set(ev.busName, (l = []));
  l.push(hop);
}
for (const l of hopsByBus.values()) l.sort((a, b) => a.tA - b.tA);
log(`hops classified ${allHops.length}`);

// -- group means (the "calibrated" counterpart of each component) --------------
const groupMean = new Map<string, { d: number; h: number; m: number; g: number; n: number }>();
{
  const acc = new Map<string, { d: number; h: number; m: number; n: number }>();
  for (const hp of allHops) {
    let a = acc.get(hp.key);
    if (!a) acc.set(hp.key, (a = { d: 0, h: 0, m: 0, n: 0 }));
    a.d += hp.dwell; a.h += hp.hold; a.m += hp.drive; a.n++;
  }
  for (const [k, a] of acc) groupMean.set(k, { d: a.d / a.n, h: a.h / a.n, m: a.m / a.n, g: (a.d + a.h + a.m) / a.n, n: a.n });
}

// -- served payload ------------------------------------------------------------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const servedCache = new Map<string, SegmentTimes>();
function payloadAt(t: number): SegmentTimes {
  const bs = calibCache.bucketStart(t);
  let p = servedCache.get(String(bs));
  if (!p) {
    const bc = calibCache.get(bs);
    const segmentTimes: SegmentTimes = {};
    for (const r of net.routes) {
      const adj = adjByRoute.get(r.id)!;
      const s: ServedRoute = serveRoute(adj, bc.byName.base);
      segmentTimes[String(r.id)] = segmentTimesFor(adj, s);
    }
    servedCache.set(String(bs), (p = segmentTimes));
  }
  return p;
}

// -- ground truths -------------------------------------------------------------
interface DetEv { s: number; t: number }
const detSeq = new Map<string, DetEv[]>();
{
  const rows = db.prepare(`SELECT bus_name b, route_id r, stop_id s, arrived_at t FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at, id`)
    .all(rawStart - 3_600_000, rawEnd + MATCH_MS) as Array<{ b: string; r: number; s: number; t: number }>;
  for (const a of rows) {
    const k = `${a.r} ${a.b}`;
    let l = detSeq.get(k);
    if (!l) detSeq.set(k, (l = []));
    l.push({ s: a.s, t: a.t });
  }
}
function detIndexAt(seq: DetEv[], t: number): number {
  let lo = 0, hi = seq.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (seq[mid]!.t <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
function detectorArrival(routeId: number, busName: string, stopId: number, t: number, occurrence: number): number | null {
  const seq = detSeq.get(`${routeId} ${busName}`);
  if (!seq) return null;
  const m = detIndexAt(seq, t);
  if (m < 0) return null;
  let seen = 0;
  for (let i = m; i < seq.length; i++) {
    const ev = seq[i]!;
    if (ev.t - t > MATCH_MS) return null;
    if (ev.s !== stopId) continue;
    if (seen === occurrence) return ev.t;
    seen++;
  }
  return null;
}
const entryCache = new Map<string, Float64Array>();
function entries(busName: string, stopId: number): Float64Array {
  const key = `${busName} ${stopId}`;
  let e = entryCache.get(key);
  if (e) return e;
  const track = trackByName.get(busName)!;
  const s = net.stopCoords[stopId]!;
  const out: number[] = [];
  let inside = false;
  let prev: PosRow | null = null;
  for (const p of track) {
    if (prev && p.t - prev.t <= 60_000) {
      const d = distanceToSegmentM(s, { lat: prev.lat, lon: prev.lon }, { lat: p.lat, lon: p.lon });
      if (!inside && d <= ENTER_M) {
        const tt = Math.max(0, Math.min(1, progressAlongSegment(s, { lat: prev.lat, lon: prev.lon }, { lat: p.lat, lon: p.lon })));
        out.push(prev.t + tt * (p.t - prev.t));
        inside = true;
      } else if (inside && haversineMeters(s, p) >= EXIT_M) inside = false;
    } else {
      const d = haversineMeters(s, p);
      if (!inside && d <= ENTER_M) { out.push(p.t); inside = true; }
      else if (inside && d >= EXIT_M) inside = false;
    }
    prev = p;
  }
  entryCache.set(key, (e = Float64Array.from(out)));
  return e;
}
function proximityArrival(busName: string, stopId: number, detT: number): number | null {
  const e = entries(busName, stopId);
  let best: number | null = null;
  for (let i = 0; i < e.length; i++) {
    const x = e[i]!;
    if (x < detT - 90_000) continue;
    if (x > detT + 300_000) break;
    if (best === null || Math.abs(x - detT) < Math.abs(best - detT)) best = x;
  }
  return best;
}

// -- score ---------------------------------------------------------------------
// Predictions are explicit sums of per-hop values, made at each hop boundary
// from the DETECTOR's anchor. At that instant the bus has just re-anchored, so
// the client would apply neither stall credit nor meaningful proration — the
// sum is what its arithmetic reduces to, and `oracleAllHops` scoring exactly 0
// against the detector truth is the proof that the plumbing is right.
//
// The shipped CLIENT function is scored alongside on the same moments, so the
// gap between "shipped sum" and "client" is what the client's own anchor and
// proration add on top of calibration error.
const MODES = ["shipped", "oracleHop1", "oracleHop1Drive", "oracleStanding", "oracleDriving", "oracleAllHops", "client"] as const;
type Mode = (typeof MODES)[number];
interface Pair { k: number; routeId: number; agree: boolean; eta: Record<Mode, number>; det: number | null; prox: number | null }
const pairs: Pair[] = [];
const posByNameTime = new Map<string, PosRow>();
for (const p of pos) posByNameTime.set(`${p.b}|${p.t}`, p);

let skipped = 0;
let noServed = 0;
for (const [busName, hops] of hopsByBus) {
  for (let hi = 0; hi < hops.length; hi++) {
    const h0 = hops[hi]!;
    const chain: Hop[] = [h0];
    let ok = true;
    for (let j = 1; j < MAX_K; j++) {
      const nx = hops[hi + j];
      if (!nx || Math.abs(nx.tA - chain[j - 1]!.tB) > 15_000 || nx.from !== chain[j - 1]!.to) { ok = false; break; }
      chain.push(nx);
    }
    if (!ok) { skipped++; continue; }
    if (!chain.every((h) => groupMean.has(h.key))) { skipped++; continue; }
    const t = h0.tA;
    const p = posByNameTime.get(`${busName}|${t}`);
    const st = stateAt.get(`${busName}|${t}`);
    if (!p || !st) { skipped++; continue; }
    const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(p.r));
    if (!cfg) { skipped++; continue; }
    const stops = mergedRouteStops(cfg, net.routeStops);
    const bus: BusData = {
      bus_id: p.i, bus_name: p.b, route_id: p.r, lat: p.lat, lon: p.lon, heading: p.h,
      last_stop_id: p.l as number, stationary: st.atStopId != null,
      ...(st.atStopId != null ? { at_stop_id: st.atStopId, at_stop_since: new Date(st.atStopSince!).toISOString().replace(/Z$/, "") } : {}),
    };
    const onRoute = isBusOnRoute(bus, stops, net.stopCoords);
    const clientIdx = onRoute ? findRouteAnchor(bus, stops, net.stopCoords) : -1;
    const base = payloadAt(t);
    const baseSegs = base[String(cfg.routeIds[0]!)] ?? {};
    const served = (h: Hop): number | null => {
      const v = baseSegs[`${h.from}-${h.to}`];
      return v && v.n >= 1 ? v.avg : null;
    };
    if (!chain.every((h) => served(h) !== null)) { noServed++; continue; }
    const gm = (h: Hop) => groupMean.get(h.key)!;

    // The client's own output at this instant, for the reference row.
    const targets = chain.map((h) => h.to);
    let clientEtas: number[] = new Array(MAX_K).fill(NaN);
    if (clientIdx >= 0) {
      const res = computeUpcomingArrivals([...new Set(targets)], [bus], net.routeStops, net.stopCoords, base, t)
        .filter((a) => a.routeLabel === cfg.label);
      const used = new Map<number, number>();
      clientEtas = targets.map((sid) => {
        const occ = used.get(sid) ?? 0;
        used.set(sid, occ + 1);
        const forStop = res.filter((a) => a.stopId === sid).sort((a, b) => a.eta - b.eta);
        return forStop[occ]?.eta ?? NaN;
      });
    }

    const cum: Record<Mode, number> = { shipped: 0, oracleHop1: 0, oracleHop1Drive: 0, oracleStanding: 0, oracleDriving: 0, oracleAllHops: 0, client: 0 };
    const agree = clientIdx >= 0 && (clientIdx - st.idx + stops.length) % stops.length === 0;
    for (let k = 1; k <= MAX_K; k++) {
      const h = chain[k - 1]!;
      const sv = served(h)!;
      cum.shipped += sv;
      cum.oracleHop1 += k === 1 ? h.hopSec : sv;
      // The true ceiling for a motion model: it can know exactly how long the
      // bus will spend DRIVING the current hop, and nothing about how long the
      // driver will stand at any stop, now or later.
      cum.oracleHop1Drive += k === 1 ? gm(h).d + gm(h).h + h.drive : sv;
      cum.oracleStanding += h.dwell + h.hold + gm(h).m;
      cum.oracleDriving += gm(h).d + gm(h).h + h.drive;
      cum.oracleAllHops += h.hopSec;
      const occ = targets.slice(0, k).filter((x) => x === h.to).length - 1;
      const det = detectorArrival(p.r, busName, h.to, t, occ);
      const prox = det === null ? null : proximityArrival(busName, h.to, det);
      pairs.push({
        k, routeId: p.r, agree,
        eta: { ...cum, client: clientEtas[k - 1]! },
        det: det === null ? null : (det - t) / 1000,
        prox: prox === null ? null : (prox - t) / 1000,
      });
    }
  }
}
log(`pairs ${pairs.length} (skipped chains ${skipped}, no served value ${noServed})`);

function score(truth: "det" | "prox", mode: Mode, filter: (p: Pair) => boolean) {
  const errs: number[] = [];
  for (const p of pairs) {
    const a = p[truth];
    const v = p.eta[mode];
    if (a === null || !Number.isFinite(v) || !filter(p)) continue;
    errs.push(v - a);
  }
  return metricsOf(errs);
}
const result: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd) },
  params: { STILL_RADIUS_M, MIN_STILL_S, AT_STOP_MAX_M },
  note: "predictions at each hop boundary, chains of 5 contiguous hops, detector anchor; 'client' is the real computeUpcomingArrivals at the same instant",
  counts: { hops: allHops.length, pairs: pairs.length, skippedChains: skipped, noServed },
  byMode: {},
  anchoring: {},
};
for (const truth of ["det", "prox"] as const) {
  const t: any = {};
  for (const m of MODES) {
    t[m] = {
      overall: score(truth, m, () => true),
      byK: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, score(truth, m, (p) => p.k === k)])),
    };
  }
  result.byMode[truth] = t;
  result.anchoring[truth] = {
    disagreeShare: Math.round((1000 * pairs.filter((p) => !p.agree).length) / pairs.length) / 10,
    clientAgree: score(truth, "client", (p) => p.agree),
    clientDisagree: score(truth, "client", (p) => !p.agree),
  };
}
result.byRoute = Object.fromEntries(
  [...new Set(pairs.map((p) => p.routeId))].map((r) => [
    `${ROUTE_ID_LABEL[r] ?? "?"}`,
    { n: pairs.filter((p) => p.routeId === r).length,
      ...Object.fromEntries(MODES.map((m) => [m, score("det", m, (p) => p.routeId === r).medianAbsSec])) },
  ]),
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/eta-budget.json`, JSON.stringify(result, null, 1));
log(`wrote ${OUT_DIR}/eta-budget.json`);
for (const truth of ["det", "prox"] as const) {
  console.log(truth === "det" ? "\ntruth=detector arrival (internally consistent with hop times)" : "\ntruth=proximity, 50 m (curb-side, comparable to docs/eta-accuracy.md)");
  for (const m of MODES) {
    const b = result.byMode[truth][m];
    console.log(`  ${m.padEnd(15)} n=${String(b.overall.n).padStart(5)} med=${String(b.overall.medianAbsSec).padStart(6)} mean=${String(b.overall.meanSignedSec).padStart(7)} | k1=${b.byK[1].medianAbsSec} k3=${b.byK[3].medianAbsSec} k5=${b.byK[5].medianAbsSec}`);
  }
}
console.log("\nanchor disagree share", result.anchoring.det.disagreeShare + "%",
  "| client med agree", result.anchoring.det.clientAgree.medianAbsSec, "disagree", result.anchoring.det.clientDisagree.medianAbsSec);
