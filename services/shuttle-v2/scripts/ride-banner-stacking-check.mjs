// Built-SPA check for bannerzindex20261002: scroll the ride page through every
// offset on a phone viewport and fail if anything paints over the sticky ride
// banner (its headline, middle or "Done"). Before the fix the map's zoom
// control and 📍 button did, so a tap on "Done" hit "Show my location".
// Run from services/shuttle-v2 after `npm run build --prefix web`:
//   node scripts/ride-banner-stacking-check.mjs   (exit 0 = banner never covered)
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const service = process.cwd();
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const executablePath = process.env.CHROMIUM
  || ['/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
// A long Red ride (20 stops) so the stop list makes the page scroll well past the map.
const seq = feed.routes['3'], board = seq[0], exit = seq[20];
const ride = { routeLabel: 'Red', color: '#e53935', busName: '307', boardStopId: board, alightStopId: exit, startedAt: now,
  toText: feed.stop_names[exit], toLat: feed.stop_coords[exit].lat, toLon: feed.stop_coords[exit].lon };
const payload = () => ({ ...feed, buses: [{ bus_name: '307', bus_id: 1, route_id: 3, ...feed.stop_coords[seq[1]], last_stop_id: seq[1], heading: 180, observed_at: now }] });

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const covered = [];
let maxScroll = 0;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await seedTestId(context);
  await context.addInitScript(r => localStorage.setItem('shuttle-boarded-ride', JSON.stringify(r)), ride);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date(now) });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'ride.test') return route.abort();
    if (url.pathname === '/api/buses') return route.fulfill({ json: payload() });
    if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + name), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('https://ride.test');
  await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show my location' }).waitFor();
  await page.locator('.leaflet-control-zoom').waitFor();
  maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  if (maxScroll < 300) throw new Error(`ride page only scrolls ${maxScroll}px; the map never reaches the banner`);
  // Unscrolled, the map's own controls must still be on top (the fix must not bury them).
  const buried = await page.evaluate(() => [['zoom in', document.querySelector('.leaflet-control-zoom-in')],
    ['locate', document.querySelector('[aria-label="Show my location"]')]].filter(([, el]) => {
    const r = el.getBoundingClientRect();
    return !el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }).map(([name]) => name));
  for (const name of buried) covered.push({ scrollY: 0, name: `map ${name} control`, by: 'something above it' });
  if (process.env.SHOT) { await page.evaluate(() => window.scrollTo(0, 250)); await page.screenshot({ path: process.env.SHOT }); }
  for (let y = 0; y <= maxScroll; y += 5) {
    const hits = await page.evaluate(y => {
      window.scrollTo(0, y);
      const done = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Done');
      const banner = done.parentElement, d = done.getBoundingClientRect(), b = banner.getBoundingClientRect();
      const points = { done: [d.left + d.width / 2, d.top + d.height / 2], headline: [b.left + 30, b.top + 18],
        middle: [b.left + b.width / 2, b.top + b.height / 2], left: [b.left + 6, b.bottom - 6], right: [b.right - 6, b.top + 6] };
      const out = [];
      for (const [name, [x, py]] of Object.entries(points)) {
        const el = document.elementFromPoint(x, py);
        if (!banner.contains(el)) out.push({ name, by: el?.closest('button')?.getAttribute('aria-label') || el?.closest('.leaflet-control')?.className || el?.className?.toString() || el?.tagName });
      }
      return out;
    }, y);
    for (const h of hits) covered.push({ scrollY: y, ...h });
  }
} finally {
  await browser.close();
}
const byPoint = Object.groupBy(covered, c => `${c.name} ← ${c.by}`);
for (const [k, v] of Object.entries(byPoint)) console.log(`covered: ${k} at scrollY ${v[0].scrollY}–${v.at(-1).scrollY} (${v.length} offsets)`);
console.log(`${covered.length ? 'FAIL' : 'ok'}: scrolled 0–${maxScroll}px in 5px steps; ${covered.length} covered banner points`);
process.exit(covered.length ? 1 : 0);
