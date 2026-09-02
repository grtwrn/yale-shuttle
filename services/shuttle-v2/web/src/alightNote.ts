// Why the planner told you to get off HERE and not at the stop nearer your
// destination.
//
// Report #59: a rider bound for 517 Prospect was sent to "344 Winchester",
// 562 m from the door, when the same Red loop stops at "Division / Prospect"
// 207 m away three stops later. They guessed the reason themselves — "did it
// suggest this one because the shuttle waits a long time?" — and they were
// right. 344 Winchester is a layover: median dwell 460 s, and the 112 m hop
// out of it is billed at 513 s (n=30), i.e. 0.22 m/s, because the segment is
// arrival-to-arrival and so swallows the rest. Staying aboard costs ~9.5 min
// to save ~5.4 min of walking, so planTrip's choice is correct and the total
// it printed is honest.
//
// What was missing is the sentence. A rider who can see a closer stop on the
// map and is given no reason assumes a bug, and the only way to find out
// otherwise was to file a report. This module derives that one sentence.
//
// Explanation only: nothing here feeds planTrip, changes an ETA, or reorders
// an option. If the note is wrong the rider reads a wrong sentence; the trip
// they are shown is unchanged.

import { haversineMeters } from "./geo";
import type { LatLon } from "./geo";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import { BUS_SPEED_M_S } from "./routes";
import { MAX_WALK_M, walkSecFromMeters } from "./walk";

/**
 * A dwell counts as a layover at the same bar the route list already uses to
 * print "⏸ ~8 min" next to a stop (TransitMap.tsx): a typical hold of five
 * minutes or more, with enough samples to trust. Keeping the two equal means
 * the rider never reads "the shuttle rests here" beside a stop the stop list
 * shows as an ordinary one.
 */
export const LAYOVER_DWELL_SEC = 300;
export const LAYOVER_MIN_SAMPLES = 3;

/**
 * How much nearer a later stop must be before it is worth explaining. Under
 * 100 m the two stops are a walk apart that nobody would notice, let alone
 * file a report about, and the note would be noise on most trips.
 */
export const CLOSER_STOP_MIN_GAIN_M = 100;

/**
 * How far past the alight stop to look for that nearer stop. The rider is
 * comparing against something they can see on their map near the destination,
 * not the far side of the loop.
 */
export const LOOK_AHEAD_STOPS = 6;

export type AlightNote = {
  /** Stop the rider could see on the map and wondered about. */
  closerStopId: number;
  /** How much nearer it is to the destination, metres. */
  metresCloser: number;
  /** Seconds the ride there would add, beyond the walking it would save. */
  extraSec: number;
  /** Typical hold at the alight stop, seconds — null when this isn't a layover. */
  layoverSec: number | null;
};

function segmentSec(
  segs: Record<string, { avg: number; n: number }>,
  prev: number,
  cur: number,
  stopCoords: Record<number, LatLon>,
): number {
  const seg = segs[`${prev}-${cur}`];
  if (seg && seg.n >= 1) return seg.avg;
  // Same fallback planTrip uses, so the two never price a leg differently.
  const pc = stopCoords[prev], cc = stopCoords[cur];
  if (pc && cc) return Math.max(30, haversineMeters(pc, cc) / BUS_SPEED_M_S);
  return 90;
}

/**
 * Does a stop further along this route sit meaningfully closer to `dest` than
 * the one the rider was told to get off at — and if so, why was it not chosen?
 *
 * Returns null when there is nothing to explain: no nearer stop ahead, or one
 * exists but riding to it really would be faster (in which case planTrip would
 * have picked it and the caller has a bug to chase, not a sentence to print).
 *
 * `stops` is the route's stop sequence, indexed by position — routes 9 and 10
 * repeat stops for the West Campus out-and-back and the duplicates are real
 * legs, so this walks positions and never de-duplicates.
 */
export function findAlightNote(
  stops: readonly number[],
  alightStopId: number,
  dest: LatLon,
  stopCoords: Record<number, LatLon>,
  routeSegs: SegmentTimes[string] | undefined,
  routeDwells: DwellTimes[string] | undefined,
): AlightNote | null {
  const alightIdx = stops.indexOf(alightStopId);
  if (alightIdx === -1) return null;
  const alightCoord = stopCoords[alightStopId];
  if (!alightCoord) return null;
  const alightDist = haversineMeters(dest, alightCoord);
  const segs = routeSegs ?? {};

  let best: AlightNote | null = null;
  let cumRide = 0;
  const limit = Math.min(LOOK_AHEAD_STOPS, stops.length - 1);
  for (let step = 1; step <= limit; step++) {
    const prev = stops[(alightIdx + step - 1) % stops.length];
    const cur = stops[(alightIdx + step) % stops.length];
    cumRide += segmentSec(segs, prev, cur, stopCoords);
    const c = stopCoords[cur];
    if (!c) continue;
    const d = haversineMeters(dest, c);
    // Only stops the rider could actually have used.
    if (d > MAX_WALK_M) continue;
    const metresCloser = alightDist - d;
    if (metresCloser < CLOSER_STOP_MIN_GAIN_M) continue;
    // Riding on costs `cumRide` and saves the difference in the walk.
    const extraSec = cumRide - (walkSecFromMeters(alightDist) - walkSecFromMeters(d));
    // If riding on were faster, planTrip would have sent them there. Nothing
    // to explain — stay silent rather than print a sentence that contradicts
    // the option above it.
    if (extraSec <= 0) return null;
    // Among the candidates, describe the nearest one — that is the stop the
    // rider is looking at.
    if (!best || metresCloser > best.metresCloser) {
      best = { closerStopId: cur, metresCloser, extraSec, layoverSec: null };
    }
  }
  if (!best) return null;

  const dw = routeDwells?.[String(alightStopId)];
  best.layoverSec =
    dw && dw.n >= LAYOVER_MIN_SAMPLES && dw.med >= LAYOVER_DWELL_SEC ? dw.med : null;
  return best;
}

/**
 * The sentence itself. Plain words only — this is rider-facing text, and
 * minutes are spelled `min`, never `m`, which here would read as metres AND
 * as miles.
 */
export function alightNoteText(note: AlightNote, closerStopName: string): string {
  const name = closerStopName.replace(/\s*\/\s*/g, "/");
  const saved = Math.max(1, Math.round(note.extraSec / 60));
  if (note.layoverSec != null) {
    const rest = Math.max(1, Math.round(note.layoverSec / 60));
    return `Closer to ${name}? The shuttle rests about ${rest} min here, so walking from this stop gets you there about ${saved} min sooner.`;
  }
  return `Closer to ${name}? Staying on to there takes about ${saved} min longer than walking from this stop.`;
}
