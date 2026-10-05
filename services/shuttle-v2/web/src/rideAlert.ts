/** Keep an open get-off prompt current without sending another notification. */
export function getOffAlertTitle(stopsRemaining: number | null): string | null {
  if (stopsRemaining === null || stopsRemaining > 2) return null;
  if (stopsRemaining <= 0) return "Get off here";
  return stopsRemaining === 1 ? "Get off at the next stop" : "Get off in 2 stops";
}

/** The ride countdown below which "Get off in 2 stops" may fire: it shows
 * 5 min or less (`formatRideEta` floors). */
export const TWO_STOPS_ALERT_BELOW_SEC = 6 * 60;

/**
 * Whether the one-shot get-off alert (buzz, notification, popup) is due. Two
 * stops out it also waits for the countdown to the exit to show 5 min or less:
 * on Purple's Building 400 -> LEPH/60 College return, two stops out is Building
 * 900, and it fired with 22 min still on the countdown
 * (bannerpopuptime20261005). Without a countdown it fires on the count alone,
 * as before; "next stop" and "here" never wait.
 */
export function getOffAlertDue(stopsRemaining: number | null, etaSec: number | null): boolean {
  if (stopsRemaining === null || getOffAlertTitle(stopsRemaining) === null) return false;
  return stopsRemaining <= 1 || etaSec === null || etaSec < TWO_STOPS_ALERT_BELOW_SEC;
}

/** An already-open prompt must follow current evidence, including its loss. */
export function getOffPromptTitle(stopsRemaining: number | null): string {
  return getOffAlertTitle(stopsRemaining)
    ?? (stopsRemaining === null
      ? "Live stop position unavailable"
      : `Your stop is ${stopsRemaining} stops away`);
}
