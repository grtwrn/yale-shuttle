/**
 * ETA STABILITY: what a rider watches, not how close it lands.
 *
 * Every other measurement on this project scores |predicted - actual|. That is
 * not the operator's complaint. Theirs is:
 *
 *   "i'm not worried about a few seconds. i'm worried about saying a bus is
 *    10min away and then a few seconds later dropping to 1 second."
 *
 * So this scores the SEQUENCE of numbers shown for one (bus, stop) across
 * consecutive 5 s polls, by replaying every raw position through the real
 * `computeUpcomingArrivals` and watching how its answer moves.
 *
 * THE METRIC. A prediction is stable when the *predicted arrival instant*
 * A(t) = t + eta(t) stays put. A well-behaved countdown has A constant and the
 * displayed number ticking down by the poll interval; a lurch is A moving.
 * So every statistic below is on `jump = A(t') - A(t)` in seconds, which is
 * exactly "the change in eta, corrected for elapsed time".
 *
 *   jump  > 0  the bus is being promised LATER than it was (countdown stalls
 *              or climbs)
 *   jump  < 0  the bus is being promised SOONER (the 10 min -> 1 min drop)
 *
 * Two series, because pin flapping produces the symptom with no estimator
 * error at all (report #62):
 *
 *   perBus   one (bus, stop) followed across polls -- isolates the estimator
 *   board    the soonest arrival at a stop across all buses -- what a rider
 *            reads off a stop card, pin switches included
 *
 * Each catastrophic jump (>= JUMP_BIG_SEC) is attributed to a cause, in
 * priority order: pin switch, anchor flip, at-stop change, re-price, feed
 * movement, unexplained.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/eta-stability.ts
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
import { buildGeometry, pointAt, projectOnLeg, step as filterStep, type FilterState, type RouteGeometry } from "./progress-filter.js";

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
const pos = db
  .prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
            FROM raw_positions ORDER BY collected_at, id`)
  .all() as PosRow[];
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

// -- route geometry for the filter, in the CLIENT's stop frame ----------------
// Leg index i means "between stops[i] and stops[i+1]", so it is directly
// comparable with what findRouteAnchor returns.
const geoByLabel = new Map<string, RouteGeometry>();
for (const cfg of ROUTE_LISTS) {
  const path = net.routePaths[String(cfg.routeIds[0]!)];
  const stops = mergedRouteStops(cfg, net.routeStops);
  const ll = stops.map((sid) => net.stopCoords[sid]).filter(Boolean) as Array<{ lat: number; lon: number }>;
  if (!path || ll.length !== stops.length || ll.length < 3) continue;
  try {
    geoByLabel.set(cfg.label, buildGeometry(path, ll));
  } catch {
    /* a route whose geometry will not trace simply has no filter arm */
  }
}
log(`geometry built for ${geoByLabel.size}/${ROUTE_LISTS.length} route lists`);

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

// -- arms ----------------------------------------------------------------------
// shipped     raw feed position + the detector's at-stop flag (production)
// filterPos   filtered position, detector at-stop  -> isolates anti-teleport
// filterFull  filtered position + the filter's own standing mode
// detAnchor is not shippable as-is -- it reads the SERVER's detector state,
// which the browser does not have. It is the ceiling: what the client would
// look like if it were given a stateful, flip-resistant anchor instead of
// re-deciding from scratch every poll.
// slew is the OUTPUT-side control: the shipped estimate passed through a rate
// limiter on the predicted arrival instant. Every other arm changes the INPUT
// to a stateless function; this one gives the output memory instead.
// detAnchorPure: like detAnchor, but ALSO withholds last_stop_id. detAnchor
// stabilised the position and left last_stop_id free -- and findRouteAnchor
// reads last_stop_id to disambiguate, so the client could still re-derive a
// flipped anchor. This arm removes that second input, which is the only way to
// actually deliver a stable anchor through the public API.
const ARMS = ["shipped", "detAnchor", "detAnchorPure", "slew"] as const;
/** How far the promised arrival instant may move in one poll, seconds. */
const MAX_SLEW_SEC = Number(process.env.MAX_SLEW_SEC ?? 45);
type Arm = (typeof ARMS)[number];

interface Frame {
  t: number;
  perBus: Map<string, number>;
  board: Map<number, { eta: number; busName: string }>;
  bus: Map<string, { anchor: number; atStopId: number | null; atStopSince: number | null; lat: number; lon: number; routeId: number }>;
  bucket: number;
}
interface Stats {
  jumps: number[]; jumpsBoard: number[];
  rev: number[]; revBoard: number[];
  up: number; upBoard: number;
  n: number; nBoard: number;
  causes: Record<string, number>; causesBoard: Record<string, number>;
  pinSwitchByOldEta: Record<string, number>;
  bigByRoute: Record<number, { big: number; n: number }>;
  errs: number[];
  etaUnchanged: number;
  anchorAgree: number;
  anchorSeen: number;
  posOffset: number[];
  worst: Array<{ t: number; jump: number; from: number; to: number; cause: string; routeId: number; stopId: number; bus: string; series: string }>;
  prev: Frame | null;
}
const mk = (): Stats => ({ jumps: [], jumpsBoard: [], rev: [], revBoard: [], up: 0, upBoard: 0, n: 0, nBoard: 0, causes: {}, causesBoard: {}, pinSwitchByOldEta: {}, bigByRoute: {}, errs: [], etaUnchanged: 0, anchorAgree: 0, anchorSeen: 0, posOffset: [], worst: [], prev: null });
const stats: Record<Arm, Stats> = { shipped: mk(), detAnchor: mk(), detAnchorPure: mk(), slew: mk() };
/** Smoothed predicted-arrival instant per `${bus}|${stop}`. */
const slewState = new Map<string, number>();

const states = new Map<string, BusState>();
const filterStates = new Map<string, FilterState>();
const ACC_STRIDE = 12; // score accuracy once a minute, not every poll

for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const plan = planTracks(poll);
  stepMany(network, states, poll, plan);
  const t = poll[0]!.collectedAt;
  const segs = segmentsAt(t);
  const dw = dwellsAt(t);
  const scoreAcc = pi % ACC_STRIDE === 0;

  const busesByArm: Record<Arm, BusData[]> = { shipped: [], detAnchor: [], detAnchorPure: [], slew: [] };
  const diagByArm: Record<Arm, Frame["bus"]> = { shipped: new Map(), detAnchor: new Map(), detAnchorPure: new Map(), slew: new Map() };

  for (const o of poll) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.enteredAt } : null;
    const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
    const geo = cfg ? geoByLabel.get(cfg.label) : undefined;

    let filtered: { lat: number; lon: number; leg: number; pStand: number; standingSince: number | null } | null = null;
    if (cfg && geo) {
      const fkey = `${cfg.label}|${o.busName}`;
      const r = filterStep(geo, filterStates.get(fkey) ?? null, { lat: o.lat, lon: o.lon, t: o.collectedAt });
      filterStates.set(fkey, r.state);
      filtered = { lat: r.out.lat, lon: r.out.lon, leg: r.out.leg, pStand: r.out.pStand, standingSince: r.out.standingSince };
    }

    const base = {
      bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, heading: o.heading,
      last_stop_id: o.lastStopId as number,
    };
    const withAt = (b: any, a: { id: number; since: number } | null): BusData => ({
      ...b, stationary: a != null,
      ...(a ? { at_stop_id: a.id, at_stop_since: new Date(a.since).toISOString().replace(/Z$/, "") } : {}),
    });
    const shippedBus = withAt({ ...base, lat: o.lat, lon: o.lon }, at);
    busesByArm.shipped.push(shippedBus);

    if (false && filtered) {
      const fpos = { ...base, lat: filtered.lat, lon: filtered.lon };
      // The filter's own standing state: it is at the stop that starts its
      // current leg, provided it is standing and actually near that stop.
      const stops = mergedRouteStops(cfg!, net.routeStops);
      const legStop = stops[filtered.leg];
      const legStopLL = legStop !== undefined ? net.stopCoords[legStop] : undefined;
      const nearLegStop = legStopLL ? distanceMeters({ lat: filtered.lat, lon: filtered.lon }, legStopLL) <= AT_STOP_MAX_M : false;
      const fAt = filtered.standingSince !== null && legStop !== undefined && nearLegStop
        && o.collectedAt - filtered.standingSince >= 15_000
        ? { id: legStop, since: filtered.standingSince }
        : null;
      busesByArm.filterFull.push(withAt(fpos, fAt));
      for (const [arm, a] of [["filterPos", at], ["filterFull", fAt]] as const) {
      }
    }

    // ---- detAnchor: keep the raw fix, but project it onto the leg the
    // detector believes the bus occupies, resolving repeated stops by taking
    // the occurrence whose projection is closest to the fix.
    let detBus: BusData | null = null;
    if (cfg && geo && st) {
      const stops = mergedRouteStops(cfg, net.routeStops);
      let bestLeg = -1;
      let bestPerp = Infinity;
      for (let li = 0; li < stops.length; li++) {
        if (stops[li] !== st.nearestStopId) continue;
        const pr = projectOnLeg(geo, li, { lat: o.lat, lon: o.lon });
        if (pr && pr.perp < bestPerp) { bestPerp = pr.perp; bestLeg = li; }
      }
      if (bestLeg >= 0) {
        const pr = projectOnLeg(geo, bestLeg, { lat: o.lat, lon: o.lon })!;
        const pt = pointAt(geo, pr.progress);
        detBus = withAt({ ...base, lat: pt.lat, lon: pt.lon }, at);
        // Same snapped position, but last_stop_id withheld so findRouteAnchor
        // cannot re-derive a flipped anchor from the feed's stop assignment.
        busesByArm.detAnchorPure.push(withAt({ ...base, lat: pt.lat, lon: pt.lon, last_stop_id: null as unknown as number }, at));
        diagByArm.detAnchorPure.set(o.busName.replace("#", ""), { anchor: bestLeg, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, lat: pt.lat, lon: pt.lon, routeId: o.routeId });
        diagByArm.detAnchor.set(o.busName.replace("#", ""), { anchor: bestLeg, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, lat: pt.lat, lon: pt.lon, routeId: o.routeId });
      }
    }
    busesByArm.detAnchor.push(detBus ?? shippedBus);
    if (!detBus) { busesByArm.detAnchorPure.push(shippedBus); diagByArm.detAnchorPure.set(o.busName.replace("#", ""), { anchor: -1, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, lat: o.lat, lon: o.lon, routeId: o.routeId }); }

    let anchor = -1;
    if (cfg) {
      const stops = mergedRouteStops(cfg, net.routeStops);
      if (isBusOnRoute(shippedBus, stops, net.stopCoords)) anchor = findRouteAnchor(shippedBus, stops, net.stopCoords);
    }
    diagByArm.shipped.set(o.busName.replace("#", ""), { anchor, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, lat: o.lat, lon: o.lon, routeId: o.routeId });
    if (st) {
      stats.shipped.anchorSeen++;
      if (anchor === st.nearestIndex) stats.shipped.anchorAgree++;

    }
    if (!detBus) diagByArm.detAnchor.set(o.busName.replace("#", ""), { anchor, atStopId: at ? at.id : null, atStopSince: at ? at.since : null, lat: o.lat, lon: o.lon, routeId: o.routeId });

  }

  const targets = new Set<number>();
  for (const cfg of ROUTE_LISTS) {
    if (!busesByArm.shipped.some((b) => cfg.busRouteIds.includes(b.route_id))) continue;
    for (const s2 of mergedRouteStops(cfg, net.routeStops)) targets.add(s2);
  }
  const targetList = [...targets];

  for (const arm of ARMS) {
    if (arm === "slew") continue; // derived below from the shipped arm
    const S = stats[arm];
    const arrivals = computeUpcomingArrivals(targetList, busesByArm[arm], net.routeStops, net.stopCoords, segs, t, dw);
    const perBus = new Map<string, number>();
    const board = new Map<number, { eta: number; busName: string }>();
    for (const a of arrivals) {
      const k = `${a.busName}|${a.stopId}`;
      const c = perBus.get(k);
      if (c === undefined || a.eta < c) perBus.set(k, a.eta);
      const b = board.get(a.stopId);
      if (!b || a.eta < b.eta) board.set(a.stopId, { eta: a.eta, busName: a.busName });
    }
    const frame: Frame = { t, perBus, board, bus: diagByArm[arm], bucket: calibCache.bucketStart(t) };
    const prev = S.prev;
    if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
      const dt = (t - prev.t) / 1000;
      const repriced = frame.bucket !== prev.bucket;
      for (const [k, eta] of perBus) {
        const before = prev.perBus.get(k);
        if (before === undefined) continue;
        S.n++;
        const jump = eta - before + dt;
        S.jumps.push(jump);
        if (eta === before) S.etaUnchanged++;
        if (eta > before + 1) { S.up++; S.rev.push(eta - before); }
        const [busName, stopIdStr] = k.split("|");
        const stopId = Number(stopIdStr);
        const d0 = prev.bus.get(busName!);
        const d1 = frame.bus.get(busName!);
        const rid = d1?.routeId ?? -1;
        (S.bigByRoute[rid] ||= { big: 0, n: 0 }).n++;
        if (Math.abs(jump) >= JUMP_BIG_SEC) {
          const cause = attribute(d0, d1, repriced, before, eta);
          S.causes[cause] = (S.causes[cause] ?? 0) + 1;
          S.bigByRoute[rid]!.big++;
          S.worst.push({ t, jump, from: before, to: eta, cause, routeId: rid, stopId, bus: busName!, series: "perBus" });
        }
        if (scoreAcc) {
          const truth = nextArrival(`#${busName}`, stopId, t);
          if (truth !== null) S.errs.push(eta - (truth - t) / 1000);
        }
      }
      for (const [stopId, cur] of board) {
        const before = prev.board.get(stopId);
        if (!before) continue;
        S.nBoard++;
        const jump = cur.eta - before.eta + dt;
        S.jumpsBoard.push(jump);
        if (cur.eta > before.eta + 1) { S.upBoard++; S.revBoard.push(cur.eta - before.eta); }
        if (Math.abs(jump) >= JUMP_BIG_SEC) {
          const switched = cur.busName !== before.busName;
          if (switched) {
            // A stop card showing "the soonest bus" SHOULD change vehicle once
            // the bus you were watching pulls in -- that is the next bus, not a
            // glitch. The defect is swapping out a bus that was still minutes
            // away. Split them, or the board figure flatters the complaint.
            const b = before.eta < 60 ? "old bus had arrived (<60s) - legitimate handoff"
              : before.eta < 300 ? "old bus 1-5 min out"
              : "old bus >5 min out - genuine swap";
            S.pinSwitchByOldEta[b] = (S.pinSwitchByOldEta[b] ?? 0) + 1;
          }
          const cause = switched ? "pin switch" : attribute(prev.bus.get(cur.busName), frame.bus.get(cur.busName), repriced, before.eta, cur.eta);
          S.causesBoard[cause] = (S.causesBoard[cause] ?? 0) + 1;
        }
      }
    }
    S.prev = frame;
  }
  // ---- slew arm, derived from the shipped frame
  {
    const S = stats.slew;
    const src = stats.shipped.prev!; // just written for this poll
    const perBus = new Map<string, number>();
    for (const [k, eta] of src.perBus) {
      const rawA = t + eta * 1000;
      const prevA = slewState.get(k);
      let A: number;
      if (prevA === undefined) A = rawA;
      else {
        // Let the promise CATCH UP at a bounded rate rather than teleport.
        // Not a freeze: a 10 min correction still lands, over 30 polls.
        const delta = rawA - prevA;
        const cap = MAX_SLEW_SEC * 1000;
        A = prevA + Math.max(-cap, Math.min(cap, delta));
        // Once the bus has effectively arrived, stop defending the old promise.
        if (eta < 30) A = rawA;
      }
      slewState.set(k, A);
      perBus.set(k, Math.max(0, (A - t) / 1000));
    }
    const board = new Map<number, { eta: number; busName: string }>();
    for (const [k, eta] of perBus) {
      const [busName, sidStr] = k.split("|");
      const sid = Number(sidStr);
      const b = board.get(sid);
      if (!b || eta < b.eta) board.set(sid, { eta, busName: busName! });
    }
    const frame: Frame = { t, perBus, board, bus: src.bus, bucket: src.bucket };
    const prev = S.prev;
    if (prev && t - prev.t > 0 && t - prev.t <= MAX_POLL_GAP_MS) {
      const dt = (t - prev.t) / 1000;
      const repriced = frame.bucket !== prev.bucket;
      for (const [k, eta] of perBus) {
        const before = prev.perBus.get(k);
        if (before === undefined) continue;
        S.n++;
        const jump = eta - before + dt;
        S.jumps.push(jump);
        if (eta === before) S.etaUnchanged++;
        if (eta > before + 1) { S.up++; S.rev.push(eta - before); }
        const [busName, sidStr] = k.split("|");
        const stopId = Number(sidStr);
        const d1 = frame.bus.get(busName!);
        const rid = d1?.routeId ?? -1;
        (S.bigByRoute[rid] ||= { big: 0, n: 0 }).n++;
        if (Math.abs(jump) >= JUMP_BIG_SEC) {
          const cause = attribute(prev.bus.get(busName!), d1, repriced, before, eta);
          S.causes[cause] = (S.causes[cause] ?? 0) + 1;
          S.bigByRoute[rid]!.big++;
          S.worst.push({ t, jump, from: before, to: eta, cause, routeId: rid, stopId, bus: busName!, series: "perBus" });
        }
        if (scoreAcc) {
          const truth = nextArrival(`#${busName}`, stopId, t);
          if (truth !== null) S.errs.push(eta - (truth - t) / 1000);
        }
      }
      for (const [stopId, cur] of board) {
        const before = prev.board.get(stopId);
        if (!before) continue;
        S.nBoard++;
        const jump = cur.eta - before.eta + dt;
        S.jumpsBoard.push(jump);
        if (cur.eta > before.eta + 1) { S.upBoard++; S.revBoard.push(cur.eta - before.eta); }
        if (Math.abs(jump) >= JUMP_BIG_SEC) {
          const switched = cur.busName !== before.busName;
          if (switched) {
            const b = before.eta < 60 ? "old bus had arrived (<60s) - legitimate handoff"
              : before.eta < 300 ? "old bus 1-5 min out" : "old bus >5 min out - genuine swap";
            S.pinSwitchByOldEta[b] = (S.pinSwitchByOldEta[b] ?? 0) + 1;
          }
          const cause = switched ? "pin switch" : attribute(prev.bus.get(cur.busName), frame.bus.get(cur.busName), repriced, before.eta, cur.eta);
          S.causesBoard[cause] = (S.causesBoard[cause] ?? 0) + 1;
        }
      }
    }
    S.prev = frame;
  }
  if (pi % 500 === 0) log(`poll ${pi}/${polls.length}`);
}

function attribute(
  d0: { anchor: number; atStopId: number | null; atStopSince: number | null; lat: number; lon: number } | undefined,
  d1: { anchor: number; atStopId: number | null; atStopSince: number | null; lat: number; lon: number } | undefined,
  repriced: boolean,
  etaBefore: number,
  etaAfter: number,
): string {
  if (!d0 || !d1) return "bus appeared/vanished";
  const advanced = d1.anchor - d0.anchor;
  if (etaAfter - etaBefore > 600 && (advanced === 1 || advanced === 2)) return "lap wrap (bus passed the stop)";
  if (d0.anchor >= 0 && d1.anchor >= 0 && advanced !== 0 && advanced !== 1) return "anchor flip";
  if (d0.atStopId !== d1.atStopId) return "at-stop change";
  if (d0.atStopSince !== d1.atStopSince) return "stall-credit reset";
  if (repriced) return "re-price (calibration bucket)";
  if (distanceMeters(d0, d1) >= 30) return "feed movement";
  return "unexplained";
}

// -- report --------------------------------------------------------------------
const q = (a: number[], p: number) => (a.length ? Math.round(pct(a, p) * 10) / 10 : null);
const absOf = (a: number[]) => a.map(Math.abs);
const result: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), polls: polls.length },
  metric: "jump = change in the PREDICTED ARRIVAL INSTANT between consecutive polls, seconds. 0 = a countdown ticking down perfectly.",
  jumpBigSec: JUMP_BIG_SEC,
  arms: {},
};
for (const arm of ARMS) {
  const S = stats[arm];
  const big = S.jumps.filter((x) => Math.abs(x) >= JUMP_BIG_SEC).length;
  const bigB = S.jumpsBoard.filter((x) => Math.abs(x) >= JUMP_BIG_SEC).length;
  S.worst.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
  result.arms[arm] = {
    perBus: {
      transitions: S.n,
      absJump: { p50: q(absOf(S.jumps), 0.5), p90: q(absOf(S.jumps), 0.9), p99: q(absOf(S.jumps), 0.99), p999: q(absOf(S.jumps), 0.999), max: q(absOf(S.jumps), 1) },
      reversalPct: Math.round((1000 * S.up) / Math.max(1, S.n)) / 10,
      reversalSizeSec: { p50: q(S.rev, 0.5), p90: q(S.rev, 0.9), p99: q(S.rev, 0.99) },
      bigJumps: big, bigJumpPct: Math.round((1000 * big) / Math.max(1, S.n)) / 10,
      over60: S.jumps.filter((x) => Math.abs(x) >= 60).length,
      over60Pct: Math.round((1000 * S.jumps.filter((x) => Math.abs(x) >= 60).length) / Math.max(1, S.n)) / 10,
      over120Pct: Math.round((1000 * S.jumps.filter((x) => Math.abs(x) >= 120).length) / Math.max(1, S.n)) / 10,
      causes: S.causes,
    },
    board: {
      transitions: S.nBoard,
      absJump: { p50: q(absOf(S.jumpsBoard), 0.5), p90: q(absOf(S.jumpsBoard), 0.9), p99: q(absOf(S.jumpsBoard), 0.99), p999: q(absOf(S.jumpsBoard), 0.999) },
      reversalPct: Math.round((1000 * S.upBoard) / Math.max(1, S.nBoard)) / 10,
      bigJumps: bigB, bigJumpPct: Math.round((1000 * bigB) / Math.max(1, S.nBoard)) / 10,
      over60Pct: Math.round((1000 * S.jumpsBoard.filter((x) => Math.abs(x) >= 60).length) / Math.max(1, S.nBoard)) / 10,
      over120Pct: Math.round((1000 * S.jumpsBoard.filter((x) => Math.abs(x) >= 120).length) / Math.max(1, S.nBoard)) / 10,
      causes: S.causesBoard,
      pinSwitchByOldEta: S.pinSwitchByOldEta,
    },
    diagnostics: {
      etaUnchangedPct: Math.round((1000 * S.etaUnchanged) / Math.max(1, S.n)) / 10,
      anchorMatchesDetectorPct: S.anchorSeen ? Math.round((1000 * S.anchorAgree) / S.anchorSeen) / 10 : null,
      filterMovedBusM: S.posOffset.length ? { p50: q(S.posOffset, 0.5), p90: q(S.posOffset, 0.9), p99: q(S.posOffset, 0.99) } : null,
    },
    accuracyGuardRail: {
      n: S.errs.length,
      medianAbsSec: q(absOf(S.errs), 0.5),
      p90AbsSec: q(absOf(S.errs), 0.9),
      meanSignedSec: S.errs.length ? Math.round((S.errs.reduce((a, b) => a + b, 0) / S.errs.length) * 10) / 10 : null,
    },
    bigByRoute: Object.fromEntries(
      Object.entries(S.bigByRoute).filter(([, v]) => v.n > 500)
        .map(([r, v]) => [ROUTE_ID_LABEL[Number(r)] ?? r, { transitions: v.n, big: v.big, pct: Math.round((1000 * v.big) / v.n) / 10 }])),
    worst10: S.worst.slice(0, 10).map((w) => ({
      at: fmtEt(w.t), route: ROUTE_ID_LABEL[w.routeId] ?? w.routeId,
      stop: net.stopById.get(w.stopId)?.name ?? w.stopId,
      shown: `${fmtMin(w.from)} -> ${fmtMin(w.to)}`, jumpSec: Math.round(w.jump), cause: w.cause, bus: w.bus,
    })),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/eta-stability.json`, JSON.stringify(result, null, 1));
log(`wrote ${OUT_DIR}/eta-stability.json`);
for (const arm of ARMS) {
  const a = result.arms[arm];
  console.log(`\n=== ${arm}`);
  console.log(`  perBus  |jump| p50=${a.perBus.absJump.p50}s p90=${a.perBus.absJump.p90}s p99=${a.perBus.absJump.p99}s p99.9=${a.perBus.absJump.p999}s`);
  console.log(`          >=60s: ${a.perBus.over60Pct}%  >=120s: ${a.perBus.over120Pct}%  >=300s: ${a.perBus.bigJumpPct}%   (board >=60s ${a.board.over60Pct}%, >=300s ${a.board.bigJumpPct}%)`);
  console.log(`          countdown UP on ${a.perBus.reversalPct}% (rise p90 ${a.perBus.reversalSizeSec.p90}s)  |  >=${JUMP_BIG_SEC}s: ${a.perBus.bigJumps} (${a.perBus.bigJumpPct}%)`);
  console.log(`          causes ${JSON.stringify(a.perBus.causes)}`);
  console.log(`  board   |jump| p99=${a.board.absJump.p99}s  >=${JUMP_BIG_SEC}s: ${a.board.bigJumps} (${a.board.bigJumpPct}%)  causes ${JSON.stringify(a.board.causes)}`);
  console.log(`          pin switches split ${JSON.stringify(a.board.pinSwitchByOldEta)}`);
  console.log(`  accuracy (guard rail) n=${a.accuracyGuardRail.n} median=${a.accuracyGuardRail.medianAbsSec}s mean=${a.accuracyGuardRail.meanSignedSec}s`);
  console.log(`  diag: eta EXACTLY unchanged on ${a.diagnostics.etaUnchangedPct}% of polls; anchor matches detector ${a.diagnostics.anchorMatchesDetectorPct}%; filter moved bus ${JSON.stringify(a.diagnostics.filterMovedBusM)}`);
}
