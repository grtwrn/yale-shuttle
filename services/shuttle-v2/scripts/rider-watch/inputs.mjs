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
