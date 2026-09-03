/**
 * layover-replay — how often does a PARKED bus restart its own layover clock?
 *
 * Replays the REAL detector (`src/collector/detector.ts`, including the
 * `stationarySince` guard shipped in #36) over a copy of production
 * `raw_positions`, and scores the stationary clock against a ground truth
 * built from what the bus does NEXT.
 *
 * Ground truth: a bus is "parked at S" for every poll of a maximal run during
 * which it stays continuously within EPISODE_R of one stop S. A reset inside
 * such a run is FALSE — the bus had not departed, by its own future positions.
 * A reset at or after the run's last poll is TRUE, and its lag is what we pay.
 *
 * Run with:
 *   cd services/shuttle-v2
 *   REPLAY_DB=./store/snap.db BUSES_JSON=./store/buses.json \
 *     npx tsx scripts/eta-replay/layover-replay.ts
 *
 * BUSES_JSON is a saved `curl -s https://yale-shuttle.fly.dev/api/buses`; it
 * supplies the dwell medians and segment averages the CLIENT bills, which is
 * what turns a reset into seconds of ETA error. Omit it and section 4 is
 * skipped.
 */
import { createRequire } from "node:module";
import fs from "node:fs";

import { TransitNetwork } from "../../src/network/TransitNetwork.js";
import { distanceMeters } from "../../src/network/geo.js";
import {
  planTracks,
  stepMany,
  STATIONARY_RADIUS_M,
  MAX_OBSERVATION_GAP_MS,
  type BusObservation,
  type BusState,
} from "../../src/collector/detector.js";
import type { Route, Stop } from "../../src/schema/api.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DB_PATH = process.env.REPLAY_DB ?? "./store/snap.db";
const BUSES_JSON = process.env.BUSES_JSON ?? "";
const OUT = process.env.REPLAY_OUT ?? "./scripts/.eta-replay";

/**
 * The radius at which the collector calls a bus "at" a stop
 * (`AT_STOP_MAX_M` in collector.ts). A visit BEGINS and ENDS on this.
 */
const AT_STOP_R = 75;
/**
 * Shortest visit that counts as parked rather than driving past. A bus rolling
 * through is inside AT_STOP_R for two or three polls; a passenger stop is
 * tens of seconds; a layover is minutes.
 */
const MIN_PARK_SEC = 60;
/** A feed gap longer than this breaks a visit — unless the bus did not move. */
const MAX_EPISODE_GAP_MS = 60_000;
/**
 * How far a bus may be from where it was before a long feed gap and still be
 * the same, unbroken wait. Above the feed's ~30 m movement quantum and far
 * below any drive. Without this the ground truth restarts its own clock on
 * every dropout — #45 sat bit-identical at Prospect / Huntington through a
 * 7.5 min gap, and a guard that (correctly) kept counting was scored as
 * over-crediting by 465 s.
 */
const STILL_ACROSS_GAP_M = 40;
/** Long enough to be a layover rather than a passenger stop. */
const LAYOVER_SEC = 180;

// ---------------------------------------------------------------- load

function loadNet() {
  const db = new Database(DB_PATH, { readonly: true });
  const stops = db.prepare("SELECT id, name, lat, lon FROM stops").all() as Stop[];
  const routes = (db
    .prepare("SELECT id, name, short_name, color, stops_json, path_json FROM routes")
    .all() as any[]).map((r) => ({
      id: r.id as number,
      name: r.name as string,
      shortName: (r.short_name ?? "") as string,
      color: (r.color ?? "") as string,
      stops: JSON.parse(r.stops_json) as number[],
    })) as Route[];
  const positions = db
    .prepare(
      "SELECT bus_id, bus_name, route_id, lat, lon, last_stop_id, collected_at FROM raw_positions ORDER BY collected_at, id",
    )
    .all() as any[];
  db.close();
  return { stops, routes, positions };
}

const { stops, routes, positions } = loadNet();
const network = TransitNetwork.build(stops, routes);
const stopById = new Map(stops.map((s) => [s.id, s]));
const routeById = new Map(routes.map((r) => [r.id, r]));

const obsAll: BusObservation[] = positions.map((p) => ({
  busId: p.bus_id,
  busName: p.bus_name,
  routeId: p.route_id,
  lat: p.lat,
  lon: p.lon,
  heading: 0,
  lastStopId: p.last_stop_id,
  collectedAt: p.collected_at,
}));

const spanH =
  (obsAll[obsAll.length - 1].collectedAt - obsAll[0].collectedAt) / 3_600_000;

// ------------------------------------------------- ground-truth visits

/** Nearest stop of `routeId` to a point, geometric only — no sequence logic. */
function nearestOnRoute(routeId: number, p: { lat: number; lon: number }) {
  const seq = routeById.get(routeId)?.stops ?? [];
  let best = -1, bestD = Infinity;
  for (const sid of seq) {
    const s = stopById.get(sid);
    if (!s) continue;
    const d = distanceMeters(p, s);
    if (d < bestD) { bestD = d; best = sid; }
  }
  return { stopId: best, meters: bestD };
}

interface Episode {
  busName: string;
  routeId: number;
  stopId: number;
  /** Indices into that track's observation array: first and last poll AT the stop. */
  a: number;
  b: number;
  startMs: number;
  endMs: number;
  durSec: number;
  /** Distance from the stop for every poll of the visit. */
  dStop: number[];
  /** Distance from the FIRST position of the visit (cumulative drift). */
  dStart: number[];
  /** Distance from the stop 1..4 polls after the last poll at the stop. */
  after: number[];
  /** True when the visit ends because the bus drove away (not a gap/EOF). */
  cleanDeparture: boolean;
  /** First poll of the final outbound run — the departure instant. */
  departIdx: number;
  /** Last poll at which the bus had demonstrably NOT departed. */
  pb: number;
  /** Last poll the visit scan vouched for; `pb` may never exceed it. */
  scanEnd: number;
}

// Group observations per vehicle (bus_name is the identity — see CLAUDE.md).
const byBus = new Map<string, BusObservation[]>();
for (const o of obsAll) {
  let a = byBus.get(o.busName);
  if (!a) byBus.set(o.busName, (a = []));
  a.push(o);
}

/**
 * A visit to stop S runs from the first poll within AT_STOP_R of S to the LAST
 * poll within AT_STOP_R of S before the bus reaches a DIFFERENT stop.
 *
 * The end is therefore decided by the bus arriving somewhere else — not by a
 * distance cutoff — so the wander measured inside a visit has no ceiling
 * imposed by this definition, and a bus that drifts 120 m and comes back is
 * still, correctly, at the stop.
 */
const episodes: Episode[] = [];
for (const [busName, obs] of byBus) {
  const near = obs.map((o) => nearestOnRoute(o.routeId, o));
  let i = 0;
  while (i < obs.length) {
    if (near[i].meters > AT_STOP_R) { i++; continue; }
    const S = near[i].stopId;
    const sPos = stopById.get(S)!;
    let last = i;   // last poll within AT_STOP_R of S
    let j = i;
    while (j + 1 < obs.length) {
      const nx = obs[j + 1];
      const gapMs = nx.collectedAt - obs[j].collectedAt;
      if (gapMs > MAX_EPISODE_GAP_MS) {
        // A dropout breaks the visit only if the bus MOVED across it. The
        // real detector keeps its state up to MAX_OBSERVATION_GAP_MS, so the
        // ground truth must too, or it manufactures errors that are its own.
        if (gapMs > MAX_OBSERVATION_GAP_MS) break;
        if (distanceMeters(nx, obs[j]) > STILL_ACROSS_GAP_M) break;
      }
      if (nx.routeId !== obs[i].routeId) break;
      // Reached a different stop => the visit to S is over.
      if (near[j + 1].meters <= AT_STOP_R && near[j + 1].stopId !== S) break;
      j++;
      if (distanceMeters(nx, sPos) <= AT_STOP_R) last = j;
    }
    const durSec = (obs[last].collectedAt - obs[i].collectedAt) / 1000;
    if (durSec >= MIN_PARK_SEC) {
      const dStop: number[] = [], dStart: number[] = [];
      for (let k = i; k <= last; k++) {
        dStop.push(distanceMeters(obs[k], sPos));
        dStart.push(distanceMeters(obs[k], obs[i]));
      }
      const after: number[] = [];
      for (let n = 1; n <= 4; n++) {
        const k = last + n;
        if (
          k < obs.length &&
          obs[k].collectedAt - obs[last].collectedAt <= MAX_EPISODE_GAP_MS * n
        ) after.push(distanceMeters(obs[k], sPos));
      }
      const clean =
        last + 1 < obs.length &&
        obs[last + 1].collectedAt - obs[last].collectedAt <= MAX_EPISODE_GAP_MS &&
        obs[last + 1].routeId === obs[i].routeId;
      episodes.push({
        busName, routeId: obs[i].routeId, stopId: S,
        a: i, b: last,
        startMs: obs[i].collectedAt, endMs: obs[last].collectedAt,
        durSec, dStop, dStart, after, cleanDeparture: clean,
        departIdx: last + 1, pb: last, scanEnd: j,
      });
    }
    i = Math.max(last, i) + 1;
  }
}

// ------------------------------------------ the departure instant
//
// Deciding WHEN a bus really left must not use the same 75 m stop radius a
// candidate guard uses, or that guard scores a perfect lag by construction.
//
// It does not have to. A parked bus on this feed does not drift: in the
// unambiguous core of a layover 99.7% of consecutive polls carry IDENTICAL
// coordinates and the 30 s net displacement is 0 m at p90 (66.6 m at its
// absolute max). So the departure is legible in the positions themselves:
//   1. find where the bus is unambiguously gone (DEPARTED_M);
//   2. walk BACK while each earlier poll is at least as close to the stop as
//      everything after it (`<=`, so the parked plateau of repeated
//      coordinates is walked through) — this lands on the final resting
//      plateau, THROUGH any shuffle, because a shuffle comes back;
//   3. the departure is the first poll after that plateau's resting distance
//      is exceeded by more than PLATEAU_TOL.
// No radius any candidate policy uses appears anywhere in this.
const DEPARTED_M = 250;
const DEPART_HORIZON = 36; // polls (~3 min)
const PLATEAU_TOL = 10;    // m — well under the feed's ~30 m movement quantum

for (const e of episodes) {
  const obs = byBus.get(e.busName)!;
  const sPos = stopById.get(e.stopId)!;
  const d = (k: number) => distanceMeters(obs[k], sPos);
  let idxFar = -1;
  for (let k = e.b + 1; k < obs.length && k <= e.b + DEPART_HORIZON; k++) {
    if (obs[k].collectedAt - obs[k - 1].collectedAt > MAX_EPISODE_GAP_MS) break;
    if (obs[k].routeId !== e.routeId) break;
    if (d(k) > DEPARTED_M) { idxFar = k; break; }
  }
  if (idxFar < 0) { e.cleanDeparture = false; e.departIdx = e.b + 1; e.pb = e.b; continue; }
  let k = idxFar;
  let sufMin = d(idxFar);
  while (k - 1 > e.a && d(k - 1) <= sufMin) { k--; sufMin = Math.min(sufMin, d(k)); }
  // `k` is the first poll of the final resting plateau; the bus leaves when it
  // gets meaningfully farther from the stop than it was while resting there.
  const restD = d(k);
  let dep = idxFar;
  for (let m = k; m <= idxFar; m++) if (d(m) > restD + PLATEAU_TOL) { dep = m; break; }
  e.departIdx = dep;
  e.cleanDeparture = true;
  // "Has not departed" runs to the poll before the outbound run begins, so the
  // END of a parked stretch is not defined by a radius either.
  // never past the poll the visit scan itself vouched for
  e.pb = Math.min(Math.max(e.a, dep - 1), e.scanEnd);
}

const epByBus = new Map<string, Episode[]>();
for (const e of episodes) {
  let a = epByBus.get(e.busName);
  if (!a) epByBus.set(e.busName, (a = []));
  a.push(e);
}
/** The parked stretch containing this instant, if any. */
function episodeAt(busName: string, ms: number): Episode | null {
  const list = epByBus.get(busName);
  if (!list) return null;
  const obs = byBus.get(busName)!;
  for (const e of list) {
    if (ms >= e.startMs && ms <= obs[e.pb].collectedAt) return e;
  }
  return null;
}

// ------------------------------------------------ replay the real detector

const ticks = new Map<number, BusObservation[]>();
for (const o of obsAll) {
  let a = ticks.get(o.collectedAt);
  if (!a) ticks.set(o.collectedAt, (a = []));
  a.push(o);
}
const tickTimes = [...ticks.keys()].sort((x, y) => x - y);

interface ResetRec {
  busName: string; ms: number; cause: "breach" | "reanchor";
  ep: Episode | null; standingSec: number;
}
const states = new Map<string, BusState>();
const resets: ResetRec[] = [];
for (const t of tickTimes) {
  const batch = ticks.get(t)!;
  const before = new Map<string, { since: number; lat: number; lon: number }>();
  for (const [k, s] of states) {
    before.set(k, { since: s.stationarySince, lat: s.stationaryLat, lon: s.stationaryLon });
  }
  const plan = planTracks(batch);
  stepMany(network, states, batch, plan);
  for (const o of batch) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const now = states.get(key);
    if (!now) continue;
    const prev = before.get(key) ?? before.get(o.busName);
    if (!prev) continue;
    if (now.stationarySince === prev.since) continue;
    const moved = distanceMeters(o, { lat: prev.lat, lon: prev.lon });
    resets.push({
      busName: o.busName, ms: o.collectedAt,
      cause: moved > STATIONARY_RADIUS_M ? "breach" : "reanchor",
      ep: episodeAt(o.busName, o.collectedAt),
      standingSec: (o.collectedAt - prev.since) / 1000,
    });
  }
}

// ------------------------------------------------------------ statistics

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const parkedEpisodes = episodes;
const layovers = parkedEpisodes.filter((e) => e.durSec >= LAYOVER_SEC);
const departures = parkedEpisodes.filter((e) => e.cleanDeparture);

const falseResets = resets.filter((r) => r.ep && r.ms > r.ep.startMs);
const epKey = (b: string, s: number) => `${b}|${s}`;
const epsWithFalse = new Set(falseResets.map((r) => epKey(r.busName, r.ep!.startMs)));
const layoversWithFalse = layovers.filter((e) => epsWithFalse.has(epKey(e.busName, e.startMs)));

// ---- Q2: wander while parked vs distance after departure -------------
// Both measured over the parked stretch [a..pb], whose end is set by the
// departure walk-back, not by a radius.
const wanderStop: number[] = [], wanderStart: number[] = [];
const epMaxStop: number[] = [], epMaxStart: number[] = [];
const layMaxStop: number[] = [], layMaxStart: number[] = [];
for (const e of parkedEpisodes) {
  const obs = byBus.get(e.busName)!;
  const sPos = stopById.get(e.stopId)!;
  const ds: number[] = [], da: number[] = [];
  for (let k = e.a; k <= e.pb; k++) {
    ds.push(distanceMeters(obs[k], sPos));
    da.push(distanceMeters(obs[k], obs[e.a]));
  }
  wanderStop.push(...ds); wanderStart.push(...da);
  epMaxStop.push(Math.max(...ds)); epMaxStart.push(Math.max(...da));
  if (e.durSec >= LAYOVER_SEC) { layMaxStop.push(Math.max(...ds)); layMaxStart.push(Math.max(...da)); }
}

const dep: number[][] = [[], [], [], []];
const depFromLast: number[][] = [[], [], [], []];
for (const e of departures) {
  const obs = byBus.get(e.busName)!;
  const sPos = stopById.get(e.stopId)!;
  const restPos = obs[e.departIdx - 1];
  for (let n = 0; n < 4; n++) {
    const k = e.departIdx + n;
    if (k >= obs.length) continue;
    dep[n].push(distanceMeters(obs[k], sPos));
    depFromLast[n].push(distanceMeters(obs[k], restPos));
  }
}

// ------------------------------------------------- variant policies
//
// Each policy is a per-track state machine over the SAME observation stream
// and decides ONE thing: does this observation restart the stationary clock?

type Machine = (o: BusObservation) => boolean;
interface Anchor { lat: number; lon: number }

/**
 * One family of stationary-clock policies.
 *
 *  - `pinned` false — the anchor is where the BUS was when the clock last
 *    restarted, re-based on every restart. This is what ships today.
 *  - `pinned` true  — while the bus is at a stop the anchor IS the stop, and
 *    is never re-based for as long as it stays that stop. Arriving at a
 *    DIFFERENT stop always restarts the clock, which is what stops a stale
 *    clock from following a bus to its next stop and over-cancelling the
 *    dwell there.
 *
 * `K` is hysteresis: consecutive polls beyond `R` before departure is
 * believed. `monotonic` additionally requires each of those polls to be
 * farther than the last, so a shuffle out-and-back never counts.
 */
function policy(R: number, K: number, pinned: boolean, monotonic = false): Machine {
  let anchor: Anchor | null = null;
  let pinnedStop: number | null = null;
  let run = 0, last = -1;
  return (o) => {
    if (pinned) {
      const n = network.nearestStopOnRoute(o.routeId, o);
      const st = n ? stopById.get(n.stopId) : undefined;
      if (st && distanceMeters(o, st) <= AT_STOP_R) {
        if (pinnedStop !== st.id) {
          anchor = { lat: st.lat, lon: st.lon };
          pinnedStop = st.id; run = 0; last = -1;
          return true; // a different stop is a different wait
        }
        run = 0; last = -1;
        return false;  // pinned to this stop: the clock survives any shuffle
      }
    }
    if (!anchor) { anchor = { lat: o.lat, lon: o.lon }; pinnedStop = null; return true; }
    const d = distanceMeters(o, anchor);
    if (d > R && (!monotonic || run === 0 || d > last)) {
      run++; last = d;
      if (run >= K) {
        anchor = { lat: o.lat, lon: o.lon };
        pinnedStop = null; run = 0; last = -1;
        return true;
      }
      return false;
    }
    run = 0; last = -1;
    return false;
  };
}

const dwellsTbl: any = BUSES_JSON && fs.existsSync(BUSES_JSON)
  ? JSON.parse(fs.readFileSync(BUSES_JSON, "utf8")) : null;

/** What the client can cancel at this stop, and the hop it cancels from. */
function billing(e: Episode): { cancellable: number; segAvg: number } | null {
  if (!dwellsTbl) return null;
  const seq = routeById.get(e.routeId)?.stops ?? [];
  const idx = seq.indexOf(e.stopId);
  if (idx < 0) return null;
  const next = seq[(idx + 1) % seq.length];
  const segAvg = dwellsTbl.segments?.[String(e.routeId)]?.[`${e.stopId}-${next}`]?.avg;
  if (!segAvg) return null;
  const dw = dwellsTbl.dwells?.[String(e.routeId)]?.[String(e.stopId)]?.med;
  return { cancellable: dw && dw > 0 ? dw : segAvg * 0.5, segAvg };
}

interface Score {
  name: string;
  falseResets: number;
  layoversHit: number; layoverPct: number;
  /** Clock SHORT of the truth (the current bug) — seconds, at every parked poll. */
  shortP50: number; shortP90: number; shortMax: number; shortPollPct: number;
  /** Clock LONG (over-credit) — the opposite error, which shortens ETAs. */
  longP90: number; longMax: number; longPollPct: number;
  /** Seconds the first hop's ETA is INFLATED (rider told later than truth). */
  lateP50: number; lateP90: number; lateMax: number; lateMean: number;
  /** Seconds the ETA is DEFLATED (rider told sooner than truth). */
  earlyP90: number; earlyMax: number;
  /** Share of rider-visible parked polls whose ETA is inflated by over a minute. */
  lateBadPct: number;
  /** Rider-visible parked polls scored. */
  polls: number;
  /** Same, layovers only — where the money is. */
  layLateP90: number; layLateMax: number; layLateMean: number; layLateP50: number;
  /** Polls (5 s) from the departure instant to the clock restarting. */
  lagP50: number; lagP90: number; lagMax: number; lagMeanSec: number; missed: number;
}

function scorePolicy(name: string, make: () => Machine): Score {
  const clockAt = new Map<string, number[]>();
  const resetTimes = new Map<string, number[]>();
  for (const [busName, obs] of byBus) {
    let m = make();
    const clocks: number[] = [], times: number[] = [];
    let since = obs[0].collectedAt;
    let prevRoute = -1, prevMs = -1;
    for (const o of obs) {
      if (prevRoute !== -1 && (o.routeId !== prevRoute || o.collectedAt - prevMs > 600_000)) {
        m = make(); // the real detector re-anchors here too
      }
      if (m(o)) { since = o.collectedAt; times.push(o.collectedAt); }
      clocks.push((o.collectedAt - since) / 1000);
      prevRoute = o.routeId; prevMs = o.collectedAt;
    }
    clockAt.set(busName, clocks);
    resetTimes.set(busName, times);
  }

  let falseN = 0;
  const hit = new Set<string>();
  const shortV: number[] = [], longV: number[] = [];
  const late: number[] = [], early: number[] = [], layLate: number[] = [];
  let shortPolls = 0, longPolls = 0, allPolls = 0, lateBad = 0;

  for (const e of parkedEpisodes) {
    const obs = byBus.get(e.busName)!;
    const clocks = clockAt.get(e.busName)!;
    const bill = billing(e);
    const isLay = e.durSec >= LAYOVER_SEC;
    const sPos = stopById.get(e.stopId)!;
    for (let k = e.a; k <= e.pb; k++) {
      // The ETA consults the clock ONLY while the payload serves `at_stop`,
      // which collector.ts does only within AT_STOP_MAX_M of the anchor stop
      // and after 15 s of dwell. Scoring anywhere else measures nothing a
      // rider can see — and would credit a policy for the roll-in seconds.
      if (distanceMeters(obs[k], sPos) > AT_STOP_R) continue;
      if (obs[k].collectedAt - e.startMs < 15_000) continue;
      const truth = (obs[k].collectedAt - e.startMs) / 1000;
      const diff = truth - clocks[k];
      allPolls++;
      // Zeros included, or a policy that is right nearly always would be
      // ranked on the handful of polls where it is wrong.
      shortV.push(Math.max(0, diff));
      longV.push(Math.max(0, -diff));
      if (diff > 60) shortPolls++;
      if (-diff > 60) longPolls++;
      if (bill) {
        const should = Math.min(truth, bill.cancellable, bill.segAvg);
        const does = Math.min(clocks[k], bill.cancellable, bill.segAvg);
        const err = should - does; // >0 => ETA inflated (the harmful direction)
        late.push(Math.max(0, err));
        early.push(Math.max(0, -err));
        if (isLay) layLate.push(Math.max(0, err));
        if (err > 60) lateBad++;
      }
    }
    const endMs = obs[e.pb].collectedAt;
    for (const t of resetTimes.get(e.busName) ?? []) {
      if (t > e.startMs + 15_000 && t <= endMs) {
        falseN++;
        if (isLay) hit.add(epKey(e.busName, e.startMs));
      }
    }
  }

  const lags: number[] = [];
  let missed = 0;
  for (const e of departures) {
    const obs = byBus.get(e.busName)!;
    const depMs = obs[e.departIdx].collectedAt;
    const hi = Math.min(obs.length - 1, e.departIdx + DEPART_HORIZON);
    const times = resetTimes.get(e.busName) ?? [];
    const t = times.find((x) => x >= depMs && x <= obs[hi].collectedAt);
    if (t === undefined) { missed++; continue; }
    let polls = 0;
    for (let k = e.departIdx; k < obs.length && obs[k].collectedAt < t; k++) polls++;
    lags.push(polls);
  }

  return {
    name,
    falseResets: falseN,
    layoversHit: hit.size,
    layoverPct: layovers.length ? r1((100 * hit.size) / layovers.length) : 0,
    shortP50: r1(q(shortV, 0.5)), shortP90: r1(q(shortV, 0.9)),
    shortMax: r1(Math.max(...shortV, 0)),
    shortPollPct: allPolls ? r1((100 * shortPolls) / allPolls) : 0,
    longP90: r1(q(longV, 0.9)), longMax: r1(Math.max(...longV, 0)),
    longPollPct: allPolls ? r1((100 * longPolls) / allPolls) : 0,
    lateP50: r1(q(late, 0.5)), lateP90: r1(q(late, 0.9)),
    lateMax: r1(Math.max(...late, 0)), lateMean: r1(late.reduce((a, b) => a + b, 0) / Math.max(1, late.length)),
    earlyP90: r1(q(early, 0.9)), earlyMax: r1(Math.max(...early, 0)),
    lateBadPct: allPolls ? r1((100 * lateBad) / allPolls) : 0,
    polls: allPolls,
    layLateP90: r1(q(layLate, 0.9)), layLateMax: r1(Math.max(...layLate, 0)),
    layLateP50: r1(q(layLate, 0.5)),
    layLateMean: r1(layLate.reduce((a, b) => a + b, 0) / Math.max(1, layLate.length)),
    lagP50: r1(q(lags, 0.5)), lagP90: r1(q(lags, 0.9)),
    lagMax: lags.length ? Math.max(...lags) : NaN,
    lagMeanSec: r1(mean(lags) * 5),
    missed,
  };
}

const variants: Score[] = [];
for (const R of [75, 100, 125, 150, 200]) {
  variants.push(scorePolicy(`a) bus-anchored  R=${R} K=1${R === 75 ? "   <-- CURRENT" : ""}`, () => policy(R, 1, false)));
}
for (const R of [75, 100, 125, 150, 250]) {
  variants.push(scorePolicy(`b) stop-pinned   R=${R} K=1`, () => policy(R, 1, true)));
}
for (const R of [75, 100, 125]) {
  for (const K of [2, 3, 4]) {
    variants.push(scorePolicy(`c) bus-anchored  R=${R} K=${K}`, () => policy(R, K, false)));
    variants.push(scorePolicy(`c') stop-pinned  R=${R} K=${K}`, () => policy(R, K, true)));
  }
}
for (const K of [2, 3]) {
  variants.push(scorePolicy(`d) monotonic bus R=75 K=${K}`, () => policy(75, K, false, true)));
  variants.push(scorePolicy(`d') monotonic pin R=100 K=${K}`, () => policy(100, K, true, true)));
}

// --------------------------------------- worst residual, recommended policy
//
// Where the RECOMMENDED policy is still wrong, and by how much. Printed so the
// residual is inspected rather than assumed benign.
const RECO = () => policy(125, 1, true);
function worstCases(make: () => Machine, n = 6) {
  const rows: any[] = [];
  for (const [busName, obs] of byBus) {
    let m = make();
    const clocks: number[] = [];
    let since = obs[0].collectedAt, prevRoute = -1, prevMs = -1;
    for (const o of obs) {
      if (prevRoute !== -1 && (o.routeId !== prevRoute || o.collectedAt - prevMs > 600_000)) m = make();
      if (m(o)) since = o.collectedAt;
      clocks.push((o.collectedAt - since) / 1000);
      prevRoute = o.routeId; prevMs = o.collectedAt;
    }
    for (const e of parkedEpisodes) {
      if (e.busName !== busName) continue;
      const sPos = stopById.get(e.stopId)!;
      let worstLong = 0, worstShort = 0, atMs = 0;
      for (let k = e.a; k <= e.pb; k++) {
        if (distanceMeters(obs[k], sPos) > AT_STOP_R) continue;
        if (obs[k].collectedAt - e.startMs < 15_000) continue;
        const diff = (obs[k].collectedAt - e.startMs) / 1000 - clocks[k];
        if (-diff > worstLong) { worstLong = -diff; atMs = obs[k].collectedAt; }
        if (diff > worstShort) worstShort = diff;
      }
      if (worstLong > 60 || worstShort > 60) {
        rows.push({
          bus: busName, routeId: e.routeId, stopId: e.stopId,
          stop: stopById.get(e.stopId)?.name,
          visitFrom: new Date(e.startMs).toISOString(),
          visitSec: r1(e.durSec),
          overCreditSec: r1(worstLong), underCreditSec: r1(worstShort),
          at: atMs ? new Date(atMs).toISOString() : null,
        });
      }
    }
  }
  rows.sort((a, b) => Math.max(b.overCreditSec, b.underCreditSec) - Math.max(a.overCreditSec, a.underCreditSec));
  return rows.slice(0, n);
}
const residual = worstCases(RECO);

// ------------------------------------------------------------- per-stop

const byStop = new Map<number, { falseN: number; eps: number; parkedSec: number; layovers: number; layHit: Set<string> }>();
for (const e of parkedEpisodes) {
  let v = byStop.get(e.stopId);
  if (!v) byStop.set(e.stopId, (v = { falseN: 0, eps: 0, parkedSec: 0, layovers: 0, layHit: new Set() }));
  v.eps++; v.parkedSec += e.durSec; if (e.durSec >= LAYOVER_SEC) v.layovers++;
}
for (const r of falseResets) {
  const v = byStop.get(r.ep!.stopId);
  if (!v) continue;
  v.falseN++;
  if (r.ep!.durSec >= LAYOVER_SEC) v.layHit.add(epKey(r.busName, r.ep!.startMs));
}
const stopRank = [...byStop.entries()]
  .map(([sid, v]) => ({
    stopId: sid, name: stopById.get(sid)?.name ?? "?",
    falseN: v.falseN, visits: v.eps, layovers: v.layovers, layoversHit: v.layHit.size,
    parkedMin: r1(v.parkedSec / 60),
    perVisit: r1(v.falseN / v.eps),
    perParkedHour: r1(v.falseN / (v.parkedSec / 3600)),
  }))
  .filter((s) => s.falseN > 0)
  .sort((a, b) => b.falseN - a.falseN);

// -------------------------------------------------- incident replay check

const INC_BUS = process.env.INCIDENT_BUS ?? "#316";
const INC_STOP = Number(process.env.INCIDENT_STOP ?? 11);
const incident = parkedEpisodes
  .filter((e) => e.busName === INC_BUS && e.stopId === INC_STOP)
  .map((e) => {
    const obs = byBus.get(e.busName)!;
    return {
      from: new Date(e.startMs).toISOString(),
      lastParked: new Date(obs[e.pb].collectedAt).toISOString(),
      parkedSec: r1((obs[e.pb].collectedAt - e.startMs) / 1000),
      falseResets: resets
        .filter((r) => r.busName === e.busName && r.ms > e.startMs && r.ms <= obs[e.pb].collectedAt)
        .map((r) => ({ at: new Date(r.ms).toISOString(), threwAwaySec: r1(r.standingSec) })),
    };
  });

// ------------------------------------------------------------- output

const out = {
  window: {
    from: new Date(obsAll[0].collectedAt).toISOString(),
    to: new Date(obsAll[obsAll.length - 1].collectedAt).toISOString(),
    hours: r1(spanH), positions: obsAll.length, buses: byBus.size,
    note: "raw_positions retention is 6 h (RAW_POSITION_RETAIN_MS in collector.ts) — a 7-day GPS replay is impossible.",
  },
  episodes: {
    visits: parkedEpisodes.length, layovers: layovers.length,
    cleanDepartures: departures.length,
    parkedHours: r1(parkedEpisodes.reduce((a, e) => a + e.durSec, 0) / 3600),
    medianVisitSec: r1(q(parkedEpisodes.map((e) => e.durSec), 0.5)),
    medianLayoverSec: r1(q(layovers.map((e) => e.durSec), 0.5)),
  },
  resets: {
    all: resets.length,
    breach: resets.filter((r) => r.cause === "breach").length,
    reanchor: resets.filter((r) => r.cause === "reanchor").length,
    false: falseResets.length,
    falseBreach: falseResets.filter((r) => r.cause === "breach").length,
    falseReanchor: falseResets.filter((r) => r.cause === "reanchor").length,
    visitsAffected: epsWithFalse.size,
    visitsAffectedPct: r1((100 * epsWithFalse.size) / parkedEpisodes.length),
    layoversAffected: layoversWithFalse.length,
    layoversAffectedPct: r1((100 * layoversWithFalse.length) / layovers.length),
  },
  wander: {
    allPolls_fromStop: { p50: r1(q(wanderStop, 0.5)), p90: r1(q(wanderStop, 0.9)), p99: r1(q(wanderStop, 0.99)), max: r1(Math.max(...wanderStop)) },
    allPolls_fromArrivalPoint: { p50: r1(q(wanderStart, 0.5)), p90: r1(q(wanderStart, 0.9)), p99: r1(q(wanderStart, 0.99)), max: r1(Math.max(...wanderStart)) },
    perVisitMax_fromStop: { p50: r1(q(epMaxStop, 0.5)), p90: r1(q(epMaxStop, 0.9)), p99: r1(q(epMaxStop, 0.99)), max: r1(Math.max(...epMaxStop)) },
    perVisitMax_fromArrivalPoint: { p50: r1(q(epMaxStart, 0.5)), p90: r1(q(epMaxStart, 0.9)), p99: r1(q(epMaxStart, 0.99)), max: r1(Math.max(...epMaxStart)) },
    perLayoverMax_fromStop: { p50: r1(q(layMaxStop, 0.5)), p90: r1(q(layMaxStop, 0.9)), p99: r1(q(layMaxStop, 0.99)), max: r1(Math.max(...layMaxStop)) },
    perLayoverMax_fromArrivalPoint: { p50: r1(q(layMaxStart, 0.5)), p90: r1(q(layMaxStart, 0.9)), p99: r1(q(layMaxStart, 0.99)), max: r1(Math.max(...layMaxStart)) },
  },
  departure: dep.map((d, i) => ({
    pollsAfterDeparture: i + 1, n: d.length,
    fromStop: { p1: r1(q(d, 0.01)), p5: r1(q(d, 0.05)), p10: r1(q(d, 0.1)), p25: r1(q(d, 0.25)), p50: r1(q(d, 0.5)), p90: r1(q(d, 0.9)) },
    fromLastRestingPoint: {
      p1: r1(q(depFromLast[i], 0.01)), p5: r1(q(depFromLast[i], 0.05)),
      p10: r1(q(depFromLast[i], 0.1)), p25: r1(q(depFromLast[i], 0.25)),
      p50: r1(q(depFromLast[i], 0.5)), p90: r1(q(depFromLast[i], 0.9)),
    },
  })),
  stopRank: stopRank.slice(0, 15),
  variants,
  incident,
  residual,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/layover.json`, JSON.stringify(out, null, 2));
console.log("wrote " + OUT + "/layover.json");
