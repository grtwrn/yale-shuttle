// What a rider is told while a bus is STANDING at a stop — the pause chip's
// words and, when the wait has real spread in it, the countdown's range.
//
// THE CASE THIS EXISTS FOR (operator, 2026-09-07). A Red bus stood at
// 344 Winchester for 9:16. The stop's served stand table is
// q = [49,125,140,167,262,307,372,433,502,642]; its unconditional median is
// 4:43. Two display rules threw away everything the model knew:
//
//   1. The chip printed `typicalSec` — the residual median as if the bus had
//      only just arrived. At 3:21 elapsed it read "⏸ 3:21 / ~4:48", which a
//      rider subtracts to "1:27 more" when the model's own conditional answer
//      was 3:15 more. The honest number was already in hand: the chip's
//      TOOLTIP said "about 3:15 still to go".
//   2. The countdown may not rise while a bus stands (#119), so it flattened
//      and never said the wait had run long.
//
// The operator's call: "if we know its going to be longer we might as well
// show that info instead of hiding it for stability. I do see the guess of
// 10:28 could have hurt the user thought since truth was 9:16."
//
// WHY A RANGE AND NOT A BIGGER NUMBER. The conditional median tracks the
// truth well for most of a stand and then OVERSHOOTS it, because a stand that
// has already outlasted the table is priced from the tail:
//
//     elapsed  conditional total   truth 9:16
//      0:00        4:43             -4:33
//      3:21        6:36             -2:40
//      5:00        7:23             -1:53
//      8:00        9:30             +0:14
//      9:00       10:28             +1:12   <- promises a bus that leaves in 16 s
//
// A rider told "10:28" strolls, and the bus goes. So the moment a bus is past
// its typical hold the answer must stop being a point at all: once a stand has
// run long it can end at ANY second, and the only statement that cannot
// mislead in that direction is one bounded below by "now". Hence:
//
//   * the chip says what is LEFT as a low-high pair ("1-6 min left"), and
//     collapses to a ceiling ("up to 4 min left") the moment the low end is
//     inside a minute — which is exactly when the bus can pull out at will;
//   * the countdown becomes a RANGE whose low end is the DRIVE FLOOR: where
//     the bus would be if it left this second. It is never earlier than that
//     (the bus cannot teleport) and never later than the q90 (it may leave
//     now). On the table above every one of those statements contains the
//     9:16 truth, at every elapsed time, which no point estimate did.
//
// The quantiles are the model's own — `shownStandSec` reads the same stand
// table, through the same pools, at the same clock the countdown is billed
// under (arrivals.ts). Nothing here estimates anything; it decides wording.

import { fmtMin } from "./format";
import { shownStandSec, type DwellStat, type DwellTimes, type ShownStand } from "./arrivals";

/**
 * Below this q10-q90 spread a range says nothing a point does not: an ordinary
 * kerb stop is 15 s of stand and "in 4-4 min" is noise. Layovers — the stops
 * where this whole problem lives — clear it several times over (344 Winchester
 * spans 7:48 at the start of a stand and still 4:40 nine minutes in).
 */
export const RANGE_MIN_SPREAD_SEC = 120;

/**
 * A low end inside this is not a number, it is a state: the bus can pull out
 * while the rider reads the line. Saying "0-5 min" invites them to average.
 */
export const IMMINENT_SEC = 60;

export interface StandWaitInput {
  /** Seconds the bus has already stood. */
  elapsedSec: number;
  /** `shownStandSec`'s answer at that clock — must be a remainder. */
  stand: ShownStand;
  /** The countdown the rider reads for this option, seconds, or null. */
  etaSec: number | null;
  /** The bus is standing at the rider's own board stop (no drive left to bound). */
  atBoardStop: boolean;
}

export interface StandWaitView {
  elapsedSec: number;
  /** The stand has already outlasted the stop's typical hold. */
  overdue: boolean;
  /** Conditional median, q10 and q90 of what is LEFT of the stand. */
  remainingSec: number;
  soonSec: number;
  lateSec: number;
  /**
   * Arrival at the board stop if the bus pulled out this second — the
   * countdown less the stand it is still carrying. THE FLOOR: nothing shown
   * may be earlier, because the drive is the one part of the wait no
   * departure can skip.
   */
  departNowSec: number | null;
  /** The countdown's range, or null to leave the point number alone. */
  range: { lowSec: number; highSec: number } | null;
  /** "1-6 min left" / "up to 4 min left" — the chip's second half. */
  leftText: string;
  chipTitle: string;
  rangeTitle: string | null;
}

function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** "4 min" -> "4", "<1 min" -> "<1". Same shared-unit idiom as fmtBusPair. */
function bare(s: string): string {
  return s.replace(" min", "");
}

/**
 * What is left of the stand, in words a rider cannot read as a promise of
 * lateness.
 *
 * BOTH ENDS ARE QUOTED, INCLUDING A LOW END UNDER A MINUTE. An earlier draft
 * suppressed the low end below `IMMINENT_SEC` and printed a bare ceiling —
 * "up to 5 min left" — on the reasoning that a bus free to leave has no
 * meaningful floor. The operator rejected it twice on the live app
 * (2026-09-09): "I liked having the estimated wait in there", and then, of the
 * chip specifically, "this part should show the range of wait time actually".
 *
 * The ceiling alone answers "how bad could this get" and never answers "how
 * long is this likely to be", which is the question being asked. And "<1" is
 * not noise: on the same morning the operator watched a `<1-6` countdown and
 * reported that the bus did arrive inside the minute. A low end that reads
 * "any moment now" is information, not an absence of it.
 *
 * Only when the WHOLE range is imminent does the range collapse — there the
 * two ends say the same thing and the words are better.
 */
export function standLeftText(soonSec: number, lateSec: number): string {
  const high = fmtMin(lateSec);
  if (lateSec < IMMINENT_SEC) return "leaving any moment";
  // "now" is the countdown's word for an arrival, not a duration — as the low
  // end of a WAIT it reads as nonsense ("now-1 min left"). The same quantity
  // spelled as a duration is "<1".
  const low = fmtMin(soonSec).replace(/^now$/, "<1 min");
  if (low === high) return `~${high} left`;
  return `${bare(low)}-${high} left`;
}

/**
 * The chip's words and the countdown's range for a bus that is standing.
 * Returns null for anything that is not a live remainder.
 */
export function standWaitView(input: StandWaitInput): StandWaitView | null {
  const { stand, elapsedSec, etaSec, atBoardStop } = input;
  if (!stand.remaining) return null;
  const remainingSec = Math.max(0, stand.sec);
  const soonSec = Math.max(0, stand.soonSec ?? remainingSec);
  const lateSec = Math.max(soonSec, stand.lateSec ?? remainingSec);
  const typicalSec = stand.typicalSec;
  const overdue = typicalSec !== undefined && elapsedSec >= typicalSec;
  const departNowSec = etaSec == null || !Number.isFinite(etaSec)
    ? null
    : Math.max(0, etaSec - remainingSec);

  const leftText = standLeftText(soonSec, lateSec);
  const typicalPart = typicalSec === undefined
    ? ""
    : overdue
      ? `, already past the ~${mmss(typicalSec)} it usually holds`
      : ` (usually ~${mmss(typicalSec)} here)`;
  // Spelled out rather than reusing `leftText`: the chip is ten pixels of
  // shorthand, the tooltip is the sentence, and "About leaving any moment to
  // go" is what reusing it produces.
  const toGo = lateSec < IMMINENT_SEC
    ? "It can pull out at any moment."
    : soonSec < IMMINENT_SEC
      ? `It can pull out at any moment, and about ${fmtMin(lateSec)} more at the outside.`
      : `About ${bare(fmtMin(soonSec))}-${fmtMin(lateSec)} still to go, and it can pull out sooner.`;
  const chipTitle = `Standing ${mmss(elapsedSec)}${typicalPart}. ${toGo}`;

  // A range is worth drawing only where the spread is real, and only where
  // there is a drive to bound it with: a bus standing AT the board stop has
  // arrived, its countdown is legitimately zero, and "now-5 min" beside a bus
  // the rider can see would read as a reason not to board.
  let range: { lowSec: number; highSec: number } | null = null;
  let rangeTitle: string | null = null;
  if (departNowSec !== null && !atBoardStop && lateSec - soonSec >= RANGE_MIN_SPREAD_SEC) {
    // Low: the drive floor plus the shortest stand still plausible. High: the
    // drive floor plus the longest. `etaSec` (the median) sits between them by
    // construction — soonSec <= remainingSec <= lateSec — and the max() keeps
    // that true even if #119's clamp has moved the point number underneath.
    const lowSec = departNowSec + soonSec;
    const highSec = Math.max(departNowSec + lateSec, etaSec as number);
    range = { lowSec, highSec };
    rangeTitle = `The bus is standing at its stop (${mmss(elapsedSec)} so far). ${fmtMin(lowSec)} if it pulls out now, ${fmtMin(highSec)} if this stand runs as long as the longest here do.`;
  }

  return {
    elapsedSec, overdue, remainingSec, soonSec, lateSec,
    departNowSec, range, leftText, chipTitle, rangeTitle,
  };
}

/**
 * The same answer straight from what a render site already holds: the standing
 * stop the PRICE resolved (liveAnchor.ts `resolveStandingStop`) and the route's
 * dwell tables. Reading the stand through `shownStandSec` is the point — it is
 * the one source the countdown is billed from, so the chip and the range
 * cannot drift from the number beside them.
 */
export function standWaitFor(
  standing: { stopId: number; standingSec: number } | null,
  routeDwells: Record<string, DwellStat>,
  dwellsByRoute: DwellTimes | undefined,
  etaSec: number | null,
  boardStopId: number,
  /** Same occurrence-specific forecast context used to price this bus's ETA. */
  visit?: Parameters<typeof shownStandSec>[4],
): StandWaitView | null {
  if (!standing) return null;
  const stat = routeDwells[String(standing.stopId)];
  if (!stat || (stat.qn ?? stat.n) < 3) return null;
  const stand = shownStandSec(stat, standing.standingSec, routeDwells, dwellsByRoute, visit);
  if (!stand) return null;
  return standWaitView({
    elapsedSec: standing.standingSec,
    stand,
    etaSec,
    atBoardStop: standing.stopId === boardStopId,
  });
}
