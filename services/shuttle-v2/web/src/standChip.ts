/**
 * The pause chip's second number: what is LEFT of this bus's hold.
 *
 * WHAT IT USED TO SAY, AND WHY THAT WAS WRONG. The chip printed
 * `⏸ 2:21 / ~4:48` — the elapsed clock, then the stop's UNCONDITIONAL median
 * stand. It reads as "2:21 of about 4:48", and a rider subtracts: 2:27 to go.
 * The countdown beside it was billing something else — the residual of the
 * same table given 2:21 already stood, 3:31 — because a stand that has
 * already lasted 2:21 is drawn from the longer-hold population. Two numbers
 * on one line, one of them not the one being charged. The operator hit it
 * live at 344 Winchester on 2026-09-08 ("4:48 seems short"), which is exactly
 * a total being read as a promise. `docs/eta-ring-posterior.md` and CLAUDE.md
 * both already claimed the chip quoted the residual "so the chip and the
 * countdown cannot disagree"; the tooltip did, the glyph did not.
 *
 * WHAT IT SAYS NOW: the remainder, the very term the countdown adds. It is a
 * statement about THIS bus rather than about the stop, which is what a rider
 * standing at the kerb is asking, and it cannot contradict the number beside
 * it because it IS part of that number.
 *
 * THE CLAMP, and the honest tension. The conditional TOTAL rises the longer a
 * bus sits — that is the inspection paradox, and it is real (344 Winchester:
 * 287 s expected at arrival, 356 s at 2:21, 702 s at ten minutes). The #119
 * clamp forbids the countdown from climbing while a bus stands, and that is
 * the operator's decision and stays. So the chip may not show the rise
 * either, or the two numbers move in opposite directions with nothing on
 * screen to explain it. The remainder mostly falls on its own — but not
 * always: on the live tables 167 of 277 stand tables have a residual median
 * that rises somewhere (worst single step +128 s), where a table's own tail
 * hazard flattens past its last recorded stand. So the shown remainder is
 * floored the same way the countdown is: within ONE rest it may pause and it
 * may fall, never climb. When the rest ends the clock changes and the floor
 * goes with it.
 *
 * The cost, stated so nobody rediscovers it: the chip no longer says what the
 * stop typically does. That figure is still shown for a stop the bus has not
 * reached — where there is no remainder to state and the typical hold IS the
 * honest answer — and it is still in the tooltip here.
 */

/** One rest's floor: the smallest remainder shown, and which rest it belongs to. */
export interface ChipFloor { rest: string; sec: number }

export type ChipFloors = Map<string, ChipFloor>;

/**
 * Identify the rest, not just the bus: a bus that pulls out and stands again
 * gets a fresh floor. `restStartMs` is the elapsed clock's own origin
 * (`now − elapsedSec`), quantised to the poll so a second's jitter in the
 * rendered clock does not read as a new rest.
 */
export function restKey(stopId: number, nowMs: number, elapsedSec: number): string {
  return `${stopId}@${Math.round((nowMs - elapsedSec * 1000) / 10_000)}`;
}

/**
 * The remainder to show, floored non-increasing within one rest.
 *
 * Pure given `floors`, which the caller owns — the same pattern as the
 * estimator's `AnchorStore`, so a test (or a replay) can hand over an empty
 * map and get the unclamped answer.
 */
export function chipRemainder(
  floors: ChipFloors,
  busKey: string,
  rest: string,
  sec: number,
): number {
  const v = Math.max(0, sec);
  const cur = floors.get(busKey);
  if (!cur || cur.rest !== rest) {
    floors.set(busKey, { rest, sec: v });
    return v;
  }
  if (v < cur.sec) cur.sec = v;
  return cur.sec;
}

/** The live app's one floor store, beside `liveAnchorStore` and `liveStandHours`. */
export const liveChipFloors: ChipFloors = new Map();
