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
// THE MIRROR RULE (2026-09-11, report on Green): the same reasoning caps the
// wide end. A band the model cannot narrow — Green's out-and-back with the
// branch undecided printed "9-52 min · 2 buses", a 43-minute span with no
// real second bus, the "2 buses" only because the second bus's point landed
// inside that span — is not a range a rider can use either. Past
// `RANGE_MAX_SHOWN_MIN` printed minutes wide, `displayBand` returns null the
// same as it does for too-narrow, and every reader (the row, the map chip,
// the wait leg, and `bunching.ts`, which only folds two buses when a band
// was passed) falls back to the point it printed before this module existed.
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

import { fmtBusBand, fmtClock, fmtMin, fmtWait, remainingSec } from "./format";

/** Below this many printed minutes between the ends, a range says nothing a point does not. */
export const RANGE_MIN_SHOWN_MIN = 3;

/**
 * Above this many printed minutes between the ends, a range says too much to
 * be useful — the case that shipped as the bug: a Green out-and-back bus the
 * model cannot branch-assign printed "9-52 min · 2 buses" (a 43-minute
 * span), with the "2 buses" suffix itself an artefact of the second bus's
 * point falling inside that huge span rather than any real bunching
 * (`bunching.ts`). This is a DISPLAY cap only — the estimator's band is
 * unchanged; the wide case still exists, it just prints as the point median
 * it would have shown before this band existed.
 *
 * MEASURED (2026-09-11), not guessed: the saved gps-replay pairs for Red and
 * Blue Day, 9/9 + 9/10 (`scripts/.eta-replay/band/pairs-2026-09-{09,10}-raw.jsonl`,
 * the served widening, no floor — the same basis as `RANGE_MIN_SHOWN_MIN`
 * above and docs/eta-band.md SS C), routes 3 and 1, n = 171,239 PRINTED bands
 * (shown width >= 3 min, `RANGE_MIN_SHOWN_MIN` already applied). Share of
 * those wider than each candidate cap: 15 min -> 1.19%, 20 min -> 0.98%,
 * 25 min -> 0.98% (2026-09-09 alone: 1.88% / 1.82% / 1.82%; 2026-09-10 alone:
 * 1.05% / 0.82% / 0.81%; route 3 (Red) 1.21% / 0.82% / 0.82%, route 1 (Blue
 * Day) 1.17% / 1.17% / 1.17%). All three candidates already clear "drops
 * under 5% of printed Red/Blue Day bands", so the rule picks the smallest:
 * 15 min caps the fewest real ranges while still catching every case this
 * wide (there is a near-empty gap between 15 and 20-25 — almost nothing
 * lands in (15, 25], so 15 costs little more than 20 or 25 would).
 */
export const RANGE_MAX_SHOWN_MIN = 15;

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
  const shownWidth = shownMinutes(high) - shownMinutes(low);
  if (shownWidth < RANGE_MIN_SHOWN_MIN) return null;
  if (shownWidth > RANGE_MAX_SHOWN_MIN) return null;
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
 * THE ARRIVAL AT THE RIDER'S OWN STOP, on the BOARD row of the expanded card's
 * stop list — the row's band and median, in the chip's words, with the verb
 * that says which quantity it is.
 *
 * THE CASE (operator, 2026-09-11 13:50 ET, Red, bus #310 standing near
 * 344 Winchester): "map says 1-8 but route list says 1-4". Both were right.
 * The row and the map bubble print the ARRIVAL at the board stop; the list
 * printed ONE number, on the bus's own row — "⏸ 13:19 · leaves in <1-4 min",
 * the DEPARTURE from the layover (standWait.ts). Arrival = departure + three
 * stops of drive, but the list never said when the bus reaches the rider, so
 * the only number in it was compared with the row and read as a contradiction.
 *
 * So the BOARD row carries the arrival, and the list reads as a timeline:
 *
 *     🚌 344 Winchester  ⏸ 13:19 · leaves in <1-4 min
 *        Winchester/Division
 *        Division/Sheffield
 *     ●  BOARD Division/Prospect  arrives in 1-8 min
 *
 * NOT A SECOND ARITHMETIC. The render site passes the row's own `leadBand` and
 * `busEtaLive` — the two values `fmtBusLine` prints on the top line — and the
 * words are `chipCountdownText`'s, the map bubble's. "arrives in" is the
 * counterpart of the chip's "leaves in": #224 named the departure, this names
 * the arrival, and neither number is left for a rider to guess the meaning of.
 *
 * "now" is an arrival's word, not a bound: the low end of a range is spelled
 * as the duration it is ("<1"), exactly as `standLeftText` spells it.
 */
export function boardArrivalText(band: EtaBand | null, etaSec: number | null): string | null {
  const t = chipCountdownText(band, etaSec);
  if (t == null) return null;
  if (t === "now" || t === "arriving now") return "arriving now";
  // "now-6 min", and "3 (now-6) min" while the median is still printed.
  return `arrives in ${t.replace(/(^|\()now-/, "$1<1-")}`;
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

/**
 * THE ARRIVAL CLOCK, AS A PROMISE — "by 2:23p".
 *
 * THE ASK (operator, 2026-09-12, of the arrival time beside the duration):
 * "do we need ranges on the arrival time too? or just put latest time?" — the
 * latest time. A destination clock answers a different question from a
 * countdown: "in 1-8 min" answers "how long from now", and a rider reading the
 * right-hand column is asking "do I make my 2:30". For that only ONE end of
 * the band is load-bearing, because arriving early costs nothing, so the
 * honest number to print is the one that can be planned against.
 *
 * WHERE THE NUMBER COMES FROM, and the one arithmetic this must not be. The
 * tempting construction is `totalSec` with the board band's high end swapped
 * in — walk + (this bus's q90 at the BOARD stop) + ride + walk. That is a
 * ceiling on the WAIT wearing a mean for everything after it: `rideSec` is a
 * sum of segment averages (planner.ts) and carries no uncertainty at all, so
 * such a "ceiling" would be missed whenever the ride itself ran long — which,
 * on a route with a layover between the two stops, is most of the time. So
 * this reads the SAME bus's own forecast at the ALIGHT stop instead: an
 * `UpcomingArrival` the estimator already priced, over the whole chain with
 * the stands in it (arrivals.ts), plus only the trailing walk, which this app
 * models deterministically (walk.ts). Nothing is priced here — the number is
 * one already-computed field plus a walk.
 *
 * WHAT `high` ACTUALLY IS, because it is tempting to call it a q90 and that is
 * wrong. The chain's own upper quantile IS the 90th percentile, but
 * `eta/arrival.ts` applies `widenBand` LAST (params.ts): the upper half-width
 * is multiplied by the learned per-horizon `CONFORMAL` factor, fitted against
 * what riders were actually shown and targeting EIGHTY percent TWO-SIDED
 * coverage. Production serves `fit-2026-09-11` — 2-5 min 1.47, 5-10 1.271,
 * 10-30 1.251 — so at every horizon this clock can print, `high` sits 25-47%
 * further above the median than the model's own q90 does. The direction
 * favours the rider (a promise later than q90 is beaten more often, not less),
 * which is why it does not need a gate to ship; but nothing here may DESCRIBE
 * it to a rider as a percentile, and the tooltip does not. The share of
 * arrivals that actually beat it is unmeasured — see docs/eta-band.md section F.
 *
 * IT IS A FIXED INSTANT, not a countdown in disguise. The seconds are decayed
 * off `computedAtMs` exactly as the point and the band are (report #48), which
 * for an ABSOLUTE clock has the opposite and better effect: `nowMs + sec`
 * comes to `computedAtMs + high + walk` at every render, so the promise does
 * not slide forward a second at a time between polls. A rider can look twice
 * and read the same time.
 *
 * THREE WAYS IT DECLINES, each falling back to the bare median clock the
 * column printed before — never to a worse promise:
 *
 *   * NO FORECAST. A walk option, a future-dated plan, or a bus whose alight
 *     row is not in hand. The column is byte-identical to today's.
 *   * AN INCOHERENT CEILING. If the promised instant lands EARLIER than the
 *     median total the column already shows, then two arithmetics disagree
 *     (the estimator's chain to the alight stop against the planner's
 *     segment-average sum) and the "ceiling" is not one. This also retires a
 *     promise that has already elapsed: `remainingSec` clamps at zero, so a
 *     passed instant sinks below `totalSec` and the word goes with it.
 *   * TOO FAR OUT TO BE USED. Past `RANGE_MAX_SHOWN_MIN` printed minutes
 *     beyond the median, for the same measured reason the band itself caps
 *     there: Green's undecided out-and-back branch produced a 43-minute span,
 *     and "by 3:06p" on a trip the model calls 23 minutes is that span with a
 *     preposition on it.
 *
 * And when the promise prints the SAME MINUTE as the median clock, the word is
 * dropped with it: "by 2:19p" above a median of 2:19p promises nothing the
 * number alone did not, and a rider who beats it half the time learns to
 * distrust the word everywhere else.
 */
export interface ArriveBy {
  /** Seconds from `nowMs` to the promised instant. */
  sec: number;
  /** "by 2:23p" — `fmtClock`'s spelling, the column's existing idiom. */
  text: string;
  title: string;
}

export function arriveByClock(
  input: {
    /** `UpcomingArrival.high` for the SAME bus at the ALIGHT stop, as of `computedAtMs`. */
    alightHighSec?: number | undefined;
    /** The trailing walk to the destination, deterministic in the walk model. */
    walkFromSec: number;
    /** What the column prints today: `now + totalSec`. */
    totalSec: number;
    computedAtMs?: number | undefined;
  },
  nowMs: number = Date.now(),
): ArriveBy | null {
  const { alightHighSec, walkFromSec, totalSec, computedAtMs } = input;
  if (alightHighSec == null || !Number.isFinite(alightHighSec)) return null;
  if (!Number.isFinite(walkFromSec) || !Number.isFinite(totalSec)) return null;
  const sec = remainingSec(alightHighSec, computedAtMs, nowMs) + Math.max(0, walkFromSec);
  // A ceiling earlier than the median the column already prints is not a
  // ceiling — and an elapsed promise arrives here too, clamped to the walk.
  if (sec < totalSec) return null;
  if (shownMinutes(sec - totalSec) > RANGE_MAX_SHOWN_MIN) return null;
  const from = new Date(nowMs);
  const clock = fmtClock(sec, from);
  // The same printed minute as the median: the preposition buys nothing.
  if (clock === fmtClock(totalSec, from)) return null;
  return {
    sec,
    text: `by ${clock}`,
    // No percentile and no frequency: `high` has been through the learned
    // per-horizon widening (see above), so it is NOT the q90 an earlier draft
    // of this line claimed, and the share of arrivals that beat it has never
    // been measured. What is true and useful is that it is the top of the very
    // range the countdown beside it prints.
    title: `The latest this trip is likely to take — the top of the range the countdown shows. About ${fmtClock(totalSec, from)} is typical.`,
  };
}
