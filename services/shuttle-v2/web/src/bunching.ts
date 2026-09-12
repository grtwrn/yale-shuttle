// TWO BUSES THAT ARE ABOUT TO ARRIVE TOGETHER, said once.
//
// THE CASE (Orange Night, 2026-09-10; project-case-orange-night-bunching).
// Route 14 had exactly two vehicles out, #49 and #51, and they bunched. The
// countdown line prints slot 1 with a range when the PINNED bus is standing
// (`fmtBusRange`, standWait.ts) and slot 2 as a bare median point, always. The
// rider got, on the same trip nine minutes apart:
//
//     22:19   "in 23-36, then 35 min"      #49 standing 14:37 on a driver
//                                          break, #51 nine stops behind
//     22:28   "in 25, 25 min"              #51 had caught up and become the
//                                          pinned bus, so the range vanished
//
// Both readings are the same fact — two buses, somewhere in one wide window —
// and neither says it. The first prints slot 2's point INSIDE slot 1's own
// interval, which reads as two separate promises six minutes apart when the
// truth was 14 minutes (22:44:09 and 22:58:15). The second prints one minute
// twice, and lost the range purely because the moving bus sorted first:
// `standCtx` was built from the pinned bus alone, so a standing bus in slot 2
// was not known to be uncertain at all.
//
// WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT. It decides WORDING only. No
// arrival time changes, no quantile is re-picked, no bus is dropped from the
// row: when the two numbers do not overlap the line is byte-identical to what
// it printed before ("in 12, 21 min", "in 3-7, then 21 min"), which the
// existing tests and canary fixtures pin.
//
// THREE RULES, AND WHY EACH ONE:
//
//  1. SLOT 2 NEVER GETS ITS OWN RANGE. Two intervals do not fit the 13 px
//     span beside the route pill at 390 px — the line already clips rather
//     than wraps ("in 1 min · next in 11 min" was dropped in 2026-09-03 for
//     exactly this), and "in 23-36, then 30-44 min" is four numbers on a line
//     that comfortably holds two. Slot 2's band is EVIDENCE here, never text.
//
//  2. WHEN SLOT 2 IS INSIDE WHAT SLOT 1 ALREADY SAYS, SAY IT ONCE PLUS THE
//     CAUSE. "in 23-36 min · 2 buses" is the whole of what is known; printing
//     "then 35 min" beside it invents a distinction the model is not making.
//     The suffix is what stops the single statement reading as a bus vanishing
//     from the row — the rider can still see there are two.
//
//  3. THE COMPARISON IS IN DISPLAYED MINUTES, not seconds. The defect is
//     presentational: what matters is whether the second number lands on or
//     inside the interval the rider can SEE, and both ends are floored by
//     `fmtMin`. Comparing seconds would call 36:10 "outside" a band whose
//     printed high end is "36 min".
//
// THE BOUNDARY IS INCLUSIVE. Slot 2 exactly on the band's upper edge (band
// 23-36, slot 2 at 36 min) is the bunched case: the printed interval already
// contains that minute, so "in 23-36, then 36 min" names the same minute
// twice. The same choice on the other side makes an equal pair of points
// ("in 25, 25 min") bunched, which is the 22:28 card.

import { fmtBusBand, fmtBusPair, fmtMin } from "./format";

/** Slot 1's displayed interval — the estimator's own band, when it is wide enough to print (etaBand.ts). */
export interface EtaBand { lowSec: number; highSec: number }

export interface BunchInput {
  /** Slot 1, the PINNED bus: the point number, seconds. */
  leadSec: number;
  /** Slot 1's range, when the band is wide enough to print (etaBand.ts `displayBand`). Displayed. */
  leadBand?: EtaBand | null;
  /** Slot 2, the bus behind it: its point, seconds, or null when there is none. */
  nextSec?: number | null;
  /**
   * Slot 2's OWN band, when that bus is standing — the 22:28 half of the case.
   * Never displayed (rule 1); it only decides whether the two buses are
   * distinguishable.
   */
  nextBand?: EtaBand | null;
}

export type BunchReason =
  /** Slot 2's point is inside the interval slot 1 is already showing. */
  | "inside-band"
  /** The two points print the same minute. */
  | "same-minute"
  /** Slot 2 is standing and its own band reaches slot 1's number. */
  | "next-band-overlap";

export interface BunchDecision {
  /** Print one statement plus the cause, instead of two numbers. */
  bunched: boolean;
  reason: BunchReason | null;
}

/**
 * The displayed token as a comparable number of minutes: "now" -> 0,
 * "<1 min" -> 0.5, "7 min" -> 7. Anything else (there is nothing else) sorts
 * last rather than throwing — this runs inside a render.
 */
function shownMin(sec: number): number {
  const token = fmtMin(sec);
  if (token === "now") return 0;
  if (token === "<1 min") return 0.5;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

const finite = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);

/**
 * Are the two slots one statement or two? Pure, and the whole of the decision:
 * the caller only chooses words from it.
 */
export function bunchDecision(input: BunchInput): BunchDecision {
  const { leadSec, leadBand, nextSec, nextBand } = input;
  const none: BunchDecision = { bunched: false, reason: null };
  if (!finite(leadSec) || !finite(nextSec)) return none;

  // What slot 1 actually PRINTS. `fmtBusBand` collapses a range whose two
  // ends round to one minute back to a point ("a range of one number is just a
  // number wearing a dash"), and when it does, the number shown is the median
  // — so the comparison has to follow it there.
  const collapsed = leadBand != null && shownMin(leadBand.lowSec) === shownMin(leadBand.highSec);
  const bandLow = leadBand && !collapsed ? leadBand.lowSec : leadSec;
  const bandHigh = leadBand && !collapsed ? leadBand.highSec : leadSec;
  const lo = shownMin(bandLow), hi = shownMin(bandHigh);
  const isInterval = leadBand != null && !collapsed;
  const next = shownMin(nextSec);

  if (isInterval && next <= hi) return { bunched: true, reason: "inside-band" };
  if (!isInterval && next === lo) return { bunched: true, reason: "same-minute" };
  // Slot 2 standing: its low end is where it could be if it pulled out now, so
  // a band reaching slot 1's own number means the two cannot be told apart.
  if (nextBand && finite(nextBand.lowSec) && shownMin(nextBand.lowSec) <= hi) {
    return { bunched: true, reason: "next-band-overlap" };
  }
  return none;
}

/**
 * The cause, as few words as the span holds, and THE HEAD DROPS ITS "in".
 *
 * MEASURED, not counted — a line that wrapped shipped on 2026-09-03 from
 * counting characters. Probed in the real card at 390 px (13 px Inter 500,
 * the countdown span's own `scrollWidth` against its `clientWidth`) with the
 * two widest route pills, "Orange Night" and "Blue Weekend", which leave the
 * span 134 px and 128 px:
 *
 *   "in 23-36 min · 2 buses"          139 px   CLIPS beside both
 *   "in 23-36 min · two buses together" 210 px CLIPS
 *   "in 23-36 min · another right behind" 216 px CLIPS
 *   "in 23-36 min · 2 due"            125 px   fits, and "due" is jargon
 *   "in 23-36 min · both"             118 px   fits, and says nothing
 *   "23-36 min · 2 buses"             124 px   fits both — this one
 *   "25 min · 2 buses"                102 px   fits
 *
 * So the widest thing this can print is 124 px of the 128 px the tightest
 * pairing allows. For scale, the line it REPLACES is already at that edge:
 * "in 23-36, then 35 min" is 133 px and clips beside "Blue Weekend" today.
 *
 * Dropping "in" is what buys the room, and it is the cheapest word to lose:
 * the map's board chip already prints this very quantity without it
 * (`chipCountdownText` strips `^in `), and the bunched line is a STATEMENT
 * about two buses rather than a countdown pair, so it is allowed to open
 * differently. The cause keeps the plainest noun, which is the whole point of
 * the change — a rider must be able to see that the row still knows about two
 * buses.
 */
export const BUNCHED_SUFFIX = "· 2 buses";

/**
 * The countdown line, all four forms. ONE composer so the collapsed row, the
 * expanded card and any future surface cannot disagree about which form they
 * are in.
 */
export function fmtBusLine(input: BunchInput): string {
  const { leadSec, leadBand, nextSec } = input;
  const second = finite(nextSec) ? nextSec : null;
  const decision = bunchDecision(input);
  if (decision.bunched) {
    const head = leadBand
      ? fmtBusBand(leadBand.lowSec, leadSec, leadBand.highSec)
      : fmtBusPair(leadSec);
    // "arriving now" and "now-6 min" have no "in" to lose and keep their words.
    return `${head.replace(/^in /, "")} ${BUNCHED_SUFFIX}`;
  }
  return leadBand
    ? fmtBusBand(leadBand.lowSec, leadSec, leadBand.highSec, second)
    : fmtBusPair(leadSec, second);
}
