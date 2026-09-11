// The words on the folded berth row, and nothing else.
//
// Their own module because they have to be UNIT TESTABLE: `BerthDisclosure`
// imports `BerthInset`, which imports Leaflet, which touches `window` at import
// time and cannot be loaded in this repo's node test environment at all. The
// wording is the part of this feature most likely to be reworded, and it is the
// part with a hard constraint on it (the canary's route-label pattern), so it
// is the part that must be reachable from a test.

import type { Berth } from "./berths";

/**
 * The toggle's own words, and they are short for a measured reason.
 *
 * `scripts/berth-row-measure.mjs` lays both controls out at 360 / 390 / 430 px
 * and reports the room left on the row. At 390 px the row is **342 px**, and:
 *
 *   🧭 Directions to published stop   263.9 px
 *   🧭 Directions to stop             181.6 px
 *   ⚠ Stops 55 m past ▾               167.5 px
 *   ⚠ 55 m past ▾                     121.4 px
 *
 * So the long button and ANY useful warning need 393 px of 342 and cannot share
 * a line; the short button and the short warning need **311 px** and share one
 * at all three widths. Counting characters is how a wrapping line shipped on
 * 2026-09-03, so those are rendered widths, not estimates.
 *
 * The warning carries the DISTANCE rather than a bare "!", because an alert
 * with no number is a worse version of the sentence it is hiding. The digits
 * are also what keep it out of the canary's route-label pattern (`isLabelish`
 * is letters and spaces only) — see the captured fixture in
 * `scripts/canary-metrics.test.mjs`.
 */
export const berthToggleText = (berth: Berth): string =>
  `⚠ ${Math.round(Math.abs(berth.offsetM))} m ${berth.offsetM > 0 ? "past" : "before"}`;

/**
 * And the button's words follow the operator's own rule, which was causal:
 * "the directions to stop button should now say directions to published stop
 * SINCE WE SHOW TWO" (2026-09-11). Folded, we no longer show two — there is one
 * stop on the card and a chip warning that buses pull up past it — so the
 * button is back to naming it plainly. Opened, the map really does show two,
 * each labelled, and the button says which one it points at.
 *
 * The label therefore changes at exactly the moment a 200 px map appears under
 * it, which is not a subtle interaction to attach it to; and it is why the long
 * form only ever has to fit a row it is allowed to wrap in.
 */
export const berthDirectionsText = (open: boolean): string =>
  open ? "🧭 Directions to published stop" : "🧭 Directions to stop";
