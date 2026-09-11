/**
 * DEPARTURE REPLAY: derive the departure instant — and with it stand, drive
 * and hold — from archived positions, with the code the collector will run.
 *
 * `segments.travel_sec` and `arrivals.dwell_sec` are one interval (arrival at
 * A to arrival at B); nothing in either table says when the bus LEFT A. This
 * replays the production detector (`stepMany`'s own `step`) and the visit
 * reducer (`src/collector/departure.ts`) over the captured `raw_positions`
 * archive and reports:
 *
 *   - departures per route, visits by outcome (stopped / passed / unresolved)
 *   - how often a candidate departure is ambiguous, and the measured
 *     P(departure | k outbound polls) that `DEPARTURE_PRIOR_BY_STEPS` pins
 *   - per stop: stand quantiles for STOPPED visits, and P(stop) — a skipped
 *     stop is a distinct outcome, not a 0 s stand
 *   - per hop: drive mean/sd and hold (mean, P(hold>0)), pooled over the day,
 *     with per-hour counts to show how thin an hourly cell would be
 *   - the reconstruction: travel_sec = approach(A) + stand(A) + rest, exactly,
 *     and against the kerb-to-kerb leg its residual approach(A) − approach(B)
 *   - departure → next arrival at the same stop, against HEADWAY_MIN
 *   - the online departure instant against the retrospective, radius-free
 *     definition from `layover-replay.ts` (plateau walk-back from 250 m)
 *
 *   cd services/shuttle-v2 && TZ=America/New_York REPLAY_DB=./store/snap2.db \
 *     CAPTURE=~/shuttle-captures/positions-20260903.jsonl,~/shuttle-captures/positions-20260904.jsonl \
 *     npx tsx scripts/eta-replay/departure-replay.ts     # -> scripts/.eta-replay/departures.json
 *
 * The capture files overlap (each re-dumps the retention window), so rows are
 * de-duplicated on (bus_id, collected_at). `REPLAY_DB` supplies stops and
 * routes only — and, when its `arrivals` overlap the capture, a cross-check
 * that the replayed detector reproduces production's own events.
 */
// The collector writes dow/hour in ET (Dockerfile TZ); the replay must too.
process.env.TZ ??= "America/New_York";

import fs from "node:fs";
import path from "node:path";

import { OUT_DIR, fmtEt, loadNet } from "./common.js";
import {
  AT_STOP_PIN_M,
  planTracks,
  type BusObservation,
  type BusState,
  type SegmentEvent,
  type ArrivalEvent,
} from "../../src/collector/detector.js";
import {
  HOLD_MIN_SEC,
  DEPART_FAR_M,
  STILL_MIN_MS,
  pruneVisits,
  stepManyWithVisits,
  type CandidateOutcome,
  type LegEvent,
  type StopVisitEvent,
  type VisitState,
} from "../../src/collector/departure.js";
import { distanceMeters } from "../../src/network/geo.js";
import { mean, median, percentile } from "../../src/calibrator/shrinkage.js";
import { ROUTE_ID_LABEL } from "../../web/src/routes";
import { HEADWAY_MIN } from "../../web/src/schedule";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const net = loadNet();
const { db, network } = net;

// -- Corpus --------------------------------------------------------------------
const CAPTURE = (process.env.CAPTURE ??
  [`${process.env.HOME}/shuttle-captures/positions-20260903.jsonl`, `${process.env.HOME}/shuttle-captures/positions-20260904.jsonl`].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

type PosRow = { i: number; b: string; r: number; lat: number; lon: number; h: number; l: number | null; t: number };
const pos: PosRow[] = [];
{
  const seen = new Set<string>();
  let total = 0;
  for (const f of CAPTURE) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      total++;
      const r = JSON.parse(line);
      const k = `${r.bus_id}:${r.collected_at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pos.push({ i: r.bus_id, b: r.bus_name, r: r.route_id, lat: r.lat, lon: r.lon, h: r.heading, l: r.last_stop_id, t: r.collected_at });
    }
  }
  pos.sort((a, b) => a.t - b.t || a.i - b.i);
  log(`corpus ${total} rows, ${pos.length} unique, ${fmtEt(pos[0]!.t)} .. ${fmtEt(pos[pos.length - 1]!.t)} ET`);
}
const rawStart = pos[0]!.t;
const rawEnd = pos[pos.length - 1]!.t;

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
const trackByName = new Map<string, PosRow[]>();
for (const p of pos) {
  let l = trackByName.get(p.b);
  if (!l) trackByName.set(p.b, (l = []));
  l.push(p);
}

// -- Replay --------------------------------------------------------------------
const states = new Map<string, BusState>();
const visitStates = new Map<string, VisitState>();
const arrivals: ArrivalEvent[] = [];
const segments: SegmentEvent[] = [];
const visits: StopVisitEvent[] = [];
const legs: LegEvent[] = [];
const candidates: CandidateOutcome[] = [];
for (const poll of polls) {
  const plan = planTracks(poll);
  const out = stepManyWithVisits(network, states, visitStates, poll, plan);
  for (const e of out.events) {
    if (e.kind === "arrival") arrivals.push(e);
    else if (e.kind === "segment") segments.push(e);
  }
  for (const v of out.visits) (v.kind === "visit" ? visits : legs).push(v as never);
  for (const c of out.resolved) candidates.push(c);
}
for (const v of pruneVisits(visitStates, new Map())) (v.kind === "visit" ? visits : legs).push(v as never);
log(`polls ${polls.length}: arrivals ${arrivals.length}, segments ${segments.length}, visits ${visits.length}, legs ${legs.length}, candidates ${candidates.length}`);

// -- Production cross-check ------------------------------------------------------
// The snapshot's arrivals overlap the capture; production and the replay must
// agree on the detector's events or nothing below is about production.
{
  const prod = db
    .prepare("SELECT bus_name b, stop_id s, arrived_at t FROM arrivals WHERE arrived_at >= ? AND arrived_at <= ?")
    .all(rawStart, rawEnd) as Array<{ b: string; s: number; t: number }>;
  const prodEnd = (db.prepare("SELECT MAX(arrived_at) m FROM arrivals").get() as { m: number }).m;
  const prodSet = new Set(prod.map((a) => `${a.b}|${a.s}|${a.t}`));
  const mine = arrivals.filter((a) => a.arrivedAt <= prodEnd);
  let hit = 0;
  for (const a of mine) if (prodSet.has(`${a.busName}|${a.stopId}|${a.arrivedAt}`)) hit++;
  log(`production cross-check to ${fmtEt(prodEnd)}: replay arrivals ${mine.length}, production ${prod.length}, identical ${hit} (${pct(hit, mine.length)}%)`);
}

// -- Helpers -------------------------------------------------------------------
function pct(a: number, b: number): string {
  return b ? ((100 * a) / b).toFixed(1) : "-";
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
const QS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99] as const;
function quantiles(xs: number[]) {
  if (!xs.length) return null;
  const q: Record<string, number> = {};
  for (const p of QS) q[`p${Math.round(p * 100)}`] = r1(percentile(xs, p));
  return { n: xs.length, mean: r1(mean(xs)), sd: r1(sd(xs)), ...q };
}
const r1 = (x: number) => Math.round(x * 10) / 10;
const label = (rid: number) => ROUTE_ID_LABEL[rid] ?? `route ${rid}`;
/** Red (route 3): the operator's target, reported first and in full. */
const RED = 3;
const stopName = (id: number) => net.stopById.get(id)?.name ?? `#${id}`;
const hourOf = (t: number) => new Date(t).getHours();
const key = (...xs: Array<string | number>) => xs.join("|");
function group<T>(items: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const kk = k(it);
    let l = m.get(kk);
    if (!l) m.set(kk, (l = []));
    l.push(it);
  }
  return m;
}
function counts<T>(items: T[], k: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[k(it)] = (out[k(it)] ?? 0) + 1;
  return out;
}
function md(header: string[], rows: Array<Array<string | number>>): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
const out: Record<string, unknown> = {
  corpus: { rows: pos.length, polls: polls.length, from: fmtEt(rawStart), to: fmtEt(rawEnd), hours: r1((rawEnd - rawStart) / 3_600_000) },
};
const md_: string[] = [];
const say = (s: string) => md_.push(s);

// -- Deliverable: per-stop stand quantiles and per-hop drive, on TWO clocks ---------
//
// The scoring lane (PR #81) conditions on r = now − at_stop_since, so it needs
// stand measured from at_stop_since (`pinnedAt`) — not from the first rest —
// and drive measured from the last at-stop poll to at_stop_since at B. Two
// clocks are written:
//   pinned  stand = departedAt − pinnedAt          drive = toPinnedAt(B) − departedAt(A)
//           (the physical exit, end of the final plateau; at_stop still set
//           for the outbound polls inside 75 m)
//   clear   stand = lastInsideAt − pinnedAt        drive = toPinnedAt(B) − lastInsideAt(A)
//           (exactly when at_stop clears: the consumer's r can never exceed it)
// The rest-to-rest clock (arrivedAt/departedAt, the physical definition) is in
// the sections below and in departures.json.
{
  const TQ = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
  const tq = (xs: number[]) => xs.length ? { n: xs.length, mean: r1(mean(xs)), sd: r1(sd(xs)), q: TQ.map((p) => r1(percentile(xs, p))) } : null;
  const visitByDeparture = new Map<string, StopVisitEvent>();
  for (const v of visits) if (v.departedAt !== null) visitByDeparture.set(key(v.busName, v.departedAt), v);
  const stopsOut: unknown[] = [];
  for (const [k, vs] of group(visits, (v) => key(v.routeId, v.stopIndex))) {
    const [rid, idx] = k.split("|").map(Number) as [number, number];
    const decided = vs.filter((v) => v.outcome !== "unresolved");
    const stopped = vs.filter((v) => v.outcome === "stopped");
    const pinnedStand = stopped.map((v) => (v.departedAt! - v.pinnedAt!) / 1000);
    const clearStand = stopped.map((v) => v.insideSec!);
    const neverPinned = decided.filter((v) => v.pinnedAt === null);
    stopsOut.push({
      routeId: rid, route: label(rid), stopId: vs[0]!.stopId, stop: stopName(vs[0]!.stopId), stopIndex: idx,
      passes: vs.length, decided: decided.length, stopped: stopped.length, passed: decided.length - stopped.length,
      neverPinned: neverPinned.length, neverPinnedClosestM: neverPinned.length ? r1(median(neverPinned.map((v) => v.closestM))) : null,
      pStop: decided.length ? r1((stopped.length / decided.length) * 1000) / 1000 : null,
      quantiles: TQ,
      standPinned: tq(pinnedStand), standClear: tq(clearStand), standRest: tq(stopped.map((v) => v.standSec!)),
    });
  }
  const hopsOut: unknown[] = [];
  for (const [k, ls] of group(legs, (l) => key(l.routeId, l.fromIndex, l.toIndex))) {
    const [rid, fi, ti] = k.split("|").map(Number) as [number, number, number];
    const pinned: number[] = [], clear: number[] = [], holdP: number[] = [];
    for (const l of ls) {
      const arrB = l.toPinnedAt ?? l.arrivedAt;
      const dp = (arrB - l.departedAt) / 1000;
      if (dp > 0) { pinned.push(dp); holdP.push(Math.min(l.holdSec, dp)); }
      const vA = visitByDeparture.get(key(l.busName, l.departedAt));
      const lastInside = vA && vA.pinnedAt !== null && vA.insideSec !== null ? vA.pinnedAt + vA.insideSec * 1000 : l.departedAt;
      // Radii can overlap (344 Winchester → Winchester/Division is 112 m, two
      // 75 m radii): the bus is pinned at B before it clears A. Zero, not dropped.
      clear.push(Math.max(0, (arrB - lastInside) / 1000));
    }
    hopsOut.push({
      routeId: rid, route: label(rid), fromStopId: ls[0]!.fromStopId, from: stopName(ls[0]!.fromStopId), fromIndex: fi,
      toStopId: ls[0]!.toStopId, to: stopName(ls[0]!.toStopId), toIndex: ti, hops: ls[0]!.hops, n: ls.length,
      quantiles: TQ,
      drivePinned: tq(pinned), driveClear: tq(clear), overlapLegs: clear.filter((x) => x === 0).length,
      holdMean: r1(mean(holdP)), pHold: r1((holdP.filter((h) => h > 0).length / Math.max(1, holdP.length)) * 1000) / 1000,
      driveRest: tq(ls.map((l) => l.driveSec)), legRest: tq(ls.map((l) => l.legSec)),
    });
  }
  const tables = {
    corpus: out.corpus, generatedAt: new Date().toISOString(),
    clocks: {
      pinned: "stand = departedAt − at_stop_since; drive = at_stop_since(B) − departedAt(A). departedAt = end of the final resting plateau (at_stop may still be set for ≤ 2 polls after it).",
      clear: "stand = last poll within 75 m − at_stop_since; drive = at_stop_since(B) − that poll. Exactly the consumer's r clock.",
      rest: "stand = departedAt − first rest inside 75 m; drive = first rest at B − departedAt(A), hold split out. The physical definition.",
    },
    note: "stopped = rested ≥ 15 s inside 75 m; passed = never did (stand quantiles exclude them; pStop is their share). drive includes hold (a light, a queue); holdMean/pHold say how much.",
    stops: stopsOut, hops: hopsOut,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "departure-tables.json"), JSON.stringify(tables, null, 1));
  const w = (stopsOut as Array<{ routeId: number; stopIndex: number; stop: string; passes: number; stopped: number; pStop: number | null; standPinned: ReturnType<typeof tq>; standClear: ReturnType<typeof tq>; standRest: ReturnType<typeof tq> }>).find((x) => x.routeId === RED && x.stop.startsWith("344 Winchester"));
  const wh = (hopsOut as Array<{ routeId: number; fromIndex: number; from: string; hops: number; n: number; drivePinned: ReturnType<typeof tq>; driveClear: ReturnType<typeof tq>; driveRest: ReturnType<typeof tq>; holdMean: number; pHold: number }>).find((x) => x.routeId === RED && x.from.startsWith("344 Winchester") && x.hops === 1);
  say(`## Red, 344 Winchester → Winchester / Division — the numbers first
`);
  say(`Quantiles are ${TQ.map((p) => `p${Math.round(p * 100)}`).join("/")}. Written to \`scripts/.eta-replay/departure-tables.json\` for every stop and hop, on all three clocks.
`);
  if (w && wh) {
    say(md(["clock", "stand n", "mean", "sd", "stand quantiles (s)", "drive n", "mean", "sd", "drive quantiles (s)"], [
      ["pinned (at_stop_since → plateau end)", w.standPinned!.n, w.standPinned!.mean, w.standPinned!.sd, w.standPinned!.q.join(" "), wh.drivePinned!.n, wh.drivePinned!.mean, wh.drivePinned!.sd, wh.drivePinned!.q.join(" ")],
      ["clear (at_stop_since → at_stop clears)", w.standClear!.n, w.standClear!.mean, w.standClear!.sd, w.standClear!.q.join(" "), wh.driveClear!.n, wh.driveClear!.mean, wh.driveClear!.sd, wh.driveClear!.q.join(" ")],
      ["rest (first rest → plateau end)", w.standRest!.n, w.standRest!.mean, w.standRest!.sd, w.standRest!.q.join(" "), wh.driveRest!.n, wh.driveRest!.mean, wh.driveRest!.sd, wh.driveRest!.q.join(" ")],
    ]));
    say(`
P(stop) at 344 Winchester ${w.pStop} over ${w.passes} passes; hold on the hop: mean ${wh.holdMean} s, P(hold>0) ${wh.pHold}. Today the hop is served as one number: travel_sec median ${r1(median(segments.filter((s) => s.routeId === RED && stopName(s.fromStopId).startsWith("344 Winchester")).map((s) => s.travelSec)))} s.
`);
  }
  out.tablesPath = "departure-tables.json";
}

// -- 0. The two named validations --------------------------------------------------
say(`## The two named cases\n`);
say(`A hop that is nearly all standing (Red's 344 Winchester layover, 112 m priced at 364–557 s today) and one that is nearly all driving (Pink's VA Entrance Inbound, "42 s" today). Each row is one production segment out of the stop; stand/drive/hold are the derivation's split of it.\n`);
{
  const visitByAnchor = new Map<string, StopVisitEvent>();
  for (const v of visits) visitByAnchor.set(key(v.busName, v.anchoredAt), v);
  const legByDeparture = new Map<string, LegEvent>();
  for (const l of legs) legByDeparture.set(key(l.busName, l.departedAt), l);
  const cases: Record<string, unknown> = {};
  for (const [name, rid] of [["344 Winchester", RED], ["VA Entrance Inbound", 8]] as const) {
    const wc = segments.filter((s) => s.routeId === rid && stopName(s.fromStopId).startsWith(name));
    if (!wc.length) continue;
    const rows: Array<Array<string | number>> = [];
    const stands: number[] = [], drives: number[] = [], holds: number[] = [], travels: number[] = [], approaches: number[] = [];
    let stoppedN = 0, passedN = 0;
    for (const s of wc) {
      const v = visitByAnchor.get(key(s.busName, s.startedAt));
      const l = v && v.departedAt !== null ? legByDeparture.get(key(s.busName, v.departedAt)) : undefined;
      if (v && v.outcome === "stopped") stoppedN++;
      if (v && v.outcome === "passed") passedN++;
      if (v && v.standSec !== null && v.arrivedAt !== null && l) { stands.push(v.standSec); drives.push(l.driveSec); holds.push(l.holdSec); travels.push(s.travelSec); approaches.push((v.arrivedAt - s.startedAt) / 1000); }
      if (rows.length < 14) rows.push([s.busName, fmtEt(s.startedAt).slice(11), stopName(s.toStopId), r1(s.travelSec), v ? v.outcome : "-", v && v.arrivedAt !== null ? r1((v.arrivedAt - s.startedAt) / 1000) : "-", v && v.standSec !== null ? r1(v.standSec) : "-", l ? r1(l.driveSec) : "-", l ? r1(l.holdSec) : "-", v?.how ?? "-", v ? v.restPolls : "-", v ? v.shuffles : "-"]);
    }
    say(`### ${label(rid)}: segments out of ${name}\n\n` + md(["bus", "anchored", "to", "travel_sec", "visit", "approach", "stand", "drive", "hold", "how", "rest polls", "shuffles"], rows));
    say(`\n${wc.length} segments (stopped ${stoppedN}, passed ${passedN}): travel_sec median ${r1(median(travels))}; approach (anchor → rest, mostly the yard beyond 75 m) median ${r1(median(approaches))} (p90 ${r1(percentile(approaches, 0.9))}); stand median ${r1(median(stands))} (p10 ${r1(percentile(stands, 0.1))}, p90 ${r1(percentile(stands, 0.9))}); drive median ${r1(median(drives))} (p10 ${r1(percentile(drives, 0.1))}, p90 ${r1(percentile(drives, 0.9))}); hold mean ${r1(mean(holds))}.`);
    cases[name] = { segments: wc.length, stopped: stoppedN, passed: passedN, travel: quantiles(travels), approach: quantiles(approaches), stand: quantiles(stands), drive: quantiles(drives), hold: quantiles(holds) };
  }
  out.cases = cases;
}

// -- 1. Departures per route, visits by outcome ---------------------------------
say(`\n## Visits and departures per route\n`);
{
  const rows: Array<Array<string | number>> = [];
  const byRoute = group(visits, (v) => String(v.routeId));
  const perRoute: Record<string, unknown> = {};
  for (const [rid, vs] of [...byRoute].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const c = counts(vs, (v) => v.outcome);
    const how = counts(vs.filter((v) => v.departedAt !== null), (v) => v.how!);
    const inside = vs.filter((v) => v.outcome === "passed" && v.arrivedAt !== null).length;
    perRoute[rid] = { label: label(Number(rid)), ...c, passedInside: inside, how };
    rows.push([label(Number(rid)), vs.length, c.stopped ?? 0, (c.passed ?? 0) - inside, inside, c.unresolved ?? 0, how.far ?? 0, how.next ?? 0, how.clock ?? 0, how.gap ?? 0]);
  }
  const c = counts(visits, (v) => v.outcome);
  const how = counts(visits.filter((v) => v.departedAt !== null), (v) => v.how!);
  const inside = visits.filter((v) => v.outcome === "passed" && v.arrivedAt !== null).length;
  rows.push(["**all**", visits.length, c.stopped ?? 0, (c.passed ?? 0) - inside, inside, c.unresolved ?? 0, how.far ?? 0, how.next ?? 0, how.clock ?? 0, how.gap ?? 0]);
  say(md(["route", "passes", "stopped", "passed (never ≤75 m)", "passed (rolled through)", "unresolved", "far", "next", "clock", "gap"], rows));
  out.perRoute = perRoute;
  say(`\nDepartures (visits with a departure instant): ${visits.filter((v) => v.departedAt !== null).length}; of which stopped ≥ 15 s: ${visits.filter((v) => v.outcome === "stopped").length}.`);
}

// -- 2. Candidate ambiguity ------------------------------------------------------
say(`\n## Candidate departures: how often the first fresh fix was a departure\n`);
{
  const c = counts(candidates, (x) => x.outcome);
  say(`Candidates (a fresh fix after the bus had rested at a stop): ${candidates.length} — far ${c.far ?? 0}, next ${c.next ?? 0}, clock ${c.clock ?? 0}, shuffle ${c.shuffle ?? 0}, gap ${c.gap ?? 0}.\n`);
  const rows: Array<Array<string | number>> = [];
  const prior: number[] = [0];
  for (let k = 1; k <= 6; k++) {
    const reached = candidates.filter((x) => x.steps >= k && x.outcome !== "gap");
    const dep = reached.filter((x) => x.outcome !== "shuffle").length;
    prior.push(reached.length ? dep / reached.length : NaN);
    rows.push([k, reached.length, dep, reached.length - dep, pct(dep, reached.length)]);
  }
  say(md(["k outbound polls", "candidates reaching k (decided)", "departures", "shuffles", "P(departure)"], rows));
  // The brief's gate: first fresh fix after ≥ 60 s frozen.
  const long = candidates.filter((x) => x.restSec >= 60);
  const cl = counts(long, (x) => x.outcome);
  const depN = (cl.far ?? 0) + (cl.next ?? 0) + (cl.clock ?? 0);
  say(`\nAfter a plateau of ≥ 60 s (the measured gate): ${long.length} candidates — departures ${depN} (${pct(depN, long.length)}%), shuffles ${cl.shuffle ?? 0} (${pct(cl.shuffle ?? 0, long.length)}%), cut off ${cl.gap ?? 0} (${pct(cl.gap ?? 0, long.length)}%).`);
  const shuffleGap = visits.filter((v) => v.outcome === "stopped" && v.shuffles > 0 && v.firstMovedAt !== null).map((v) => (v.departedAt! - v.firstMovedAt!) / 1000);
  say(`Where a shuffle preceded the exit, seconds from the first movement to the final plateau's end: p10/p50/p90 ${r1(percentile(shuffleGap, 0.1))}/${r1(percentile(shuffleGap, 0.5))}/${r1(percentile(shuffleGap, 0.9))} (n ${shuffleGap.length}).`);
  const first = candidates.filter((x) => x.outcome !== "gap").map((x) => x.firstStepM);
  const fDep = candidates.filter((x) => x.outcome === "far" || x.outcome === "next" || x.outcome === "clock").map((x) => x.firstStepM);
  const fShuf = candidates.filter((x) => x.outcome === "shuffle").map((x) => x.firstStepM);
  say(`First step (m): departures p10/p50/p90 ${r1(percentile(fDep, 0.1))}/${r1(percentile(fDep, 0.5))}/${r1(percentile(fDep, 0.9))}; shuffles ${r1(percentile(fShuf, 0.1))}/${r1(percentile(fShuf, 0.5))}/${r1(percentile(fShuf, 0.9))} (n ${first.length}).`);
  const confirm = visits.filter((v) => v.confirmSec !== null && v.how !== "gap").map((v) => v.confirmSec!);
  say(`Seconds from first fresh fix to confirmation: p50 ${r1(percentile(confirm, 0.5))}, p90 ${r1(percentile(confirm, 0.9))}, max ${r1(Math.max(...confirm))}.`);
  const shuffled = visits.filter((v) => v.outcome === "stopped");
  say(`Stopped visits with ≥ 1 shuffle before leaving: ${shuffled.filter((v) => v.shuffles > 0).length} of ${shuffled.length} (${pct(shuffled.filter((v) => v.shuffles > 0).length, shuffled.length)}%).`);
  out.candidates = { counts: c, priorByStepsMeasured: prior.map((p) => r1(p * 1000) / 1000), gate60: cl };
}

// -- 3. The online instant vs the retrospective plateau walk-back ----------------
say(`\n## Departure instant: online reducer vs retrospective walk-back\n`);
{
  // layover-replay.ts's ground truth, verbatim in spirit: find the first poll
  // > 250 m from the stop, walk back while each earlier poll is at least as
  // close as everything after it, and call the departure the first poll that
  // exceeds that resting distance by > 10 m. Uses no radius the reducer uses.
  const DEPARTED_M = 250, PLATEAU_TOL = 10, HORIZON_MS = 45 * 60_000;
  const lags: number[] = [];
  let compared = 0, noFar = 0;
  for (const v of visits) {
    if (v.outcome !== "stopped" || v.departedAt === null || v.how === "gap") continue;
    const track = trackByName.get(v.busName)!;
    const stop = net.stopById.get(v.stopId)!;
    let a = 0;
    while (a < track.length && track[a]!.t < v.arrivedAt!) a++;
    const d = (k: number) => distanceMeters(track[k]!, stop);
    let far = -1;
    for (let k = a; k < track.length && track[k]!.t - v.arrivedAt! <= HORIZON_MS; k++) {
      if (track[k]!.r !== v.routeId) break;
      if (d(k) > DEPARTED_M) { far = k; break; }
    }
    if (far < 0) { noFar++; continue; }
    let k = far, sufMin = d(far);
    while (k - 1 > a && d(k - 1) <= sufMin) { k--; sufMin = Math.min(sufMin, d(k)); }
    const restD = d(k);
    let dep = far;
    for (let m = k; m <= far; m++) if (d(m) > restD + PLATEAU_TOL) { dep = m; break; }
    // GT departure instant = the last poll before the first outbound poll.
    const gt = track[Math.max(a, dep - 1)]!.t;
    lags.push((v.departedAt - gt) / 1000);
    compared++;
  }
  const exact = lags.filter((x) => x === 0).length;
  const within5 = lags.filter((x) => Math.abs(x) <= 5).length;
  say(`Against the walk-back (first movement that never comes back closer): compared ${compared} stopped departures (${noFar} never reached 250 m before the horizon). reducer − walk-back: identical ${pct(exact, compared)}%, within one poll ${pct(within5, compared)}%, p10/p50/p90 ${r1(percentile(lags, 0.1))}/${r1(percentile(lags, 0.5))}/${r1(percentile(lags, 0.9))} s, later by > 60 s: ${lags.filter((x) => x > 60).length}. The reducer dates a departure from the END of the last plateau, the walk-back from the first outward shuffle that was never undone; the gap between them is the shuffle-to-exit interval above.`);
  out.instantVsWalkback = { compared, noFar, exact, within5, lag: quantiles(lags) };
  // Retrospective last-plateau: the reducer's own definition computed after
  // the fact from the raw track, with no confirmation logic. Agreement here
  // measures the ONLINE machinery — a candidate wrongly refuted, a stutter
  // taken for a shuffle — not the definition.
  const lags2: number[] = [];
  let noFar2 = 0;
  for (const v of visits) {
    if (v.outcome !== "stopped" || v.departedAt === null || v.how === "gap") continue;
    const track = trackByName.get(v.busName)!;
    const stop = net.stopById.get(v.stopId)!;
    let a = 0;
    while (a < track.length && track[a]!.t < v.arrivedAt!) a++;
    const d = (k: number) => distanceMeters(track[k]!, stop);
    let far = -1;
    for (let k = a; k < track.length && track[k]!.t - v.arrivedAt! <= HORIZON_MS; k++) {
      if (track[k]!.r !== v.routeId) break;
      if (d(k) > DEPARTED_M) { far = k; break; }
    }
    if (far < 0) { noFar2++; continue; }
    // Walk back from `far` to the end of the last run of identical fixes of
    // ≥ HOLD_MIN_SEC inside the pin radius.
    let gt: number | null = null;
    for (let k = far - 1; k > a; k--) {
      if (d(k) > AT_STOP_PIN_M) continue;
      let j = k;
      while (j - 1 >= a && track[j - 1]!.lat === track[k]!.lat && track[j - 1]!.lon === track[k]!.lon) j--;
      if (track[k]!.t - track[j]!.t >= STILL_MIN_MS) { gt = track[k]!.t; break; }
      k = j;
    }
    if (gt === null) { noFar2++; continue; }
    lags2.push((v.departedAt - gt) / 1000);
  }
  void DEPART_FAR_M;
  say(`Against the retrospective last plateau (same definition, computed after the fact): n ${lags2.length}, identical ${pct(lags2.filter((x) => x === 0).length, lags2.length)}%, within one poll ${pct(lags2.filter((x) => Math.abs(x) <= 5).length, lags2.length)}%, p10/p50/p90 ${r1(percentile(lags2, 0.1))}/${r1(percentile(lags2, 0.5))}/${r1(percentile(lags2, 0.9))} s, |lag| > 30 s: ${lags2.filter((x) => Math.abs(x) > 30).length}.`);
  out.instantVsLastPlateau = { n: lags2.length, lag: quantiles(lags2) };
}

// -- 4. Per stop: stand -----------------------------------------------------------
say(`\n## Per stop: stand (stopped visits only) and P(stop)\n`);
{
  const perStop: Record<string, unknown> = {};
  const rows: Array<Array<string | number>> = [];
  const redRows: Array<Array<string | number>> = [];
  const byStop = group(visits, (v) => key(v.routeId, v.stopIndex));
  const cellN: number[] = [];
  const hourCellN: number[] = [];
  for (const [k, vs] of byStop) {
    const [rid, idx] = k.split("|").map(Number) as [number, number];
    const decided = vs.filter((v) => v.outcome !== "unresolved");
    const stopped = vs.filter((v) => v.outcome === "stopped");
    const stands = stopped.map((v) => v.standSec!);
    const byHour = counts(stopped, (v) => String(hourOf(v.arrivedAt!)));
    cellN.push(stopped.length);
    for (const n of Object.values(byHour)) hourCellN.push(n);
    perStop[k] = {
      route: label(rid), stopId: vs[0]!.stopId, stop: stopName(vs[0]!.stopId), stopIndex: idx,
      passes: vs.length, decided: decided.length, stopped: stopped.length, pStop: decided.length ? r1((stopped.length / decided.length) * 1000) / 1000 : null,
      stand: quantiles(stands), standAllDecided: quantiles(decided.map((v) => v.standSec!)),
      firstMoveStand: quantiles(stopped.filter((v) => v.firstMovedAt !== null).map((v) => (v.firstMovedAt! - v.arrivedAt!) / 1000)),
      byHour,
    };
    const inside15 = decided.filter((v) => v.insideSec !== null && v.insideSec >= 15).length;
    (perStop[k] as Record<string, unknown>).pStopInside15 = decided.length ? r1((inside15 / decided.length) * 1000) / 1000 : null;
    if (decided.length >= 5) {
      const q = quantiles(stands);
      const row = [label(rid), `${stopName(vs[0]!.stopId)} [${idx}]`, decided.length, stopped.length, pct(stopped.length, decided.length), pct(inside15, decided.length), q ? q.p10 : "-", q ? q.p25 : "-", q ? q.p50 : "-", q ? q.p75 : "-", q ? q.p90 : "-", q ? q.mean : "-"];
      if (rid === RED) redRows.push([idx, ...row.slice(1)]);
      else rows.push(row);
    }
  }
  redRows.sort((a, b) => Number(a[0]) - Number(b[0]));
  say(`### Red, every stop in sequence order\n`);
  say(md(["idx", "stop", "passes", "stopped", "P(stop) %", "P(≥15 s inside 75 m) %", "stand p10", "p25", "p50", "p75", "p90", "mean"], redRows));
  rows.sort((a, b) => Number(b[2]) - Number(a[2]));
  say(`\n### Other routes, top 30 by passes\n`);
  say(md(["route", "stop [index]", "passes", "stopped", "P(stop) %", "P(≥15 s inside) %", "stand p10", "p25", "p50", "p75", "p90", "mean"], rows.slice(0, 30)));
  say(`\n(${rows.length + redRows.length} stops with ≥ 5 decided passes; all in the JSON.)`);
  const skipped = Object.values(perStop as Record<string, { route: string; stop: string; decided: number; pStop: number | null }>).filter((s) => s.decided >= 5 && s.pStop !== null && s.pStop < 0.5);
  say(`\nStops skipped more often than not (P(stop) < 0.5, ≥ 5 passes): ${skipped.length} of ${rows.length} — ${skipped.map((s) => `${s.stop} (${s.route}) ${s.pStop}`).join("; ")}.`);
  say(`\nSparsity, pooled over the day: stops with ≥5 stopped visits ${cellN.filter((n) => n >= 5).length}/${cellN.length}, ≥10 ${cellN.filter((n) => n >= 10).length}. Per (stop, hour) cells: n≥5 in ${hourCellN.filter((n) => n >= 5).length}/${hourCellN.length}, median n ${median(hourCellN)}.`);
  out.perStop = perStop;
  out.standSparsity = { stopsWithData: cellN.length, ge5: cellN.filter((n) => n >= 5).length, ge10: cellN.filter((n) => n >= 10).length, hourCells: hourCellN.length, hourCellsGe5: hourCellN.filter((n) => n >= 5).length, hourCellMedian: median(hourCellN) };
  const all = visits.filter((v) => v.outcome === "stopped").map((v) => v.standSec!);
  say(`\nAll stopped visits pooled (n ${all.length}): stand p10/p25/p50/p75/p90/p99 ${[0.1, 0.25, 0.5, 0.75, 0.9, 0.99].map((p) => r1(percentile(all, p))).join("/")} s.`);
}

// -- 5. Per hop: drive and hold -----------------------------------------------------
say(`\n## Per hop: drive and hold (kerb to kerb), pooled over the day\n`);
{
  const perHop: Record<string, unknown> = {};
  const rows: Array<Array<string | number>> = [];
  const redRows: Array<Array<string | number>> = [];
  const byHop = group(legs, (l) => key(l.routeId, l.fromIndex, l.toIndex));
  const cellN: number[] = [];
  const hourCellN: number[] = [];
  for (const [k, ls] of byHop) {
    const [rid, fi, ti] = k.split("|").map(Number) as [number, number, number];
    const drive = ls.map((l) => l.driveSec);
    const hold = ls.map((l) => l.holdSec);
    const withHold = ls.filter((l) => l.holdSec > 0);
    const byHour = counts(ls, (l) => String(hourOf(l.departedAt)));
    cellN.push(ls.length);
    for (const n of Object.values(byHour)) hourCellN.push(n);
    perHop[k] = {
      route: label(rid), from: stopName(ls[0]!.fromStopId), fromIndex: fi, to: stopName(ls[0]!.toStopId), toIndex: ti, hops: ls[0]!.hops,
      n: ls.length, reached: ls.filter((l) => l.reached).length,
      leg: quantiles(ls.map((l) => l.legSec)), drive: quantiles(drive),
      hold: { mean: r1(mean(hold)), pHold: r1((withHold.length / ls.length) * 1000) / 1000, meanGivenHold: withHold.length ? r1(mean(withHold.map((l) => l.holdSec))) : null, p90: r1(percentile(hold, 0.9)) },
      byHour,
    };
    if (ls.length >= 5) {
      const row = [label(rid), `${stopName(ls[0]!.fromStopId)} → ${stopName(ls[0]!.toStopId)}`, ls[0]!.hops, ls.length, r1(mean(drive)), r1(sd(drive)), r1(percentile(drive, 0.1)), r1(percentile(drive, 0.5)), r1(percentile(drive, 0.9)), r1(mean(hold)), pct(withHold.length, ls.length), withHold.length ? r1(mean(withHold.map((l) => l.holdSec))) : "-", r1(mean(ls.map((l) => l.legSec)))];
      if (rid === RED) redRows.push([fi, ...row.slice(1)]);
      else rows.push(row);
    }
  }
  redRows.sort((a, b) => Number(a[0]) - Number(b[0]));
  say(`### Red, every hop in sequence order\n`);
  say(md(["from idx", "hop", "hops", "n", "drive mean", "sd", "p10", "p50", "p90", "hold mean", "P(hold>0) %", "hold | >0", "leg mean"], redRows));
  rows.sort((a, b) => Number(b[3]) - Number(a[3]));
  say(`\n### Other routes, top 30 by legs\n`);
  say(md(["route", "hop", "hops", "n", "drive mean", "sd", "p10", "p50", "p90", "hold mean", "P(hold>0) %", "hold | >0", "leg mean"], rows.slice(0, 30)));
  say(`\n(${rows.length + redRows.length} hops with ≥ 5 legs; all in the JSON.)`);
  say(`\nSparsity: hops with ≥5 legs ${cellN.filter((n) => n >= 5).length}/${cellN.length}, ≥10 ${cellN.filter((n) => n >= 10).length}; per (hop, hour) cells n≥5 in ${hourCellN.filter((n) => n >= 5).length}/${hourCellN.length}, median n ${median(hourCellN)}. Traversals per hop per hour, median: ${r1(median(cellN.map((n) => n / ((rawEnd - rawStart) / 3_600_000))))}.`);
  const allDrive = legs.map((l) => l.driveSec), allHold = legs.map((l) => l.holdSec), allLeg = legs.map((l) => l.legSec);
  say(`\nAll legs pooled (n ${legs.length}, 1-hop ${legs.filter((l) => l.hops === 1).length}): leg mean ${r1(mean(allLeg))} sd ${r1(sd(allLeg))}; drive mean ${r1(mean(allDrive))} sd ${r1(sd(allDrive))}; hold mean ${r1(mean(allHold))}, P(hold>0) ${pct(legs.filter((l) => l.holdSec > 0).length, legs.length)}%, hold share of leg seconds ${pct(allHold.reduce((a, b) => a + b, 0), allLeg.reduce((a, b) => a + b, 0))}%.`);
  out.perHop = perHop;
  out.hopSparsity = { hopsWithData: cellN.length, ge5: cellN.filter((n) => n >= 5).length, ge10: cellN.filter((n) => n >= 10).length, hourCells: hourCellN.length, hourCellsGe5: hourCellN.filter((n) => n >= 5).length, hourCellMedian: median(hourCellN) };

  // Hold sensitivity + an independent recomputation of the reducer's hold from the raw track.
  let agree = 0, checked = 0;
  const hold25: number[] = [];
  for (const l of legs) {
    const track = trackByName.get(l.busName)!;
    let s = 0;
    while (s < track.length && track[s]!.t < l.departedAt) s++;
    let e = s;
    while (e < track.length && track[e]!.t <= l.arrivedAt) e++;
    const runs: Array<[number, number]> = [];
    let i = s;
    while (i < e) {
      let j = i;
      while (j + 1 < e && track[j + 1]!.lat === track[i]!.lat && track[j + 1]!.lon === track[i]!.lon) j++;
      runs.push([track[i]!.t, track[j]!.t]);
      i = j + 1;
    }
    // A run that began before the leg's first poll: the reducer sees it start at the previous poll.
    const h15 = runs.reduce((acc, [a, b]) => acc + (b - a >= STILL_MIN_MS ? (b - a) / 1000 : 0), 0);
    const h25 = runs.reduce((acc, [a, b]) => acc + (b - a >= 25_000 ? (b - a) / 1000 : 0), 0);
    hold25.push(h25);
    checked++;
    if (Math.abs(h15 - l.holdSec) < 0.5) agree++;
  }
  say(`\nHold recomputed independently from the raw track (frozen runs ≥ ${HOLD_MIN_SEC} s less a poll of jitter): agrees with the reducer on ${pct(agree, checked)}% of legs. With a 25 s minimum run instead: hold mean ${r1(mean(hold25))}, P(hold>0) ${pct(hold25.filter((h) => h > 0).length, hold25.length)}%.`);
  out.holdCheck = { agree, checked, hold25Mean: r1(mean(hold25)) };
}

// -- 6. Reconstruction of travel_sec ------------------------------------------------
say(`\n## Reconstruction: what the arrival-to-arrival segment contains\n`);
{
  const visitByAnchor = new Map<string, StopVisitEvent>();
  for (const v of visits) visitByAnchor.set(key(v.busName, v.anchoredAt), v);
  const legByDeparture = new Map<string, LegEvent>();
  for (const l of legs) legByDeparture.set(key(l.busName, l.departedAt), l);
  let passThrough = 0, standingThrough = 0, unresolved = 0, decomposed = 0, other = 0;
  const approachA: number[] = [], stand: number[] = [], rest: number[] = [], residual: number[] = [], travel: number[] = [], legSecs: number[] = [];
  const standShare: number[] = [];
  const decomp: Array<{ routeId: number; from: number; to: number; travel: number; stand: number; leg: number }> = [];
  let identityFail = 0;
  for (const s of segments) {
    const eB = s.startedAt + s.travelSec * 1000;
    const v = visitByAnchor.get(key(s.busName, s.startedAt));
    if (!v || v.stopId !== s.fromStopId) { other++; continue; }
    if (v.arrivedAt === null) { passThrough++; travel.push(s.travelSec); continue; }
    if (v.outcome === "unresolved") { unresolved++; continue; }
    if (v.departedAt! >= eB) { standingThrough++; continue; }
    decomposed++;
    const ap = (v.arrivedAt - s.startedAt) / 1000;
    const st = v.standSec!;
    const re = (eB - v.departedAt!) / 1000;
    if (Math.abs(ap + st + re - s.travelSec) > 1e-6) identityFail++;
    approachA.push(ap); stand.push(st); rest.push(re); travel.push(s.travelSec);
    standShare.push(st / s.travelSec);
    const l = legByDeparture.get(key(s.busName, v.departedAt!));
    if (l && l.toStopId === s.toStopId) { legSecs.push(l.legSec); residual.push(s.travelSec - (st + l.legSec)); decomp.push({ routeId: s.routeId, from: s.fromStopId, to: s.toStopId, travel: s.travelSec, stand: st, leg: l.legSec }); }
  }
  const n = segments.length;
  say(`${n} segments: decomposed ${decomposed} (${pct(decomposed, n)}%), pass-through at A (no stand) ${passThrough} (${pct(passThrough, n)}%), still standing at A when the anchor moved on ${standingThrough} (${pct(standingThrough, n)}%), unresolved ${unresolved}, no matching visit ${other}. Identity approach + stand + rest = travel_sec failed on ${identityFail}.`);
  const q = (xs: number[]) => { const o = quantiles(xs); return o ? `n ${o.n}, mean ${o.mean}, sd ${o.sd}, p10/p50/p90 ${o.p10}/${o.p50}/${o.p90}` : "-"; };
  say(`\n- approach(A), anchor → 75 m of A: ${q(approachA)}`);
  say(`- stand(A): ${q(stand)}`);
  say(`- rest, departure → anchor at B: ${q(rest)}`);
  say(`- travel_sec of those segments: ${q(stand.map((x, i) => x + approachA[i]! + rest[i]!))}`);
  say(`- kerb leg A → B (drive + hold): ${q(legSecs)}`);
  say(`- residual travel_sec − (stand + leg) = approach(A) − approach(B): ${q(residual)}`);
  const vT = sd(stand.map((x, i) => x + approachA[i]! + rest[i]!)) ** 2;
  const vS = sd(stand) ** 2, vR = sd(rest) ** 2, vA = sd(approachA) ** 2;
  say(`\nVariance of travel_sec across decomposed segments: ${r1(vT)} s²; of stand alone ${r1(vS)} (${pct(vS, vT)}%), of rest ${r1(vR)} (${pct(vR, vT)}%), of approach ${r1(vA)} (${pct(vA, vT)}%); stand's share of a segment's seconds: mean ${pct(mean(standShare), 1)}%, p90 ${pct(percentile(standShare, 0.9), 1)}%.`);
  // Within-hop: pooled variance of travel_sec about each hop's own mean, and
  // the share of it that stand alone accounts for — the estimator's residual
  // after it has looked the hop up (docs/eta-error-budget.md's 72.5%).
  {
    const rowsByHop = group(decomp, (x) => key(x.routeId, x.from, x.to));
    let ssT = 0, ssS = 0, ssL = 0, dof = 0;
    for (const [, xs] of rowsByHop) {
      if (xs.length < 2) continue;
      const mT = mean(xs.map((x) => x.travel)), mS = mean(xs.map((x) => x.stand)), mL = mean(xs.map((x) => x.leg));
      for (const x of xs) { ssT += (x.travel - mT) ** 2; ssS += (x.stand - mS) ** 2; ssL += (x.leg - mL) ** 2; }
      dof += xs.length - 1;
    }
    say(`\nWithin-hop (about each hop's own mean, ${dof} dof): travel_sec sd ${r1(Math.sqrt(ssT / dof))} s; stand alone accounts for ${pct(ssS, ssT)}% of that variance, the kerb leg (drive + hold) for ${pct(ssL, ssT)}%.`);
    out.withinHop = { dof, sdTravel: r1(Math.sqrt(ssT / dof)), standShare: r1((100 * ssS) / ssT), legShare: r1((100 * ssL) / ssT) };
  }
  out.reconstruction = { segments: n, decomposed, passThrough, standingThrough, unresolved, other, identityFail, approachA: quantiles(approachA), stand: quantiles(stand), rest: quantiles(rest), leg: quantiles(legSecs), residual: quantiles(residual), varTravel: r1(vT), varStand: r1(vS), varRest: r1(vR) };

  void 0;
}

// -- 7. Departure → next arrival at the same stop, vs headway ----------------------
say(`\n## Departure → next arrival at the same stop, against HEADWAY_MIN\n`);
{
  const byStop = group(visits.filter((v) => v.arrivedAt !== null), (v) => key(v.routeId, v.stopIndex));
  const gapsByRoute = new Map<number, number[]>();
  for (const [, vs] of byStop) {
    const arr = vs.map((v) => v.arrivedAt!).sort((a, b) => a - b);
    for (const v of vs) {
      if (v.outcome !== "stopped" || v.departedAt === null) continue;
      const next = arr.find((t) => t > v.departedAt!);
      if (next === undefined) continue;
      let l = gapsByRoute.get(v.routeId);
      if (!l) gapsByRoute.set(v.routeId, (l = []));
      l.push((next - v.departedAt) / 60_000);
    }
  }
  const rows: Array<Array<string | number>> = [];
  const hw: Record<string, unknown> = {};
  for (const [rid, gaps] of [...gapsByRoute].sort((a, b) => a[0] - b[0])) {
    const lb = label(rid);
    rows.push([lb, gaps.length, r1(percentile(gaps, 0.5)), r1(percentile(gaps, 0.1)), r1(percentile(gaps, 0.9)), HEADWAY_MIN[lb] ?? "-"]);
    hw[rid] = { label: lb, n: gaps.length, p50: r1(percentile(gaps, 0.5)), p10: r1(percentile(gaps, 0.1)), p90: r1(percentile(gaps, 0.9)), headwayMin: HEADWAY_MIN[lb] ?? null };
  }
  say(md(["route", "n", "gap p50 (min)", "p10", "p90", "HEADWAY_MIN"], rows));
  out.headway = hw;
  const legMed = group(legs.filter((l) => l.hops === 1), (l) => String(l.routeId));
  say(`\nOne-hop kerb-to-kerb leg medians (s): ` + [...legMed].sort((a, b) => Number(a[0]) - Number(b[0])).map(([rid, ls]) => `${label(Number(rid))} ${r1(median(ls.map((l) => l.legSec)))} (n ${ls.length})`).join("; ") + ".");
}

// -- Write -------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });
const jsonPath = path.join(OUT_DIR, process.env.OUT_NAME ?? "departures.json");
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 1));
const mdPath = path.join(OUT_DIR, (process.env.OUT_NAME ?? "departures.json").replace(/\.json$/, ".md"));
fs.writeFileSync(mdPath, md_.join("\n") + "\n");
console.log(md_.join("\n"));
log(`wrote ${jsonPath} and ${mdPath}`);
