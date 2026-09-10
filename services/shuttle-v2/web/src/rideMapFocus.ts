/** A viewport can follow a leg only when its two endpoint occurrences are known. */
export function rideMapStopSequence(
  route: readonly number[] | undefined,
  boardStopId: number,
  alightStopId: number,
): number[] | null {
  if (!route || boardStopId === alightStopId) return null;
  const board = route.indexOf(boardStopId), alight = route.indexOf(alightStopId);
  if (board < 0 || alight < 0 || board !== route.lastIndexOf(boardStopId) || alight !== route.lastIndexOf(alightStopId)) return null;
  return board < alight
    ? route.slice(board, alight + 1)
    : [...route.slice(board), ...route.slice(0, alight + 1)];
}
