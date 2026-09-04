/**
 * rider-sim — the pure half. No database, no network, no client imports.
 *
 * Everything here is about ONE rider's wait: who the riders are, when the bus
 * actually reached them, how the sequence of numbers they were shown is
 * scored, and how thousands of such waits are summarised so "is it better
 * than yesterday" is answerable at a glance. The poll loop that produces the
 * ticks (the real client functions, the real detector, time-travelled
 * calibration) lives in run.ts; this file is what the unit tests cover.
 *
 * The scoring arithmetic is the canary's own (`scripts/canary-metrics.mjs`):
 * display buckets, the smallest movement two readings permit, the 180 s bar.
 * It is imported, not copied, so a simulated wait and a browser-watched wait
 * are judged by one rule.
 */
import {
  haversineM,
  parseBusEtaText,
  scoreSequence,
  THRESHOLDS,
} from "../../canary-metrics.mjs";

// -- positions ----------------------------------------------------------------

/** One capture row. Field names follow `raw_positions`, shortened. */
export interface PosRow {
  i: number; // bus_id
  b: string; // bus_name, "#309"
  r: number; // route_id
  lat: number;
  lon: number;
  h: number; // heading
  l: number | null; // last_stop_id
  t: number; // collected_at, epoch ms
}

export function parseCaptureLine(line: string): PosRow | null {
  const s = line.trim();
  if (!s) return null;
  let j: any;
  try { j = JSON.parse(s); } catch { return null; }
  if (typeof j.collected_at !== "number" || typeof j.lat !== "number" || typeof j.lon !== "number") return null;
  return {
    i: Number(j.bus_id), b: String(j.bus_name), r: Number(j.route_id),
    lat: j.lat, lon: j.lon, h: Number(j.heading ?? 0),
    l: j.last_stop_id == null ? null : Number(j.last_stop_id), t: j.collected_at,
  };
}

/**
 * The recorder writes a whole retention window into each new day's file
 * (`LAST=0` on a fresh file), so two consecutive captures overlap by up to six
 * hours. One row per (bus_id, collected_at), in time order.
 */
export function dedupeAndSort(rows: PosRow[]): PosRow[] {
  const seen = new Map<string, PosRow>();
  for (const r of rows) seen.set(`${r.i}|${r.t}`, r);
  return [...seen.values()].sort((a, b) => a.t - b.t || a.i - b.i);
}

/** Rows sharing a `collected_at` are one upstream poll. */
export function groupPolls(rows: PosRow[]): PosRow[][] {
  const polls: PosRow[][] = [];
  let cur: PosRow[] = [];
  let at = NaN;
  for (const r of rows) {
    if (r.t !== at) {
      if (cur.length) polls.push(cur);
      cur = [];
      at = r.t;
    }
    cur.push(r);
  }
  if (cur.length) polls.push(cur);
  return polls;
}

// -- truth: when a bus actually reached a stop ---------------------------------

/** Same two radii as the canary: inside 45 m is "arrived", re-arm past 120 m. */
export const ARRIVAL_M = 45;
export const REARM_M = 120;

export interface StopVisit {
  enter: number;
  /** null when the data ends with the bus still inside the radius. */
  exit: number | null;
  busName: string;
  routeId: number;
}

export type LatLon = { lat: number; lon: number };

/**
 * Every (bus, stop) approach in the data, as an interval inside the 45 m
 * radius, keyed by stop. Only stops on the bus's own route are watched, so a
 * Red bus passing a Blue-only stop is not a Blue arrival.
 */
export function stopVisits(
  rows: readonly PosRow[],
  stopsForRoute: (routeId: number) => readonly number[],
  stopCoords: Record<number, LatLon>,
): Map<number, StopVisit[]> {
  const byBus = new Map<string, PosRow[]>();
  for (const r of rows) {
    let l = byBus.get(r.b);
    if (!l) byBus.set(r.b, (l = []));
    l.push(r);
  }
  const out = new Map<number, StopVisit[]>();
  for (const [busName, track] of byBus) {
    // near-state per (route, stop) — a bus can change route mid-day
    const open = new Map<string, StopVisit>();
    for (const p of track) {
      const stops = stopsForRoute(p.r);
      const seen = new Set<number>();
      for (const sid of stops) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        const c = stopCoords[sid];
        if (!c) continue;
        const d = haversineM(p, c);
        const key = `${p.r}|${sid}`;
        const cur = open.get(key);
        if (!cur && d <= ARRIVAL_M) {
          const v: StopVisit = { enter: p.t, exit: null, busName, routeId: p.r };
          open.set(key, v);
          let l = out.get(sid);
          if (!l) out.set(sid, (l = []));
          l.push(v);
        } else if (cur && d > REARM_M) {
          cur.exit = p.t;
          open.delete(key);
        }
      }
    }
  }
  for (const l of out.values()) l.sort((a, b) => a.enter - b.enter);
  return out;
}

export type Truth =
  | { kind: "arrived"; at: number; busName: string }
  | { kind: "boardedOnArrival"; busName: string }
  | { kind: "none" };

/**
 * The first bus of the line to reach the stop after the rider got there. A
 * bus already inside the radius when the rider arrives is a wait of zero —
 * the app says "arriving now" and there is no countdown to judge — so it is
 * reported separately rather than scored.
 */
export function truthFor(
  visits: readonly StopVisit[] | undefined,
  busRouteIds: readonly number[],
  t0: number,
  maxWaitMs: number,
  /** Ignore a bus already inside the radius at t0 and wait for the NEXT approach (the canary's arming). */
  armed = false,
): Truth {
  if (!visits) return { kind: "none" };
  if (!armed) {
    for (const v of visits) {
      if (!busRouteIds.includes(v.routeId)) continue;
      if (v.enter <= t0 && (v.exit === null || v.exit > t0)) return { kind: "boardedOnArrival", busName: v.busName };
    }
  }
  for (const v of visits) {
    if (!busRouteIds.includes(v.routeId)) continue;
    if (v.enter <= t0) continue;
    if (v.enter - t0 > maxWaitMs) break;
    return { kind: "arrived", at: v.enter, busName: v.busName };
  }
  return { kind: "none" };
}

// -- riders -------------------------------------------------------------------

export type RiderSource = "uniform" | "targeted" | "named" | "chain";

export interface RiderSpec {
  id: string;
  label: string;
  boardStopId: number;
  alightStopId: number;
  /** When the rider reaches the stop and opens the app, epoch ms. */
  t0: number;
  source: RiderSource;
  /** For targeted riders: the event they were placed to witness. */
  why?: string;
  /**
   * Where the rider actually stands. Omitted, they are AT the stop (walk 0).
   * The canary's rider is NOT: its geolocation is Prospect / Canner, 83 m from
   * Red's board stop and ~200 m from Brown's, so the app bills a walk and
   * decides catchability against it — which is what produced "in 1 min" then
   * "in 56 min" at 77 m out (the app judged, by its own rule, that a rider
   * three minutes away could not catch a bus 24 s away, and re-pinned the same
   * vehicle a lap later). Reproducing that needs the origin.
   */
  origin?: LatLon;
  /**
   * Chain riders: the departure they were placed to witness — when the bus
   * they are downstream of left its layover stop, and which bus. The
   * departure-moment score keys on it.
   */
  eventT?: number;
  eventBus?: string;
}

export const riderId = (label: string, stop: number, t0: number): string =>
  `${label}|${stop}|${new Date(t0).toISOString()}`;

/** Below this the planner would rightly answer "walk". Same as the canary. */
export const MIN_RIDE_M = 500;

/**
 * A destination for the plan: roughly a quarter of the loop ahead, the first
 * stop at least MIN_RIDE_M away (wrapping), else the farthest stop. The ride
 * leg never touches the countdown; the destination exists so the real planner
 * can produce the option the rider is looking at.
 */
export function chooseAlight(
  stops: readonly number[],
  boardIdx: number,
  stopCoords: Record<number, LatLon>,
): number | null {
  const N = stops.length;
  const board = stopCoords[stops[boardIdx]!];
  if (!board || N < 2) return null;
  let far: { sid: number; d: number } | null = null;
  for (let k = Math.max(1, Math.round(N / 4)); k < N; k++) {
    const sid = stops[(boardIdx + k) % N]!;
    const c = stopCoords[sid];
    if (!c) continue;
    const d = haversineM(board, c);
    if (d >= MIN_RIDE_M) return sid;
    if (!far || d > far.d) far = { sid, d };
  }
  return far?.sid ?? null;
}

/**
 * `Red@48@2026-09-03T21:18:03Z` — label, board stop id, arrival instant;
 * optionally `@lat,lon` for where the rider stands (default: at the stop).
 */
export function parseRiderArg(s: string): { label: string; boardStopId: number; t0: number; origin?: LatLon } {
  const m = s.match(/^([^@]+)@(\d+)@([^@]+)(?:@(-?[\d.]+),(-?[\d.]+))?$/);
  if (!m) throw new Error(`bad --rider "${s}" (want Label@stopId@ISO[@lat,lon])`);
  const t0 = Date.parse(m[3]!);
  if (!Number.isFinite(t0)) throw new Error(`bad time in --rider "${s}"`);
  const out: { label: string; boardStopId: number; t0: number; origin?: LatLon } = { label: m[1]!, boardStopId: Number(m[2]), t0 };
  if (m[4] !== undefined) out.origin = { lat: Number(m[4]), lon: Number(m[5]) };
  return out;
}

// -- one rider's screen, poll by poll ------------------------------------------

export type TickState =
  /** the collapsed row shows "🚌 …" */
  | "countdown"
  /** the option is on the list marked Departed; no countdown */
  | "departed"
  /** the option is on the list but the pinned bus has no valid anchor, so the row shows no countdown */
  | "nopin"
  /** the plan offers no option for this line at all */
  | "nooption";

export interface Tick {
  t: number;
  state: TickState;
  /** The "🚌 …" text without the emoji, exactly as `fmtBusPair` printed it, or null. */
  token: string | null;
  etaSec: number | null;
  nextSec: number | null;
  /** Vehicle the option is following this poll (the app's `busName`). */
  bus: string | null;
  /** "🚌 You can't catch #X" is on the card. */
  missedBus: string | null;
}

export interface Transition {
  atMs: number;
  dtSec: number;
  driftSec: number;
  from: string;
  to: string;
  reversal: boolean;
  notable: boolean;
  catastrophic: boolean;
  pinAnnouncedChange: boolean;
  /** Vehicle before / after, from the ticks. */
  busFrom: string | null;
  busTo: string | null;
}

export interface WaitResult {
  id: string;
  label: string;
  boardStopId: number;
  alightStopId: number;
  t0: number;
  source: RiderSource;
  why?: string;
  eventBus?: string;
  /** How the wait ended. */
  outcome: "arrived" | "gaveUp" | "dataEnded";
  /**
   * A bus of this line was already at the stop (inside 45 m) when the rider
   * arrived. The app rightly says "arriving now"; the wait scored here is for
   * the NEXT approach, as the canary arms it, and such waits are reported
   * separately.
   */
  busAtStopOnArrival: string | null;
  /** Bus that reached the stop (curb rule), and when. */
  arrivedAt: number | null;
  arrivedBus: string | null;
  /** The detector's own arrival event for that bus at that stop, if any. */
  detectorArrivedAt: number | null;
  waitSec: number | null;
  ticks: number;
  readings: number;
  /** First countdown shown: when, text, and the bucket [lo, hi) in seconds. */
  firstSight: { atMs: number; raw: string; lo: number; hi: number } | null;
  /**
   * Arrival relative to the first promise window, seconds. 0 = inside the
   * window; NEGATIVE = the bus came EARLIER than promised (the direction that
   * strands a rider who trusted the number); positive = later.
   */
  firstSightMissSec: number | null;
  transitions: Transition[];
  reversals: number;
  notableReversals: number;
  catastrophic: number;
  worstDriftSec: number;
  /** The single largest-magnitude transition, signed. */
  worst: Transition | null;
  /** Vehicles the row followed, in order of first appearance. */
  pins: string[];
  pinChanged: boolean;
  /** Countdown episodes that ended in Departed / no countdown / no option. */
  vanished: number;
  /** ...and a countdown came back afterwards. */
  returned: boolean;
  /** Same vehicle, countdown rose by a lap (>= 10 min) — the app re-priced it a lap later. */
  lapRepriced: boolean;
  /**
   * The operator's complaint, as a flag: a DOWNWARD jump larger than the
   * countdown left after it, with the bus then arriving within two minutes.
   * "Told 7, then 2, gone in 66 s."
   */
  strand: boolean;
  /** Any jump at least as large as the number that was on screen before it. */
  overshoot: boolean;
  /** Countdown was never shown at all during the wait. */
  neverShown: boolean;
  /** Compressed sequence for humans: "21:21:40 in 9, 23 min | …". */
  sequence: string;
  /**
   * Chain riders only: what the countdown did when the bus left its layover
   * stop. `rise*` is the raw ETA's movement beyond the clock (eta(t) − eta(t₀)
   * + elapsed, seconds; positive = the promise got LATER) at the first poll at
   * or after the departure, then ~30 s and ~60 s after it — the same shape as
   * the production departure-cliff measurement (+16 / +115 / +151 s). `drift`
   * is the DISPLAYED transition at the departure poll, canary-scored.
   */
  departure?: { eventT: number; watching: boolean; riseAt0: number | null; riseAt30: number | null; riseAt60: number | null; drift: number };
}

export const STRAND_ARRIVE_WITHIN_SEC = 120;
/**
 * The smallest drop that counts as a strand. "3 min" -> "<1 min" is a 115 s
 * correction at most and the ordinary end of an approach on a bus that beat
 * its segment average; two full display minutes is where a rider who
 * stepped away on the strength of the number starts losing the bus.
 */
export const STRAND_MIN_DROP_SEC = 120;
export const LAP_REPRICE_SEC = 600;

const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

export function fmtSequence(ticks: readonly Tick[]): string {
  const parts: string[] = [];
  let last: string | null = null;
  for (const k of ticks) {
    const tok = k.state === "countdown" ? (k.token ?? "?") : k.state === "departed" ? "Departed" : k.state === "nopin" ? "(no countdown)" : "(no option)";
    if (tok !== last) {
      parts.push(`${hhmmss(k.t)} ${tok}`);
      last = tok;
    }
  }
  return parts.join(" | ");
}

/** Keep one tick per `sampleMs` from t0 — the canary reads every 15 s, the screen re-renders every poll. */
export function subsample(ticks: readonly Tick[], t0: number, sampleMs: number): Tick[] {
  if (sampleMs <= 0) return [...ticks];
  const out: Tick[] = [];
  let nextAt = t0;
  for (const k of ticks) {
    if (k.t < nextAt) continue;
    out.push(k);
    nextAt = k.t + sampleMs - 1; // the next tick at least sampleMs later (polls are ~5 s, never exact)
  }
  return out;
}

export interface ScoreOpts {
  sampleMs: number;
  thresholds?: typeof THRESHOLDS;
}

export function scoreWait(
  spec: RiderSpec,
  allTicks: readonly Tick[],
  truth: Truth,
  detectorArrivedAt: number | null,
  outcome: WaitResult["outcome"],
  opts: ScoreOpts,
  busAtStopOnArrival: string | null = null,
): WaitResult {
  const th = opts.thresholds ?? THRESHOLDS;
  const ticks = subsample(allTicks, spec.t0, opts.sampleMs);
  const samples = ticks.map((k) => ({
    atMs: k.t,
    present: k.state !== "nooption",
    eta: k.state === "countdown" && k.token ? parseBusEtaText(k.token) : null,
    missedBus: k.missedBus,
    departed: k.state === "departed",
    // The simulator KNOWS the pinned vehicle, so `scoreSequence` pairs slot 0
    // by identity instead of falling back to nearest-ETA the way the live
    // canary has to. That is what keeps "the same bus re-priced a lap later"
    // a drift of a lap rather than one bus leaving and another joining.
    busName: k.bus,
  }));
  const seq = scoreSequence(samples, th);
  // attach vehicles to each transition
  const byAt = new Map<number, number>();
  ticks.forEach((k, i) => byAt.set(k.t, i));
  const transitions: Transition[] = seq.transitions.map((t: any) => {
    const i = byAt.get(t.atMs) ?? -1;
    let j = i - 1;
    while (j >= 0 && ticks[j]!.state !== "countdown") j--;
    // Only slot 0 is the pinned vehicle. A reading holds up to two buses and
    // scoring now reports a drift for each, so naming the pin on the SECOND
    // one would credit the bus-after-the-pinned-one's movement to the bus the
    // rider is waiting for — and `lapRepriced` keys on exactly that name.
    const pinned = t.fromSlot === 0 && t.toSlot === 0;
    return {
      ...t,
      busFrom: pinned && j >= 0 ? ticks[j]!.bus : null,
      busTo: pinned && i >= 0 ? ticks[i]!.bus : null,
    };
  });

  const arrivedAt = truth.kind === "arrived" ? truth.at : null;
  const arrivedBus = truth.kind === "arrived" || truth.kind === "boardedOnArrival" ? truth.busName : null;

  let firstSight: WaitResult["firstSight"] = null;
  for (let i = 0; i < ticks.length; i++) {
    const s = samples[i]!;
    if (s.eta) {
      firstSight = { atMs: s.atMs, raw: s.eta.raw, lo: s.eta.first[0]!, hi: s.eta.first[1]! };
      break;
    }
  }
  let firstSightMissSec: number | null = null;
  if (firstSight && arrivedAt !== null) {
    const lo = firstSight.atMs + firstSight.lo * 1000;
    const hi = firstSight.atMs + firstSight.hi * 1000;
    firstSightMissSec = arrivedAt < lo ? Math.round((arrivedAt - lo) / 1000) : arrivedAt > hi ? Math.round((arrivedAt - hi) / 1000) : 0;
  }

  const pins: string[] = [];
  for (const k of ticks) if (k.state === "countdown" && k.bus && !pins.includes(k.bus)) pins.push(k.bus);

  let vanished = 0;
  let returned = false;
  let sawCountdown = false;
  let inGap = false;
  for (const k of ticks) {
    if (k.state === "countdown") {
      if (inGap) returned = true;
      sawCountdown = true;
      inGap = false;
    } else if (sawCountdown && !inGap) {
      vanished++;
      inGap = true;
    }
  }

  let worst: Transition | null = null;
  let strand = false;
  let overshoot = false;
  let lapRepriced = false;
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i]!;
    if (!worst || Math.abs(t.driftSec) > Math.abs(worst.driftSec)) worst = t;
    const after = parseBusEtaText(t.to);
    const before = parseBusEtaText(t.from);
    if (after && before) {
      const afterHi = after.first[1]!;
      const beforeLo = before.first[0]!;
      if (t.driftSec <= -STRAND_MIN_DROP_SEC && -t.driftSec > afterHi && arrivedAt !== null && arrivedAt - t.atMs <= STRAND_ARRIVE_WITHIN_SEC * 1000 && arrivedAt >= t.atMs) strand = true;
      if (Math.abs(t.driftSec) >= Math.max(60, beforeLo)) overshoot = true;
    }
    if (t.driftSec >= LAP_REPRICE_SEC && t.busFrom && t.busFrom === t.busTo) lapRepriced = true;
  }

  const waitSec = arrivedAt !== null ? Math.round((arrivedAt - spec.t0) / 1000) : null;
  const worstDriftSec: number = seq.worstDriftSec ?? 0;
  let departure: WaitResult["departure"];
  if (spec.eventT !== undefined) {
    const T = spec.eventT;
    // the last countdown the rider saw before the departure, same pinned bus
    let before: Tick | null = null;
    for (const k of allTicks) { if (k.t >= T) break; if (k.state === "countdown" && k.etaSec !== null) before = k; }
    const at = (offsetSec: number): number | null => {
      if (!before) return null;
      const k = allTicks.find((x) => x.t >= T + offsetSec * 1000);
      if (!k || k.state !== "countdown" || k.etaSec === null || k.bus !== before!.bus) return null;
      return Math.round(k.etaSec - before.etaSec! + (k.t - before.t) / 1000);
    };
    const dep = transitions.find((t) => t.atMs >= T && t.atMs <= T + 10_000);
    departure = { eventT: T, watching: !!before && !!allTicks.find((x) => x.t >= T && x.state === "countdown"), riseAt0: at(0), riseAt30: at(30), riseAt60: at(60), drift: dep ? dep.driftSec : 0 };
  }
  return {
    id: spec.id, label: spec.label, boardStopId: spec.boardStopId, alightStopId: spec.alightStopId, t0: spec.t0,
    source: spec.source, ...(spec.why ? { why: spec.why } : {}),
    ...(spec.eventBus ? { eventBus: spec.eventBus } : {}),
    outcome, busAtStopOnArrival, arrivedAt, arrivedBus, detectorArrivedAt, waitSec,
    ticks: allTicks.length, readings: seq.readings,
    firstSight, firstSightMissSec,
    transitions, reversals: seq.reversals, notableReversals: seq.notableReversals, catastrophic: seq.catastrophic,
    worstDriftSec, worst,
    pins, pinChanged: pins.length > 1,
    vanished, returned, lapRepriced, strand, overshoot,
    neverShown: !sawCountdown,
    sequence: fmtSequence(ticks),
    ...(departure ? { departure } : {}),
  };
}

// -- aggregation ----------------------------------------------------------------

export interface GroupSummary {
  waits: number;
  arrived: number;
  gaveUp: number;
  dataEnded: number;
  boardedOnArrival: number;
  /** Of the waits that were scored (arrived + a countdown was shown). */
  scored: number;
  medianWaitMin: number | null;
  p90WaitMin: number | null;
  firstSight: { medianAbsSec: number | null; p90AbsSec: number | null; earlyOver60Pct: number | null; lateOver60Pct: number | null };
  pctJump180: number;
  pctJump300: number;
  pctReversal60: number;
  pctStrand: number;
  pctOvershoot: number;
  pctPinChanged: number;
  pctVanished: number;
  pctLapRepriced: number;
  pctNeverShown: number;
  worstDrift: { p50: number | null; p90: number | null; max: number | null };
}

export interface Summary {
  all: GroupSummary;
  byRoute: Record<string, GroupSummary>;
  worstStops: Array<{ key: string; label: string; stopId: number; waits: number; pctJump180: number; pctStrand: number }>;
  worstWaits: Array<{ id: string; label: string; stopId: number; worstDriftSec: number; strand: boolean; outcome: string; sequence: string }>;
}

export function pct(xs: ArrayLike<number>, q: number): number | null {
  const s = Float64Array.from(xs).sort();
  if (s.length === 0) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const share = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

export function summarise(waits: readonly WaitResult[]): GroupSummary {
  const arrived = waits.filter((w) => w.outcome === "arrived" && !w.busAtStopOnArrival);
  const scored = arrived.filter((w) => !w.neverShown);
  const miss = scored.map((w) => w.firstSightMissSec).filter((x): x is number => x !== null);
  const worst = scored.map((w) => w.worstDriftSec);
  return {
    waits: waits.length,
    arrived: arrived.length,
    gaveUp: waits.filter((w) => w.outcome === "gaveUp").length,
    dataEnded: waits.filter((w) => w.outcome === "dataEnded").length,
    boardedOnArrival: waits.filter((w) => !!w.busAtStopOnArrival).length,
    scored: scored.length,
    medianWaitMin: r1(pct(arrived.map((w) => w.waitSec! / 60), 0.5)),
    p90WaitMin: r1(pct(arrived.map((w) => w.waitSec! / 60), 0.9)),
    firstSight: {
      medianAbsSec: r1(pct(miss.map(Math.abs), 0.5)),
      p90AbsSec: r1(pct(miss.map(Math.abs), 0.9)),
      earlyOver60Pct: miss.length ? share(miss.filter((m) => m < -60).length, miss.length) : null,
      lateOver60Pct: miss.length ? share(miss.filter((m) => m > 60).length, miss.length) : null,
    },
    pctJump180: share(scored.filter((w) => w.worstDriftSec >= 180).length, scored.length),
    pctJump300: share(scored.filter((w) => w.worstDriftSec >= 300).length, scored.length),
    pctReversal60: share(scored.filter((w) => w.notableReversals > 0).length, scored.length),
    pctStrand: share(scored.filter((w) => w.strand).length, scored.length),
    pctOvershoot: share(scored.filter((w) => w.overshoot).length, scored.length),
    pctPinChanged: share(scored.filter((w) => w.pinChanged).length, scored.length),
    pctVanished: share(scored.filter((w) => w.vanished > 0).length, scored.length),
    pctLapRepriced: share(scored.filter((w) => w.lapRepriced).length, scored.length),
    pctNeverShown: share(arrived.filter((w) => w.neverShown).length, arrived.length),
    worstDrift: { p50: r1(pct(worst, 0.5)), p90: r1(pct(worst, 0.9)), max: worst.length ? Math.max(...worst) : null },
  };
}

export function aggregate(waits: readonly WaitResult[]): Summary {
  const byRoute: Record<string, GroupSummary> = {};
  const labels = [...new Set(waits.map((w) => w.label))].sort();
  for (const l of labels) byRoute[l] = summarise(waits.filter((w) => w.label === l));
  const byStop = new Map<string, WaitResult[]>();
  for (const w of waits) {
    const k = `${w.label}|${w.boardStopId}`;
    let l = byStop.get(k);
    if (!l) byStop.set(k, (l = []));
    l.push(w);
  }
  const worstStops = [...byStop.entries()]
    .map(([key, ws]) => {
      const s = summarise(ws);
      return { key, label: ws[0]!.label, stopId: ws[0]!.boardStopId, waits: s.scored, pctJump180: s.pctJump180, pctStrand: s.pctStrand };
    })
    .filter((x) => x.waits >= 3)
    .sort((a, b) => b.pctJump180 - a.pctJump180 || b.pctStrand - a.pctStrand)
    .slice(0, 15);
  const worstWaits = [...waits]
    .filter((w) => w.outcome === "arrived" && !w.neverShown && !w.busAtStopOnArrival)
    .sort((a, b) => b.worstDriftSec - a.worstDriftSec)
    .slice(0, 10)
    .map((w) => ({ id: w.id, label: w.label, stopId: w.boardStopId, worstDriftSec: w.worstDriftSec, strand: w.strand, outcome: w.outcome, sequence: w.sequence }));
  return { all: summarise(waits), byRoute, worstStops, worstWaits };
}

const padR = (s: unknown, n: number) => String(s).padEnd(n);
const padL = (s: unknown, n: number) => String(s).padStart(n);

// -- the chain: riders downstream of one layover stop -----------------------------

export interface ChainSummary {
  stops: Array<{ stopId: number; hops: number } & GroupSummary>;
  departure: {
    n: number;
    watching: number;
    riseAt0: { p50: number | null; mean: number | null; n: number };
    riseAt30: { p50: number | null; mean: number | null; n: number };
    riseAt60: { p50: number | null; mean: number | null; n: number };
    displayedDrift: { p50: number | null; p90: number | null; max: number | null; over180: number; over300: number };
    byStop: Record<string, { n: number; riseAt0: number | null; riseAt30: number | null; riseAt60: number | null; driftP90: number | null; over180: number }>;
  };
}

export function chainSummary(waits: readonly WaitResult[], chainStops: readonly number[]): ChainSummary {
  const stops = chainStops.map((stopId, i) => ({ stopId, hops: i + 1, ...summarise(waits.filter((w) => w.boardStopId === stopId)) }));
  const withDep = waits.filter((w) => w.departure && w.outcome === "arrived" && !w.busAtStopOnArrival);
  const watching = withDep.filter((w) => w.departure!.watching);
  const stat = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return { p50: r1(pct(v, 0.5)), mean: v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null, n: v.length };
  };
  const drifts = watching.map((w) => w.departure!.drift);
  const byStop: ChainSummary["departure"]["byStop"] = {};
  for (const sid of chainStops) {
    const ws = watching.filter((w) => w.boardStopId === sid);
    const d = ws.map((w) => w.departure!.drift);
    byStop[String(sid)] = {
      n: ws.length,
      riseAt0: stat(ws.map((w) => w.departure!.riseAt0)).p50,
      riseAt30: stat(ws.map((w) => w.departure!.riseAt30)).p50,
      riseAt60: stat(ws.map((w) => w.departure!.riseAt60)).p50,
      driftP90: r1(pct(d.map(Math.abs), 0.9)),
      over180: d.filter((x) => Math.abs(x) >= 180).length,
    };
  }
  return {
    stops,
    departure: {
      n: withDep.length,
      watching: watching.length,
      riseAt0: stat(watching.map((w) => w.departure!.riseAt0)),
      riseAt30: stat(watching.map((w) => w.departure!.riseAt30)),
      riseAt60: stat(watching.map((w) => w.departure!.riseAt60)),
      displayedDrift: { p50: r1(pct(drifts.map(Math.abs), 0.5)), p90: r1(pct(drifts.map(Math.abs), 0.9)), max: drifts.length ? Math.max(...drifts.map(Math.abs)) : null, over180: drifts.filter((x) => Math.abs(x) >= 180).length, over300: drifts.filter((x) => Math.abs(x) >= 300).length },
      byStop,
    },
  };
}

export function renderChain(title: string, c: ChainSummary, stopName: (id: number) => string): string {
  const out: string[] = [title];
  out.push(`  ${padR("stop", 26)}${padL("hops", 5)}${padL("scored", 7)}${padL("wait", 6)}${padL("miss", 6)}${padL("early", 6)}${padL("j180", 6)}${padL("j300", 6)}${padL("rev", 6)}${padL("strand", 7)}${padL("pin", 6)}${padL("p90dr", 7)}`);
  for (const s of c.stops) {
    out.push(`  ${padR(`${stopName(s.stopId)} (${s.stopId})`, 26)}${padL(s.hops, 5)}${padL(s.scored, 7)}${padL(s.medianWaitMin ?? "-", 6)}${padL(s.firstSight.medianAbsSec ?? "-", 6)}${padL(s.firstSight.earlyOver60Pct ?? "-", 6)}${padL(s.pctJump180, 6)}${padL(s.pctJump300, 6)}${padL(s.pctReversal60, 6)}${padL(s.pctStrand, 7)}${padL(s.pctPinChanged, 6)}${padL(s.worstDrift.p90 ?? "-", 7)}`);
  }
  const d = c.departure;
  out.push(`  departure moment (${d.watching} of ${d.n} chain riders were watching the bus when it left): raw ETA beyond the clock at +0 s p50 ${d.riseAt0.p50} (mean ${d.riseAt0.mean}, n ${d.riseAt0.n}); +30 s p50 ${d.riseAt30.p50} (mean ${d.riseAt30.mean}); +60 s p50 ${d.riseAt60.p50} (mean ${d.riseAt60.mean})`);
  out.push(`  displayed drift at the departure poll: p50 ${d.displayedDrift.p50} s, p90 ${d.displayedDrift.p90} s, max ${d.displayedDrift.max} s; >=180 s on ${d.displayedDrift.over180}, >=300 s on ${d.displayedDrift.over300}`);
  out.push(`  ${padR("per stop", 26)}${padL("n", 5)}${padL("+0s", 7)}${padL("+30s", 7)}${padL("+60s", 7)}${padL("p90dr", 7)}${padL(">=180", 6)}`);
  for (const [sid, x] of Object.entries(d.byStop)) out.push(`  ${padR(`${stopName(Number(sid))} (${sid})`, 26)}${padL(x.n, 5)}${padL(x.riseAt0 ?? "-", 7)}${padL(x.riseAt30 ?? "-", 7)}${padL(x.riseAt60 ?? "-", 7)}${padL(x.driftP90 ?? "-", 7)}${padL(x.over180, 6)}`);
  return out.join("\n");
}

// -- paired comparison of two runs ----------------------------------------------

export interface Compare {
  paired: number;
  onlyA: number;
  onlyB: number;
  jump180: { both: number; onlyA: number; onlyB: number; neither: number };
  strand: { both: number; onlyA: number; onlyB: number; neither: number };
  reversal60: { both: number; onlyA: number; onlyB: number; neither: number };
  /** b.worstDrift - a.worstDrift over paired scored waits */
  worstDriftDelta: { p10: number | null; p50: number | null; p90: number | null; improved: number; worsened: number; same: number };
  firstSightAbsMissDelta: { p50: number | null; improved: number; worsened: number };
  examples: { fixed: string[]; introduced: string[] };
}

export function compareRuns(a: readonly WaitResult[], b: readonly WaitResult[]): Compare {
  const ma = new Map(a.map((w) => [w.id, w]));
  const mb = new Map(b.map((w) => [w.id, w]));
  const ids = [...ma.keys()].filter((id) => mb.has(id));
  const scored = ids.filter((id) => ma.get(id)!.outcome === "arrived" && mb.get(id)!.outcome === "arrived" && !ma.get(id)!.neverShown && !mb.get(id)!.neverShown && !ma.get(id)!.busAtStopOnArrival);
  const quad = (f: (w: WaitResult) => boolean) => {
    const q = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
    for (const id of scored) {
      const x = f(ma.get(id)!), y = f(mb.get(id)!);
      if (x && y) q.both++; else if (x) q.onlyA++; else if (y) q.onlyB++; else q.neither++;
    }
    return q;
  };
  const dd = scored.map((id) => mb.get(id)!.worstDriftSec - ma.get(id)!.worstDriftSec);
  const fs = scored
    .filter((id) => ma.get(id)!.firstSightMissSec !== null && mb.get(id)!.firstSightMissSec !== null)
    .map((id) => Math.abs(mb.get(id)!.firstSightMissSec!) - Math.abs(ma.get(id)!.firstSightMissSec!));
  const j = (w: WaitResult) => w.worstDriftSec >= 180;
  return {
    paired: ids.length,
    onlyA: a.length - ids.length,
    onlyB: b.length - ids.length,
    jump180: quad(j),
    strand: quad((w) => w.strand),
    reversal60: quad((w) => w.notableReversals > 0),
    worstDriftDelta: {
      p10: r1(pct(dd, 0.1)), p50: r1(pct(dd, 0.5)), p90: r1(pct(dd, 0.9)),
      improved: dd.filter((x) => x < 0).length, worsened: dd.filter((x) => x > 0).length, same: dd.filter((x) => x === 0).length,
    },
    firstSightAbsMissDelta: { p50: r1(pct(fs, 0.5)), improved: fs.filter((x) => x < 0).length, worsened: fs.filter((x) => x > 0).length },
    examples: {
      fixed: scored.filter((id) => j(ma.get(id)!) && !j(mb.get(id)!)).slice(0, 5),
      introduced: scored.filter((id) => !j(ma.get(id)!) && j(mb.get(id)!)).slice(0, 5),
    },
  };
}

// -- console rendering ----------------------------------------------------------

export function renderSummary(title: string, s: Summary): string {
  const out: string[] = [];
  const g = s.all;
  out.push(`${title}`);
  out.push(`  waits ${g.waits}: arrived ${g.arrived}, gave up ${g.gaveUp}, data ended ${g.dataEnded}, boarded on arrival ${g.boardedOnArrival}; scored ${g.scored}`);
  out.push(`  wait median ${g.medianWaitMin} min, p90 ${g.p90WaitMin} min; first promise |miss| median ${g.firstSight.medianAbsSec} s, p90 ${g.firstSight.p90AbsSec} s (early>60 s ${g.firstSight.earlyOver60Pct}%, late>60 s ${g.firstSight.lateOver60Pct}%)`);
  out.push(`  riders who saw: jump>=180 s ${g.pctJump180}% | jump>=300 s ${g.pctJump300}% | reversal>=60 s ${g.pctReversal60}% | STRAND ${g.pctStrand}% | overshoot ${g.pctOvershoot}% | pin changed ${g.pctPinChanged}% | countdown vanished ${g.pctVanished}% | lap re-priced ${g.pctLapRepriced}% | never shown ${g.pctNeverShown}%`);
  out.push(`  worst drift per wait: p50 ${g.worstDrift.p50} s, p90 ${g.worstDrift.p90} s, max ${g.worstDrift.max} s`);
  out.push(`  ${padR("route", 14)}${padL("scored", 7)}${padL("wait", 6)}${padL("miss", 6)}${padL("j180", 6)}${padL("j300", 6)}${padL("rev", 6)}${padL("strand", 7)}${padL("pin", 6)}${padL("vanish", 7)}${padL("lap", 6)}${padL("p90dr", 7)}`);
  for (const [label, r] of Object.entries(s.byRoute)) {
    out.push(`  ${padR(label, 14)}${padL(r.scored, 7)}${padL(r.medianWaitMin ?? "-", 6)}${padL(r.firstSight.medianAbsSec ?? "-", 6)}${padL(r.pctJump180, 6)}${padL(r.pctJump300, 6)}${padL(r.pctReversal60, 6)}${padL(r.pctStrand, 7)}${padL(r.pctPinChanged, 6)}${padL(r.pctVanished, 7)}${padL(r.pctLapRepriced, 6)}${padL(r.worstDrift.p90 ?? "-", 7)}`);
  }
  if (s.worstStops.length) {
    out.push(`  worst stops (>=3 scored waits): ` + s.worstStops.slice(0, 8).map((x) => `${x.label}@${x.stopId} ${x.pctJump180}%/${x.pctStrand}% (${x.waits})`).join("; "));
  }
  for (const w of s.worstWaits.slice(0, 5)) out.push(`  worst: ${w.id} drift ${w.worstDriftSec} s${w.strand ? " STRAND" : ""}: ${w.sequence.slice(0, 400)}`);
  return out.join("\n");
}

export function renderCompare(c: Compare, nameA: string, nameB: string): string {
  const q = (x: { both: number; onlyA: number; onlyB: number; neither: number }) => `both ${x.both}, only ${nameA} ${x.onlyA}, only ${nameB} ${x.onlyB}, neither ${x.neither}`;
  return [
    `paired waits ${c.paired} (only ${nameA} ${c.onlyA}, only ${nameB} ${c.onlyB})`,
    `  jump>=180 s: ${q(c.jump180)}`,
    `  strand:      ${q(c.strand)}`,
    `  reversal>=60 s: ${q(c.reversal60)}`,
    `  worst drift ${nameB} - ${nameA}: p10 ${c.worstDriftDelta.p10} p50 ${c.worstDriftDelta.p50} p90 ${c.worstDriftDelta.p90} s; improved ${c.worstDriftDelta.improved}, worsened ${c.worstDriftDelta.worsened}, same ${c.worstDriftDelta.same}`,
    `  first promise |miss| ${nameB} - ${nameA}: p50 ${c.firstSightAbsMissDelta.p50} s; improved ${c.firstSightAbsMissDelta.improved}, worsened ${c.firstSightAbsMissDelta.worsened}`,
    c.examples.fixed.length ? `  fixed in ${nameB}: ${c.examples.fixed.join(", ")}` : "",
    c.examples.introduced.length ? `  introduced in ${nameB}: ${c.examples.introduced.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
