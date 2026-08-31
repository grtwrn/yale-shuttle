/**
 * Replay harness for the vehicle-identity fix.
 *
 * Upstream's `bus_id` is reissued per service block, so keying detector state
 * on it throws a bus's anchor away several times a day. This feeds recorded
 * `raw_positions` through the REAL detector under three keying strategies and
 * reports what each one does to the calibration tables:
 *
 *   byBusId  — the old behaviour: one state slot per upstream id.
 *   naive    — keyed on the stable `bus_name`, inheriting the anchor across
 *              every id reissue with no continuity check.
 *   fixed    — what ships: keyed on `bus_name` (id-qualified while two ids
 *              contend for one name), inheriting the anchor only across a
 *              reissue that is continuous in time and space.
 *
 * Usage:
 *   npx tsx scripts/id-churn-replay.ts <replay.json>
 *
 * `replay.json` is `{ stops, routes, pos }` dumped read-only from the
 * production SQLite, where each `pos` row is
 * `[bus_id, bus_name, route_id, lat, lon, heading, last_stop_id, collected_at]`.
 */
import fs from "node:fs";

import {
  step,
  stepMany,
  planTracks,
  type BusObservation,
  type BusState,
  type DetectorEvent,
} from "../src/collector/detector.js";
import { distanceMeters } from "../src/network/geo.js";
import { TransitNetwork } from "../src/network/TransitNetwork.js";
import type { Route, Stop } from "../src/schema/api.js";

type PosRow = [number, string, number, number, number, number, number | null, number];

interface Dump {
  stops: Stop[];
  routes: Array<{
    id: number;
    name: string;
    shortName: string;
    color: string;
    stopsJson: string;
  }>;
  pos: PosRow[];
}

const file = process.argv[2];
if (!file) throw new Error("usage: id-churn-replay.ts <replay.json>");

const dump = JSON.parse(fs.readFileSync(file, "utf8")) as Dump;
const routes: Route[] = dump.routes.map((r) => ({
  id: r.id,
  name: r.name,
  shortName: r.shortName,
  color: r.color,
  stops: JSON.parse(r.stopsJson) as number[],
}));
const net = TransitNetwork.build(dump.stops, routes);
const stopById = new Map(dump.stops.map((s) => [s.id, s]));

// Regroup rows into polls. The collector stamps every row of one tick with the
// same `collected_at`, so this reconstructs the real batches — which matters,
// because contention between two ids for one name is defined per poll.
const polls: BusObservation[][] = [];
{
  let current: BusObservation[] = [];
  let currentAt = -1;
  for (const [busId, busName, routeId, lat, lon, heading, lastStopId, collectedAt] of dump.pos) {
    if (collectedAt !== currentAt) {
      if (current.length > 0) polls.push(current);
      current = [];
      currentAt = collectedAt;
    }
    current.push({ busId, busName, routeId, lat, lon, heading, lastStopId, collectedAt });
  }
  if (current.length > 0) polls.push(current);
}

interface Result {
  segments: number;
  /** Distinct route:from→to legs with at least one sample. */
  legs: number;
  /** Segments whose straight-line speed exceeds 60 km/h — impossible samples. */
  implausible: number;
  arrivals: number;
  dwells: number;
  /** Total travel seconds recorded. Inflates when a layover is billed as travel. */
  segmentSec: number;
  medianSegmentSec: number;
  /** Segments whose window covers a >60 s hole in the feed for that vehicle. */
  segmentsSpanningFeedGap: number;
}

function summarise(events: DetectorEvent[], gapWindows: Array<[string, number, number]>): Result {
  const legs = new Set<string>();
  let segments = 0;
  let implausible = 0;
  let arrivals = 0;
  let dwells = 0;
  let segmentSec = 0;
  let spanning = 0;
  const durations: number[] = [];
  for (const e of events) {
    if (e.kind === "arrival") {
      arrivals++;
      continue;
    }
    if (e.kind === "dwell") {
      dwells++;
      continue;
    }
    segments++;
    segmentSec += e.travelSec;
    durations.push(e.travelSec);
    legs.add(`${e.routeId}:${e.fromStopId}->${e.toStopId}`);
    const a = stopById.get(e.fromStopId);
    const b = stopById.get(e.toStopId);
    if (a && b && distanceMeters(a, b) / e.travelSec > 60_000 / 3600) implausible++;
    const endedAt = e.startedAt + e.travelSec * 1000;
    if (
      gapWindows.some(
        ([name, from, to]) => name === e.busName && from >= e.startedAt && to <= endedAt,
      )
    )
      spanning++;
  }
  durations.sort((x, y) => x - y);
  return {
    segments,
    legs: legs.size,
    implausible,
    arrivals,
    dwells,
    segmentSec: Math.round(segmentSec),
    medianSegmentSec: durations.length ? Math.round(durations[durations.length >> 1]!) : 0,
    segmentsSpanningFeedGap: spanning,
  };
}

/** Holes >60 s in a single vehicle's feed, by fleet number. */
const gapWindows: Array<[string, number, number]> = [];
{
  const lastSeen = new Map<string, number>();
  for (const poll of polls) {
    for (const o of poll) {
      const prev = lastSeen.get(o.busName);
      if (prev !== undefined && o.collectedAt - prev > 60_000) {
        gapWindows.push([o.busName, prev, o.collectedAt]);
      }
      lastSeen.set(o.busName, o.collectedAt);
    }
  }
}

/** Old keying: one state slot per upstream bus id, no identity continuity. */
function runByBusId(): DetectorEvent[] {
  const states = new Map<string, BusState>();
  const out: DetectorEvent[] = [];
  for (const poll of polls) {
    for (const obs of poll) {
      const key = String(obs.busId);
      const { state, events } = step(net, states.get(key) ?? null, obs);
      if (state) states.set(key, state);
      else states.delete(key);
      out.push(...events);
    }
  }
  return out;
}

/**
 * Name keying with the continuity check defeated. Achieved by relabelling the
 * observation with the tracked id, which is precisely the assumption "a
 * reissued id is always the same bus, carrying on where it left off".
 */
function runNaiveByName(): DetectorEvent[] {
  const states = new Map<string, BusState>();
  const out: DetectorEvent[] = [];
  for (const poll of polls) {
    for (const obs of poll) {
      const key = obs.busName;
      const prev = states.get(key) ?? null;
      const masked = prev ? { ...obs, busId: prev.busId } : obs;
      const { state, events } = step(net, prev, masked);
      if (state) states.set(key, state);
      else states.delete(key);
      out.push(...events);
    }
  }
  return out;
}

/** What ships: the real `stepMany`, keys and continuity checks included. */
function runFixed(): DetectorEvent[] {
  const states = new Map<string, BusState>();
  const out: DetectorEvent[] = [];
  for (const poll of polls) {
    out.push(...stepMany(net, states, poll, planTracks(poll)));
  }
  return out;
}

const first = dump.pos[0]![7];
const last = dump.pos[dump.pos.length - 1]![7];
console.log(
  JSON.stringify(
    {
      polls: polls.length,
      positions: dump.pos.length,
      windowHours: Number(((last - first) / 3_600_000).toFixed(2)),
      vehicleFeedGapsOver60s: gapWindows.length,
      byBusId: summarise(runByBusId(), gapWindows),
      naiveByName: summarise(runNaiveByName(), gapWindows),
      fixed: summarise(runFixed(), gapWindows),
    },
    null,
    1,
  ),
);
