/** Keep an open get-off prompt current without sending another notification. */
export function getOffAlertTitle(stopsRemaining: number | null): string | null {
  if (stopsRemaining === null || stopsRemaining > 2) return null;
  if (stopsRemaining <= 0) return "Get off here";
  return stopsRemaining === 1 ? "Get off at the next stop" : "Get off in 2 stops";
}
