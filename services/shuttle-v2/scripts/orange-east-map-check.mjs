/** Inspect the reported Division / Prospect → YSPH trip on the hosted runner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { traceStopLegs, polylineMeters } from '../web/src/geo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'gallery-review/orange-east');
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile(path.join(root, 'scripts/__fixtures__/minimap-label-feed.json'), 'utf8'));
const now = feed.server_eta.servedAt;
const report = { errors: [], scope: 'Recorded route geometry; scheduled evening trip, not live ETA validation' };
const routeStops = feed.routes['17'];
const routeCoords = [...routeStops, routeStops[0]].map(id => feed.stop_coords[id]);
report.geometry = traceStopLegs(feed.route_paths['17'], routeCoords).map((leg, i) => ({
  from: feed.stop_names[routeStops[i]], to: feed.stop_names[routeStops[(i + 1) % routeStops.length]],
  meters: Math.round(polylineMeters(leg.slice)), bridged: leg.bridged,
}));
assert(report.geometry.every(leg => !leg.bridged), 'Orange East drawing falls back to a straight line between stops');
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await seedTestId(context);
  await context.addInitScript(({ now, fromLL }) => {
    const D = Date;
    window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    window.setInterval = () => 0;
    sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Division / Prospect', fromLL,
      toText: 'School of Public Health (YSPH)', toLL: { lat: 41.303735, lon: -72.932155 },
      tripTime: '', expandedKey: null, savedAt: now }));
  }, { now, fromLL: feed.stop_coords[48] });
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (['tile.openstreetmap.org', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return route.continue();
    if (u.hostname !== 'orange-east.test') return route.abort();
    if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
    if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
    const f = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({ body: await fs.readFile(root + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('https://orange-east.test');
  // Choose an evening departure after the recorded feed has loaded, as a
  // rider does. The initial empty feed cannot supply scheduled route geometry.
  await page.getByRole('button', { name: 'View Red trip details', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Plan for later…', exact: true }).click();
  await page.getByLabel('Departure time', { exact: true }).fill('2026-09-18T19:00');
  await page.getByText(/Estimated from service hours and typical wait and travel times/).waitFor();
  const more = page.getByRole('button', { name: /Show \d+ more route/ });
  if (await more.isVisible()) await more.click();
  report.options = await page.getByTestId('route-timing-table').innerText();
  await page.getByRole('button', { name: 'View Orange East trip details', exact: true }).click();
  const stops = page.getByTestId('trip-stop-list');
  await stops.waitFor();
  report.stops = await stops.innerText();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const tiles = [...document.querySelectorAll('.trip-map-canvas .leaflet-tile')];
    return tiles.length && tiles.every(i => i.complete && i.naturalWidth);
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(report.errors, []);
  await page.locator('.trip-map-wrap').screenshot({ path: path.join(out, 'division-prospect-ysph-390.png'), animations: 'disabled' });
  await context.close();
} catch (error) {
  report.errors.push(String(error.stack));
  throw error;
} finally {
  await browser.close();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
