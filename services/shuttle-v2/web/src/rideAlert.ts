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
 * {@link GET_OFF_ALERT_BELOW_SEC} or more is stuck high, not waiting on a hold
 * the model priced. */
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
 * arrival's `departNow`) still 6 min or more, no hold the model priced explains
 * it. Blue West's approach to 333 Cedar read 12 min with the bus 760 m out; it
 * arrived 3.7 min later. A bus laying over at 333 Cedar 360 m short of 300
 * George St prices the hold, not the drive, and still waits. A hold the model
 * didn't price fires it too: on about a third of standing rows no rest is taken
 * out of `departNow`, which then equals the countdown (standWait.ts
 * `arrivalBand`). #377's review counted 21 of 49 escape fires on standing
 * buses, e.g. Blue Night 50 -> 97 9.3 min before the exit, where master fired
 * as well.
 *
 * The banner asks this only once the rider can be on the bus ({@link rideBoarded}).
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

/**
 * Whether the ride's bus has carried the rider yet: seen, since the ride
 * began, at the pickup or at a call between it and the exit, on the pass the
 * banner counts to (`row`, liveAnchor.ts `rideCallIndex` on the ride's
 * `callCount` calls). Sticky (`seen`); the banner keeps it with the ride, so a
 * reload still knows.
 *
 * A ride can be started before its bus comes (TripBoardingActions), and the
 * count is then to whichever pass of the exit comes first, which can be before
 * the pickup (ridecountpreboard20261005). A Green bus on Orange Street, coming
 * to a rider at Building 400, counted 2 and 1 to West Haven Train Station's
 * outbound call, and "Get off at the next stop" popped up 12 min before the
 * rider boarded, which spent the one-shot alert, so none came on the ride. A
 * bus at the exit on its way round to the pickup counts 0, "Get off here":
 * Purple 10 -> 127 at the station, Grocery Ham 54 -> 170, Red 48 -> 72 at
 * LEPH / 60 College, 33 min before boarding. Neither is at a call of the ride
 * short of the exit. A bus already on the ride when it begins is the rider's,
 * as before: by the feed alone a ride started on board looks the same as one
 * started a lap behind.
 */
export function rideBoarded(seen: boolean, row: number, callCount: number): boolean {
  return seen || (row >= 0 && row < callCount - 1);
}

/** An already-open prompt must follow current evidence, including its loss. */
export function getOffPromptTitle(stopsRemaining: number | null): string {
  return getOffAlertTitle(stopsRemaining)
    ?? (stopsRemaining === null
      ? "Live stop position unavailable"
      : `Your stop is ${stopsRemaining} stops away`);
}
