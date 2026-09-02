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
 * A dwell counts as a layover at four minutes, with enough samples to trust.
 * Above the route list's own "⏸" badge (three minutes), because this sentence
 * asserts a REASON to a rider deciding whether the app made a mistake — but
 * not so high that it misses the case it was written for: 344 Winchester,
 * the stop in report #59, holds a median of 4.9 min (n=12 on 2026-09-02),
 * and a five-minute bar would have silently excluded it.
 */
export const LAYOVER_DWELL_SEC = 240;
export const LAYOVER_MIN_SAMPLES = 3;

/**
 * How much nearer a later stop must be before it is worth explaining. Under
 * 100 m the two stops are a walk apart that nobody would notice, let alone
 * file a report about, and the note would be noise on most trips.
 */
export const CLOSER_STOP_MIN_GAIN_M = 100;

/**
 * How far past the alight stop to look for that nearer stop, as RIDE TIME
 * rather than a stop count. Six stops means very different things on Red (29
 * stops) and Grocery TJ (5), where it wrapped four fifths of the way round the
 * loop and produced sentences about a stop on the other side of town. Four
 * minutes is about as far ahead as a rider looking at their map would even
 * consider staying on.
 */
export const LOOK_AHEAD_SEC = 4 * 60;

/**
 * The smallest time difference worth asserting. The app's own measured ETA
 * error is about 1.26 min, so a note claiming "about 1 min" off a 13-second
 * margin — which happened on a quarter of firings — is noise dressed as an
 * explanation.
 */
export const MIN_EXTRA_SEC = 120;

export type AlightNote = {
  /** Stop the rider could see on the map and wondered about. */
  closerStopId: number;
  /** How much nearer it is to the destination, metres. */
  metresCloser: number;
  /** Seconds the ride there would add, beyond the walking it would save. */
  extraSec: number;
  /** Typical hold at the alight stop, seconds. Never null: see findAlightNote. */
  layoverSec: number;
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

  // The only thing worth saying is WHY: this stop is a layover. Without that
  // the sentence just restates arithmetic the card already shows ("staying on
  // takes 2 min longer"), which was 80% of what this printed — a recurring
  // grey line answering a question nobody asked. No layover, no note.
  const dw = routeDwells?.[String(alightStopId)];
  const layoverSec =
    dw && dw.n >= LAYOVER_MIN_SAMPLES && dw.med >= LAYOVER_DWELL_SEC ? dw.med : null;
  if (layoverSec == null) return null;

  let best: AlightNote | null = null;
  let cumRide = 0;
  let firstSegSec = 0;
  for (let step = 1; step < stops.length; step++) {
    const prev = stops[(alightIdx + step - 1) % stops.length];
    const cur = stops[(alightIdx + step) % stops.length];
    const segSec = segmentSec(segs, prev, cur, stopCoords);
    if (step === 1) firstSegSec = segSec;
    cumRide += segSec;
    // Past the horizon: stop looking rather than wrap round the loop.
    //
    // Measured on MOVING time. Segments are arrival-to-arrival, so the hop out
    // of a layover stop swallows the rest itself — on the reported case that
    // one segment is 8.5 min, of which 7.7 is the shuttle sitting still. The
    // rest is a real cost (extraSec counts it) but it is not distance, and
    // charging it against a "how far ahead would you consider" horizon hid
    // the very stop this feature exists to name.
    if (cumRide - Math.min(layoverSec, firstSegSec) > LOOK_AHEAD_SEC) break;
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
    // Too close to call: below the app's own ETA error, saying "about 1 min"
    // would be asserting precision the numbers do not have.
    if (extraSec < MIN_EXTRA_SEC) continue;
    // Among the candidates, describe the nearest one — that is the stop the
    // rider is looking at.
    if (!best || metresCloser > best.metresCloser) {
      best = { closerStopId: cur, metresCloser, extraSec, layoverSec };
    }
  }
  return best;
}

/**
 * The sentence itself. Plain words only — this is rider-facing text, and
 * minutes are spelled `min`, never `m`, which here would read as metres AND
 * as miles.
 */
export function alightNoteText(note: AlightNote, closerStopName: string): string {
  const name = closerStopName.replace(/\s*\/\s*/g, "/");
  const saved = Math.round(note.extraSec / 60);
  const rest = Math.round(note.layoverSec / 60);
  return `Closer to ${name}? The shuttle rests about ${rest} min here, so walking from this stop gets you there about ${saved} min sooner.`;
}
