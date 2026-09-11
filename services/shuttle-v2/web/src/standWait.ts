// What a rider is told while a bus is STANDING at a stop — the pause chip's
// words, and the ONE composition every stop list reads the countdown through.
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
//   * the chip says what is LEFT as a low-high pair, named as the DEPARTURE it
//     is ("leaves in 1-6 min"), and collapses to "leaving any moment" once the
//     whole range is inside a minute — which is exactly when the bus can pull
//     out at will;
//   * the countdown becomes a RANGE. Until 2026-09-11 that range was built
//     HERE from these stand quantiles plus the drive floor, and only while
//     the bus stood. It is now the estimator's own 10-90 band, printed with
//     its median on every row, standing or moving (etaBand.ts; the operator:
//     "it only shows a range for red when its at the dwell stop but earlier
//     might be helpful"). For a STANDING bus that band's low end is floored
//     at departNow + the shortest stand still left (`standingLowFloor`) —
//     the low end this module used to print — and `arrivalBand` below is the
//     one place the two are put together, so the row, the minimap chip, the
//     Map tab's stop rows and the wait leg cannot disagree.
//
// The quantiles are the model's own — `shownStandSec` reads the same stand
// table, through the same pools, at the same clock the countdown is billed
// under (arrivals.ts). Nothing here estimates anything; it decides wording.

import { fmtMin } from "./format";
import { chipCountdownText, displayBand, standingLowFloor, type EtaBand } from "./etaBand";
import { shownStandSec, type DwellStat, type DwellTimes, type ShownStand } from "./arrivals";

/**
 * A low end inside this is not a number, it is a state: the bus can pull out
 * while the rider reads the line. Saying "0-5 min" invites them to average.
 */
export const IMMINENT_SEC = 60;

/**
 * The verb that separates a DEPARTURE from an ARRIVAL. The chip and the
 * countdown beside it describe the same bus and the same stand, one as when it
 * goes and one as when it reaches you; without this the chip's bare "N min
 * left" was read as the second (operator, 2026-09-11).
 */
const LEAVES = "leaves in";

export interface StandWaitInput {
  /** Seconds the bus has already stood. */
  elapsedSec: number;
  /** `shownStandSec`'s answer at that clock — must be a remainder. */
  stand: ShownStand;
}

export interface StandWaitView {
  elapsedSec: number;
  /** The stand has already outlasted the stop's typical hold. */
  overdue: boolean;
  /** Conditional median, q10 and q90 of what is LEFT of the stand. */
  remainingSec: number;
  soonSec: number;
  lateSec: number;
  /** "leaves in 1-6 min" / "leaving any moment" — the chip's second half. */
  leftText: string;
  chipTitle: string;
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
 *
 * IT NAMES ITS QUANTITY (operator, 2026-09-11). The chip used to read
 * "<1-8 min left", which sat in the expanded card's stop list twelve pixels
 * under a row reading "in 2-9 min" and a map bubble reading "(R) 2-9 min" —
 * "im seeing different estimates in the route list and the minimap … look down
 * at the stop list it had different numbers". Both numbers were right and they
 * came from one belief: reproduced from production (#310 standing at 344
 * Winchester, 08:26:47 ET) the stand's remainder is q10/q50/q90 = 56/241/487 s
 * and the model's own drive floor to the board stop is 72 s, so 2-9 IS
 * (<1-8) + the drive. What the chip never said is what the 8 minutes were
 * eight minutes OF. "left" reads as "left until it gets here" in a list of
 * stops; "leaves in" cannot. The row's "in …" is an arrival, this is a
 * departure, and the two are now distinguishable at a glance.
 */
export function standLeftText(soonSec: number, lateSec: number): string {
  const high = fmtMin(lateSec);
  if (lateSec < IMMINENT_SEC) return "leaving any moment";
  // "now" is the countdown's word for an arrival, not a duration — as the low
  // end of a WAIT it reads as nonsense ("now-1 min left"). The same quantity
  // spelled as a duration is "<1".
  const low = fmtMin(soonSec).replace(/^now$/, "<1 min");
  if (low === high) return `${LEAVES} ~${high}`;
  // "<1-1 min" is not a range, it is two spellings of about a minute
  // (operator, 2026-09-10: "reads a little funny"). It is the one adjacent
  // pair that breaks, because the two tokens differ only by the "<" — every
  // other neighbouring pair reads correctly ("3-4 min"). Both ends are
  // inside two minutes here, so the existing collapse is the honest wording.
  if (low === "<1 min" && high === "1 min") return `${LEAVES} ~1 min`;
  return `${LEAVES} ${bare(low)}-${high}`;
}

/**
 * The chip's words and the countdown's range for a bus that is standing.
 * Returns null for anything that is not a live remainder.
 */
export function standWaitView(input: StandWaitInput): StandWaitView | null {
  const { stand, elapsedSec } = input;
  if (!stand.remaining) return null;
  const remainingSec = Math.max(0, stand.sec);
  const soonSec = Math.max(0, stand.soonSec ?? remainingSec);
  const lateSec = Math.max(soonSec, stand.lateSec ?? remainingSec);
  const typicalSec = stand.typicalSec;
  const overdue = typicalSec !== undefined && elapsedSec >= typicalSec;

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

  return { elapsedSec, overdue, remainingSec, soonSec, lateSec, leftText, chipTitle };
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
): StandWaitView | null {
  if (!standing) return null;
  const stat = routeDwells[String(standing.stopId)];
  if (!stat || stat.n < 3) return null;
  const stand = shownStandSec(stat, standing.standingSec, routeDwells, dwellsByRoute);
  if (!stand) return null;
  return standWaitView({ elapsedSec: standing.standingSec, stand });
}

/**
 * THE PAUSE CHIP beside a stop a bus is resting at — one composition, every
 * stop list.
 *
 * There are two stop lists in this app (the expanded trip card's and the Map
 * tab's route cards') and they used to answer differently about the same bus at
 * the same instant. The trip card was moved onto the model on 2026-09-04; the
 * Map tab kept reading `at_stop_since` off the payload and `dwell.med ± sd` off
 * the served table, so on the live payload it badged West Haven Train Station
 * "8-9 min" where the model's stand is 23 s, and 344 Winchester "9-13 min"
 * against 4:59. Both are the arrival-to-arrival median, which CONTAINS DRIVE
 * TIME — the mistake arrivals.ts documents twice.
 *
 * So the chip is built HERE and nowhere else. A render site supplies the belief
 * (`resolveStandingStop`) and the tables; it does not get to compose the words.
 */
export function standChipFor(
  standing: { stopId: number; standingSec: number; approach?: boolean } | null,
  routeDwells: Record<string, DwellStat>,
  dwellsByRoute: DwellTimes | undefined,
): { clock: string; text: string; title: string; overdue: boolean } | null {
  if (!standing) return null;
  const view = standWaitFor(standing, routeDwells, dwellsByRoute);
  if (!view) return null;
  return {
    clock: mmss(standing.standingSec),
    text: view.leftText,
    title: (standing.approach
      ? "Waiting for this stop, holding just short of the marker. "
      : "") + view.chipTitle,
    overdue: view.overdue,
  };
}

/**
 * THE BAND ONE ARRIVAL PRINTS — the one place the estimator's 10-90 band
 * (`UpcomingArrival.low` / `.high`) and the stand a bus is in are put
 * together. `displayBand` decides whether the band is wide enough to print
 * and ticks it with the point; for a STANDING bus (`view` non-null) its low
 * end is floored at `departNow + the shortest stand still left`
 * (`standingLowFloor`, etaBand.ts) — the low end this module used to print on
 * its own. Every surface — the trip row, the minimap chip (`stopEtaText`),
 * the Map tab's stop rows (`stopEtaText`) and the expanded card's wait leg —
 * reads the band through here, so none can disagree about one bus.
 */
export function arrivalBand(
  view: StandWaitView | null,
  arrival: { low?: number | undefined; high?: number | undefined; departNow?: number | undefined; computedAtMs?: number | undefined },
  nowMs: number = Date.now(),
): EtaBand | null {
  return displayBand(
    arrival.low, arrival.high, arrival.computedAtMs, nowMs,
    view ? standingLowFloor(arrival.departNow, view.soonSec) : undefined,
  );
}

/**
 * THE COUNTDOWN FOR ONE STOP, wherever it is drawn: the trip card's minimap
 * chip and the Map tab's route-card rows.
 *
 * Both read the same `UpcomingArrival`. Until 2026-09-11 only the minimap knew
 * that a standing bus's arrival is a range, so a bus mid-layover printed
 * "2-9 min" on the trip card and its minimap and a definitive "1 min" on the
 * Map tab's own row for the same stop — below the model's own drive floor. That
 * is the operator's 2026-09-10 complaint ("its a little weird showing a
 * definitive answer in map and a range in the stop list") on the surface the
 * fix missed. The band is `arrivalBand`'s, the words `chipCountdownText`'s
 * (etaBand.ts): "4 (2-10) min" with a band, `fmtMin`'s point without one.
 *
 * `arrival.eta` is passed already decayed where the caller decays it (report
 * #48); the band is decayed off `arrival.computedAtMs` the same way.
 */
export function stopEtaText(
  standing: { stopId: number; standingSec: number } | null,
  arrival: { eta: number; low?: number | undefined; high?: number | undefined; departNow?: number | undefined; computedAtMs?: number | undefined },
  routeDwells: Record<string, DwellStat>,
  dwellsByRoute: DwellTimes | undefined,
): string | null {
  const view = standing ? standWaitFor(standing, routeDwells, dwellsByRoute) : null;
  return chipCountdownText(arrivalBand(view, arrival), arrival.eta);
}
