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
 * tracked bus when it is observed at the stop; while it is still near the
 * stop (≤150 m) but not observed there, skip the poll rather than switch.
 * Otherwise take the single line bus observed at the stop. Several unknown
 * buses at the stop fail closed. */
export function followedBusName(text, boardStopId, buses, routeIds, previous, stopCoords) {
  const named = String(text).match(/🚌\s*(#[\w-]+)\s*·/)?.[1];
  if (named) return named;
  const stop = stopCoords?.[boardStopId];
  if (boardStopId == null || !stop || !/(?:^|\n)BOARD\s*🚌/.test(String(text))) return null;
  const line = (buses ?? []).filter(b => routeIds.includes(b.route_id));
  const here = line.filter(b => observedAtStop(b, boardStopId, stopCoords));
  if (here.some(b => b.bus_name === previous)) return previous;
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
