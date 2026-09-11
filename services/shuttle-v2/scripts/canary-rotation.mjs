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
import { haversineM, liveBusesOf, MIN_RIDE_M, stopsOfLine } from "./canary-metrics.mjs";

/** The line with its own rider. The rotation never rides it. */
export const DEDICATED_LINE = "Red";

/**
 * How far ahead of a bus the board stop is placed, in stops. 1..6: close
 * enough that the countdown the rider watches is the bus already on the road
 * (map-bot's own preference is a wait of 3–20 min), far enough that the bus
 * has not pulled in before the browser has finished planning.
 */
export const BOARD_AHEAD_MAX = 6;
/** The ride the rotation prefers, in stops: 4..11 (fleet.sh). */
export const RIDE_STOPS_MIN = 4;
export const RIDE_STOPS_MAX = 11;

// ── the planner's own limits, mirrored ──────────────────────────────────────
// canary-rotation.test.mjs parses each of these out of the frontend's source,
// so the picker cannot drift from the planner it is second-guessing.

/** web/src/planner.ts — the planner stops scanning past this much riding. */
export const MAX_RIDE_SEC = 25 * 60;
/** web/src/routes.ts — the planner's speed for a hop with no observed time. */
export const BUS_SPEED_M_S = 6;
/** web/src/walk.ts — the app's effective walking rate over crow-flies metres. */
export const WALK_EFFECTIVE_M_S = 1.1;
/**
 * A ride must beat the walk between its two stops by this much before the
 * rotation asks the app for it. The planner offers any ride under
 * MAX_RIDE_SEC whose walk legs do not already exceed the direct walk, but a
 * ride that walking nearly matches is one the app is right to rank under
 * Walk and fold away — and a canary demanding it on the fold is how the
 * 2026-09-06 16:25 false positive happened (below).
 */
export const DOMINANCE_MARGIN_SEC = 120;
/** A wait the watch can actually see through; longer ones are last resort. */
export const WAIT_PREF_SEC = 20 * 60;

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
 * The planner's ride estimate for consecutive stops `a -> b`, exactly as
 * web/src/planner.ts prices a hop: the calibrated arrival-to-arrival average
 * when it has at least one sample, else crow-flies at BUS_SPEED_M_S with a
 * 30 s floor.
 */
export function hopSec(payload, line, a, b) {
  for (const rid of line.busRouteIds) {
    const seg = payload.segments?.[rid]?.[`${a}-${b}`];
    if (seg && seg.n >= 1 && Number.isFinite(seg.avg)) return seg.avg;
  }
  const pa = payload.stop_coords?.[a];
  const pb = payload.stop_coords?.[b];
  return pa && pb ? Math.max(30, haversineM(pa, pb) / BUS_SPEED_M_S) : 90;
}

/** Seconds the app would quote for walking between two coordinates. */
export const walkSec = (a, b) => haversineM(a, b) / WALK_EFFECTIVE_M_S;

/**
 * Every ride on `line` the planner would offer, from every bus's position.
 *
 * On 2026-09-06 at 16:25 ET the rotation asked for Whitney / Humphrey (N) ->
 * Elm / College on Grocery Ham: a 6-stop loop, and that pair is the long way
 * round — five hops past Aldi/Walmart and Shop Rite, ~66 min of riding for a
 * 1.5 km walk. The planner rightly offered Walk and Blue Weekend and never
 * Grocery Ham, and the canary filed `line-missing` + `option-vanished`
 * against a healthy app. The old picker drew "alight 4..11 stops on" modulo
 * the loop, which on a short loop wraps past its far end.
 *
 * So a ride here (positions, not ids — routes 9 and 10 repeat stops):
 *   - stays in one lap: alight index > board index, never wrapped;
 *   - is at most half the loop, in hops AND in metres — past half way the
 *     other direction is the short way;
 *   - is under the planner's MAX_RIDE_SEC, priced the planner's way;
 *   - beats the crow-flies walk between the two stops at the app's own rate
 *     by DOMINANCE_MARGIN_SEC.
 * The bus->board hops may wrap (the bus goes round; the rider does not).
 */
export function candidateRides(payload, line) {
  const stops = stopsOfLine(payload, line);
  const n = stops.length;
  if (n < 3) return [];
  const coord = (id) => payload.stop_coords?.[id] ?? null;
  const hopM = (i) => {
    const a = coord(stops[i]);
    const b = coord(stops[(i + 1) % n]);
    return a && b ? haversineM(a, b) : 0;
  };
  const loopM = stops.reduce((sum, _, i) => sum + hopM(i), 0);
  const maxHops = Math.ceil(n / 2);

  const out = [];
  // Only buses ON the route: `last_stop_id` is upstream's memory of the last
  // stop the bus visited, and it is still set while the bus deadheads in from
  // kilometres away (#57 carried Prospect / Sachem (N) all the way down
  // Whitney Ave from Hamden). A ride "1 stop out" from a bus that is not on
  // the line is a ride the planner will never offer.
  for (const bus of liveBusesOf(payload, line)) {
    if (bus.last_stop_id == null) continue;
    for (let p = 0; p < n; p++) {
      if (stops[p] !== bus.last_stop_id) continue;
      for (let ahead = 1; ahead <= BOARD_AHEAD_MAX; ahead++) {
        const i = (p + ahead) % n;
        if (stops[i] === bus.last_stop_id) continue;
        let waitSec = 0;
        for (let k = 0; k < ahead; k++) waitSec += hopSec(payload, line, stops[(p + k) % n], stops[(p + k + 1) % n]);
        const board = coord(stops[i]);
        if (!board) continue;
        let rideSec = 0;
        let rideM = 0;
        for (let j = i + 1; j < n && j - i <= maxHops; j++) {
          rideSec += hopSec(payload, line, stops[j - 1], stops[j]);
          rideM += hopM(j - 1);
          if (rideSec > MAX_RIDE_SEC || rideM > loopM / 2) break;
          const alight = coord(stops[j]);
          if (!alight || stops[j] === stops[i]) continue;
          const walk = walkSec(board, alight);
          if (haversineM(board, alight) < MIN_RIDE_M) continue;
          if (rideSec + DOMINANCE_MARGIN_SEC > walk) continue;
          out.push({
            busName: bus.bus_name, stopsAway: ahead, waitSec, rideSec, rideM, walkSec: walk,
            hops: j - i, board: i, alight: j, boardId: stops[i], alightId: stops[j],
          });
        }
      }
    }
  }
  return out;
}

/**
 * The trip the rotation rides on `line`, or why it must not.
 *
 * A random pick among the rides with the preferred shape — RIDE_STOPS_MIN..
 * RIDE_STOPS_MAX hops and a wait the watch can see through — else the
 * longest ride that still beats walking (a 5-stop grocery loop never has a
 * 4-hop ride under the half-loop rule), else `{ trip: null, reason }`: the
 * caller skips the line this cycle and says why. It never falls back to a
 * fixed trip, because a trip the planner will not offer is a finding against
 * the canary, not the app.
 */
export function randomTripForLine(payload, line, rng = Math.random) {
  const stops = stopsOfLine(payload, line);
  const name = (id) => payload.stop_names?.[id] ?? `stop ${id}`;
  const coord = (id) => payload.stop_coords?.[id] ?? null;
  const positioned = liveBusesOf(payload, line).some((b) =>
    b.last_stop_id != null && stops.includes(b.last_stop_id));
  if (!positioned) return { trip: null, reason: `no bus on ${line.label} reports a position on its stops` };

  const all = candidateRides(payload, line);
  if (!all.length) {
    return { trip: null, reason: `no forward ride on ${line.label} (${stops.length} stops) beats walking within the planner's ${MAX_RIDE_SEC / 60} min` };
  }
  const preferred = all.filter((c) =>
    c.hops >= RIDE_STOPS_MIN && c.hops <= RIDE_STOPS_MAX && c.waitSec <= WAIT_PREF_SEC);
  let pick;
  let shape;
  if (preferred.length) {
    pick = preferred[Math.floor(rng() * preferred.length)];
    shape = "random";
  } else {
    pick = all.reduce((best, c) => (c.rideM > best.rideM ? c : best), all[0]);
    shape = "longest";
  }
  const b = coord(pick.boardId);
  const d = coord(pick.alightId);
  return {
    trip: {
      kind: shape,
      origin: { label: name(pick.boardId), lat: b.lat, lon: b.lon, stopId: pick.boardId },
      destination: {
        display_name: name(pick.alightId), lat: d.lat, lon: d.lon,
        // Auto-picked by the frontend on type "bus_stop", like a derived trip.
        type: "bus_stop", class: "shuttle", stopId: pick.alightId,
      },
      approaching: { busName: pick.busName, stopsAway: pick.stopsAway },
      estimate: {
        hops: pick.hops, rideSec: Math.round(pick.rideSec), waitSec: Math.round(pick.waitSec),
        walkSec: Math.round(pick.walkSec), rideM: Math.round(pick.rideM),
      },
    },
    reason: null,
  };
}
