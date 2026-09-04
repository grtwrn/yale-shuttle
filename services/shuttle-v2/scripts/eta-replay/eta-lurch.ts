/**
 * ETA LURCH: is the jump information, or is it jitter?
 *
 * The operator's ruling, 2026-09-03:
 *
 *   "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it
 *    is jitter we need a fix."
 *
 * So the question is NOT "how big are the jumps" — that is `eta-stability.ts`
 * and it is answered (docs/eta-error-budget.md). It is "how many of them have
 * a real-world event behind them". A jump that coincides with the bus actually
 * moving, departing or arriving is information a waiting rider needs
 * immediately and must never be smoothed. A jump with nothing behind it — the
 * coordinate did not change, the detector did not move the bus, nothing
 * arrived or left — is the operator's jitter, and it is the only population
 * worth suppressing. Nobody had sized it.
 *
 * THE METRIC (identical to eta-stability.ts, so the numbers are comparable).
 * For a (bus, stop) followed across consecutive polls, the predicted arrival
 * instant is A(t) = t + eta(t). A well-behaved countdown holds A still and
 * ticks the displayed number down by the poll interval; a lurch is A moving.
 *
 *     jump = A(t') - A(t)          seconds, = "change in eta net of elapsed"
 *     jump < 0   promised SOONER   (the 5 min -> 1 min drop)
 *     jump > 0   promised LATER    (the countdown stalls or climbs)
 *
 * ARMS. All computed from the SAME replayed inputs, so every comparison is
 * paired.
 *
 *   shipped     the real `computeUpcomingArrivals`, byte-checked (below)
 *   A-cap/-lin/-sq  the served-dwell credit: how much of the first hop a bus
 *               that has ALREADY stood there may cancel, as a function of
 *               observed/expected rather than a hard bound
 *   B45         the output-side slew limiter at 45 s/poll — kept only as a
 *               baseline for the record, since the operator rejected it
 *   A-sq+B45    both, to show whether they overlap
 *
 * THE REPLICA GUARD. `arrivalsFor()` is a hand copy of the first-hop pricing
 * in `web/src/arrivals.ts`, needed because arm A cannot be expressed by
 * post-processing. At `shape: "shipped"` it is compared with the REAL
 * `computeUpcomingArrivals` on every observation and a mismatch fails the run.
 * `gps-replay.ts`'s replica went stale silently and its numbers were quoted as
 * the client's; this one cannot.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/eta-lurch.ts
 *
 * Env: REPLAY_DB, REPLAY_OUT, MAX_K (5), POLL_STRIDE (1), WINDOW_HOURS (all),
 * SLEW_SEC (45), CASE_BUS / CASE_STOP / CASE_FROM / CASE_TO.
 */
import fs from "node:fs";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  metricsOf,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
} from "./common.js";
import { planTracks, stepMany, type BusObservation, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { median } from "../../src/calibrator/shrinkage.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes } from "../../web/src/arrivals";
import { findRouteAnchor, isBusOnRoute, registerRoutePaths } from "../../web/src/anchor";
import { distanceToSegmentM, haversineMeters, progressAlongSegment } from "../../web/src/geo";
import type { BusData } from "../../web/src/map-data";
import { BUS_SPEED_M_S, ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const MAX_K = Number(process.env.MAX_K ?? 5);
const POLL_STRIDE = Number(process.env.POLL_STRIDE ?? 1);
/** collector.ts AT_STOP_MAX_M. */
const AT_STOP_MAX_M = 75;
/** A jump this big is the operator's complaint rather than ordinary noise. */
const JUMP_BIG_SEC = 300;
const JUMP_MED_SEC = 60;
/** Two polls further apart than this are a feed gap, not a transition. */
const MAX_POLL_GAP_MS = 20_000;
/**
 * The feed's position deadband, measured in docs/eta-error-budget.md: upstream
 * reports a new coordinate only once the vehicle has moved ~30 m (p1 of 33,118
 * distinct fixes is 30.1 m; exactly 2 displacements below 28 m exist). So a
 * displacement at or above it is the feed SAYING the bus moved; one below it
 * is a censored observation meaning "it did not measurably move".
 */
const DEADBAND_M = 30;
/** calibrator.ts DWELL_WINDOW_DAYS / DWELL_LOW_*. */
const DWELL_WINDOW_MS = 14 * 86_400_000;
const DWELL_LOW_QUANTILE = 0.35;
const DWELL_LOW_MIN_SAMPLES = 5;
/** Ground truth: the bus's own track entering / leaving a stop's radius. */
const ENTER_M = 50;
const EXIT_M = 80;
const TRUTH_HORIZON_MS = 45 * 60_000;
const SLEW_SEC = Number(process.env.SLEW_SEC ?? 45);
/**
 * Arm C's layover apron. `AT_STOP_MAX_M` is 75 m, and a bus manoeuvring in the
 * 344 Winchester lot reaches 95 m from the stop while plainly still serving it
 * (measured on #309, 2026-09-03 17:25-17:28: every fix moves the deadband's
 * 31-36 m and the distance to the stop walks 174 -> 5 -> 95 -> 46 m without
 * the bus going anywhere). The hold is additionally gated on the DETECTOR
 * still anchoring the bus to that stop, which is what stops a bus merely
 * driving past from inheriting a stale clock.
 */
const HOLD_APRON_M = Number(process.env.HOLD_APRON_M ?? 150);
/**
 * Net progress window. A single 31 m fix clears the feed's deadband and so
 * counts as "the bus moved", but a bus shuffling in a layover lot clears it
 * every few polls while going nowhere. Distance from where the bus was
 * NET_PROGRESS_MS ago separates the two.
 */
const NET_PROGRESS_MS = 90_000;
const NET_PROGRESS_M = 100;
/** The limiter must release once the bus has effectively arrived. */
const SLEW_RELEASE_ETA = 30;

const net = loadNet();
const { db, network } = net;
registerRoutePaths(net.routePaths);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
let pos = db
  .prepare(`SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
            FROM raw_positions ORDER BY collected_at, id`)
  .all() as PosRow[];
if (process.env.WINDOW_HOURS) {
  const cut = pos[pos.length - 1]!.t - Number(process.env.WINDOW_HOURS) * 3_600_000;
  pos = pos.filter((p) => p.t >= cut);
}
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

// -- Served payload, time-travelled per hour ----------------------------------
const samples = loadSamples(net, rawStart - SEGMENT_WINDOW_MS - 3_600_000, rawEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const segCache = new Map<number, SegmentTimes>();
function segmentsAt(t: number): SegmentTimes {
  const bs = calibCache.bucketStart(t);
  let p = segCache.get(bs);
  if (!p) {
    const bc = calibCache.get(bs);
    const st: SegmentTimes = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(bs, (p = st));
  }
  return p;
}

/**
 * The `dwells` half of the payload, rebuilt per hour exactly as
 * `computeDwellStats` builds it. `computeUpcomingArrivals` reads it for the
 * stall-credit bound, so calling the client with `{}` — which `gps-replay.ts`
 * on master still does — replays a client production does not ship.
 */
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
function pctOf(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const dwellCache = new Map<number, DwellTimes>();
function dwellsAt(t: number): DwellTimes {
  const start = calibCache.bucketStart(t);
  const hit = dwellCache.get(start);
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
      // Only rows that had COMPLETED by the bucket start were visible then.
      if (g.at[i]! < start - DWELL_WINDOW_MS || g.done[i]! > start) continue;
      all.push(g.sec[i]!);
      if (g.dow[i] === dow && hours.has(g.hour[i]!)) win.push(g.sec[i]!);
    }
    if (all.length === 0) continue;
    const priorMedian = median(all);
    const low = all.length >= DWELL_LOW_MIN_SAMPLES ? pctOf(all, DWELL_LOW_QUANTILE) : undefined;
    let stat: { med: number; sd: number; n: number; low?: number };
    if (win.length === 0) {
      stat = { med: priorMedian, sd: Math.max(pctOf(all, 0.9) - priorMedian, 5), n: 0, ...(low !== undefined ? { low } : {}) };
    } else {
      const med = median(win);
      stat = { med, sd: Math.max(pctOf(win, 0.9) - med, 5), n: win.length, ...(low !== undefined ? { low: Math.min(low, med) } : {}) };
    }
    // v1compat rounds the served numbers to one decimal.
    (out[rid!] ||= {})[sid!] = {
      med: Math.round(stat.med * 10) / 10,
      sd: Math.round(stat.sd * 10) / 10,
      n: stat.n,
      ...(stat.low !== undefined ? { low: Math.round(stat.low * 10) / 10 } : {}),
    };
  }
  dwellCache.set(start, out);
  return out;
}

// -- Detector replay: the real at_stop_id / at_stop_since ---------------------
// `collector.updateLivePositions`, INCLUDING the 2026-09-03 hotfix that keys
// the clock on `stationarySince` rather than `enteredAt`. `gps-replay.ts` on
// master still uses `enteredAt`, i.e. the pre-hotfix client, which understates
// the standing time on exactly the parked buses this investigation is about.
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

interface Obs {
  bus: BusData;
  t: number;
  routeId: number;
  atStop: boolean;
  detIdx: number;
  stationarySince: number;
  /**
   * Arm C's corrected standing clock: the stop the bus is HELD at and when it
   * started being held, carried across a flicker of `at_stop_id` and across a
   * restart of `at_stop_since`, and dropped only on real movement (the same
   * 75 m the collector already calls standing). Null when the bus is not held.
   */
  hold: { stopId: number; sinceMs: number } | null;
  /** Seconds of standing the collector's clock DID NOT bill (hold - shipped). */
  clockLossSec: number;
  /** Metres from where this bus was NET_PROGRESS_MS ago (NaN if unknown). */
  netProgressM: number;
}
const observations: Obs[] = [];
{
  const states = new Map<string, BusState>();
  const holds = new Map<string, { stopId: number; sinceMs: number; lastT: number }>();
  const trail = new Map<string, Array<{ t: number; lat: number; lon: number }>>();
  for (let pi = 0; pi < polls.length; pi++) {
    const poll = polls[pi]!;
    const plan = planTracks(poll);
    stepMany(network, states, poll, plan);
    if (pi % POLL_STRIDE !== 0) continue;
    for (const o of poll) {
      const key = plan.keys.get(o.busId) ?? o.busName;
      const st = states.get(key);
      const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
      const cand = st && dwellingForMs >= 15_000 ? net.stopById.get(st.nearestStopId) : undefined;
      const atStop = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M
        ? { id: st.nearestStopId, since: st.stationarySince }
        : null;
      const bus: BusData = {
        bus_id: o.busId,
        bus_name: o.busName,
        route_id: o.routeId,
        lat: o.lat,
        lon: o.lon,
        heading: o.heading,
        last_stop_id: o.lastStopId as number,
        stationary: atStop != null,
        ...(atStop ? { at_stop_id: atStop.id, at_stop_since: new Date(atStop.since).toISOString().replace(/Z$/, "") } : {}),
      };
      // Arm C's hold. Kept alive while the bus is within STATIONARY_RADIUS_M
      // of where the hold began and the feed has not gone quiet; a flicker of
      // at_stop_id to null, or a restart of at_stop_since, does not end it.
      const h = holds.get(o.busName);
      const heldStop = h ? net.stopById.get(h.stopId) : undefined;
      let hold: { stopId: number; sinceMs: number } | null = null;
      if (
        h && heldStop &&
        o.collectedAt - h.lastT <= 60_000 &&
        st !== undefined && st.nearestStopId === h.stopId &&
        distanceMeters(o, heldStop) <= HOLD_APRON_M
      ) {
        h.lastT = o.collectedAt;
        hold = { stopId: h.stopId, sinceMs: h.sinceMs };
      } else if (atStop) {
        holds.set(o.busName, { stopId: atStop.id, sinceMs: atStop.since, lastT: o.collectedAt });
        hold = { stopId: atStop.id, sinceMs: atStop.since };
      } else {
        holds.delete(o.busName);
      }
      let tr = trail.get(o.busName);
      if (!tr) trail.set(o.busName, (tr = []));
      tr.push({ t: o.collectedAt, lat: o.lat, lon: o.lon });
      while (tr.length > 1 && o.collectedAt - tr[0]!.t > NET_PROGRESS_MS) tr.shift();
      const netProgressM = o.collectedAt - tr[0]!.t >= NET_PROGRESS_MS * 0.7
        ? distanceMeters(o, tr[0]!)
        : Number.NaN;
      observations.push({
        bus, t: o.collectedAt, routeId: o.routeId, atStop: atStop != null,
        detIdx: st ? st.nearestIndex : -1, stationarySince: st ? st.stationarySince : 0,
        hold,
        clockLossSec: hold && atStop ? (atStop.since - hold.sinceMs) / 1000 : 0,
        netProgressM,
      });
    }
  }
}
log(`observations ${observations.length}`);

// -- Ground truth: the bus's own track entering the stop's radius -------------
const trackByName = new Map<string, PosRow[]>();
for (const p of pos) {
  let l = trackByName.get(p.b);
  if (!l) trackByName.set(p.b, (l = []));
  l.push(p);
}
const entryCache = new Map<string, Float64Array>();
function entries(busName: string, stopId: number): Float64Array {
  const key = `${busName} ${stopId}`;
  let e = entryCache.get(key);
  if (e) return e;
  const track = trackByName.get(busName) ?? [];
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
      if (!inside && d <= ENTER_M) {
        out.push(p.t);
        inside = true;
      } else if (inside && d >= EXIT_M) inside = false;
    }
    prev = p;
  }
  entryCache.set(key, (e = Float64Array.from(out)));
  return e;
}
/** The next physical arrival of this bus at this stop at or after `t`, else NaN. */
function nextArrival(busName: string, stopId: number, t: number): number {
  const e = entries(busName, stopId);
  for (let i = 0; i < e.length; i++) {
    const x = e[i]!;
    if (x < t - 15_000) continue;
    return x - t > TRUTH_HORIZON_MS ? NaN : x;
  }
  return NaN;
}

// -- The estimator, with the first-hop credit parameterised -------------------
/**
 * ARM A. `r` is observed/expected: how much of the rest the bus has been SEEN
 * to serve, over what the payload says that rest costs.
 *
 *   shipped   applied = min(elapsed, cancellable, segAvg)
 *             cancellable = dwells[stop].med, else segAvg * STALL_CREDIT_MAX_FRACTION
 *             — a HARD bound. Once elapsed passes it the number stops moving,
 *               however much longer the bus stands there. That is the steady
 *               wrong number the operator is pointing at.
 *   A-cap     the same linear-in-elapsed credit, but bounded by what the hop
 *             can physically give up: segAvg minus a drive floor. No shape.
 *   A-lin     A-cap's bound, released linearly:      g(r) = min(1, r)
 *   A-sq      A-cap's bound, released as             g(r) = min(1, r^2)
 *             — little credit early, full credit once the expected rest has
 *               been served.
 *
 * The drive floor is the straight-line distance at BUS_SPEED_M_S, which the
 * client ALREADY uses as the price of an unmeasured hop, so no new constant is
 * introduced. The bound is never allowed below the shipped one, so at r >= 1
 * every A arm is a strict relaxation of what ships today.
 */
type Shape = "shipped" | "A-cap" | "A-sq" | "C-clock" | "A-sq+C" | "D-prorate" | "C+D" | "A-sq+C+D";
const SHAPES: Shape[] = ["shipped", "A-cap", "A-sq", "C-clock", "A-sq+C", "D-prorate", "C+D", "A-sq+C+D"];
/** Which shapes read arm C's corrected standing clock. */
const USES_HOLD = new Set<Shape>(["C-clock", "A-sq+C", "C+D", "A-sq+C+D"]);
/**
 * ARM D. Today the first hop is priced by ONE of two rules, chosen by whether
 * the bus is flagged at its stop: standing -> credit, no proration; moving ->
 * proration, no credit. Switching rule is a step change with no motion behind
 * it, and it is what the operator watched: #309's berth at 344 Winchester
 * projects 65% of the way along the chord to the next stop, so the instant the
 * at-stop flag cleared the same bus in the same place was re-priced from 420 s
 * to 184 s. Arm D applies proration in BOTH regimes, so the parked number
 * already knows where the bus is parked.
 */
const ALWAYS_PRORATE = new Set<Shape>(["D-prorate", "C+D", "A-sq+C+D"]);
/** The credit rule each shape applies once it has an elapsed standing time. */
const CREDIT_OF: Record<Shape, "shipped" | "A-cap" | "A-sq"> = {
  shipped: "shipped", "A-cap": "A-cap", "A-sq": "A-sq", "C-clock": "shipped", "A-sq+C": "A-sq",
  "D-prorate": "shipped", "C+D": "shipped", "A-sq+C+D": "A-sq",
};

function creditFor(shape: Shape, elapsed: number, dwellMed: number, segAvg: number, driveFloor: number): number {
  const rule = CREDIT_OF[shape];
  const shippedCancellable = dwellMed > 0 ? dwellMed : segAvg * 0.5;
  if (rule === "shipped") return Math.min(elapsed, shippedCancellable, segAvg);
  const cap = Math.max(shippedCancellable, segAvg - driveFloor);
  const expected = shippedCancellable;
  const r = expected > 0 ? elapsed / expected : 1;
  // A-lin — g(r) = min(1, r) — was measured too and is ARITHMETICALLY
  // identical to A-cap: min(elapsed, cap*r) = elapsed whenever cap >= expected,
  // which the max() above guarantees. Its row was a duplicate; dropped.
  const g = rule === "A-cap" ? 1 : Math.min(1, r * r);
  return Math.min(elapsed, cap * g, segAvg);
}

interface Internals { busIdx: number; atStopIdx: number; elapsed: number; dwellMed: number; seg1Raw: number; applied: number; factor: number; cancellable: number }
/**
 * The next MAX_K stops' ETAs for ONE bus: a transcription of
 * `computeUpcomingArrivals`'s inner loop, verified against the real function
 * on every observation at `shape: "shipped"`.
 */
function arrivalsFor(
  bus: BusData,
  stops: number[],
  busIdx: number,
  routeSegs: Record<string, { avg: number; sd?: number; n: number }>,
  routeDwells: Record<string, { med: number; sd: number; n: number; low?: number }>,
  now: number,
  shape: Shape,
  outEta: Float64Array,
  out?: Internals,
  /** Arm C: use this held stop + clock instead of the payload's at_stop_*. */
  hold?: { stopId: number; sinceMs: number } | null,
): void {
  const segValues = Object.values(routeSegs).filter((s) => s.n >= 2);
  const avgSeg = segValues.length > 0 ? segValues.reduce((sum, s) => sum + s.avg, 0) / segValues.length : 0;
  let stallCredit = 0;
  let atStopIdx = -1;
  const atId = hold ? hold.stopId : bus.at_stop_id;
  const sinceMs = hold ? hold.sinceMs : bus.at_stop_since ? new Date(bus.at_stop_since + "Z").getTime() : null;
  if (atId && sinceMs !== null) {
    atStopIdx = stops.indexOf(atId);
    if (atStopIdx >= 0 && atStopIdx === busIdx) {
      stallCredit = Math.max(0, (now - sinceMs) / 1000);
    }
  }
  let factor = 1;
  if ((stallCredit === 0 || ALWAYS_PRORATE.has(shape)) && bus.lat && bus.lon) {
    const a = net.stopCoords[stops[busIdx]!];
    const b = net.stopCoords[stops[(busIdx + 1) % stops.length]!];
    if (a && b) {
      const t = progressAlongSegment({ lat: bus.lat, lon: bus.lon }, a, b);
      factor = Math.max(0, Math.min(1, 1 - t));
    }
  }
  if (out) {
    out.busIdx = busIdx; out.atStopIdx = atStopIdx; out.elapsed = stallCredit;
    out.factor = factor; out.dwellMed = 0; out.seg1Raw = 0; out.applied = 0; out.cancellable = 0;
  }
  let cumulative = 0;
  const N = stops.length;
  for (let step = 1; step <= MAX_K; step++) {
    const prevI = (busIdx + step - 1) % N;
    const curI = (busIdx + step) % N;
    const seg = routeSegs[`${stops[prevI]}-${stops[curI]}`];
    const pc = net.stopCoords[stops[prevI]!];
    const cc = net.stopCoords[stops[curI]!];
    const byDistance = pc && cc ? Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S) : 0;
    let segAvg: number;
    if (seg && seg.n >= 1) segAvg = seg.avg;
    else if (avgSeg > 0 && avgSeg >= byDistance) segAvg = avgSeg;
    else segAvg = byDistance || 90;
    if (step === 1) {
      if (out) out.seg1Raw = segAvg;
      if (stallCredit > 0) {
        const dwell = routeDwells[String(stops[busIdx]!)];
        const dwellMed = dwell && dwell.med > 0 ? dwell.med : 0;
        const applied = creditFor(shape, stallCredit, dwellMed, segAvg, byDistance);
        if (out) {
          out.dwellMed = dwellMed;
          out.applied = applied;
          out.cancellable = dwellMed > 0 ? dwellMed : segAvg * 0.5;
        }
        segAvg -= applied;
        stallCredit -= applied;
      }
      if (factor < 1) segAvg *= factor;
    }
    cumulative += segAvg;
    outEta[step - 1] = cumulative;
  }
}

// -- Arms ---------------------------------------------------------------------
interface Arm { name: string; shape: Shape; slew: number }
const ARMS: Arm[] = [
  { name: "shipped", shape: "shipped", slew: 0 },
  { name: "A-cap", shape: "A-cap", slew: 0 },
  { name: "A-sq", shape: "A-sq", slew: 0 },
  { name: "C-clock", shape: "C-clock", slew: 0 },
  { name: "A-sq+C", shape: "A-sq+C", slew: 0 },
  { name: "D-prorate", shape: "D-prorate", slew: 0 },
  { name: "C+D", shape: "C+D", slew: 0 },
  { name: "A-sq+C+D", shape: "A-sq+C+D", slew: 0 },
  { name: "B45", shape: "shipped", slew: SLEW_SEC },
];
const NA = ARMS.length;

// -- Walk every observation, columnar -----------------------------------------
/**
 * Is the shipped credit at its cap? Counted over every observation where the
 * bus is standing at its anchor stop. If the cap rarely binds, arm A — which
 * only raises the cap — cannot move anything.
 */
const creditBind = { atStopRows: 0, capBound: 0, elapsedBound: 0, elapsedSum: 0, cancellableSum: 0, ratios: [] as number[] };
const cT: number[] = [];
const cBus: number[] = [];      // index into busNames
const cLabel: number[] = [];    // index into labels
const cStop: number[] = [];
const cK: number[] = [];
const cEta: number[][] = SHAPES.map(() => []);
const cAtStop: number[] = [];
const cAnchor: number[] = [];
const cDet: number[] = [];
const cLat: number[] = [];
const cLon: number[] = [];
const cStat: number[] = [];
const cAtStopId: number[] = [];
const cCalib: number[] = [];
const cClockLoss: number[] = [];
const cFactor: number[] = [];
const cNet: number[] = [];
const cTruth: number[] = [];
const busNames: string[] = [];
const busIdOf = new Map<string, number>();
const labels: string[] = [];
const labelIdOf = new Map<string, number>();

const counts = { obs: observations.length, noCfg: 0, offRoute: 0, noAnchor: 0, emitted: 0, replicaChecked: 0, replicaMismatch: 0 };
let maxReplicaDiff = 0;

const CASE_BUS = process.env.CASE_BUS ?? "#309";
const CASE_STOP = Number(process.env.CASE_STOP ?? 48);
const CASE_FROM = Date.parse(process.env.CASE_FROM ?? "2026-09-03T17:14:00-04:00");
const CASE_TO = Date.parse(process.env.CASE_TO ?? "2026-09-03T17:28:00-04:00");
const caseRows: Array<Record<string, number | boolean>> = [];

const etaBuf: Float64Array[] = SHAPES.map(() => new Float64Array(MAX_K));
const internals: Internals = { busIdx: -1, atStopIdx: -1, elapsed: 0, dwellMed: 0, seg1Raw: 0, applied: 0, factor: 1, cancellable: 0 };
let done = 0;
for (const o of observations) {
  if (++done % 20000 === 0) log(`  ...${done}/${observations.length}`);
  const cfg = ROUTE_LISTS.find((c) => c.busRouteIds.includes(o.routeId));
  if (!cfg) { counts.noCfg++; continue; }
  const stops = mergedRouteStops(cfg, net.routeStops);
  if (!isBusOnRoute(o.bus, stops, net.stopCoords)) { counts.offRoute++; continue; }
  const busIdx = findRouteAnchor(o.bus, stops, net.stopCoords);
  if (busIdx < 0) { counts.noAnchor++; continue; }

  const segTimes = segmentsAt(o.t);
  const dwellTimes = dwellsAt(o.t);
  const routeSegs = segTimes[String(cfg.routeIds[0])] ?? {};
  const routeDwells = (dwellTimes[String(cfg.routeIds[0])] ?? {}) as Record<string, { med: number; sd: number; n: number; low?: number }>;
  for (let si = 0; si < SHAPES.length; si++) {
    const sh = SHAPES[si]!;
    arrivalsFor(o.bus, stops, busIdx, routeSegs, routeDwells, o.t, sh, etaBuf[si]!, si === 0 ? internals : undefined, USES_HOLD.has(sh) ? o.hold : null);
  }

  // ---- replica guard: the shipped shape must BE the client ----
  const targets = [...new Set(Array.from({ length: MAX_K }, (_, i) => stops[(busIdx + i + 1) % stops.length]!))];
  const real = computeUpcomingArrivals(targets, [o.bus], net.routeStops, net.stopCoords, segTimes, o.t, dwellTimes)
    .filter((a) => a.routeLabel === cfg.label);
  const firstRealByStop = new Map<number, number>();
  for (const a of real) if (!firstRealByStop.has(a.stopId)) firstRealByStop.set(a.stopId, a.eta);

  let bi = busIdOf.get(o.bus.bus_name);
  if (bi === undefined) { bi = busNames.length; busNames.push(o.bus.bus_name); busIdOf.set(o.bus.bus_name, bi); }
  let li = labelIdOf.get(cfg.label);
  if (li === undefined) { li = labels.length; labels.push(cfg.label); labelIdOf.set(cfg.label, li); }

  const seen = new Set<number>();
  for (let k = 1; k <= MAX_K; k++) {
    const sid = stops[(busIdx + k) % stops.length]!;
    if (seen.has(sid)) continue; // repeated stop: the real fn's first occurrence is this one
    seen.add(sid);
    const r = firstRealByStop.get(sid);
    if (r !== undefined) {
      counts.replicaChecked++;
      const d = Math.abs(r - etaBuf[0]![k - 1]!);
      if (d > maxReplicaDiff) maxReplicaDiff = d;
      if (d > 0.5) counts.replicaMismatch++;
    }
    if (k === 1 && internals.elapsed > 0) {
      creditBind.atStopRows++;
      if (internals.elapsed >= internals.cancellable) creditBind.capBound++;
      else creditBind.elapsedBound++;
      creditBind.elapsedSum += internals.elapsed;
      creditBind.cancellableSum += internals.cancellable;
      if (internals.cancellable > 0) creditBind.ratios.push(internals.elapsed / internals.cancellable);
    }
    cT.push(o.t); cBus.push(bi); cLabel.push(li); cStop.push(sid); cK.push(k);
    for (let si = 0; si < SHAPES.length; si++) cEta[si]!.push(etaBuf[si]![k - 1]!);
    cAtStop.push(o.atStop ? 1 : 0); cAnchor.push(busIdx); cDet.push(o.detIdx);
    cLat.push(o.bus.lat); cLon.push(o.bus.lon); cStat.push(o.stationarySince);
    cAtStopId.push(o.bus.at_stop_id ?? -1); cCalib.push(calibCache.bucketStart(o.t)); cClockLoss.push(o.clockLossSec); cFactor.push(internals.factor); cNet.push(o.netProgressM);
    cTruth.push(nextArrival(o.bus.bus_name, sid, o.t));
    counts.emitted++;

    if (o.bus.bus_name === CASE_BUS && sid === CASE_STOP && o.t >= CASE_FROM && o.t <= CASE_TO) {
      caseRows.push({
        t: o.t, k, atStop: o.atStop, atStopId: o.bus.at_stop_id ?? -1, anchor: busIdx, det: o.detIdx,
        elapsed: Math.round(internals.elapsed), dwellMed: internals.dwellMed,
        seg1Raw: Math.round(internals.seg1Raw), applied: Math.round(internals.applied),
        factor: Math.round(internals.factor * 1000) / 1000,
        lat: o.bus.lat, lon: o.bus.lon,
        shipped: etaBuf[0]![k - 1]!, Acap: etaBuf[1]![k - 1]!, Asq: etaBuf[2]![k - 1]!,
        Cclock: etaBuf[3]![k - 1]!, AsqC: etaBuf[4]![k - 1]!, Dpro: etaBuf[5]![k - 1]!, CD: etaBuf[6]![k - 1]!, AsqCD: etaBuf[7]![k - 1]!,
        clockLoss: Math.round(o.clockLossSec),
        truth: nextArrival(o.bus.bus_name, sid, o.t),
      });
    }
  }
}
const NROW = cT.length;
log(`rows ${NROW}`, JSON.stringify(counts), `max replica diff ${maxReplicaDiff.toFixed(3)} s`);
if (counts.replicaMismatch > 0) {
  console.error("");
  console.error("  ############################################################");
  console.error("  #  REPLICA IS STALE — arm `shipped` is NOT the client.     #");
  console.error("  ############################################################");
  console.error(`  ${counts.replicaMismatch}/${counts.replicaChecked} disagree, worst ${maxReplicaDiff.toFixed(1)} s.`);
  console.error("  Re-sync arrivalsFor() with web/src/arrivals.ts before reading anything below.");
  process.exitCode = 1;
}

// -- Series: one (bus, stop) followed across polls -----------------------------
const order = new Int32Array(NROW);
for (let i = 0; i < NROW; i++) order[i] = i;
{
  const arr = Array.from(order);
  arr.sort((a, b) => cBus[a]! - cBus[b]! || cStop[a]! - cStop[b]! || cT[a]! - cT[b]!);
  for (let i = 0; i < NROW; i++) order[i] = arr[i]!;
}
log("sorted");

/** Slew per (arm, series): clamp how far the predicted arrival instant may move. */
function applySlew(prevShown: number, prevT: number, t: number, raw: number, slew: number): number {
  if (slew <= 0) return raw;
  if (!Number.isFinite(prevShown) || t - prevT > MAX_POLL_GAP_MS) return raw;
  if (raw < SLEW_RELEASE_ETA) return raw;
  const prevA = prevT + prevShown * 1000;
  const rawA = t + raw * 1000;
  const lim = slew * 1000;
  const a = Math.max(prevA - lim, Math.min(prevA + lim, rawA));
  return Math.max(0, (a - t) / 1000);
}

// Accumulators
const absJump: number[][] = ARMS.map(() => []);
const absJumpDep: number[][] = ARMS.map(() => []);
const absJumpStand: number[][] = ARMS.map(() => []);
const accErr: number[][] = ARMS.map(() => []);
const freezeSame = new Int32Array(NA);
const freezeUp = new Int32Array(NA);
const freezeTot = new Int32Array(NA);
const risesByArm: number[][] = ARMS.map(() => []);
const ge60 = new Int32Array(NA);
const ge300 = new Int32Array(NA);
const drops300 = new Int32Array(NA);
const depGe300 = new Int32Array(NA);
const standGe300 = new Int32Array(NA);
/** classification counters: [arm][threshold 0=60,1=300][kindIdx] */
const KINDS = ["departure", "arrival", "detector-advance", "movement", "shuffle", "stall-clock-reset", "at-stop-flag", "anchor-flip", "at-stop-id", "reprice", "unexplained"] as const;
/**
 * "shuffle" is deliberately NOT eventful: the feed reported a new coordinate,
 * but the bus is no further from where it was a minute and a half ago than a
 * bus standing in a lot. Nothing a rider would call an event happened.
 */
const EVENTFUL_KINDS = new Set(["departure", "arrival", "detector-advance", "movement"]);
const kindIdx = new Map(KINDS.map((k, i) => [k as string, i]));
const clsN = [0, 1].map(() => ARMS.map(() => new Int32Array(KINDS.length)));
const clsDrop = [0, 1].map(() => ARMS.map(() => new Int32Array(KINDS.length)));
const clsAbs: number[][][] = [0, 1].map(() => ARMS.map(() => [] as number[]));
/** removed / added big drops relative to shipped, paired per transition */
const dropRemoved = new Int32Array(NA);
const dropAdded = new Int32Array(NA);
const eventlessBig: Array<Record<string, unknown>> = [];
/** For |jump| >= 300 s on the shipped arm: what the CLIENT anchor did. */
const bigAnchor = { eventfulSame: 0, eventfulFwd1: 0, eventfulOther: 0, eventlessSame: 0, eventlessFwd1: 0, eventlessOther: 0 };
const bigDisp: number[] = [];
/** Standing-clock resets: consecutive at-stop polls, same stop, no movement. */
const clockStat = { pairs: 0, resets: 0, resetLoss: [] as number[] };
/**
 * How much standing time the collector's clock had LOST by the moment the bus
 * pulled out — i.e. how much of the layover the ETA never credited. Collected
 * on the last standing observation of every hold.
 */
const departLoss: number[] = [];
const departLossBig: number[] = [];
/**
 * The progress factor the FIRST poll after the at-stop flag clears. Proration
 * is switched off while a bus is flagged at its stop, so this number is the
 * size of the pricing step the rider sees at that instant, with no motion
 * behind it beyond the metres that cleared the flag.
 */
const departFactor: number[] = [];
const departFactorBigDrop: number[] = [];
let eventlessCalib = 0;
let eventlessAnchor = 0;
let eventlessFlag = 0;
let eventlessFrozenCoord = 0;
let nTrans = 0;
let nDep = 0;
let nStand = 0;

function eventOf(disp: number, det0: number, det1: number, at0: number, at1: number, stat0: number, stat1: number, anc0: number, anc1: number, atId0: number, atId1: number, calibChanged: boolean, net1: number): string {
  const moved = disp >= DEADBAND_M;
  const detMoved = det0 >= 0 && det1 >= 0 && det0 !== det1;
  const departed = at0 === 1 && at1 === 0;
  const arrived = at0 === 0 && at1 === 1;
  const clockRestart = stat0 !== stat1;
  if (departed && (moved || clockRestart)) return "departure";
  if (arrived && (moved || clockRestart)) return "arrival";
  if (detMoved) return "detector-advance";
  // A fix that clears the 30 m deadband but leaves the bus where it was 90 s
  // ago is a manoeuvre, not progress.
  if (moved) return Number.isFinite(net1) && net1 < NET_PROGRESS_M ? "shuffle" : "movement";
  if (departed || arrived) return "at-stop-flag";
  if (anc0 !== anc1) return "anchor-flip";
  if (atId0 !== atId1) return "at-stop-id";
  // The bus is standing at the same stop and has not moved, but the collector
  // restarted its standing clock. The credit collapses to zero and the ETA
  // jumps back to the uncredited hop — the "5 min, 7 min, 5 min" oscillation.
  if (at0 === 1 && at1 === 1 && stat0 !== stat1) return "stall-clock-reset";
  if (calibChanged) return "reprice";
  return "unexplained";
}

{
  const prevShown = new Float64Array(NA).fill(NaN);
  let i = 0;
  while (i < NROW) {
    let j = i;
    const b = cBus[order[i]!]!;
    const s = cStop[order[i]!]!;
    while (j < NROW && cBus[order[j]!] === b && cStop[order[j]!] === s) j++;
    prevShown.fill(NaN);
    let prevT = -Infinity;
    let prevIdx = -1;
    for (let x = i; x < j; x++) {
      const r = order[x]!;
      const t = cT[r]!;
      const shown = new Float64Array(NA);
      for (let a = 0; a < NA; a++) {
        const raw = cEta[SHAPES.indexOf(ARMS[a]!.shape)]![r]!;
        shown[a] = applySlew(prevShown[a]!, prevT, t, raw, ARMS[a]!.slew);
      }
      const truth = cTruth[r]!;
      if (Number.isFinite(truth)) {
        const actual = (truth - t) / 1000;
        for (let a = 0; a < NA; a++) accErr[a]!.push(shown[a]! - actual);
      }
      if (prevIdx >= 0 && t - prevT <= MAX_POLL_GAP_MS) {
        nTrans++;
        const disp = haversineMeters({ lat: cLat[prevIdx]!, lon: cLon[prevIdx]! }, { lat: cLat[r]!, lon: cLon[r]! });
        const at0 = cAtStop[prevIdx]!;
        const at1 = cAtStop[r]!;
        const isDep = at0 === 1 && at1 === 0;
        const isStand = at0 === 1 && at1 === 1;
        if (isDep) {
          nDep++;
          departLoss.push(cClockLoss[prevIdx]!);
          departFactor.push(cFactor[r]!);
        }
        if (isStand) nStand++;
        if (at0 === 1 && at1 === 1 && cAtStopId[prevIdx] === cAtStopId[r] && disp < DEADBAND_M && cK[r] === 1) {
          clockStat.pairs++;
          if (cStat[prevIdx]! !== cStat[r]!) {
            clockStat.resets++;
            clockStat.resetLoss.push((cStat[r]! - cStat[prevIdx]!) / 1000);
          }
        }
        const kind = eventOf(disp, cDet[prevIdx]!, cDet[r]!, at0, at1, cStat[prevIdx]!, cStat[r]!, cAnchor[prevIdx]!, cAnchor[r]!, cAtStopId[prevIdx]!, cAtStopId[r]!, cCalib[prevIdx] !== cCalib[r], cNet[r]!);
        const ki = kindIdx.get(kind)!;
        let shippedIsDrop = false;
        for (let a = 0; a < NA; a++) {
          const jmp = (t + shown[a]! * 1000 - (prevT + prevShown[a]! * 1000)) / 1000;
          const abs = Math.abs(jmp);
          absJump[a]!.push(abs);
          if (isDep) absJumpDep[a]!.push(abs);
          if (isStand) absJumpStand[a]!.push(abs);
          freezeTot[a]!++;
          if (Math.abs(shown[a]! - prevShown[a]!) < 0.05) freezeSame[a]!++;
          else if (shown[a]! > prevShown[a]!) { freezeUp[a]!++; risesByArm[a]!.push(shown[a]! - prevShown[a]!); }
          if (abs >= JUMP_MED_SEC) { ge60[a]!++; clsN[0]![a]![ki]!++; clsAbs[0]![a]!.push(abs); if (jmp <= -JUMP_MED_SEC) clsDrop[0]![a]![ki]!++; }
          if (abs >= JUMP_BIG_SEC) {
            ge300[a]!++;
            clsN[1]![a]![ki]!++;
            clsAbs[1]![a]!.push(abs);
            if (isDep) {
              depGe300[a]!++;
              if (a === 0) {
                departLossBig.push(cClockLoss[prevIdx]!);
                departFactorBigDrop.push(cFactor[r]!);
              }
            }
            if (isStand) standGe300[a]!++;
            if (jmp <= -JUMP_BIG_SEC) clsDrop[1]![a]![ki]!++;
          }
          const isDrop = jmp <= -JUMP_BIG_SEC;
          if (isDrop) drops300[a]!++;
          if (a === 0) shippedIsDrop = isDrop;
          else {
            if (shippedIsDrop && !isDrop) dropRemoved[a]!++;
            if (!shippedIsDrop && isDrop) dropAdded[a]!++;
          }
          if (a === 0 && abs >= JUMP_BIG_SEC) {
            const d = cAnchor[r]! - cAnchor[prevIdx]!;
            // +1 is a legitimate stop advance; a large negative is the wrap
            // from the last stop of the loop back to the first.
            const fwd1 = d === 1 || d < -20;
            const same = d === 0;
            const ev = EVENTFUL_KINDS.has(kind);
            if (ev) bigDisp.push(disp);
            if (same) ev ? bigAnchor.eventfulSame++ : bigAnchor.eventlessSame++;
            else if (fwd1) ev ? bigAnchor.eventfulFwd1++ : bigAnchor.eventlessFwd1++;
            else ev ? bigAnchor.eventfulOther++ : bigAnchor.eventlessOther++;
          }
          if (a === 0 && abs >= JUMP_BIG_SEC && !EVENTFUL_KINDS.has(kind)) {
            if (cCalib[prevIdx] !== cCalib[r]) eventlessCalib++;
            if (cAnchor[prevIdx] !== cAnchor[r]) eventlessAnchor++;
            else if (at0 !== at1 || cAtStopId[prevIdx] !== cAtStopId[r]) eventlessFlag++;
            if (disp === 0) eventlessFrozenCoord++;
            if (eventlessBig.length < 40) {
              eventlessBig.push({
                t: fmtEt(t), time: new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }),
                bus: busNames[b], label: labels[cLabel[r]!], stop: net.stopById.get(s)?.name ?? s,
                kind, jump: Math.round(jmp), fromEta: Math.round(prevShown[0]!), toEta: Math.round(shown[0]!),
                dispM: Math.round(disp * 10) / 10, anchor: `${cAnchor[prevIdx]}->${cAnchor[r]}`,
                det: `${cDet[prevIdx]}->${cDet[r]}`, atStop: `${at0 ? cAtStopId[prevIdx] : "-"}->${at1 ? cAtStopId[r] : "-"}`,
                calibChanged: cCalib[prevIdx] !== cCalib[r],
              });
            }
          }
        }
      }
      for (let a = 0; a < NA; a++) prevShown[a] = shown[a]!;
      prevT = t;
      prevIdx = r;
    }
    i = j;
  }
}
log(`transitions ${nTrans}  departures ${nDep}  standing ${nStand}`);

// -- Statistics ---------------------------------------------------------------
function quantiles(a: number[]): Record<string, number> {
  if (a.length === 0) return { p50: NaN, p90: NaN, p99: NaN, p999: NaN };
  const s = Float64Array.from(a).sort();
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return Math.round((s[lo]! + (s[hi]! - s[lo]!) * (i - lo)) * 10) / 10;
  };
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), p999: q(0.999) };
}
const pctOfN = (x: number, n: number) => (n ? Math.round((1000 * x) / n) / 10 : NaN);

const result: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), hours: Math.round(((rawEnd - rawStart) / 3_600_000) * 10) / 10 },
  config: { MAX_K, POLL_STRIDE, JUMP_BIG_SEC, DEADBAND_M, SLEW_SEC },
  counts,
  replicaCheck: { maxAbsDiffSec: Math.round(maxReplicaDiff * 1000) / 1000, mismatched: counts.replicaMismatch, checked: counts.replicaChecked },
  transitions: nTrans,
  departures: nDep,
  standing: nStand,
  arms: {},
  classification: {},
};
for (let a = 0; a < NA; a++) {
  const name = ARMS[a]!.name;
  const e = accErr[a]!;
  let opt = 0;
  let pes = 0;
  for (const x of e) { if (x < -120) opt++; if (x > 120) pes++; }
  result.arms[name] = {
    jumps: { n: nTrans, ...quantiles(absJump[a]!), ge60: ge60[a], ge60Pct: pctOfN(ge60[a]!, nTrans), ge300: ge300[a], ge300Pct: pctOfN(ge300[a]!, nTrans), drops300: drops300[a] },
    layoverDeparture: { n: nDep, ...quantiles(absJumpDep[a]!), ge300: depGe300[a], ge300Pct: pctOfN(depGe300[a]!, nDep) },
    whileStanding: { n: nStand, ...quantiles(absJumpStand[a]!), ge300: standGe300[a], ge300Pct: pctOfN(standGe300[a]!, nStand) },
    accuracy: { ...metricsOf(e), optimisticGt2minPct: pctOfN(opt, e.length), pessimisticGt2minPct: pctOfN(pes, e.length) },
    frozenPct: pctOfN(freezeSame[a]!, freezeTot[a]!),
    countdownUpPct: pctOfN(freezeUp[a]!, freezeTot[a]!),
    riseP90: quantiles(risesByArm[a]!).p90,
    ...(a > 0 ? { vsShippedDrops300: { shipped: drops300[0], arm: drops300[a], removed: dropRemoved[a], added: dropAdded[a] } } : {}),
  };
  for (const [ti, thr] of [[0, JUMP_MED_SEC], [1, JUMP_BIG_SEC]] as const) {
    const byKind: Record<string, { n: number; drops: number }> = {};
    let eventful = 0;
    let eventless = 0;
    let eventfulDrops = 0;
    let eventlessDrops = 0;
    for (let k = 0; k < KINDS.length; k++) {
      const n = clsN[ti]![a]![k]!;
      if (n === 0) continue;
      byKind[KINDS[k]!] = { n, drops: clsDrop[ti]![a]![k]! };
      if (EVENTFUL_KINDS.has(KINDS[k]!)) { eventful += n; eventfulDrops += clsDrop[ti]![a]![k]!; }
      else { eventless += n; eventlessDrops += clsDrop[ti]![a]![k]!; }
    }
    const tot = eventful + eventless;
    (result.classification[name] ||= {})[`ge${thr}`] = {
      total: tot, eventful, eventless,
      eventfulPct: pctOfN(eventful, tot), eventlessPct: pctOfN(eventless, tot),
      eventfulDrops, eventlessDrops,
      ratePerTransitionPct: pctOfN(tot, nTrans),
      byKind,
    };
  }
}
result.creditBinding = {
  atStopObservations: creditBind.atStopRows,
  capBound: creditBind.capBound,
  capBoundPct: pctOfN(creditBind.capBound, creditBind.atStopRows),
  elapsedBound: creditBind.elapsedBound,
  meanElapsedSec: creditBind.atStopRows ? Math.round(creditBind.elapsedSum / creditBind.atStopRows) : NaN,
  meanCancellableSec: creditBind.atStopRows ? Math.round(creditBind.cancellableSum / creditBind.atStopRows) : NaN,
  ratioQuantiles: quantiles(creditBind.ratios),
};
result.standingClock = {
  pairs: clockStat.pairs,
  resets: clockStat.resets,
  resetPct: pctOfN(clockStat.resets, clockStat.pairs),
  lostSecQuantiles: quantiles(clockStat.resetLoss),
};
result.departureClockLoss = {
  n: departLoss.length,
  quantiles: quantiles(departLoss),
  anyLossPct: pctOfN(departLoss.filter((x) => x > 0).length, departLoss.length),
  bigJumpDepartures: { n: departLossBig.length, quantiles: quantiles(departLossBig), anyLossPct: pctOfN(departLossBig.filter((x) => x > 0).length, departLossBig.length) },
};
result.departureProration = {
  n: departFactor.length,
  factorQuantiles: quantiles(departFactor),
  under50Pct: pctOfN(departFactor.filter((x) => x < 0.5).length, departFactor.length),
  under80Pct: pctOfN(departFactor.filter((x) => x < 0.8).length, departFactor.length),
  bigJump: { n: departFactorBigDrop.length, factorQuantiles: quantiles(departFactorBigDrop), under50Pct: pctOfN(departFactorBigDrop.filter((x) => x < 0.5).length, departFactorBigDrop.length) },
};
result.bigJumpAnchor = bigAnchor;
result.bigJumpEventfulDispQuantiles = quantiles(bigDisp);
result.eventlessDetail = {
  n: result.classification.shipped.ge300.eventless,
  calibBoundary: eventlessCalib,
  anchorFlip: eventlessAnchor,
  atStopFlagOnly: eventlessFlag,
  frozenCoordinate: eventlessFrozenCoord,
  examples: eventlessBig,
};
result.caseStudy = { bus: CASE_BUS, stop: net.stopById.get(CASE_STOP)?.name ?? CASE_STOP, rows: caseRows };

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/${process.env.OUT_NAME ?? "lurch"}.json`, JSON.stringify(result, null, 1));
log(`wrote ${OUT_DIR}/${process.env.OUT_NAME ?? "lurch"}.json`);

// -- Console summary ----------------------------------------------------------
const pad = (s: unknown, n: number) => String(s).padEnd(n);
console.log("");
console.log(`window ${result.window.start} .. ${result.window.end} ET  (${result.window.hours} h)   transitions ${nTrans}`);
console.log(`replica: ${counts.replicaMismatch} mismatches in ${counts.replicaChecked} checks, worst ${result.replicaCheck.maxAbsDiffSec} s`);
console.log("");
console.log(pad("arm", 10), pad("p50", 6), pad("p90", 7), pad("p99", 8), pad("p99.9", 9), pad(">=60s", 16), pad(">=300s", 16), pad("frozen", 8), pad("up", 7), pad("medAE", 8), pad("opt>2m", 8), pad("pes>2m", 8));
for (const a of ARMS) {
  const r = result.arms[a.name];
  console.log(pad(a.name, 10), pad(r.jumps.p50, 6), pad(r.jumps.p90, 7), pad(r.jumps.p99, 8), pad(r.jumps.p999, 9),
    pad(`${r.jumps.ge60} (${r.jumps.ge60Pct}%)`, 16), pad(`${r.jumps.ge300} (${r.jumps.ge300Pct}%)`, 16),
    pad(`${r.frozenPct}%`, 8), pad(`${r.countdownUpPct}%`, 7), pad(r.accuracy.medianAbsSec, 8),
    pad(`${r.accuracy.optimisticGt2minPct}%`, 8), pad(`${r.accuracy.pessimisticGt2minPct}%`, 8));
}
console.log("");
console.log(`LAYOVER DEPARTURES (bus leaves a stop it was standing at), n = ${nDep}`);
for (const a of ARMS) {
  const r = result.arms[a.name].layoverDeparture;
  console.log(pad(a.name, 10), `p50 ${pad(r.p50, 8)} p90 ${pad(r.p90, 9)} p99 ${pad(r.p99, 9)} p99.9 ${pad(r.p999, 9)} >=300s ${r.ge300} (${r.ge300Pct}%)`);
}
console.log("");
console.log(`WHILE STANDING (both polls at the stop), n = ${nStand}`);
for (const a of ARMS) {
  const r = result.arms[a.name].whileStanding;
  console.log(pad(a.name, 10), `p50 ${pad(r.p50, 8)} p90 ${pad(r.p90, 9)} >=300s ${r.ge300} (${r.ge300Pct}%)`);
}
console.log("");
for (const a of ARMS) {
  const c = result.classification[a.name].ge300;
  console.log(`CLASSIFICATION |jump|>=300s  ${pad(a.name, 10)} total ${pad(c.total, 7)} eventful ${pad(`${c.eventful} (${c.eventfulPct}%)`, 16)} EVENTLESS ${c.eventless} (${c.eventlessPct}%)`);
}
console.log("");
console.log("shipped, by kind:");
for (const [k, v] of Object.entries(result.classification.shipped.ge300.byKind as Record<string, any>)) {
  console.log(`   ${pad(k, 18)} n ${pad(v.n, 8)} drops<=-300 ${v.drops}`);
}
console.log("   eventless detail:", JSON.stringify({ ...result.eventlessDetail, examples: undefined }));
console.log("   client anchor on big jumps:", JSON.stringify(result.bigJumpAnchor));
console.log("   eventful big-jump displacement:", JSON.stringify(result.bigJumpEventfulDispQuantiles), "m");
console.log("");
console.log("CREDIT BINDING (is arm A's cap even reached?):", JSON.stringify(result.creditBinding));
console.log("STANDING CLOCK (same stop, no movement):", JSON.stringify(result.standingClock));
console.log("CLOCK LOSS AT DEPARTURE:", JSON.stringify(result.departureClockLoss));
console.log("PRORATION STEP AT DEPARTURE:", JSON.stringify(result.departureProration));
console.log("");
console.log(`CASE STUDY ${CASE_BUS} -> ${result.caseStudy.stop} (${caseRows.length} polls)`);
for (const r of caseRows as any[]) {
  console.log(
    new Date(r.t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }),
    `k${r.k}`, `anc ${pad(r.anchor, 3)}`, `det ${pad(r.det, 3)}`, `at ${pad(r.atStopId, 5)}`,
    `stood ${pad(r.elapsed + "s", 7)}`, `dwellMed ${pad(r.dwellMed, 7)}`, `seg1 ${pad(Math.round(r.seg1Raw), 6)}`,
    `credit ${pad(r.applied, 6)}`, `f ${pad(r.factor, 6)}`,
    `lost ${pad(r.clockLoss + "s", 6)}`,
    `| ship ${pad(Math.round(r.shipped), 5)}`, `Acap ${pad(Math.round(r.Acap), 5)}`,
    `Asq ${pad(Math.round(r.Asq), 5)}`, `C ${pad(Math.round(r.Cclock), 5)}`,
    `D ${pad(Math.round(r.Dpro), 5)}`, `C+D ${pad(Math.round(r.CD), 5)}`, `AsqCD ${pad(Math.round(r.AsqCD), 5)}`,
    `| truth ${Number.isFinite(r.truth) ? Math.round((r.truth - r.t) / 1000) : "-"}`,
  );
}
