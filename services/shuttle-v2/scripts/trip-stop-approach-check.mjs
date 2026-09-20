/** Report #121: a bus on the previous lap must show every stop before pickup.
 * Recorded public route geometry with synthetic positions/forecasts, no live
 * reports, geocoding, analytics, or estimator calibration are touched. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'gallery-review/trip-stop-approach');
await fs.mkdir(out, { recursive: true });
const original = JSON.parse(await fs.readFile(path.join(root, 'scripts/__fixtures__/minimap-label-feed.json'), 'utf8'));
const now = Date.parse('2026-09-20T19:44:00-04:00');
const sequence = original.routes['16'];
assert.deepEqual(sequence, [10, 153, 154, 155, 156, 161, 162, 27, 163, 164, 98]);
const scenarios = [
  { name: 'phelps-before-pickup', stop: 98, approach: [98, 10, 153, 154, 155, 156, 161, 162, 27] },
  { name: 'cedar-before-pickup', stop: 10, approach: [10, 153, 154, 155, 156, 161, 162, 27] },
  { name: 'one-stop-before-pickup', stop: 27, approach: [27] },
  { name: 'at-pickup', stop: 163, approach: [] },
];
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { errors: [], runs: [] };
try {
  for (const width of [390, 1280]) {
    for (const scenario of scenarios) {
      const feed = structuredClone(original);
      const anchor = sequence.indexOf(scenario.stop);
      feed.announcements = [];
      feed.buses = [{ bus_name: '#325', bus_id: 9325, route_id: 16, ...feed.stop_coords[scenario.stop],
        last_stop_id: scenario.stop, at_stop_id: scenario.stop, observed_at: now,
        at_stop_since: new Date(now - 62_000).toISOString().replace(/Z$/, ''), stationary: true, heading: 180 }];
      const rows = Array.from({ length: 2 * sequence.length }, (_, h) => {
        const eta = h * 150;
        return [0, sequence[(anchor + h) % sequence.length], eta, Math.max(0, eta - 60), eta + 120, h, 0, Math.max(0, eta - 60), Math.max(0, eta - 60)];
      });
      feed.server_eta = { v: 2, at: now, servedAt: now,
        buses: [['325', 'Blue West', anchor, { stopId: scenario.stop, standingSec: 62, approach: false }]], rows,
        distributions: rows.map(r => Array.from({ length: 50 }, (_, i) => r[3] + i * (r[4] - r[3]) / 49)) };
      const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 500,
        hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      await seedTestId(context);
      await context.addInitScript(({ now, fromLL, toLL }) => {
        const D = Date;
        window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
        window.setInterval = () => 0;
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Mansfield / Division', fromLL,
          toText: '333 Cedar', toLL, tripTime: '', expandedKey: null, savedAt: now }));
      }, { now, fromLL: feed.stop_coords[163], toLL: feed.stop_coords[10] });
      const page = await context.newPage();
      page.on('pageerror', e => report.errors.push(e.message));
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (['tile.openstreetmap.org', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return route.continue();
        if (u.hostname !== 'trip-stop-approach.test') return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
        if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
        const f = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({ body: await fs.readFile(root + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      await page.goto('https://trip-stop-approach.test');
      const more = page.getByRole('button', { name: /Show \d+ more route/ });
      const card = page.getByRole('button', { name: 'View Blue West trip details', exact: true });
      await page.getByTestId('route-timing-table').waitFor();
      if (await more.isVisible()) await more.click();
      await card.click();
      const stops = page.getByTestId('trip-stop-list');
      await stops.waitFor();
      const ids = locator => locator.locator('[data-stop-id]').evaluateAll(es => es.map(e => Number(e.dataset.stopId)));
      assert.deepEqual(await ids(page.getByTestId('trip-approach-stops')), scenario.approach, scenario.name);
      const ride = page.getByTestId('trip-ride-stops');
      assert.deepEqual(await ids(ride), [163, 164, 98, 10], 'boarding-to-destination stops changed');
      assert.equal(await stops.locator('[data-bus-here="true"]').count(), 1, 'bus duplicated or missing');
      const bus = stops.locator('[data-bus-here="true"]');
      assert.equal(await bus.getAttribute('data-stop-id'), String(scenario.stop));
      assert.match(await bus.innerText(), /⏸ 1:02/, 'current hold moved to the wrong visit');
      assert.equal(await ride.locator('[data-bus-here="true"]').count(), scenario.approach.length ? 0 : 1,
        'bus is highlighted on the future ride before pickup');
      if (scenario.approach.length) assert.match(await stops.innerText(), new RegExp(`${scenario.approach.length} stops? to pickup`));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      await page.addStyleTag({ content: '.trip-map-wrap .leaflet-tile { opacity: 1 !important; }' });
      if (scenario.stop === 98) {
        await page.waitForFunction(() => {
          const tiles = [...document.querySelectorAll('.trip-map-canvas .leaflet-tile')];
          return tiles.length && tiles.every(i => i.complete && i.naturalWidth);
        });
        await page.locator('.trip-map-wrap').screenshot({ path: path.join(out, `${scenario.name}-${width}.png`), animations: 'disabled' });
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        assert.equal(await page.locator('.map-fs').getByTestId('trip-stop-list').count(), 1);
        assert.deepEqual(await ids(page.getByTestId('trip-approach-stops')), scenario.approach, 'fullscreen loses approach');
      }
      report.runs.push({ width, scenario: scenario.name, approach: scenario.approach, ride: [163, 164, 98, 10], bus: scenario.stop });
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(String(error.stack)); throw error; }
finally { await browser.close(); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
