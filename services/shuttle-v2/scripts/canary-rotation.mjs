/**
 * canary-rotation.mjs — which line the second rider takes next, and what
 * trip it rides there. Pure; the browser and the feed live in rider-canary.mjs.
 *
 * The operator's ask (2026-09-06): "the canary should have one red line rider
 * always when its running and also another always that round Robin through
 * running lines". Two riders, then. The Red one is fixed. This module is the
 * other one's brain:
 *
 *   nextInRotation  — the next line in CANARY_LINES order after the one the
 *                     rotation last rode, skipping lines with nothing rideable
 *                     and never the dedicated line, which has its own rider.
 *                     A FIXED order that advances, not `cursor % pool.length`:
 *                     the old modulo walked a pool that changed shape every
 *                     cycle, so a line dropping out of service shifted every
 *                     other line's turn.
 *   randomTripForLine — a random trip on that line with a bus genuinely on
 *                     its way to the board stop, the way ~/eta-live/fleet.sh
 *                     and map-bot pick theirs. A fixed pair only ever
 *                     exercises one pair of segments, and the defects found so
 *                     far (the layover padding, the anchor on shared roads)
 *                     live at particular stops.
 */
import { haversineM, MIN_RIDE_M, stopsOfLine } from "./canary-metrics.mjs";

/** The line with its own rider. The rotation never rides it. */
export const DEDICATED_LINE = "Red";

/**
 * How far ahead of a bus the board stop is placed, in stops. 1..6: close
 * enough that the countdown the rider watches is the bus already on the road
 * (map-bot's own preference is a wait of 3–20 min), far enough that the bus
 * has not pulled in before the browser has finished planning.
 */
export const BOARD_AHEAD_MAX = 6;
/** How far past the board stop the rider alights, in stops: 4..11 (fleet.sh). */
export const RIDE_STOPS_MIN = 4;
export const RIDE_STOPS_SPAN = 8;

/**
 * The next line the rotation rides, or null when nothing outside the
 * dedicated line is rideable — in which case the rider idles rather than
 * doubling up on the line that already has a watcher.
 *
 * `lines` is `rideableLines()` output in CANARY_LINES order; `lastLabel` is
 * whatever the rotation rode last (unknown or retired labels start it over).
 */
export function nextInRotation(lines, lastLabel, dedicated = DEDICATED_LINE) {
  const order = lines.filter((l) => l.label !== dedicated);
  if (!order.length) return null;
  const last = order.findIndex((l) => l.label === lastLabel);
  for (let k = 1; k <= order.length; k++) {
    const cand = order[(last + k) % order.length];
    if (cand.rideable) return cand;
  }
  return null;
}

/**
 * A random trip on `line` with a bus approaching the board stop.
 *
 * Positions, not ids, throughout: routes 9 and 10 repeat stop ids on the West
 * Campus out-and-back, so "the stop after this one" is a position. A bus is
 * placed at the position of its `last_stop_id` (a random occurrence when the
 * id repeats), the board stop is 1..BOARD_AHEAD_MAX positions ahead of it, and
 * the alight stop RIDE_STOPS_MIN..+SPAN further on — at least MIN_RIDE_M away,
 * or the planner would rightly answer "walk". Returns null when no bus on the
 * line has a usable position, which the caller treats as "use the fixed trip".
 *
 * The board coordinate is the stop's own; the app plans from that GPS fix and
 * may pick a different board stop, and the canary reads the choice back out of
 * the app (see rider-canary.mjs), so this is a request, not an assertion.
 */
export function randomTripForLine(payload, line, rng = Math.random) {
  const stops = stopsOfLine(payload, line);
  const n = stops.length;
  if (n < RIDE_STOPS_MIN + 2) return null;
  const coord = (id) => payload.stop_coords?.[id] ?? null;
  const name = (id) => payload.stop_names?.[id] ?? `stop ${id}`;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const buses = (payload.buses ?? [])
    .filter((b) => line.busRouteIds.includes(b.route_id) && b.last_stop_id != null)
    .map((b) => ({ bus: b, at: stops.flatMap((id, i) => (id === b.last_stop_id ? [i] : [])) }))
    .filter((x) => x.at.length > 0);
  if (!buses.length) return null;

  for (let tries = 0; tries < 24; tries++) {
    const { bus, at } = pick(buses);
    const p = pick(at);
    const ahead = 1 + Math.floor(rng() * BOARD_AHEAD_MAX);
    const i = (p + ahead) % n;
    const j = (i + RIDE_STOPS_MIN + Math.floor(rng() * RIDE_STOPS_SPAN)) % n;
    if (stops[i] === stops[j] || stops[i] === bus.last_stop_id) continue;
    const b = coord(stops[i]);
    const d = coord(stops[j]);
    if (!b || !d || haversineM(b, d) < MIN_RIDE_M) continue;
    return {
      kind: "random",
      origin: { label: name(stops[i]), lat: b.lat, lon: b.lon, stopId: stops[i] },
      destination: {
        display_name: name(stops[j]), lat: d.lat, lon: d.lon,
        // Auto-picked by the frontend on type "bus_stop", like a derived trip.
        type: "bus_stop", class: "shuttle", stopId: stops[j],
      },
      approaching: { busName: bus.bus_name, stopsAway: ahead },
    };
  }
  return null;
}
