import {haversineM} from '../canary-metrics.mjs';
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
/** The bus the trip card follows. "🚌 #NN · N stops away" names it while it
 * approaches; once it is at the pickup the app drops that line and decorates
 * BOARD with 🚌/⏸ instead. Then take the line bus the feed reports at the
 * board stop (the app's own at-stop choice), preferring the one we tracked.
 * Several unknown buses at the stop fail closed. */
export function followedBusName(text, boardStopId, buses, routeIds, previous) {
  const named = String(text).match(/🚌\s*(#[\w-]+)\s*·/)?.[1];
  if (named) return named;
  if (boardStopId == null || !/(?:^|\n)BOARD\s*🚌/.test(String(text))) return null;
  const here = (buses ?? []).filter(b => routeIds.includes(b.route_id) && b.at_stop_id === boardStopId);
  if (here.some(b => b.bus_name === previous)) return previous;
  return here.length === 1 ? here[0].bus_name : null;
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
