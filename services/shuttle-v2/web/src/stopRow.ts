// How a single row of the ride's stop list is highlighted.
//
// The list already bands its two ENDS — BOARD and GET OFF — in the route's own
// colour, so the eye finds "where do I get on" instantly. The one thing it did
// NOT band was the row that actually moves: the stop the bus is sitting at or
// has just cleared. That row was distinguished only by a 🚌 and bolder text,
// which is easy to miss on a list of a dozen near-identical names (rider
// report, 2026-09-03: "can you make where bus currently is a green or blue
// horizontal highlight so it's more obvious").
//
// It is green, not blue: blue is already spoken for as the rider's own GPS dot
// (see makeYouIcon in TransitMap.tsx), and two blue "you are here" marks on one
// screen would be one too many. #2E7D32 is the app's existing green for a live,
// confirmed status ("N buses running", saved stops).
//
// Pure on purpose — the decision is three booleans and a colour, and the
// 6.8k-line shell is the last place a rule like that should live.

/** The app's green for a live, confirmed status. */
export const BUS_HERE_COLOR = "#2E7D32";
/** The band behind the bus's row — the same green, at a tint that keeps
 *  bold 13-14px text on it above 4.5:1 against white. */
export const BUS_HERE_BG = "rgba(46,125,50,0.16)";

export type StopRowHighlight = {
  /** CSS background for the row; "transparent" when the row is plain. */
  background: string;
  /**
   * True when the row is drawn as a full-width band rather than a bare line.
   * The caller pads the row out and shifts its dot back by the same 6px, so
   * banded and plain rows keep one vertical rule.
   */
  banded: boolean;
  /** Text colour for the stop's name. */
  color: string;
};

const PLAIN: StopRowHighlight = { background: "transparent", banded: false, color: "#5f6368" };

/**
 * The bus's row wins over an end's.
 *
 * A rider standing at BOARD already knows they are at BOARD — it is labelled in
 * words, and the label and its big filled dot stay whichever band is behind
 * them. What they cannot see without looking is that the bus is THERE, so when
 * the two coincide the green is the fact worth drawing.
 */
export function stopRowHighlight(
  isBusHere: boolean,
  isEnd: boolean,
  routeColor: string,
): StopRowHighlight {
  if (isBusHere) {
    return {
      background: BUS_HERE_BG,
      banded: true,
      // At an end the name is already near-black beside its BOARD/GET OFF
      // label; recolouring it green there would fight that label for the row.
      color: isEnd ? "#202124" : BUS_HERE_COLOR,
    };
  }
  if (isEnd) {
    return { background: `${routeColor}1f`, banded: true, color: "#202124" };
  }
  return PLAIN;
}
