/** Keep an open get-off prompt current without sending another notification. */
export function getOffAlertTitle(stopsRemaining: number | null): string | null {
  if (stopsRemaining === null || stopsRemaining > 2) return null;
  if (stopsRemaining <= 0) return "Get off here";
  return stopsRemaining === 1 ? "Get off at the next stop" : "Get off in 2 stops";
}

/** The ride countdown below which "Get off in 2 stops" and "Get off at the
 * next stop" may fire: it shows 5 min or less (`formatRideEta` floors). */
export const GET_OFF_ALERT_BELOW_SEC = 6 * 60;

/** Within this distance of the exit, a countdown whose drive alone is still
 * {@link GET_OFF_ALERT_BELOW_SEC} or more is stuck high, not waiting on a hold. */
export const NEXT_STOP_STUCK_WITHIN_M = 1000;

/**
 * Whether the one-shot get-off alert (buzz, notification, popup) is due. Two
 * stops and one stop out it also waits for the countdown to the exit to show
 * 5 min or less. On Purple's Building 400 -> LEPH/60 College return, two stops
 * out is Building 900 with 22 min still on the countdown
 * (bannerpopuptime20261005); one stop out is West Haven station, its hold and
 * the drive downtown, 18 min, and Grocery Ham's last leg to Aldi/Walmart is
 * 18 min too (nextstoppopupfloor20261005). Without a countdown it fires on the
 * count alone, as before; "here" never waits.
 *
 * "Next stop" doesn't wait on a countdown that is stuck high either: with the
 * bus within 1 km of the exit and the countdown's drive alone (`driveSec`, the
 * arrival's `departNow`) still 6 min or more, no hold explains it. Blue West's
 * approach to 333 Cedar read 12 min with the bus 760 m out; it arrived 3.7 min
 * later. A bus laying over at 333 Cedar 360 m short of 300 George St prices the
 * hold, not the drive, and still waits.
 */
export function getOffAlertDue(
  stopsRemaining: number | null,
  etaSec: number | null,
  driveSec: number | null = null,
  exitMeters: number | null = null,
): boolean {
  if (stopsRemaining === null || getOffAlertTitle(stopsRemaining) === null) return false;
  if (stopsRemaining <= 0 || etaSec === null || etaSec < GET_OFF_ALERT_BELOW_SEC) return true;
  return stopsRemaining === 1
    && exitMeters !== null && exitMeters < NEXT_STOP_STUCK_WITHIN_M
    && driveSec !== null && driveSec >= GET_OFF_ALERT_BELOW_SEC;
}

/** An already-open prompt must follow current evidence, including its loss. */
export function getOffPromptTitle(stopsRemaining: number | null): string {
  return getOffAlertTitle(stopsRemaining)
    ?? (stopsRemaining === null
      ? "Live stop position unavailable"
      : `Your stop is ${stopsRemaining} stops away`);
}
