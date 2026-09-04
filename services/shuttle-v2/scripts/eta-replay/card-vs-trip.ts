/**
 * CARD vs TRIP — the app has two ETA estimators; this measures how far apart
 * they are, and scores both against what the buses actually did.
 *
 * The trip card runs `computeUpcomingArrivals` (web/src/arrivals.ts) — the
 * gated anchor (#72/#90/#93/#97), the direction branch (#86), the stall credit
 * and its dwell bound, the stand/drive split (#81/#85), mid-hop proration, a
 * second lap, and the 90-minute sanity cap.
 *
 * The ROUTE CARDS on the Map tab do not. `StopList` in TransitMap.tsx carries
 * its own arithmetic inline. It is transcribed VERBATIM below (`cardArrivals`,
 * `nearestRouteStop`) from TransitMap.tsx lines 5269-5464 at d4cf07e — do not
 * "improve" it here, it exists to be measured, and `--selfcheck` asserts the
 * transcription still matches the file it came from.
 *
 * Four differences, each measured separately:
 *
 *   1. ANCHOR. The card takes the nearest stop by squared lat/lon DEGREE
 *      delta (not metres, not projected onto the route line, no gate, no
 *      direction, no at_stop refinement).
 *   2. STOP LIST. The card de-duplicates the primary route's sequence; the
 *      canonical `mergedRouteStops` keeps it verbatim because routes 9/10
 *      pass West Campus twice. Green 23 -> 20, Purple 15 -> 11.
 *   3. PRICING. No stall credit, no proration, no stand/drive split: the card
 *      always bills the whole arrival-to-arrival segment for the first hop.
 *   4. DISPLAY. The card prints `round(low/60) min` (the LOW end of the
 *      interval); the trip card prints `floor(eta/60) min`.
 *
 * Same corpus, same snapshot, same detector and same time-travelled
 * calibration as rider-sim, so the numbers here and in docs/rider-sim.md are
 * about the same day. PAYLOAD_PATCH is honoured for exactly the reason it
 * exists: without it the trip arm silently scores the pre-#85 client.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap3-split.db \
 *     PAYLOAD_PATCH=./scripts/.eta-replay/split-patch-0903.json \
 *     npx tsx scripts/eta-replay/card-vs-trip.ts
 *
 * Env: CAPTURE, REPLAY_DB, REPLAY_OUT, PAYLOAD_PATCH, CALIB_LAG_MIN,
 *      FROM/TO (ISO), EVERY (pair on every Nth poll; the detector and the
 *      anchor store still step on every one), ROUTES (comma-separated labels
 *      or "all"), CHAIN (Red:11:6), MAX_TRUTH_MIN (45), OUT_NAME.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  loadNet,
  loadSamples,
  makeCalibCache,
  makeDwellCache,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
} from "./common.js";
import { distanceMeters } from "../../src/network/geo.js";
import {
  dedupeAndSort,
  groupPolls,
  parseCaptureLine,
  stopVisits,
  type PosRow,
} from "./rider-sim/lib.js";

import * as det from "../../src/collector/detector.js";
import { computeUpcomingArrivals, splitServedForRoute } from "../../web/src/arrivals.js";
import { isBusOnRoute, registerRoutePaths } from "../../web/src/anchor.js";
import { anchorIndexOnList } from "../../web/src/liveAnchor.js";
import { liveAnchorStore } from "../../web/src/anchorGate.js";
import { isBusInService } from "../../web/src/schedule.js";
import { BUS_SPEED_M_S, mergedRouteStops, ROUTE_LISTS } from "../../web/src/routes.js";
import { haversineMeters } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";
import type { LatLon } from "../../web/src/geo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const EVERY = Number(process.env.EVERY) || 1;
const OUT_NAME = process.env.OUT_NAME ?? "card-vs-trip";
const FROM = process.env.FROM ? Date.parse(process.env.FROM) : -Infinity;
const TO = process.env.TO ? Date.parse(process.env.TO) : Infinity;
const CALIB_LAG_MS = (Number(process.env.CALIB_LAG_MIN) || 0) * 60_000;
const MAX_TRUTH_MS = (Number(process.env.MAX_TRUTH_MIN) || 45) * 60_000;
/** TRACE_STOP=48 prints, poll by poll, what each arm told a rider at that stop. */
const TRACE_STOP = process.env.TRACE_STOP ? Number(process.env.TRACE_STOP) : null;
const traceLines: string[] = [];
/** collector.ts's own numbers, as rider-sim uses them. */
const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;
const LIVE_BUS_TTL_MS = 120_000;

// ---------------------------------------------------------------------------
// THE CARD ESTIMATOR, transcribed from TransitMap.tsx `StopList`.
// ---------------------------------------------------------------------------

/** TransitMap.tsx:5270 — "GPS-based: find nearest route stop for each bus". */
function nearestRouteStop(
  bus: BusData,
  routeIds: string[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
): number | null {
  if (!bus.lat || !bus.lon) return null;
  let bestStop: number | null = null;
  let bestD = Infinity;
  for (const rid of routeIds) {
    for (const sid of routeStops[rid] ?? []) {
      const sc = stopCoords[sid];
      if (!sc) continue;
      const dLat = bus.lat - sc.lat;
      const dLon = bus.lon - sc.lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; bestStop = sid; }
    }
  }
  return bestStop;
}

interface CardEta { eta: number; low: number; high: number; busName: string; estimated: boolean }

/**
 * TransitMap.tsx:5285-5464 — the card's `busLookups` + `etaAtStop`, for one
 * ROUTE_LISTS entry. Returns the card's whole answer for that line: which stop
 * each bus is treated as being at, and the ETA table the rows read.
 */
function cardArrivals(
  cfg: (typeof ROUTE_LISTS)[number],
  buses: BusData[],
  routeStops: Record<string, number[]>,
  stopCoords: Record<number, LatLon>,
  segmentTimes: Record<string, Record<string, { avg: number; sd?: number; n: number }>>,
): { stops: number[]; busMap: Record<number, BusData>; etaAtStop: Record<number, CardEta> } {
  // busLookups: keyed by stop, LAST bus at that stop wins.
  const busMap: Record<number, BusData> = {};
  for (const bus of buses) {
    if (!cfg.busRouteIds.includes(bus.route_id)) continue;
    const gpsStop = nearestRouteStop(bus, cfg.routeIds, routeStops, stopCoords);
    const busStop = gpsStop ?? bus.last_stop_id;
    busMap[busStop as number] = bus;
  }
  // The card's own merged list: de-duplicated across every route id, primary
  // included — which is where it parts company with `mergedRouteStops`.
  const seen = new Set<number>();
  let stops: number[] = [];
  for (const rid of cfg.routeIds) {
    for (const sid of routeStops[rid] ?? []) {
      if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
    }
  }
  if (cfg.sliceStart !== undefined || cfg.sliceEnd !== undefined) {
    stops = stops.slice(cfg.sliceStart ?? 0, cfg.sliceEnd);
  }
  const etaAtStop: Record<number, CardEta> = {};
  if (stops.length === 0) return { stops, busMap, etaAtStop };

  const primaryRouteId = cfg.routeIds[0]!;
  const routeSegs = segmentTimes[primaryRouteId] ?? {};
  const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
  const avgSeg = segValues.length > 0
    ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length
    : 0;

  for (const [sid, b] of Object.entries(busMap)) {
    const busIdx = stops.indexOf(Number(sid));
    if (busIdx === -1) continue;
    let cumulative = 0;
    let cumulativeVar = 0;
    let hasAnyData = false;
    const totalStops = stops.length;
    const fallbackSd = avgSeg * 0.5;
    for (let step = 1; step < totalStops; step++) {
      const prevIdx = (busIdx + step - 1) % totalStops;
      const curIdx = (busIdx + step) % totalStops;
      const seg = routeSegs[`${stops[prevIdx]}-${stops[curIdx]}`];
      if (seg && seg.n >= 1) {
        cumulative += seg.avg;
        cumulativeVar += (seg.sd ?? 0) ** 2;
        hasAnyData = true;
      } else if (avgSeg > 0) {
        cumulative += avgSeg;
        cumulativeVar += fallbackSd * fallbackSd;
      } else {
        const pc = stopCoords[stops[prevIdx]!], cc = stopCoords[stops[curIdx]!];
        if (!pc || !cc) break;
        const est = Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
        cumulative += est;
        cumulativeVar += (est * 0.5) ** 2;
      }
      if (cumulative > 0) {
        const sd = Math.sqrt(cumulativeVar);
        const existing = etaAtStop[stops[curIdx]!];
        if (!existing || cumulative < existing.eta) {
          etaAtStop[stops[curIdx]!] = {
            eta: cumulative,
            low: Math.max(0, cumulative - sd),
            high: cumulative + sd,
            busName: (b as BusData).bus_name,
            estimated: !hasAnyData,
          };
        }
      }
    }
  }
  return { stops, busMap, etaAtStop };
}

/**
 * The transcription is only worth anything if it is still the transcription.
 * These are the load-bearing lines of StopList; if TransitMap.tsx stops
 * containing them the copy above has drifted and the run is invalid.
 */
function selfcheck(): void {
  const src = fs.readFileSync(path.join(HERE, "../../web/src/TransitMap.tsx"), "utf8");
  const must = [
    "const d = dLat * dLat + dLon * dLon;",
    "const gpsStop = nearestRouteStop(bus, cfg.routeIds);",
    "busLookups[idx][busStop] = bus;",
    "for (let step = 1; step < totalStops; step++) {",
    "cumulative += seg.avg;",
    "cumulativeVar += (seg.sd ?? 0) ** 2;",
    "low: Math.max(0, cumulative - sd),",
    "{e.estimated ? \"~\" : \"\"}{lo} min",
    "const lo = Math.round(e.low / 60);",
  ];
  const missing = must.filter((m) => !src.includes(m));
  if (missing.length) {
    throw new Error(
      `card-vs-trip: the StopList transcription has drifted — TransitMap.tsx no longer contains:\n  ${missing.join("\n  ")}`,
    );
  }
  // and the card must still have no anchor/credit/proration machinery
  const stopList = src.slice(src.indexOf("const StopList: FC<{"), src.indexOf("const RideStopList: FC<{"));
  for (const forbidden of ["resolveAnchorIndex", "anchorIndexOnList", "stallCredit", "firstSegProgressFactor", "priceFirstHop"]) {
    if (stopList.includes(forbidden)) {
      throw new Error(`card-vs-trip: StopList now uses ${forbidden} — the divergence this measures has changed; re-derive.`);
    }
  }
}

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const i = Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1))));
  return xs[i]!;
};
function dist(xsIn: number[]) {
  const xs = [...xsIn].sort((a, b) => a - b);
  const abs = xs.map(Math.abs).sort((a, b) => a - b);
  const n = xs.length;
  return {
    n,
    mean: n ? xs.reduce((s, x) => s + x, 0) / n : NaN,
    p10: q(xs, 0.1), p50: q(xs, 0.5), p90: q(xs, 0.9), p99: q(xs, 0.99),
    absP50: q(abs, 0.5), absP90: q(abs, 0.9), absP99: q(abs, 0.99),
    max: n ? xs[n - 1]! : NaN, min: n ? xs[0]! : NaN,
  };
}
const r0 = (x: number) => (Number.isFinite(x) ? Math.round(x) : null);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

selfcheck();
log("selfcheck ok: the StopList transcription still matches TransitMap.tsx");

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`)
      .filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()
      .map((f) => `${process.env.HOME}/shuttle-captures/${f}`)
).map((f) => f.trim()).filter(Boolean);
let raw: PosRow[] = [];
for (const f of captureFiles) {
  const before = raw.length;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const r = parseCaptureLine(line);
    if (r) raw.push(r);
  }
  log(`${f}: ${raw.length - before} rows`);
}
const rows = dedupeAndSort(raw);
raw = [];
const polls = groupPolls(rows);
const dataStart = rows[0]!.t;
const dataEnd = rows[rows.length - 1]!.t;
log(`${rows.length} positions, ${polls.length} polls, ${new Date(dataStart).toISOString()} .. ${new Date(dataEnd).toISOString()}`);

const net = loadNet();
const { network } = net;
registerRoutePaths(net.routePaths);
const cfgByLabel = new Map(ROUTE_LISTS.map((c) => [c.label, c]));
const cfgByRouteId = new Map<number, (typeof ROUTE_LISTS)[number]>();
for (const c of ROUTE_LISTS) for (const rid of c.busRouteIds) cfgByRouteId.set(rid, c);
const resolveLabels = (spec: string): string[] =>
  spec.trim().toLowerCase() === "all"
    ? ROUTE_LISTS.map((c) => c.label)
    : spec.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
        if (cfgByLabel.has(x)) return x;
        const byId = cfgByRouteId.get(Number(x));
        if (byId) return byId.label;
        throw new Error(`unknown route "${x}"`);
      });
const LABELS = new Set(resolveLabels(process.env.ROUTES ?? "all"));
const CHAIN_ENV = process.env.CHAIN ?? "Red:11:6";
const chainParts = CHAIN_ENV.split(":");
const CHAIN = CHAIN_ENV.trim().toLowerCase() === "none"
  ? null
  : { label: resolveLabels(chainParts[0]!)[0]!, stopId: Number(chainParts[1]), hops: Number(chainParts[2] ?? 6) };
const chainStops = new Set<number>();
if (CHAIN) {
  const seq = mergedRouteStops(cfgByLabel.get(CHAIN.label)!, net.routeStops);
  const i = seq.indexOf(CHAIN.stopId);
  if (i < 0) throw new Error(`CHAIN stop ${CHAIN.stopId} not on ${CHAIN.label}`);
  for (let k = 1; k <= CHAIN.hops; k++) chainStops.add(seq[(i + k) % seq.length]!);
}
log(`routes ${[...LABELS].join(",")}  chain ${CHAIN ? `${CHAIN.label}@${CHAIN.stopId} -> ${[...chainStops].join(",")}` : "none"}`);

// calibration, time-travelled — identical to rider-sim's
const samples = loadSamples(net, dataStart - SEGMENT_WINDOW_MS - 3_600_000, dataEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));

interface PayloadPatch {
  segments?: Record<string, Record<string, Record<string, unknown>>>;
  dwells?: Record<string, Record<string, Record<string, unknown>>>;
}
const patch: PayloadPatch | null = process.env.PAYLOAD_PATCH
  ? (JSON.parse(fs.readFileSync(process.env.PAYLOAD_PATCH, "utf8")) as PayloadPatch)
  : null;
const patched = new WeakSet<object>();
type PatchTable = Record<string, Record<string, Record<string, unknown>>>;
function applyPatch<T extends PatchTable>(table: T, extra: PayloadPatch["segments"] | undefined): T {
  if (!extra || patched.has(table)) return table;
  const t = table as PatchTable;
  for (const [rid, byKey] of Object.entries(extra)) {
    const r = (t[rid] ??= {});
    for (const [k, fields] of Object.entries(byKey)) Object.assign((r[k] ??= {}), fields);
  }
  patched.add(table);
  return table;
}
const segCache = new Map<number, any>();
function segmentsAt(t: number) {
  const bs = calibCache.bucketStart(t - CALIB_LAG_MS);
  let p = segCache.get(bs);
  if (!p) {
    const bc = calibCache.get(bs);
    const st: Record<string, Record<string, { avg: number; sd: number; n: number }>> = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(bs, (p = applyPatch(st, patch?.segments)));
  }
  return p;
}
const dwellCache = makeDwellCache(net, dataStart, dataEnd);
const dwellsAt = (t: number) => applyPatch(dwellCache.at(calibCache.bucketStart(t - CALIB_LAG_MS)), patch?.dwells);
if (patch) {
  log(`payload patch: segments ${Object.values(patch.segments ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys, dwells ${Object.values(patch.dwells ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys`);
} else {
  log("WARNING: no PAYLOAD_PATCH — the trip arm is the pre-#85 client (no stand/drive split)");
}

const visits = stopVisits(
  rows,
  (rid) => (cfgByRouteId.get(rid) ? mergedRouteStops(cfgByRouteId.get(rid)!, net.routeStops) : []),
  net.stopCoords,
);
/** flattened truth per (stop, routeId): sorted enter times with the bus name */
const truthIdx = new Map<number, { t: number; bus: string; route: number }[]>();
for (const [sid, vs] of visits) {
  truthIdx.set(sid, vs.map((v) => ({ t: v.enter, bus: v.busName, route: v.routeId })).sort((a, b) => a.t - b.t));
}
/** first arrival of ANY bus on `routeIds` at `sid` strictly after `t` */
function nextArrival(sid: number, routeIds: readonly number[], t: number, bus?: string): number | null {
  const l = truthIdx.get(sid);
  if (!l) return null;
  for (const v of l) {
    if (v.t <= t) continue;
    if (v.t - t > MAX_TRUTH_MS) return null;
    if (!routeIds.includes(v.route)) continue;
    if (bus && v.bus !== bus) continue;
    return v.t;
  }
  return null;
}
log(`stop visits for ${visits.size} stops`);

// ---------------------------------------------------------------------------
// the feed — the same detector + at-stop rule rider-sim uses (run.ts makeFeed)
// ---------------------------------------------------------------------------

type LivePos = { o: det.BusObservation; atStopId: number | null; atStopSince: number | null };
const states = new Map<string, det.BusState>();
const livePositions = new Map<string, LivePos>();
/** buses whose at_stop_id cleared on THIS poll, by bus name */
let departedThisPoll = new Set<string>();

function step(poll: PosRow[]): BusData[] {
  const obs = poll.map((p) => ({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t }));
  const t = poll[0]!.t;
  const plan = det.planTracks(obs);
  det.stepMany(network, states as any, obs, plan);
  departedThisPoll = new Set();
  for (const o of obs) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
    const cand = st && dwellingForMs >= AT_STOP_MIN_DWELL_MS ? net.stopById.get(st.nearestStopId) : undefined;
    const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.stationarySince } : null;
    const prev = livePositions.get(key);
    if (prev && prev.atStopId !== null && at === null) departedThisPoll.add(o.busName);
    livePositions.set(key, { o, atStopId: at ? at.id : null, atStopSince: at ? at.since : null });
  }
  for (const [k, v] of livePositions) if (v.o.collectedAt < t - LIVE_BUS_TTL_MS) livePositions.delete(k);
  const all: BusData[] = [...livePositions.values()].map((v) => ({
    bus_id: v.o.busId, bus_name: v.o.busName, route_id: v.o.routeId, lat: v.o.lat, lon: v.o.lon, heading: v.o.heading,
    last_stop_id: v.o.lastStopId as number, stationary: v.atStopId != null,
    ...(v.atStopId != null ? { at_stop_id: v.atStopId } : {}),
    ...(v.atStopSince != null ? { at_stop_since: new Date(v.atStopSince).toISOString().replace(/Z$/, "") } : {}),
  }));
  return all.filter((b) => isBusInService(b, t));
}

// ---------------------------------------------------------------------------
// buckets
// ---------------------------------------------------------------------------

interface Bucket {
  /** card eta - trip eta, seconds, same (line, stop), each arm's own choice of bus */
  screenDelta: number[];
  /** the same, restricted to pairs where BOTH arms name the same vehicle */
  sameBusDelta: number[];
  /** displayed minutes: round(card.low/60) - floor(trip.eta/60) */
  minuteDelta: number[];
  /** signed error against the observed arrival: predicted - actual */
  errCard: number[];
  errCardShown: number[];
  errTrip: number[];
  /** paired |err| difference, card - trip, on the rows both arms answered and truth exists */
  errAbsPairDelta: number[];
  rows: number;
  agreeStop: number;
  seqN: number;
  cardFrozen: number;
  tripFrozen: number;
  cardCollapse: number;
  tripCollapse: number;
  cardJump: number;
  tripJump: number;
  anchorSame: number;
  anchorN: number;
}
const mkBucket = (): Bucket => ({
  screenDelta: [], sameBusDelta: [], minuteDelta: [],
  errCard: [], errCardShown: [], errTrip: [], errAbsPairDelta: [],
  rows: 0, agreeStop: 0, anchorSame: 0, anchorN: 0,
  seqN: 0, cardFrozen: 0, tripFrozen: 0, cardCollapse: 0, tripCollapse: 0, cardJump: 0, tripJump: 0,
});
const buckets = new Map<string, Bucket>();
const B = (k: string): Bucket => {
  let b = buckets.get(k);
  if (!b) buckets.set(k, (b = mkBucket()));
  return b;
};

/**
 * THE SEQUENCE, not the level. The operator's complaint is "said 10 min, then a
 * few seconds later 1 min" — a property of consecutive readings at ONE stop.
 * Per (line, stop) we hold the last reading of each arm and count, per bucket:
 * a poll where the number did not move at all (frozen), and a poll where the
 * DISPLAYED minutes fell by two or more (a collapse — the canary's strand
 * shape). Frozen is scored only while a poll pair is adjacent (<= 30 s apart)
 * and both arms named the same vehicle, so a lap wrap or a pin change is not
 * counted as either.
 */
interface Seq { t: number; card: number; trip: number; cardMin: number; tripMin: number; bus: string }
const lastSeen = new Map<string, Seq>();
/** anchor disagreement in hops, per line */
const anchorHops = new Map<string, number[]>();
/** worst individual disagreements, for the trace */
const worst: { t: number; label: string; stop: number; sid: number; card: number; trip: number; cardBus: string; tripBus: string; why: string }[] = [];

const splitSeen = new Map<string, boolean>();
const stopName = (sid: number) => net.stopById.get(sid)?.name ?? `Stop ${sid}`;

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

log("pass: both estimators, every poll");
let paired = 0;
/** the card rendered a number for a stop the trip estimator had none for */
let cardOnly = 0;
/** the card answered a line where computeUpcomingArrivals sees no bus on route */
let offRouteLines = 0, offRouteRows = 0;
const offRouteByLabel = new Map<string, number>();
for (let pi = 0; pi < polls.length; pi++) {
  const poll = polls[pi]!;
  const t = poll[0]!.t;
  const buses = step(poll);
  if (pi % EVERY !== 0) continue;
  if (t < FROM || t > TO) continue;

  const segmentTimes = segmentsAt(t);
  const dwellTimes = dwellsAt(t);

  // ARM T — one call, all stops, the production singleton store.
  const allStops: number[] = [];
  for (const cfg of ROUTE_LISTS) for (const sid of mergedRouteStops(cfg, net.routeStops)) allStops.push(sid);
  const trip = computeUpcomingArrivals(
    allStops, buses, net.routeStops, net.stopCoords, segmentTimes as any, t, dwellTimes as any, liveAnchorStore,
  );
  /** earliest trip entry per (label, stop) and per (label, bus, stop) */
  const tripByStop = new Map<string, { eta: number; busName: string }>();
  const tripByBusStop = new Map<string, number>();
  for (const a of trip) {
    const k1 = `${a.routeLabel}|${a.stopId}`;
    if (!tripByStop.has(k1)) tripByStop.set(k1, { eta: a.eta, busName: a.busName });
    const k2 = `${a.routeLabel}|${a.busName}|${a.stopId}`;
    if (!tripByBusStop.has(k2)) tripByBusStop.set(k2, a.eta);
  }

  for (const cfg of ROUTE_LISTS) {
    if (!LABELS.has(cfg.label)) continue;
    const canonical = mergedRouteStops(cfg, net.routeStops);
    if (canonical.length === 0) continue;
    const routeSegs = (segmentTimes as any)[cfg.routeIds[0]!] ?? {};
    const routeDwells = (dwellTimes as any)[cfg.routeIds[0]!] ?? {};
    const split = splitServedForRoute(routeSegs, routeDwells);
    splitSeen.set(cfg.label, split || (splitSeen.get(cfg.label) ?? false));

    const card = cardArrivals(cfg, buses, net.routeStops, net.stopCoords, segmentTimes as any);
    const onRoute = buses.filter((b) => cfg.busRouteIds.includes(b.route_id) && isBusOnRoute(b, canonical, net.stopCoords));
    if (onRoute.length === 0) {
      // The card shows a countdown off a bus `isBusOnRoute` rejects. Worth
      // counting on its own: a merge deletes those rows, which is a change a
      // rider can see (a line's card goes blank), so it must not be a surprise.
      const n = Object.keys(card.etaAtStop).length;
      if (n > 0) { offRouteLines++; offRouteRows += n; offRouteByLabel.set(cfg.label, (offRouteByLabel.get(cfg.label) ?? 0) + n); }
      continue;
    }

    // --- anchor comparison, per bus -----------------------------------------
    // The trip anchor expressed on the CARD's list, so both are stop ids.
    let standingAtLayover = false;
    let departingNow = false;
    for (const bus of onRoute) {
      const cardStopId = nearestRouteStop(bus, cfg.routeIds, net.routeStops, net.stopCoords) ?? bus.last_stop_id;
      const ti = anchorIndexOnList(bus, cfg, net.routeStops, net.stopCoords, card.stops, t, liveAnchorStore);
      const tripStopId = ti >= 0 ? card.stops[ti] : undefined;
      const bk = B(`route:${cfg.label}`);
      if (tripStopId !== undefined) {
        bk.anchorN++;
        if (tripStopId === cardStopId) bk.anchorSame++;
        else {
          const ci = card.stops.indexOf(cardStopId as number);
          if (ci >= 0) {
            const N = card.stops.length;
            const d = Math.min(((ci - ti) % N + N) % N, ((ti - ci) % N + N) % N);
            let l = anchorHops.get(cfg.label);
            if (!l) anchorHops.set(cfg.label, (l = []));
            l.push(d);
          }
        }
      }
      if (bus.at_stop_id) {
        const dw = routeDwells[String(bus.at_stop_id)];
        if (dw && dw.n >= 3 && dw.med >= 300) standingAtLayover = true;
      }
      if (departedThisPoll.has(bus.bus_name)) departingNow = true;
    }

    // --- ETA comparison, per rendered stop row -------------------------------
    for (const sid of card.stops) {
      const c = card.etaAtStop[sid];
      // The row shows an ETA only when no bus of this line is parked on it.
      if (!c || card.busMap[sid]) continue;
      const tr = tripByStop.get(`${cfg.label}|${sid}`);
      if (!tr) { cardOnly++; continue; }
      paired++;
      const cardBus = c.busName.replace(/^#/, "");
      const delta = c.eta - tr.eta;
      const minuteD = Math.round(c.low / 60) - Math.floor(tr.eta / 60);
      const sameBus = tripByBusStop.get(`${cfg.label}|${cardBus}|${sid}`);
      const arr = nextArrival(sid, cfg.busRouteIds, t);
      const truthSec = arr === null ? null : (arr - t) / 1000;

      // Stratify by how soon the bus is due. Far-future rows are both arms
      // summing the same segment table and agree by construction; the rows a
      // rider acts on are the near ones, and they are where the anchor, the
      // credit and the proration all live.
      const horizon = tr.eta <= 300 ? "horizon:<=5min"
        : tr.eta <= 900 ? "horizon:5-15min" : "horizon:>15min";
      const keys = ["all", horizon, `route:${cfg.label}`, split ? "split:served" : "split:absent"];
      if (horizon === "horizon:<=5min") keys.push(`near:${cfg.label}`);
      if (standingAtLayover) keys.push("layover:standing");
      if (departingNow) keys.push("layover:departure-poll");
      if (CHAIN && cfg.label === CHAIN.label && chainStops.has(sid)) {
        keys.push("chain:all");
        if (standingAtLayover) keys.push("chain:standing");
        if (departingNow) keys.push("chain:departure-poll");
      }
      // sequence flags, against this (line, stop)'s previous reading
      const seqKey = `${cfg.label}|${sid}`;
      const prev = lastSeen.get(seqKey);
      const cardMin = Math.round(c.low / 60), tripMin = Math.floor(tr.eta / 60);
      const adjacent = prev && t - prev.t <= 30_000 && prev.bus === cardBus && cardBus === tr.busName;
      lastSeen.set(seqKey, { t, card: c.eta, trip: tr.eta, cardMin, tripMin, bus: cardBus });

      for (const k of keys) {
        const b = B(k);
        b.rows++;
        if (adjacent && prev) {
          b.seqN++;
          if (c.eta === prev.card) b.cardFrozen++;
          if (tr.eta === prev.trip) b.tripFrozen++;
          if (prev.cardMin - cardMin >= 2) b.cardCollapse++;
          if (prev.tripMin - tripMin >= 2) b.tripCollapse++;
          if (Math.abs(c.eta - prev.card) >= 180) b.cardJump++;
          if (Math.abs(tr.eta - prev.trip) >= 180) b.tripJump++;
        }
        b.screenDelta.push(delta);
        b.minuteDelta.push(minuteD);
        if (cardBus === tr.busName) b.agreeStop++;
        if (sameBus !== undefined) b.sameBusDelta.push(c.eta - sameBus);
        if (truthSec !== null) {
          b.errCard.push(c.eta - truthSec);
          b.errCardShown.push(c.low - truthSec);
          b.errTrip.push(tr.eta - truthSec);
          b.errAbsPairDelta.push(Math.abs(c.eta - truthSec) - Math.abs(tr.eta - truthSec));
        }
      }
      if (TRACE_STOP !== null && sid === TRACE_STOP) {
        const cm = Math.round(c.low / 60), tm = Math.floor(tr.eta / 60);
        traceLines.push(
          `${new Date(t).toISOString().slice(11, 19)}  card ${String(cm).padStart(3)} min (#${cardBus})  |  trip ${String(tm).padStart(3)} min (#${tr.busName})  |  raw ${c.eta.toFixed(0)}s vs ${tr.eta.toFixed(0)}s${standingAtLayover ? "  [standing]" : ""}${departingNow ? "  [DEPARTURE POLL]" : ""}`,
        );
      }
      if (Math.abs(delta) > 600 && worst.length < 400_000) {
        worst.push({ t, label: cfg.label, stop: sid, sid, card: c.eta, trip: tr.eta, cardBus, tripBus: tr.busName, why: standingAtLayover ? "standing" : departingNow ? "departure" : "" });
      }
    }
  }
  if (pi % 500 === 0) log(`poll ${pi}/${polls.length} (${new Date(t).toISOString()}) paired=${paired}`);
}
log(`done: ${paired} paired stop rows`);

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const out: any = {
  generatedAt: new Date().toISOString(),
  capture: captureFiles,
  db: process.env.REPLAY_DB ?? "./store/snap.db",
  patch: process.env.PAYLOAD_PATCH ?? null,
  window: { from: new Date(dataStart).toISOString(), to: new Date(dataEnd).toISOString() },
  polls: polls.length,
  pairedRows: paired,
  cardOnlyRows: cardOnly,
  offRoute: { lineRenders: offRouteLines, rows: offRouteRows, byLabel: Object.fromEntries(offRouteByLabel) },
  splitServed: Object.fromEntries(splitSeen),
  buckets: {},
  anchorHops: {},
};
for (const [k, b] of buckets) {
  if (b.rows === 0 && b.anchorN === 0) continue;
  out.buckets[k] = {
    rows: b.rows,
    sameVehicle: b.rows ? +(100 * b.agreeStop / b.rows).toFixed(1) : null,
    anchorAgree: b.anchorN ? +(100 * b.anchorSame / b.anchorN).toFixed(1) : null,
    anchorN: b.anchorN,
    screenDelta: dist(b.screenDelta),
    sameBusDelta: dist(b.sameBusDelta),
    minuteDelta: dist(b.minuteDelta),
    errCard: dist(b.errCard),
    errCardShown: dist(b.errCardShown),
    errTrip: dist(b.errTrip),
    errAbsPairDelta: dist(b.errAbsPairDelta),
    seq: { pairs: b.seqN, cardFrozen: b.cardFrozen, tripFrozen: b.tripFrozen, cardCollapse: b.cardCollapse, tripCollapse: b.tripCollapse, cardJump: b.cardJump, tripJump: b.tripJump },
  };
}
for (const [k, v] of anchorHops) out.anchorHops[k] = dist(v);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.json`), JSON.stringify(out, null, 2));

// -- the readable table ------------------------------------------------------
const L: string[] = [];
L.push(`# card vs trip — two estimators, one app`);
L.push("");
L.push(`capture ${captureFiles.map((f) => path.basename(f)).join(", ")}  db ${out.db}  patch ${out.patch ?? "NONE (pre-#85 trip arm!)"}`);
L.push(`the card answered ${offRouteRows} rows across ${offRouteLines} line-renders where computeUpcomingArrivals sees no bus on route (isBusOnRoute): ${[...offRouteByLabel].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
L.push("");
L.push(`${polls.length} polls, ${paired} paired stop rows, ${cardOnly} rows the card answered and the trip estimator did not (a row = one line's card row for one stop at one poll, where the card shows an ETA and the trip card also has one)`);
L.push("");
L.push(`## how far apart, in seconds (card eta - trip eta)`);
L.push("");
L.push(`| bucket | rows | same vehicle | |Δ| p50 | |Δ| p90 | |Δ| p99 | Δ p10 | Δ p50 | Δ p90 | Δ >60 s | Δ >180 s | Δ >300 s |`);
L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
const order = ["all", "horizon:<=5min", "horizon:5-15min", "horizon:>15min",
  "split:served", "split:absent", "layover:standing", "layover:departure-poll",
  "chain:all", "chain:standing", "chain:departure-poll",
  ...[...buckets.keys()].filter((k) => k.startsWith("route:")).sort(),
  ...[...buckets.keys()].filter((k) => k.startsWith("near:")).sort()];
for (const k of order) {
  const b = buckets.get(k);
  if (!b || b.rows === 0) continue;
  const d = dist(b.screenDelta);
  const over = (x: number) => pct(b.screenDelta.filter((v) => Math.abs(v) > x).length, b.rows);
  L.push(`| ${k} | ${b.rows} | ${pct(b.agreeStop, b.rows)} | ${r0(d.absP50)} | ${r0(d.absP90)} | ${r0(d.absP99)} | ${r0(d.p10)} | ${r0(d.p50)} | ${r0(d.p90)} | ${over(60)} | ${over(180)} | ${over(300)} |`);
}
L.push("");
L.push(`## the minutes on screen (card \`round(low/60)\` - trip \`floor(eta/60)\`)`);
L.push("");
L.push(`| bucket | rows | same minute | ±1 min | ≥2 min apart | ≥5 min apart | p10 | p50 | p90 |`);
L.push(`|---|---|---|---|---|---|---|---|---|`);
for (const k of order) {
  const b = buckets.get(k);
  if (!b || b.rows === 0) continue;
  const d = dist(b.minuteDelta);
  const within = (x: number) => pct(b.minuteDelta.filter((v) => Math.abs(v) <= x).length, b.rows);
  const beyond = (x: number) => pct(b.minuteDelta.filter((v) => Math.abs(v) >= x).length, b.rows);
  L.push(`| ${k} | ${b.rows} | ${within(0)} | ${within(1)} | ${beyond(2)} | ${beyond(5)} | ${r0(d.p10)} | ${r0(d.p50)} | ${r0(d.p90)} |`);
}
L.push("");
L.push(`## which is right — signed error against the observed arrival (predicted - actual, s; + = late promise)`);
L.push("");
L.push(`| bucket | scored | card \`eta\` \\|err\\| p50 / p90 / bias | card SHOWN \`low\` \\|err\\| p50 / bias | trip \\|err\\| p50 / p90 / bias | paired: card better | trip better |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const k of order) {
  const b = buckets.get(k);
  if (!b || b.errCard.length === 0) continue;
  const c = dist(b.errCard), cs = dist(b.errCardShown), tp = dist(b.errTrip), pd = dist(b.errAbsPairDelta);
  const better = b.errAbsPairDelta.filter((v) => v < -5).length;
  const worseN = b.errAbsPairDelta.filter((v) => v > 5).length;
  L.push(`| ${k} | ${c.n} | ${r0(c.absP50)} / ${r0(c.absP90)} / ${r0(c.p50)} | ${r0(cs.absP50)} / ${r0(cs.p50)} | ${r0(tp.absP50)} / ${r0(tp.absP90)} / ${r0(tp.p50)} | ${pct(better, c.n)} | ${pct(worseN, c.n)} (median Δ\\|err\\| ${r0(pd.p50)} s) |`);
}
L.push("");
L.push(`## the SEQUENCE a rider watches — consecutive readings at one stop, same vehicle`);
L.push("");
L.push(`| bucket | poll pairs | card frozen | trip frozen | card drops ≥2 min in one poll | trip drops ≥2 min | card jump ≥180 s | trip jump ≥180 s |`);
L.push(`|---|---|---|---|---|---|---|---|`);
for (const k of order) {
  const b = buckets.get(k);
  if (!b || b.seqN === 0) continue;
  L.push(`| ${k} | ${b.seqN} | ${pct(b.cardFrozen, b.seqN)} | ${pct(b.tripFrozen, b.seqN)} | ${pct(b.cardCollapse, b.seqN)} | ${pct(b.tripCollapse, b.seqN)} | ${pct(b.cardJump, b.seqN)} | ${pct(b.tripJump, b.seqN)} |`);
}
L.push("");
L.push(`## where each arm thinks the bus is (card's nearest-stop-by-degrees vs the gated anchor)`);
L.push("");
L.push(`| line | bus-polls | same stop | hops apart when not: p50 / p90 / max | split served |`);
L.push(`|---|---|---|---|---|`);
for (const k of [...buckets.keys()].filter((x) => x.startsWith("route:")).sort()) {
  const b = buckets.get(k)!;
  if (b.anchorN === 0) continue;
  const label = k.slice(6);
  const h = dist(anchorHops.get(label) ?? []);
  L.push(`| ${label} | ${b.anchorN} | ${pct(b.anchorSame, b.anchorN)} | ${r0(h.p50)} / ${r0(h.p90)} / ${r0(h.max)} | ${splitSeen.get(label) ? "yes" : "no"} |`);
}
L.push("");
L.push(`## the ten worst single disagreements`);
L.push("");
worst.sort((a, b) => Math.abs(b.card - b.trip) - Math.abs(a.card - a.trip));
for (const w of worst.slice(0, 10)) {
  L.push(`- ${new Date(w.t).toISOString()} ${w.label} @ ${stopName(w.sid)} (${w.sid}): card **${(w.card / 60).toFixed(1)} min** (#${w.cardBus}) vs trip **${(w.trip / 60).toFixed(1)} min** (#${w.tripBus})${w.why ? ` [${w.why}]` : ""}`);
}
L.push("");
L.push(`(${worst.length} rows disagreed by more than 10 minutes.)`);
if (TRACE_STOP !== null) {
  L.push("");
  L.push(`## trace: stop ${TRACE_STOP} (${stopName(TRACE_STOP)})`);
  L.push("");
  L.push("~~~");
  L.push(...traceLines);
  L.push("~~~");
}
fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.md`), L.join("\n") + "\n");
console.log(L.join("\n"));
log(`wrote ${path.join(OUT_DIR, OUT_NAME)}.{json,md}`);
