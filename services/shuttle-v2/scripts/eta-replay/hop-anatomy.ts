/**
 * Hop anatomy: split every hop the ETA actually predicts into the three
 * things a bus spends time on, then attribute the hop's variance to them.
 *
 * WHY THIS EXISTS. `segments.travel_sec` and `arrivals.dwell_sec` are the
 * SAME measured interval (see docs/eta-error-budget.md): the detector emits
 * both from one `elapsedSec`, so joining the tables to split dwell from drive
 * returns "drive = 0, dwell = 100%" — arithmetically true, semantically
 * vacuous. The only record that separates standing from rolling is
 * `raw_positions`, so the split has to be re-derived from GPS.
 *
 * METHOD. Replay the production detector (`stepMany`) over every logged raw
 * position to recover hop boundaries exactly as production drew them, then
 * classify each 5 s tick inside a hop as
 *
 *   dwell  — stationary within AT_STOP_MAX_M of the hop's ORIGIN stop
 *   hold   — stationary anywhere else (traffic signal, queue, layover off-stop)
 *   drive  — moving
 *
 * "Stationary" is NOT "the coordinate did not change": the feed repeats a
 * position on 53.6% of consecutive samples (docs/bus-speed.md), so that test
 * would call a moving bus stopped a fifth of the time. A sample is stationary
 * when it belongs to a run of >= MIN_STILL_S that stays inside a
 * STILL_RADIUS_M ball, which a bus doing even 3 mph leaves comfortably.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/hop-anatomy.ts
 */
import fs from "node:fs";

import { OUT_DIR, fmtEt, loadNet } from "./common.js";
import {
  planTracks,
  stepMany,
  type BusObservation,
  type BusState,
  type SegmentEvent,
} from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";
import { ROUTE_ID_LABEL } from "../../web/src/routes";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

/** A run that stays inside this ball, for this long, is the bus standing still. */
const STILL_RADIUS_M = Number(process.env.STILL_RADIUS_M ?? 25);
/** detector.ts MIN_DWELL_SEC is 15 s; anything shorter is a bus rolling through. */
const MIN_STILL_S = Number(process.env.MIN_STILL_S ?? 15);
/** collector.ts AT_STOP_MAX_M — how close counts as "at" the stop. */
const AT_STOP_MAX_M = 75;

const net = loadNet();
const { db, network } = net;

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos = db
  .prepare(
    `SELECT bus_id i, bus_name b, route_id r, lat, lon, heading h, last_stop_id l, collected_at t
     FROM raw_positions ORDER BY collected_at, id`,
  )
  .all() as PosRow[];
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;
log(`raw positions ${pos.length}, ${fmtEt(rawStart)} .. ${fmtEt(rawEnd)} ET`);

// -- Per-track sample series + stillness ---------------------------------------
// Keyed by bus_name: the stable identity (CLAUDE.md). Contended names are rare
// and only matter for the detector's anchor, which we take from the replay.
const trackByName = new Map<string, PosRow[]>();
for (const p of pos) {
  let l = trackByName.get(p.b);
  if (!l) trackByName.set(p.b, (l = []));
  l.push(p);
}

/**
 * still[name][i] — was the bus stationary at track sample i?
 *
 * Definition: sample i is stationary iff SOME run of consecutive samples
 * containing i stays inside a STILL_RADIUS_M ball for at least MIN_STILL_S.
 * "Some run", not "the centred window": a centred +/-30 s test calls the
 * middle of a 30 s dwell moving, because its window reaches into the driving
 * on both sides, which silently deletes every short dwell. The existential
 * form has no edge bias.
 *
 * This is deliberately not "the coordinate did not change" — the feed repeats
 * a position on ~54% of consecutive samples (docs/bus-speed.md), which would
 * call a moving bus stopped a fifth of the time.
 */
const stillByName = new Map<string, Uint8Array>();
/** Radius of the still run each stationary sample belongs to (receiver wander). */
const stillRadiusByName = new Map<string, Float64Array>();
for (const [name, track] of trackByName) {
  const n = track.length;
  const still = new Uint8Array(n);
  const radius = new Float64Array(n);
  radius.fill(-1);
  for (let i = 0; i < n; i++) {
    // Longest run starting at i that stays inside the ball around track[i],
    // with no feed gap longer than 60 s inside it.
    let j = i;
    let maxD = 0;
    while (j + 1 < n) {
      if (track[j + 1]!.t - track[j]!.t > 60_000) break;
      const d = distanceMeters(track[i]!, track[j + 1]!);
      if (d > STILL_RADIUS_M) break;
      if (d > maxD) maxD = d;
      j++;
    }
    if (track[j]!.t - track[i]!.t >= MIN_STILL_S * 1000) {
      for (let k = i; k <= j; k++) {
        still[k] = 1;
        if (maxD > radius[k]!) radius[k] = maxD;
      }
    }
  }
  stillByName.set(name, still);
  stillRadiusByName.set(name, radius);
}
log(`stillness computed for ${trackByName.size} tracks`);

// -- Detector replay: recover the hops production actually measured -----------
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
{
  const states = new Map<string, BusState>();
  for (const poll of polls) {
    const plan = planTracks(poll);
    for (const e of stepMany(network, states, poll, plan)) {
      if (e.kind === "segment") segEvents.push(e);
    }
  }
}
log(`polls ${polls.length}, segment events ${segEvents.length}`);

// -- Classify each hop ---------------------------------------------------------
interface Hop {
  key: string;          // route:from:to
  routeId: number;
  from: number;
  to: number;
  hops: number;
  busName: string;
  startedAt: number;
  hopSec: number;
  dwellSec: number;     // stationary within 75 m of the origin stop
  holdSec: number;      // stationary elsewhere
  driveSec: number;     // moving
  unknownSec: number;   // ticks the stillness test could not judge
  hour: number;
  dow: number;
  /** number of separate stationary spells away from the origin stop */
  holdSpells: number;
  /** longest single such spell */
  longestHoldSec: number;
}
const hops: Hop[] = [];
let skippedNoTrack = 0;
let skippedGap = 0;

for (const ev of segEvents) {
  const track = trackByName.get(ev.busName);
  if (!track) {
    skippedNoTrack++;
    continue;
  }
  const still = stillByName.get(ev.busName)!;
  const tA = ev.startedAt;
  const tB = ev.startedAt + ev.travelSec * 1000;
  const origin = net.stopById.get(ev.fromStopId);
  if (!origin) continue;

  // Samples inside [tA, tB]. Each sample i owns the interval to sample i+1.
  let s = 0;
  while (s < track.length && track[s]!.t < tA) s++;
  let e = s;
  while (e < track.length && track[e]!.t <= tB) e++;
  if (e - s < 2) {
    skippedGap++;
    continue;
  }
  let dwell = 0;
  let hold = 0;
  let drive = 0;
  let unknown = 0;
  let holdSpells = 0;
  let curHold = 0;
  let longestHold = 0;
  let prevWasHold = false;
  let coveredMs = 0;
  for (let i = s; i + 1 < e; i++) {
    const dt = track[i + 1]!.t - track[i]!.t;
    // A gap longer than a minute is a feed dropout, not a measurement.
    if (dt > 60_000) {
      unknown += dt / 1000;
      coveredMs += dt;
      prevWasHold = false;
      continue;
    }
    coveredMs += dt;
    const isStill = still[i] === 1;
    const nearOrigin = distanceMeters(track[i]!, origin) <= AT_STOP_MAX_M;
    if (!isStill) {
      drive += dt / 1000;
      if (prevWasHold) {
        if (curHold > longestHold) longestHold = curHold;
        curHold = 0;
      }
      prevWasHold = false;
    } else if (nearOrigin) {
      dwell += dt / 1000;
      if (prevWasHold) {
        if (curHold > longestHold) longestHold = curHold;
        curHold = 0;
      }
      prevWasHold = false;
    } else {
      hold += dt / 1000;
      if (!prevWasHold) holdSpells++;
      curHold += dt / 1000;
      prevWasHold = true;
    }
  }
  if (curHold > longestHold) longestHold = curHold;
  // The samples do not tile [tA, tB] exactly (the boundary ticks land inside).
  // Attribute the uncovered remainder proportionally rather than inventing a
  // category for it, and record how much that was.
  const measured = dwell + hold + drive + unknown;
  const slackSec = ev.travelSec - measured;
  if (measured > 0 && Math.abs(slackSec) < ev.travelSec * 0.5) {
    const scale = ev.travelSec / measured;
    dwell *= scale;
    hold *= scale;
    drive *= scale;
    unknown *= scale;
  }
  const d = new Date(tA);
  hops.push({
    key: `${ev.routeId}:${ev.fromStopId}:${ev.toStopId}`,
    routeId: ev.routeId,
    from: ev.fromStopId,
    to: ev.toStopId,
    hops: ev.hops,
    busName: ev.busName,
    startedAt: tA,
    hopSec: ev.travelSec,
    dwellSec: dwell,
    holdSec: hold,
    driveSec: drive,
    unknownSec: unknown,
    hour: d.getHours(),
    dow: d.getDay(),
    holdSpells,
    longestHoldSec: longestHold,
  });
}
log(`hops classified ${hops.length} (skipped: no track ${skippedNoTrack}, sparse ${skippedGap})`);

// -- Statistics ----------------------------------------------------------------
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return sum(a.map((x) => (x - m) * (x - m))) / (a.length - 1);
}
function cov(a: number[], b: number[]): number {
  if (a.length < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - ma) * (b[i]! - mb);
  return s / (a.length - 1);
}
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Attribute Var(total) to additive components via Cov(part, total)/Var(total).
 * These sum to exactly 1 by bilinearity, and unlike raw variance shares they
 * charge each component for its covariance with the others.
 */
function attribute(parts: Record<string, number[]>, total: number[]) {
  const vt = variance(total);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parts)) out[k] = vt > 0 ? r3(cov(v, total) / vt) : 0;
  return { varianceTotal: r1(vt), sdTotal: r1(Math.sqrt(vt)), shares: out };
}

// Only hops with a usable measurement.
const clean = hops.filter((h) => h.unknownSec < 0.1 * h.hopSec);
log(`clean hops ${clean.length} of ${hops.length}`);

const result: any = {
  generatedAt: new Date().toISOString(),
  window: { start: fmtEt(rawStart), end: fmtEt(rawEnd), hours: r1((rawEnd - rawStart) / 3_600_000) },
  params: { STILL_RADIUS_M, MIN_STILL_S, AT_STOP_MAX_M },
  counts: { rawPositions: pos.length, segmentEvents: segEvents.length, hopsClassified: hops.length, cleanHops: clean.length, skippedNoTrack, skippedGap },
};

// -- Level 1: where the time goes ---------------------------------------------
{
  const tot = sum(clean.map((h) => h.hopSec));
  result.timeBudget = {
    description: "share of all hop-seconds, pooled",
    medianHopSec: r1(med(clean.map((h) => h.hopSec))),
    meanHopSec: r1(mean(clean.map((h) => h.hopSec))),
    dwellPct: r1((100 * sum(clean.map((h) => h.dwellSec))) / tot),
    holdPct: r1((100 * sum(clean.map((h) => h.holdSec))) / tot),
    drivePct: r1((100 * sum(clean.map((h) => h.driveSec))) / tot),
    medianDwellSec: r1(med(clean.map((h) => h.dwellSec))),
    medianHoldSec: r1(med(clean.map((h) => h.holdSec))),
    medianDriveSec: r1(med(clean.map((h) => h.driveSec))),
    hopsWithZeroDwell: r1((100 * clean.filter((h) => h.dwellSec < 5).length) / clean.length),
    hopsWithAnyHold: r1((100 * clean.filter((h) => h.holdSec >= 10).length) / clean.length),
  };
}

// -- Level 2: variance attribution, pooled and within segment ------------------
{
  const pooled = attribute(
    { dwell: clean.map((h) => h.dwellSec), hold: clean.map((h) => h.holdSec), drive: clean.map((h) => h.driveSec), unknown: clean.map((h) => h.unknownSec) },
    clean.map((h) => h.hopSec),
  );
  // Within-segment: subtract each (route, from, to) group's own mean. This is
  // the variance the estimator still faces AFTER it has looked up the segment,
  // which is the only part it can be blamed for.
  const byKey = new Map<string, Hop[]>();
  for (const h of clean) {
    let l = byKey.get(h.key);
    if (!l) byKey.set(h.key, (l = []));
    l.push(h);
  }
  const dev: Record<string, number[]> = { dwell: [], hold: [], drive: [], unknown: [] };
  const devTotal: number[] = [];
  let usedGroups = 0;
  for (const [, l] of byKey) {
    if (l.length < 5) continue;
    usedGroups++;
    const m = { dwell: mean(l.map((h) => h.dwellSec)), hold: mean(l.map((h) => h.holdSec)), drive: mean(l.map((h) => h.driveSec)), unknown: mean(l.map((h) => h.unknownSec)), hop: mean(l.map((h) => h.hopSec)) };
    for (const h of l) {
      dev.dwell!.push(h.dwellSec - m.dwell);
      dev.hold!.push(h.holdSec - m.hold);
      dev.drive!.push(h.driveSec - m.drive);
      dev.unknown!.push(h.unknownSec - m.unknown);
      devTotal.push(h.hopSec - m.hop);
    }
  }
  result.variance = {
    pooled: { note: "across all hops on all segments; dominated by which segment it is", ...pooled },
    withinSegment: {
      note: "deviation from each (route,from,to) group mean, groups with n>=5 — the residual the estimator faces",
      groups: usedGroups,
      n: devTotal.length,
      ...attribute(dev, devTotal),
    },
  };
}

// -- Level 3: per-route and per-hour views ------------------------------------
{
  const byRoute = new Map<number, Hop[]>();
  for (const h of clean) {
    let l = byRoute.get(h.routeId);
    if (!l) byRoute.set(h.routeId, (l = []));
    l.push(h);
  }
  result.byRoute = Object.fromEntries(
    [...byRoute.entries()]
      .filter(([, l]) => l.length >= 30)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([r, l]) => {
        const tot = sum(l.map((h) => h.hopSec));
        return [
          `${ROUTE_ID_LABEL[r] ?? "?"} (${net.routeById.get(r)?.name ?? r})`,
          { n: l.length, medianHopSec: r1(med(l.map((h) => h.hopSec))), dwellPct: r1((100 * sum(l.map((h) => h.dwellSec))) / tot), holdPct: r1((100 * sum(l.map((h) => h.holdSec))) / tot), drivePct: r1((100 * sum(l.map((h) => h.driveSec))) / tot) },
        ];
      }),
  );
  const byHour = new Map<number, Hop[]>();
  for (const h of clean) {
    let l = byHour.get(h.hour);
    if (!l) byHour.set(h.hour, (l = []));
    l.push(h);
  }
  result.byHour = Object.fromEntries(
    [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hr, l]) => {
      const tot = sum(l.map((h) => h.hopSec));
      return [hr, { n: l.length, medianHopSec: r1(med(l.map((h) => h.hopSec))), dwellPct: r1((100 * sum(l.map((h) => h.dwellSec))) / tot), holdPct: r1((100 * sum(l.map((h) => h.holdSec))) / tot), drivePct: r1((100 * sum(l.map((h) => h.driveSec))) / tot) }];
    }),
  );
}

// -- Level 4: is a segment's DRIVE time bimodal? (the traffic-light question) --
{
  // For each well-sampled segment, compare the spread of drive time with the
  // spread of dwell, and look for bimodality via the dip between the two
  // halves of the sorted drive times.
  const byKey = new Map<string, Hop[]>();
  for (const h of clean) {
    let l = byKey.get(h.key);
    if (!l) byKey.set(h.key, (l = []));
    l.push(h);
  }
  const rows: any[] = [];
  for (const [k, l] of byKey) {
    if (l.length < 20) continue;
    const drive = l.map((h) => h.driveSec);
    const dwell = l.map((h) => h.dwellSec);
    const hold = l.map((h) => h.holdSec);
    rows.push({
      key: k,
      route: ROUTE_ID_LABEL[l[0]!.routeId] ?? "?",
      n: l.length,
      medianHop: r1(med(l.map((h) => h.hopSec))),
      driveMed: r1(med(drive)),
      driveIqr: r1(quantile(drive, 0.75) - quantile(drive, 0.25)),
      driveCv: r3(Math.sqrt(variance(drive)) / Math.max(1, mean(drive))),
      dwellMed: r1(med(dwell)),
      dwellIqr: r1(quantile(dwell, 0.75) - quantile(dwell, 0.25)),
      holdMed: r1(med(hold)),
      holdShare: r1((100 * sum(hold)) / sum(l.map((h) => h.hopSec))),
      anyHoldPct: r1((100 * l.filter((h) => h.holdSec >= 10).length) / l.length),
      longestHoldP90: r1(quantile(l.map((h) => h.longestHoldSec), 0.9)),
    });
  }
  rows.sort((a, b) => b.holdShare - a.holdShare);
  result.segments = { n: rows.length, topByHoldShare: rows.slice(0, 20), all: rows };
}

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

// -- Level 5: hand-checkable cases --------------------------------------------
{
  // A few long hops with a big hold, and a few pure-drive hops, printed with
  // enough detail to verify by eye against the raw track.
  const withHold = clean.filter((h) => h.holdSec > 60).sort((a, b) => b.holdSec - a.holdSec).slice(0, 5);
  const pureDrive = clean.filter((h) => h.dwellSec < 5 && h.holdSec < 5 && h.hopSec > 60).slice(0, 5);
  const bigDwell = clean.filter((h) => h.dwellSec > 120).sort((a, b) => b.dwellSec - a.dwellSec).slice(0, 5);
  const describe = (h: Hop) => ({
    bus: h.busName,
    route: ROUTE_ID_LABEL[h.routeId] ?? "?",
    from: net.stopById.get(h.from)?.name,
    to: net.stopById.get(h.to)?.name,
    startedAt: fmtEt(h.startedAt),
    hopSec: r1(h.hopSec),
    dwellSec: r1(h.dwellSec),
    holdSec: r1(h.holdSec),
    driveSec: r1(h.driveSec),
    holdSpells: h.holdSpells,
    longestHoldSec: r1(h.longestHoldSec),
  });
  result.handCheck = { longestHolds: withHold.map(describe), pureDrive: pureDrive.map(describe), longestDwells: bigDwell.map(describe) };
}

// -- Level 6: what the sensor does while the bus is standing still ------------
{
  // While a bus is genuinely still, every changed fix is measurement noise and
  // nothing else. That is the observation variance any filter would need.
  const stillRunRadii: number[] = [];
  const stillJumps: number[] = [];
  let stillIdentical = 0;
  const movingJumps: number[] = [];
  let allIdentical = 0;
  let total = 0;
  for (const [name, track] of trackByName) {
    const still = stillByName.get(name)!;
    const rad = stillRadiusByName.get(name)!;
    for (let i = 0; i < track.length; i++) if (still[i] === 1 && rad[i]! >= 0) stillRunRadii.push(rad[i]!);
    for (let i = 0; i + 1 < track.length; i++) {
      const dt = track[i + 1]!.t - track[i]!.t;
      if (dt <= 0 || dt > 20_000) continue;
      total++;
      const d = distanceMeters(track[i]!, track[i + 1]!);
      if (d === 0) allIdentical++;
      if (still[i] === 1 && still[i + 1] === 1) {
        stillJumps.push(d);
        if (d === 0) stillIdentical++;
      } else if (still[i] === 0 && still[i + 1] === 0) movingJumps.push(d);
    }
  }
  const stillChanged = stillJumps.filter((d) => d > 0);
  const movingChanged = movingJumps.filter((d) => d > 0);
  result.sensor = {
    note: "consecutive fixes <=20 s apart. 'still' pairs are both inside a stationary run, so any displacement there is receiver noise, not motion.",
    pairs: total,
    identicalPct: r1((100 * allIdentical) / total),
    still: {
      pairs: stillJumps.length,
      identicalPct: r1((100 * stillIdentical) / Math.max(1, stillJumps.length)),
      changedFixes: stillChanged.length,
      changedMedianM: r1(med(stillChanged)),
      changedP90M: r1(quantile(stillChanged, 0.9)),
      changedP99M: r1(quantile(stillChanged, 0.99)),
      runRadiusMedianM: r1(med(stillRunRadii)),
      runRadiusP90M: r1(quantile(stillRunRadii, 0.9)),
      runRadiusMaxM: r1(Math.max(0, ...stillRunRadii)),
    },
    moving: {
      pairs: movingJumps.length,
      identicalPct: r1((100 * movingJumps.filter((d) => d === 0).length) / Math.max(1, movingJumps.length)),
      changedMedianM: r1(med(movingChanged)),
      changedP90M: r1(quantile(movingChanged, 0.9)),
    },
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/hop-anatomy.json`, JSON.stringify(result, null, 1));
log(`wrote ${OUT_DIR}/hop-anatomy.json`);
console.log(JSON.stringify({ params: result.params, counts: result.counts, timeBudget: result.timeBudget, variance: result.variance, sensor: result.sensor }, null, 1));
