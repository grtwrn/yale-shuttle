/**
 * HOW MUCH OF THE FOLD AMBIGUITY IS DECIDABLE AT ALL?
 *
 * `docs/eta-estimator-design.md` says the stationary half of the fold cannot be
 * settled by geometry, by a threshold or by direction, and that the honest
 * answer there is a distribution. This script asks the distribution what it
 * knows: it drives the candidate client the way the app drives it (one shared
 * `AnchorStore`, `computeUpcomingArrivals` every poll) and reads the belief
 * back out with `peekBelief`, per route and per poll:
 *
 *   split      the belief carries more than one branch at all
 *   undecided  no branch reaches SWITCH_AT — nothing in the feed can choose
 *   agrees     the leading branch is the one production is showing
 *
 * It exists to BOUND the lane. If the belief is nearly always decided and
 * nearly always agrees with production, there is no headroom in a better
 * decision rule and the answer is not a filter (see docs/eta-estimator-imm.md).
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap3.db npx tsx scripts/eta-replay/belief-split.ts
 *
 * Env: CAPTURE, REPLAY_DB, ROUTES (default Green,Purple,Red), FROM/TO (ISO).
 */
import fs from "node:fs";

import { loadNet } from "./common.js";
import { dedupeAndSort, groupPolls, parseCaptureLine, type PosRow } from "./rider-sim/lib.js";
import { computeUpcomingArrivals } from "../../web/src/arrivals";
import { peekBelief, SWITCH_AT } from "../../web/src/estimator";
import { registerRoutePaths } from "../../web/src/anchor";
import type { AnchorStore } from "../../web/src/anchorGate";
import type { BusData } from "../../web/src/map-data";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes";
import { planTracks, stepMany, type BusState } from "../../src/collector/detector.js";
import { distanceMeters } from "../../src/network/geo.js";

const log = (...a: unknown[]) => console.error("[belief-split]", ...a);
const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;
/** Under this displacement the feed has published nothing new — the bus is standing. */
const MOVED_M = 30;

const net = loadNet();
registerRoutePaths(net.routePaths);
const wanted = (process.env.ROUTES ?? "Green,Purple,Red").split(",").map((s) => s.trim()).filter(Boolean);
const cfgs = ROUTE_LISTS.filter((c) => wanted.includes("all") || wanted.includes(c.label));
const stopsOf = new Map(cfgs.map((c) => [c.label, mergedRouteStops(c, net.routeStops)] as const));

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()
      .map((f) => `${process.env.HOME}/shuttle-captures/${f}`)
).map((f) => f.trim()).filter(Boolean);
let raw: PosRow[] = [];
for (const f of captureFiles) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
  const r = parseCaptureLine(line);
  if (r) raw.push(r);
}
const rows = dedupeAndSort(raw);
raw = [];
const polls = groupPolls(rows);
const FROM = process.env.FROM ? Date.parse(process.env.FROM) : -Infinity;
const TO = process.env.TO ? Date.parse(process.env.TO) : Infinity;
log(`${rows.length} positions, ${polls.length} polls, routes ${cfgs.map((c) => c.label).join(",")}`);

interface Tally {
  polls: number; split: number; undecided: number; disagrees: number;
  movedPolls: number; movedSplit: number; movedUndecided: number;
  stillPolls: number; stillSplit: number; stillUndecided: number;
}
const tally = new Map<string, Tally>();
const get = (label: string): Tally => {
  let t = tally.get(label);
  if (!t) tally.set(label, (t = {
    polls: 0, split: 0, undecided: 0, disagrees: 0,
    movedPolls: 0, movedSplit: 0, movedUndecided: 0,
    stillPolls: 0, stillSplit: 0, stillUndecided: 0,
  }));
  return t;
};

const states = new Map<string, BusState>();
const store: AnchorStore = new Map();
const lastCoord = new Map<string, { lat: number; lon: number }>();
const segmentTimes = {};
const dwellTimes = {};

for (const poll of polls) {
  const t = poll[0]!.t;
  const obs = poll.map((p) => ({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t }));
  const plan = planTracks(obs);
  stepMany(net.network, states as never, obs, plan);
  if (t < FROM || t > TO) continue;

  const buses: BusData[] = [];
  for (const o of obs) {
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    if (!st) continue;
    const cand = t - st.enteredAt >= AT_STOP_MIN_DWELL_MS ? net.stopById.get(st.nearestStopId) : undefined;
    const at = cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? st.nearestStopId : null;
    buses.push({
      bus_id: o.busId, bus_name: o.busName, route_id: o.routeId, lat: o.lat, lon: o.lon,
      heading: o.heading, last_stop_id: o.lastStopId as number, stationary: at != null,
      ...(at != null ? { at_stop_id: at, at_stop_since: new Date(st.stationarySince).toISOString().replace(/Z$/, "") } : {}),
    } as BusData);
  }

  for (const cfg of cfgs) {
    const stops = stopsOf.get(cfg.label)!;
    // Ask for every stop on the line, which is what forces the client to place
    // every bus on it — the app's route card does exactly this.
    computeUpcomingArrivals(stops, buses, net.routeStops, net.stopCoords, segmentTimes, t, dwellTimes, store);
    for (const b of buses) {
      if (!cfg.busRouteIds.includes(b.route_id)) continue;
      const belief = peekBelief(store, `${cfg.label}|${b.bus_name}`);
      if (!belief || belief.length === 0) continue;
      const gkey = `${cfg.label}|${b.bus_name}`;
      const seen = lastCoord.get(gkey);
      const movedM = seen ? Math.hypot((b.lat - seen.lat) * 111_000, (b.lon - seen.lon) * 84_000) : Infinity;
      lastCoord.set(gkey, { lat: b.lat, lon: b.lon });
      const moving = movedM >= MOVED_M;
      const top = belief.reduce((a, x) => (x.w > a.w ? x : a), belief[0]!);
      const split = belief.length > 1;
      const undecided = split && top.w < SWITCH_AT;
      const gated = store.get(gkey);
      const tl = get(cfg.label);
      tl.polls++;
      if (split) tl.split++;
      if (undecided) tl.undecided++;
      if (gated && gated.index >= 0 && top.leg !== gated.index) tl.disagrees++;
      if (moving) { tl.movedPolls++; if (split) tl.movedSplit++; if (undecided) tl.movedUndecided++; }
      else { tl.stillPolls++; if (split) tl.stillSplit++; if (undecided) tl.stillUndecided++; }
    }
  }
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "—");
console.log(`\nwhat the belief knows (SWITCH_AT ${SWITCH_AT}) — one shared store, every poll\n`);
console.log("  route          polls    split   undecided   disagrees with the gate | moving: split/undec | standing: split/undec");
for (const label of [...tally.keys()].sort()) {
  const t = tally.get(label)!;
  console.log(
    `  ${label.padEnd(12)} ${String(t.polls).padStart(7)}` +
    `  ${pct(t.split, t.polls).padStart(5)}%  ${pct(t.undecided, t.polls).padStart(6)}%` +
    `      ${pct(t.disagrees, t.polls).padStart(6)}%` +
    `        | ${pct(t.movedSplit, t.movedPolls).padStart(5)}% / ${pct(t.movedUndecided, t.movedPolls).padStart(5)}%` +
    `  | ${pct(t.stillSplit, t.stillPolls).padStart(5)}% / ${pct(t.stillUndecided, t.stillPolls).padStart(5)}%`,
  );
}
