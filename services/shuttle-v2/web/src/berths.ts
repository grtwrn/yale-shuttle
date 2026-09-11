/**
 * Where a line actually pulls up, for the handful of stops where that is not
 * where the map draws the stop.
 *
 * THE RIDER PROBLEM (operator, 2026-09-10): "sometimes the shuttle does not
 * stop at the location indicated on the map. That makes it confusing for
 * first-time riders to know where to stand."
 *
 * These coordinates are MEASURED, not published: `scripts/berth-offsets.mjs`
 * takes the last stand of every visit the detector scored `stopped`, projects
 * it onto the route's own polyline, and reads the front of the cloud (the
 * feed's ~30 m deadband means every observation lags the true stop, so a high
 * quantile estimates it and a mean would report every stop ~15 m short). The
 * full method, the gates and three refused discriminators are in
 * `docs/berth-offsets.md`. Regenerate with
 * `node scripts/berth-offsets.mjs --payload buses.json --json out.json`.
 *
 * WHY THIS IS A TABLE AND NOT A SERVED FIELD. Ten entries that change when a
 * kerb changes — the same shape as `landmarks.ts`, and for the same reason: a
 * human should read the diff. It costs no payload byte and no calibrator work.
 *
 * SCOPE, deliberately narrow. 10 of 235 stop/route cells cleared the gates over
 * 2026-09-03..09 (27,718 visits). A cell needs >=20 observed visits, >=20 of
 * them inside one 40 m window holding >=75% of the visits that are not SHORT of
 * it and a majority of all of them, <=10% ending PAST it, a berth >=35 m from
 * the published stop — above anything the deadband alone can produce — and no
 * other stop nearer to that berth than its own. Division / Prospect on Red is
 * here because the operator supplied the ground truth that separates its two
 * clusters: the northern one is Red waiting to turn off Division, the southern one is the
 * kerb.
 *
 * THE STOP IS DIFFERENT PER LINE, so cells are per (stop, route) and never
 * pooled: at 14 of 53 stops served by two or more lines the berths are more
 * than a bus length apart, and 10 of those 14 are lines travelling the SAME
 * direction, so direction does not explain it either.
 */
export interface Berth {
  stopId: number;
  /** Upstream `route_id`, matched against a config's `busRouteIds`. */
  routeId: number;
  lat: number;
  lon: number;
  /** Metres along the route from the published stop; negative is short of it. */
  offsetM: number;
  /** Visits that berthed here, of the visits that berthed at all. */
  seen: number;
  of: number;
}

export const BERTHS: readonly Berth[] = [
  { stopId: 1, routeId: 10, lat: 41.298876, lon: -72.929185, offsetM: 91, seen: 23, of: 25 }, // 100 Church Street South — Purple
  { stopId: 9, routeId: 13, lat: 41.304492, lon: -72.930752, offsetM: 65, seen: 37, of: 39 }, // 300 George St — Blue Night
  { stopId: 26, routeId: 9, lat: 41.260247, lon: -72.986613, offsetM: 36, seen: 43, of: 43 }, // Building 900 — Green
  { stopId: 27, routeId: 3, lat: 41.321533, lon: -72.929334, offsetM: 64, seen: 35, of: 36 }, // Canal / Munson — Red
  { stopId: 35, routeId: 13, lat: 41.303003, lon: -72.928061, offsetM: 49, seen: 39, of: 39 }, // Church / George — Blue Night
  { stopId: 48, routeId: 3, lat: 41.324475, lon: -72.923216, offsetM: 55, seen: 37, of: 40 }, // Division / Prospect — Red
  { stopId: 67, routeId: 13, lat: 41.312427, lon: -72.928741, offsetM: 40, seen: 32, of: 32 }, // Wall / York — Blue Night
  { stopId: 100, routeId: 1, lat: 41.325912, lon: -72.922697, offsetM: 64, seen: 52, of: 52 }, // Prospect / Canner — Blue Day
  { stopId: 154, routeId: 16, lat: 41.309614, lon: -72.93672, offsetM: -39, seen: 21, of: 21 }, // Chapel / Dwight — Blue West
  { stopId: 157, routeId: 17, lat: 41.307126, lon: -72.921496, offsetM: 88, seen: 38, of: 40 }, // Elm / Orange — Orange East
];

/**
 * The berth for a line at a stop, or null — which is the answer for all but ten
 * cells, and the map is unchanged wherever it is null.
 */
export function berthFor(stopId: number, routeIds: readonly number[]): Berth | null {
  for (const b of BERTHS) if (b.stopId === stopId && routeIds.includes(b.routeId)) return b;
  return null;
}
