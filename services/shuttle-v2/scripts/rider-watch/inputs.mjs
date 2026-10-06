import {CANARY_LINES,CANONICAL_TRIP,haversineM,stopsOfLine} from '../canary-metrics.mjs';
const norm = s => String(s).replace(/\s/g, '').toLowerCase();
/** Match the whole stop name after removing only known rendered decorations.
 * Ambiguous names fail closed; do not turn a suffix/prefix into another stop. */
export function labeledStopId(text, label, names) {
  const lines = String(text).split('\n').filter(line => line.startsWith(label));
  if (lines.length !== 1) return null;
  const name = lines[0].slice(label.length).replace(/^🚌\s*/, '').split('⏸')[0].trim();
  const matches = Object.entries(names).filter(([, value]) => norm(value) === norm(name));
  return matches.length === 1 ? Number(matches[0][0]) : null;
}
/** The app's direct at-stop observation, mirrored from `observedAtStop`
 * (web/src/liveAnchor.ts:43-51): stationary, at_stop_id is the stop, and
 * within 75 m. at_stop_id alone can linger after departure. */
export function observedAtStop(bus, stopId, stopCoords) {
  const stop = stopCoords?.[stopId];
  return bus.stationary === true && bus.at_stop_id === stopId && !!stop
    && haversineM(bus, stop) <= 75;
}
/** A fix unchanged for this long is a bus standing still: the collector polls
 * upstream every 5 s and a standing bus repeats its fix exactly (detector.ts
 * `MOVED_M`), so this is two unchanged polls. */
export const MOVING_MS = 9000;
/** The feed's own clock says the bus is moving: its fix changed within
 * `MOVING_MS` of the poll (v1compat `last_moved_at`, naive UTC, against
 * `observed_at`). A payload without the clock says nothing, so false, as the
 * app's `stillSec` (web/src/eta/filter.ts) reads it. */
export function movingNow(bus) {
  const stillMs = stillForMs(bus);
  return Number.isFinite(stillMs) && stillMs < MOVING_MS;
}
/** How long the fix had been unchanged at the poll, or NaN without the clock. */
function stillForMs(bus) {
  const moved = bus.last_moved_at == null ? NaN : Date.parse(bus.last_moved_at + 'Z');
  return Number.isFinite(bus.observed_at) ? bus.observed_at - moved : NaN;
}
/** The runner boards a followed bus within this of the pickup's pole. */
export const BOARD_M = 45;
/** The named card still puts this bus at least two stops from pickup, while
 * its direct observation is closer to the same-name opposite compass curb
 * and its GPS heading agrees with that other curb, not the pickup direction.
 * Both poles must be unique, non-neighbouring occurrences on this bus's
 * route: nearby sequential stops (e.g. Broadway/TYCO) are not a conflict.
 * This vetoes a proximity boarding, not a curb-service/arrival assertion;
 * an at-stop card and missing/ambiguous metadata keep the existing rules. */
export function oppositePickupCurb(bus, stopId, text, feed) {
  const quotes = [...String(text).matchAll(/🚌\s*(#[\w-]+)\s*·\s*(\d+) stops? away/g)];
  if (quotes.length !== 1 || quotes[0][1] !== bus.bus_name || Number(quotes[0][2]) < 2) return false;
  const curb = id => {
    const m = String(feed.stop_names?.[id]).match(/^(.*)\(([NSEW])\)\s*$/);
    return m ? {base: norm(m[1]), direction: m[2]} : null;
  };
  const pickup = curb(stopId), other = curb(bus.at_stop_id);
  if (!pickup || !other || pickup.base !== other.base
    || ({N:'S', S:'N', E:'W', W:'E'})[pickup.direction] !== other.direction) return false;
  // at_stop_id can linger on the wrong pole even on a correctly directed
  // approach (Pink Front/Rt 1, Green Orange/Humphrey). Corroborate with the
  // raw heading; missing/perpendicular headings do not justify this veto.
  if (!Number.isFinite(bus.heading) || bus.heading < 0 || bus.heading > 360) return false;
  const h = bus.heading % 360;
  const agrees = {N: h < 90 || h > 270, S: h > 90 && h < 270,
    E: h > 0 && h < 180, W: h > 180 && h < 360};
  if (!agrees[other.direction]) return false;
  const seq = feed.routes?.[bus.route_id];
  if (!Array.isArray(seq) || seq.filter(id => id === stopId).length !== 1
    || seq.filter(id => id === bus.at_stop_id).length !== 1) return false;
  const hops = Math.abs(seq.indexOf(stopId) - seq.indexOf(bus.at_stop_id));
  if (Math.min(hops, seq.length - hops) < 2) return false;
  const coord = feed.stop_coords?.[stopId];
  return !!coord && observedAtStop(bus, bus.at_stop_id, feed.stop_coords)
    && haversineM(bus, feed.stop_coords[bus.at_stop_id]) < haversineM(bus, coord);
}
/** A bus standing at the pickup that the feed does not put there: its fix has
 * held still for `MOVING_MS` within `BOARD_M` of the pole, whatever
 * `at_stop_id` says. Upstream can name the neighbouring stop, or none (and
 * v1compat's `stationary` is only `at_stop_id != null`): Blue Weekend #44 stood
 * 7 m from Broadway / York with at_stop_id Elm / York (TYCO), 2026-10-04
 * 15:37:17Z-15:37:42Z. The radius is the runner's own and inside the app's
 * `STOOD_HERE_M` (55 m, web/src/eta/filter.ts). Without the clock, false. */
export function standsAtPickup(bus, stopId, stopCoords) {
  const stop = stopCoords?.[stopId];
  return !!stop && stillForMs(bus) >= MOVING_MS && haversineM(bus, stop) <= BOARD_M;
}
/** The feed has the bus driving on past the pickup: upstream's `last_stop_id`
 * is already the pickup, the fix is still moving, and the app's at-stop rule
 * does not hold. These are the two witnesses the app's `leavingLastStop`
 * takes. `last_stop_id` alone is not enough: it can name a stop before the bus
 * reaches the pole, and while the bus stands at it with `at_stop_id` naming a
 * neighbouring stop (Blue Weekend #44 7 m from Broadway / York, at_stop_id
 * Elm / York, 2026-10-04). Purple #317 drove through 100 Church Street South
 * and was 42 m past the pole, moving, on the next poll
 * (riderboarddrivethrough20261005). */
export function pastPickup(bus, stopId, stopCoords) {
  return bus.last_stop_id === stopId && movingNow(bus)
    && !observedAtStop(bus, stopId, stopCoords);
}
/** The app's unnamed "🚌 I'm on it" stores the line's bus within this of the
 * rider, mirrored from `boardingBusName` and `BOARDING_BUS_M`
 * (web/src/tripBusIdentity.ts): the card's own when it is one of them, else
 * the nearest. */
export const BOARDING_BUS_M = 100;
/** Whether that button stores `name` for a rider at `at`: it is the nearest
 * line bus within 100 m. A card following another bus that close can still
 * store that one; the runner's wrong-bus check ends such a run. */
export function cardBoardsBus(buses, routeIds, at, name) {
  const bare = n => String(n).replace(/^#/, '');
  const near = (buses ?? []).filter(b => routeIds.includes(b.route_id) && Number.isFinite(b.lat) && Number.isFinite(b.lon))
    .map(b => ({name: bare(b.bus_name), m: haversineM(at, b)}))
    .filter(b => b.m <= BOARDING_BUS_M).sort((a, b) => a.m - b.m);
  return near.length > 0 && near[0].name === bare(name);
}
export const FOLLOWED_NEAR_STOP_M = 150;
/** The bus the trip card follows. "🚌 #NN · N stops away" names it while it
 * approaches; once it is at the pickup the app drops that line and decorates
 * BOARD with 🚌/⏸ instead. That 🚌 is the bus the app follows, which it may
 * place at the stop from route belief, not only from the feed. So keep the
 * tracked bus when it is observed at the stop, or when it is the only line
 * bus standing at the pickup, observed there or `standsAtPickup` (the feed
 * naming a neighbouring stop or none); while it is still near the stop
 * (≤150 m) otherwise, skip the poll rather than switch. Otherwise take the
 * single line bus observed at the stop. Several unknown buses at the stop
 * fail closed. `standsAtPickup` alone never picks an untracked bus: a bus at
 * the opposite curb stands as close (Green #302 at Orange / Bradley (S),
 * 13-26 m from (N)'s pole, 2026-10-02 and 10-05). */
export function followedBusName(text, boardStopId, buses, routeIds, previous, stopCoords) {
  const named = String(text).match(/🚌\s*(#[\w-]+)\s*·/)?.[1];
  if (named) return named;
  const stop = stopCoords?.[boardStopId];
  if (boardStopId == null || !stop || !/(?:^|\n)BOARD\s*🚌/.test(String(text))) return null;
  const line = (buses ?? []).filter(b => routeIds.includes(b.route_id));
  const here = line.filter(b => observedAtStop(b, boardStopId, stopCoords));
  if (here.some(b => b.bus_name === previous)) return previous;
  const standing = line.filter(b => here.includes(b) || standsAtPickup(b, boardStopId, stopCoords));
  if (standing.length === 1 && standing[0].bus_name === previous) return previous;
  const tracked = line.find(b => b.bus_name === previous);
  if (tracked && haversineM(tracked, stop) <= FOLLOWED_NEAR_STOP_M) return null;
  return here.length === 1 ? here[0].bus_name : null;
}
/** The ride the trip card quoted ("🚌 54 min" on its own line, fmtMin), or
 * null when it shows none or disagreeing values. */
export function quotedRideMin(text) {
  const quotes = [...String(text ?? '').matchAll(/(?:^|\n)🚌 (\d+) min(?=\n|$)/g)].map(m => Number(m[1]));
  return quotes.length && quotes.every(q => q === quotes[0]) ? quotes[0] : null;
}
export const RIDE_CAP_MIN = 50, RIDE_CAP_MAX_MIN = 90;
/** Minutes to ride before giving up: 1.5× the quoted ride, never below the
 * old fixed 50 min (an unquoted ride keeps it) and never above 90 min, so a
 * bus that never reaches the stop still ends the run. */
export function rideCapMin(quoted) {
  return Math.min(RIDE_CAP_MAX_MIN, Math.max(RIDE_CAP_MIN, Math.ceil((quoted ?? 0) * 1.5)));
}
/** The wait the trip card quoted ("Arrival: About 44 min · Likely 33–60 min";
 * "About <1 min" is 0), or null when it shows none or disagreeing values. */
export function quotedWaitMin(text) {
  const quotes = [...String(text ?? '').matchAll(/(?:^|\n)Arrival: About (<1|\d+) min/g)].map(m => m[1] === '<1' ? 0 : Number(m[1]));
  return quotes.length && quotes.every(q => q === quotes[0]) ? quotes[0] : null;
}
export const WAIT_CAP_MIN = 45, WAIT_CAP_MAX_MIN = 90;
/** Minutes to wait before giving up, from the journey's start: 1.5× the
 * first quoted wait, never below the old fixed 45 min (an unquoted wait keeps
 * it) and never above 90 min. */
export function waitCapMin(quoted) {
  return Math.min(WAIT_CAP_MAX_MIN, Math.max(WAIT_CAP_MIN, Math.ceil((quoted ?? 0) * 1.5)));
}
/** The rider's assignment from the environment. Unset: random lines and
 * trips. RIDER_LINE alone pins the line. With RIDER_FROM (board stop id) and
 * RIDER_TO (stop id, or `ysph` for the School of Public Health landmark riders
 * search for) it repeats one trip, idling while the line has no live bus.
 * A stop that is not on the line fails instead of riding something else. */
export function riderConfig(env, feed) {
  const label = env.RIDER_LINE?.trim();
  if (!label) {
    if (env.RIDER_FROM || env.RIDER_TO) throw new Error('RIDER_FROM/RIDER_TO need RIDER_LINE');
    return {randomLines: true};
  }
  const line = CANARY_LINES.find(l => l.label === label);
  if (!line) throw new Error(`Unknown RIDER_LINE ${label}`);
  if (!env.RIDER_FROM && !env.RIDER_TO) return {allowedLabels: [label]};
  const stop = (raw, role) => {
    const id = Number(raw), coord = feed.stop_coords?.[id];
    if (!Number.isInteger(id) || !stopsOfLine(feed, line).includes(id) || !coord)
      throw new Error(`${role}=${raw} is not a ${label} stop`);
    return {id, name: feed.stop_names?.[id] ?? `stop ${id}`, lat: coord.lat, lon: coord.lon};
  };
  const from = stop(env.RIDER_FROM, 'RIDER_FROM');
  const to = String(env.RIDER_TO).trim().toLowerCase() === 'ysph' ? null : stop(env.RIDER_TO, 'RIDER_TO');
  return {allowedLabels: [label], fixedTrip: {
    kind: 'fixed',
    origin: {label: from.name, lat: from.lat, lon: from.lon, stopId: from.id},
    destination: to
      ? {display_name: to.name, lat: to.lat, lon: to.lon, type: 'bus_stop', class: 'shuttle', stopId: to.id}
      : {...CANONICAL_TRIP.destination},
  }};
}
export function destinationMatches(draft, destination) {
  const p = draft?.toLL;
  return !!p && [p.lat,p.lon,destination.lat,destination.lon].every(Number.isFinite)
    && haversineM(p, destination) <= 80;
}
export async function selectDestination(page, destination) {
  const input = page.getByPlaceholder('Where do you want to go?');
  await input.fill(destination.display_name);
  // A curated result may use an alias, e.g. West Haven Station. Exercise the
  // rider's normal Enter action, then verify the resolved destination.
  await input.press('Enter');
  await page.waitForFunction(() => !!JSON.parse(sessionStorage.getItem('shuttle-trip-draft') || 'null')?.toLL,
    undefined, {timeout:10000});
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft') || 'null'));
  if (!destinationMatches(draft, destination)) throw new Error('Resolved destination is not within 80 m of intended stop');
  return draft;
}
