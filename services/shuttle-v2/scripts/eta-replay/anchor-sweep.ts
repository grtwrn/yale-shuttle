/**
 * Sweep the two candidate mechanisms inside findRouteAnchor against the
 * detector's own anchor, over every raw position in a snapshot.
 *
 *   WINDOW  — what counts as a candidate: distance to the chord between two
 *             stops (master) or to the published road between them (poly).
 *   PICK    — which candidate wins: master's forward sort, or forward-distance
 *             exclusion + GPS-nearest among the survivors.
 *
 * Ground truth is gps-replay's own "oracleAnchor": among {detIdx, detIdx-1}
 * take the GPS-nearer leg.
 *
 * ⚠️ READ THIS BEFORE QUOTING A NUMBER FROM IT. "Nearer" in that oracle is
 * measured with a DISTANCE, so the target moves with the arm unless it is
 * pinned — and pinning it to the chord makes the chord arm right by
 * construction, while letting it move makes the road arm right by
 * construction. `FIXED_ORACLE=1` pins it. The two readings disagree exactly as
 * that predicts (2026-09-03, 54,920 positions):
 *
 *   arm                              oracle per-arm   oracle pinned to chord
 *   master                                 41.04%                   41.04%
 *   chord window + exclusion rule          35.61%                   35.61%
 *   road window + exclusion rule           35.61%                   38.21%
 *   road window + master's sort            42.16%                   42.66%
 *
 * So this instrument JUDGES THE SELECTION RULE — which does not touch the
 * candidate set, so both columns move together — and CANNOT JUDGE THE WINDOW.
 * The window's evidence has to be oracle-free: `cand-size.ts` (how often the
 * true leg is not a candidate at all) and `rider-sim/`.
 *
 * DECIDED, 2026-09-04, and recorded here so it is not re-imposed: the
 * anchor/detector disagreement rate is **not a gate** on a change to the
 * candidate window. It rose on Pink, Purple, Green and Blue Night when the
 * window moved from the chord to the road while those routes' rider error was
 * flat or better, and the reason is the paragraph above — a window fix cannot
 * be judged by the thing it replaces. The gate for such a change is
 * `rider-sim/` paired against master (strands, reversals and drops by
 * fixed/introduced split, not by total — the selection-only arm showed a total
 * can hide a swap), `branch-lock.ts` for the folds, and the departure trace.
 */
import { loadNet, fmtEt } from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { isBusOnRoute, registerRoutePaths, ANCHOR_GPS_THRESHOLD_M } from "../../web/src/anchor.js";
import { distanceToSegmentM, traceStopLegs } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import type { BusData } from "../../web/src/map-data.js";
import type { LatLon } from "../../web/src/geo.js";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const AT_STOP_MAX_M = 75;
const ONLY = process.env.ONLY_RULES ? new Set(process.env.ONLY_RULES.split(",")) : null;

const net = loadNet();
const { db } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db.prepare(
  `SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
   FROM raw_positions ORDER BY collected_at, id`).all() as PosRow[];
log(`raw positions ${pos.length}, ${fmtEt(pos[0]!.t)} .. ${fmtEt(pos[pos.length - 1]!.t)} ET`);

const polls: BusObservation[][] = [];
{
  let cur: BusObservation[] = []; let curAt = -1;
  for (const p of pos) {
    if (p.t !== curAt) { if (cur.length) polls.push(cur); cur = []; curAt = p.t; }
    cur.push({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t });
  }
  if (cur.length) polls.push(cur);
}

interface Obs { bus: BusData; t: number; routeId: number; detIdx: number }
const observations: Obs[] = [];
{
  const states = new Map<string, BusState>();
  for (const poll of polls) {
    const plan = planTracks(poll);
    stepMany(net.network, states, poll, plan);
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
      const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const atStop = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? st.nearestStopId : null;
      observations.push({
        bus: {
          bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: o.lat, lon: o.lon,
          heading: o.heading, last_stop_id: o.lastStopId as number, stationary: atStop != null,
          ...(atStop != null ? { at_stop_id: atStop } : {}),
        } as BusData,
        t: o.collectedAt, routeId: o.routeId, detIdx: st ? st.nearestIndex : -1,
      });
    }
  }
}
log(`observations ${observations.length}`);

// -- per-route geometry ------------------------------------------------------
interface RouteGeom { stops: number[]; label: string; legs: (readonly [number, number])[][] | null }
const geoms = new Map<number, RouteGeom>();
for (const cfg of ROUTE_LISTS) {
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!stops.length) continue;
  const path = net.routePaths[cfg.routeIds[0]!];
  let legs: (readonly [number, number])[][] | null = null;
  if (path && path.length >= 2) {
    const ring: LatLon[] = [];
    let ok = true;
    for (const s of stops) { const c = net.stopCoords[s]; if (!c) { ok = false; break; } ring.push(c); }
    if (ok) {
      ring.push(ring[0]!);
      const t = traceStopLegs(path, ring);
      if (t.length === stops.length) legs = t.map((l) => l.slice);
    }
  }
  for (const rid of cfg.busRouteIds) geoms.set(rid, { stops, label: cfg.label, legs });
}

function polyD(p: LatLon, line: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = distanceToSegmentM(p, { lat: line[i]![0], lon: line[i]![1] }, { lat: line[i + 1]![0], lon: line[i + 1]![1] });
    if (d < best) best = d;
  }
  return best;
}

// -- rules -------------------------------------------------------------------
type Pick = (cands: number[], dists: number[], lastIdx: number, N: number) => number;
const master: Pick = (c, d, lastIdx, N) => {
  const s = [...c];
  if (lastIdx >= 0) s.sort((a, b) => {
    const fa = (a - lastIdx + N) % N, fb = (b - lastIdx + N) % N;
    return fa !== fb ? fa - fb : d[a]! - d[b]!;
  });
  else s.sort((a, b) => d[a]! - d[b]!);
  return s[0]!;
};
const win = (W: number, EPS = 0): Pick => (c, d, lastIdx, N) => {
  let keep = c;
  if (lastIdx >= 0) { const k = c.filter((i) => ((i - lastIdx + N) % N) <= W); if (k.length) keep = k; }
  let nearest = Infinity;
  for (const i of keep) if (d[i]! < nearest) nearest = d[i]!;
  const tied = keep.filter((i) => d[i]! <= nearest + EPS);
  if (lastIdx >= 0) tied.sort((a, b) => {
    const fa = (a - lastIdx + N) % N, fb = (b - lastIdx + N) % N;
    return fa !== fb ? fa - fb : d[a]! - d[b]!;
  });
  else tied.sort((a, b) => d[a]! - d[b]!);
  return tied[0]!;
};

const RULES: Array<[string, "chord" | "poly", Pick]> = [];
RULES.push(["master", "chord", master]);
RULES.push(["poly+sort", "poly", master]);
for (const W of [3, 4, 5, 6, 8]) RULES.push([`chord+w${W}e0`, "chord", win(W)]);
for (const W of [3, 4, 5, 6, 8]) for (const E of [0, 15, 30, 50]) RULES.push([`poly+w${W}e${E}`, "poly", win(W, E)]);
const ACTIVE = RULES.filter(([n]) => !ONLY || ONLY.has(n));

interface Acc { scored: number; disagree: number; lag: number; lead: number }
const acc = new Map<string, Map<string, Acc>>();
const get = (rule: string, label: string) => {
  let m = acc.get(rule); if (!m) acc.set(rule, (m = new Map()));
  let a = m.get(label); if (!a) m.set(label, (a = { scored: 0, disagree: 0, lag: 0, lead: 0 }));
  return a;
};

let truthMissedChord = 0, truthMissedPoly = 0, scoredAll = 0;
for (const o of observations) {
  const g = geoms.get(o.routeId);
  if (!g || o.detIdx < 0 || !o.bus.lat || !o.bus.lon) continue;
  const { stops, label, legs } = g;
  const N = stops.length;
  if (!isBusOnRoute(o.bus, stops, net.stopCoords)) continue;

  const dChord: number[] = new Array(N);
  const dPoly: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = net.stopCoords[stops[i]!], b = net.stopCoords[stops[(i + 1) % N]!];
    dChord[i] = a && b ? distanceToSegmentM(o.bus, a, b) : Infinity;
    const leg = legs?.[i];
    dPoly[i] = leg && leg.length >= 2 ? polyD(o.bus, leg) : dChord[i]!;
  }
  const oc = [o.detIdx, (o.detIdx - 1 + N) % N];
  const oracleC = dChord[oc[0]!]! <= dChord[oc[1]!]! ? oc[0]! : oc[1]!;
  const oracleP = dPoly[oc[0]!]! <= dPoly[oc[1]!]! ? oc[0]! : oc[1]!;

  scoredAll++;
  if (dChord[oracleC]! >= ANCHOR_GPS_THRESHOLD_M) truthMissedChord++;
  if (dPoly[oracleP]! >= ANCHOR_GPS_THRESHOLD_M) truthMissedPoly++;

  const lastIdx = o.bus.last_stop_id != null ? stops.indexOf(o.bus.last_stop_id) : -1;
  const refine = (gpsIdx: number): number => {
    if (o.bus.at_stop_id == null) return gpsIdx;
    const ai = stops.indexOf(o.bus.at_stop_id);
    if (ai < 0) return gpsIdx;
    const sc = net.stopCoords[stops[ai]!];
    if (!sc) return gpsIdx;
    const dlat = (o.bus.lat - sc.lat) * 111_000, dlon = (o.bus.lon - sc.lon) * 84_000;
    const near = dlat * dlat + dlon * dlon < ANCHOR_GPS_THRESHOLD_M * ANCHOR_GPS_THRESHOLD_M;
    return near && (ai - gpsIdx + N) % N <= 1 ? ai : gpsIdx;
  };

  const sets: Record<string, { d: number[]; cands: number[]; fb: number; oracle: number }> = {} as never;
  for (const [k, d, oracle] of [["chord", dChord, oracleC], ["poly", dPoly, oracleP]] as const) {
    const cands: number[] = [];
    for (let i = 0; i < N; i++) if (d[i]! < ANCHOR_GPS_THRESHOLD_M) cands.push(i);
    let fb = 0, best = d[0]!;
    for (let i = 1; i < N; i++) if (d[i]! < best) { best = d[i]!; fb = i; }
    sets[k] = { d, cands, fb, oracle: process.env.FIXED_ORACLE ? oracleC : oracle };
  }

  for (const [name, window, pick] of ACTIVE) {
    const s = sets[window]!;
    const idx = refine(s.cands.length ? pick(s.cands, s.d, lastIdx, N) : s.fb);
    const a = get(name, label);
    a.scored++;
    if (idx !== s.oracle) {
      a.disagree++;
      if ((idx - s.oracle + N) % N > N / 2) a.lag++; else a.lead++;
    }
  }
}

log(`truth outside the ${ANCHOR_GPS_THRESHOLD_M} m window: chord ${(100 * truthMissedChord / scoredAll).toFixed(2)}%  poly ${(100 * truthMissedPoly / scoredAll).toFixed(2)}%  of ${scoredAll}`);

const show = ["Red", "Blue Day", "Blue West", "Green", "Purple", "Orange East", "Pink"];
const hdr = ["rule".padEnd(12), "ALL".padStart(7), ...show.map((l) => l.slice(0, 9).padStart(10))].join(" ");
for (const [title, field] of [["disagreement", "disagree"], ["lag (BEHIND the detector)", "lag"], ["lead (AHEAD — the stranding direction)", "lead"]] as const) {
  console.log(`\n-- ${title} --`);
  console.log(hdr);
  for (const [name] of ACTIVE) {
    const m = acc.get(name)!;
    let s = 0, v = 0;
    for (const a of m.values()) { s += a.scored; v += (a as never as Record<string, number>)[field]!; }
    const cells = show.map((l) => {
      const a = m.get(l);
      return a ? `${(100 * (a as never as Record<string, number>)[field]! / a.scored).toFixed(2)}%`.padStart(10) : "-".padStart(10);
    });
    console.log([name.padEnd(12), `${(100 * v / s).toFixed(2)}%`.padStart(7), ...cells].join(" "));
  }
}
