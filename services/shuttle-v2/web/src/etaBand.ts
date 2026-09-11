// THE COUNTDOWN'S RANGE, from the estimator's own band — for a bus that is
// driving as much as for one that is standing.
//
// THE ASK (operator, 2026-09-11, reading a Red card): "it only shows a range
// for red when its at the dwell stop but earlier might be helpful", and "we
// should show the expected median or average to give user more info".
//
// Until now the row's range was built by standWait.ts from the STAND's own
// quantiles plus the drive floor — a second arithmetic, and one that could
// only exist while the pinned bus stood at a stop. A bus ten minutes out and
// driving toward a layover it has yet to take printed a bare "in 10 min",
// which is exactly the case where the arrival is least certain. Meanwhile
// the estimator's own 10-90 band (eta/arrival.ts `low`/`high`) was computed
// for every arrival and rendered nowhere.
//
// So the range is now that band, on every row, and the point number is the
// SAME distribution's median: one distribution, three numbers. Nothing here
// prices anything — this module decides only whether the band is worth
// printing and how the three numbers tick between polls.
//
// WHEN A RANGE IS PRINTED: when the two ends print at least
// `RANGE_MIN_SHOWN_MIN` whole minutes apart. Measured (2026-09-11,
// gps-replay 9/10, Red and Blue Day, detector truth, the served widening;
// docs/eta-band.md §C): a printed band 3 or more minutes wide contains the
// arrival 77-82% of the time standing and moving on Red (78 / 71 on Blue
// Day); 2 minutes wide, 58-79%; 1 minute, 59-73%; under a minute, 19-61%.
// A band that narrow is a point wearing a dash, and one the rider should not
// trust as a range — so it prints as the point it is. Below the threshold,
// and on a bus standing AT the board stop (the band is 0-0), the row is
// byte-identical to what it printed before. On the rider simulator (9/10,
// 12:00-13:30 ET) 80% of Red first sights and 77% of Blue Day's print a
// band under this rule.
//
// A STANDING BUS CANNOT BEAT ITS OWN STAND. For a bus standing at a stop the
// band's low end is floored at `departNow + q10 of what is LEFT of the stand`
// (`standingLowFloor`) — the low end standWait.ts printed until today, and one
// no bus can beat: it must finish at least that much of its stand and then
// drive. Coverage cannot see this floor (a too-low low end never costs
// coverage), which is why the replay measurements in docs/eta-band.md could
// not refuse "now" for a standing bus — and "in 4 (now-10) min" for a bus
// three stops away sends a rider running for nothing. A MOVING bus keeps the
// band as measured: there `departNow` is `eta` itself and any floor on it
// deletes the band's lower half (docs/eta-band.md §B).
//
// TICKING. The point number is decayed by wall clock between polls (report
// #48: a frozen "1:49" while the bus visibly closed in). The band ticks WITH
// it, by the same seconds off both ends: the three numbers are one
// distribution shifted by the time elapsed, and decaying one without the
// others would let the point walk out of its own band.

import { fmtBusBand, fmtMin, fmtWait, remainingSec } from "./format";

/** Below this many printed minutes between the ends, a range says nothing a point does not. */
export const RANGE_MIN_SHOWN_MIN = 3;

export interface EtaBand { lowSec: number; highSec: number }

/** Whole printed minutes of a countdown, on `fmtMin`'s own buckets ("now" 0, "<1" 0.5). */
export function shownMinutes(sec: number): number {
  if (sec < 10) return 0;
  if (sec < 60) return 0.5;
  return Math.floor(sec / 60);
}

/**
 * The band the row prints, or null to leave the point number alone. `lowSec`
 * / `highSec` are the pinned arrival's own (planner.ts `busLowSec` /
 * `busHighSec`), at `computedAtMs`; both are decayed to `nowMs` exactly as
 * the point is.
 */
export function displayBand(
  lowSec: number | undefined,
  highSec: number | undefined,
  computedAtMs: number | undefined,
  nowMs: number = Date.now(),
  /** `standingLowFloor` for a standing pinned bus; undefined for a moving one. NOT decayed — none of the drive has been served while the bus sits. */
  floorSec?: number | undefined,
): EtaBand | null {
  if (lowSec == null || highSec == null || !Number.isFinite(lowSec) || !Number.isFinite(highSec)) return null;
  let low = remainingSec(lowSec, computedAtMs, nowMs);
  const high = remainingSec(highSec, computedAtMs, nowMs);
  if (floorSec != null && Number.isFinite(floorSec)) low = Math.max(low, floorSec);
  if (high <= low) return null;
  if (shownMinutes(high) - shownMinutes(low) < RANGE_MIN_SHOWN_MIN) return null;
  return { lowSec: low, highSec: high };
}

/**
 * The low end a STANDING bus cannot beat: the drive floor (`departNow`, the
 * chain with the stand ended this second) plus the shortest stand still
 * plausible (`soonSec`, the q10 of what is left, standWait.ts). Both are the
 * model's own numbers at the same clock the countdown is billed under.
 */
export function standingLowFloor(departNowSec: number | undefined, soonSec: number | undefined): number | undefined {
  if (departNowSec == null || soonSec == null || !Number.isFinite(departNowSec) || !Number.isFinite(soonSec)) return undefined;
  return Math.max(0, departNowSec) + Math.max(0, soonSec);
}

/** The tooltip behind a printed range: the median first, the band as what it is. */
export function bandTitle(band: EtaBand, etaSec: number): string {
  const min = (s: number) => `${Math.max(0, Math.round(s / 60))} min`;
  return `Most likely about ${min(etaSec)}. Four arrivals in five fall between ${min(band.lowSec)} and ${min(band.highSec)}; the bus may leave a stop early or hold longer.`;
}

/**
 * The countdown for the MAP's board chip — the same three numbers as the
 * row, in the map's shorter vocabulary ("4 min", never "in 4 min"). One
 * formatter for both surfaces, so a rider cannot read a definitive number on
 * the map beside a range on the card (operator, 2026-09-10).
 */
export function chipCountdownText(band: EtaBand | null, etaSec: number | null): string | null {
  if (etaSec == null || !Number.isFinite(etaSec)) return null;
  if (band) return fmtBusBand(band.lowSec, etaSec, band.highSec).replace(/^in /, "");
  // `fmtMin`'s own spelling ("4 min", "now"): the non-banded chip is
  // byte-identical to what the map drew before any range existed.
  return fmtMin(etaSec);
}

/**
 * The expanded card's wait leg ("⏳ 2-9 min"): the row's own band, less the
 * walk to the stop, so the leg strip and the countdown above it describe one
 * arrival. Null when there is nothing to wait for.
 */
export function waitLegText(band: EtaBand | null, etaSec: number | null, walkSec: number, waitSec: number): string | null {
  if (band && etaSec != null) {
    const low = Math.max(0, band.lowSec - walkSec);
    const high = Math.max(0, band.highSec - walkSec);
    const mid = Math.max(0, etaSec - walkSec);
    return high < 60 ? null : fmtBusBand(low, mid, high).replace(/^in /, "");
  }
  return waitSec < 60 ? null : fmtWait(waitSec);
}
