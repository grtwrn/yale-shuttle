/** Recorded Red hold: inspect the actual mini-map key without loading the Pi. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { parseOptions } from './canary-metrics.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'gallery-review/timing-key');
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile(path.join(root, 'scripts/__fixtures__/minimap-label-feed.json'), 'utf8'));
const now = feed.server_eta.servedAt;
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { errors: [], runs: [] };
try {
  for (const width of [320, 390]) {
    let servedFeed = feed;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true,
      geolocation: { latitude: 41.324769, longitude: -72.923522 }, permissions: ['geolocation'], timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(context);
    await context.addInitScript(now => {
      const D = Date;
      window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
      window.setInterval = () => 0;
    }, now);
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (['tile.openstreetmap.org', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return route.continue();
      if (u.hostname !== 'timing-key.test') return route.abort();
      if (u.pathname === '/api/buses') return route.fulfill({ json: servedFeed });
      if (u.pathname === '/api/geocode') return route.fulfill({ json: { results: [{ display_name: 'Rosenkranz Hall', lat: 41.314701, lon: -72.924551, type: 'college', class: 'yale' }] } });
      if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
      const f = u.pathname === '/' ? '/index.html' : u.pathname;
      try { return route.fulfill({ body: await fs.readFile(root + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto('https://timing-key.test');
    await page.getByPlaceholder('Where do you want to go?').fill('Rosenkranz');
    await page.getByText('Rosenkranz Hall', { exact: true }).first().click();
    const more = page.getByRole('button', { name: /Show \d+ more route/ });
    if (await more.isVisible()) await more.click();
    const card = page.getByRole('button', { name: 'View Red trip details', exact: true });
    await card.waitFor();
    await page.addStyleTag({ content: '.trip-map-wrap .leaflet-tile { opacity: 1 !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll('.trip-map-canvas .leaflet-tile')];
      return tiles.length && tiles.every(i => i.complete && i.naturalWidth);
    });
    const table = page.getByTestId('route-timing-table');
    const checkKey = async () => {
      const key = await table.boundingBox();
      const map = await page.locator('.trip-map-canvas').boundingBox();
      assert(key.y >= map.y + map.height, 'key must sit below the map');
      assert.doesNotMatch(await table.innerText(), /Next/);
      const pins = await page.locator('.trip-map-canvas .leaflet-marker-icon, .trip-map-canvas .bus-wait-label').evaluateAll(es => es.map(e => {
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
      for (const pin of pins) {
        assert(pin.y + pin.height <= key.y || pin.x + pin.width <= key.x || pin.x >= key.x + key.width, 'key hides a pin or waiting label');
      }
      return { keyHeight: key.height, mapHeight: map.height };
    };
    await table.scrollIntoViewIfNeeded();
    assert(await table.isVisible());
    assert.equal(await page.locator('.trip-map-canvas .eta-tip:not(.bus-wait-tip)').count(), 0);
    assert(await page.locator('.bus-wait-label').count() > 0, 'waiting label was lost');
    assert.doesNotMatch(await card.innerText(), /Arrives in|At destination/);
    const text = await page.locator('body').innerText();
    assert(parseOptions(text).some(o => o.routeLabel === 'Red' && o.eta?.spread));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const overview = await checkKey();
    assert.equal(await page.getByTestId('route-summary').count(), 0);
    assert.equal(await page.getByTestId('trip-detail-panel').count(), 0);
    assert.match(await table.locator('[data-route="Red"]').getByTestId('journey-legs').innerText(), /🚌.*min/);
    await page.screenshot({ path: path.join(out, `overview-${width}.png`), fullPage: true });
    await card.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '← All routes', exact: true }).waitFor();
    assert.equal(await table.locator('tbody[data-route]').count(), 1);
    const stopList = page.locator('.trip-map-wrap').getByTestId('trip-stop-list');
    assert.equal(await stopList.count(), 1, 'selected stops must be in the map panel');
    assert.equal(await page.getByTestId('trip-detail-panel').getByTestId('trip-stop-list').count(), 0, 'stop list is duplicated below trip controls');
    assert.match(await stopList.innerText(), /BOARD[\s\S]*GET OFF/);
    await checkKey();
    await page.locator('.trip-map-wrap').screenshot({ path: path.join(out, `red-detail-${width}.png`), animations: 'disabled' });
    const waiting = await page.locator('.bus-wait-label').innerText();
    assert.match(waiting, /Red/);
    if (width === 390) {
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.waitForTimeout(250);
      await checkKey();
      assert.equal(await page.locator('.map-fs').getByTestId('trip-stop-list').count(), 1);
      await page.screenshot({ path: path.join(out, 'red-fullscreen-390.png') });
      await table.getByRole('button', { name: /^Red arrival details:/ }).click();
      assert(await page.getByRole('dialog').isVisible(), 'key cannot open arrival details');
      await page.getByRole('button', { name: 'Close arrival details' }).click();
    }
    report.runs.push({ width, waiting, table: await table.innerText(), overview });
    if (width === 390) {
      // Deliberately identical paths expose occlusion that two merely
      // intersecting real routes would not. Put both synthetic buses on them
      // so the Map tab's running/on-route filter includes both lines.
      const redBus = feed.buses.find(b => b.route_id === 3);
      servedFeed = { ...feed, routes: { '1': feed.routes['3'], '3': feed.routes['3'] },
        route_paths: { '1': feed.route_paths['3'], '3': feed.route_paths['3'] },
        buses: [{ ...redBus, route_id: 1, bus_name: '#38', bus_id: 999 }, redBus] };
      await page.reload();
      await page.getByRole('button', { name: /^map$/i }).click();
      const lines = page.locator('.map-route-line:visible');
      await lines.first().waitFor();
      assert.equal(await lines.count(), 2);
      const checkSeparation = async () => {
        const measured = await lines.evaluateAll(es => {
          const [a, b] = es;
          const distances = [0.2, 0.4, 0.6, 0.8].map(t => {
            const point = a.getPointAtLength(a.getTotalLength() * t);
            let nearest = Infinity;
            for (let j = 0; j <= 500; j++) {
              const other = b.getPointAtLength(b.getTotalLength() * j / 500);
              nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.y - other.y));
            }
            return nearest;
          }).sort((a, b) => a - b);
          return { separation: distances[2], offsets: es.map(e => Number(e.dataset.offset)).sort((a, b) => a - b), paths: es.map(e => e.getAttribute('d')) };
        });
        assert.deepEqual(measured.offsets, [0, 5]);
        assert.notEqual(measured.paths[0], measured.paths[1]);
        assert(measured.separation >= 3 && measured.separation <= 8, `shared routes not visibly separated: ${measured.separation}`);
        return measured.separation;
      };
      const beforeZoom = await checkSeparation();
      await page.locator('.leaflet-control-zoom-in:visible').click();
      await page.waitForTimeout(250);
      const afterZoom = await checkSeparation();
      await page.screenshot({ path: path.join(out, 'identical-routes-separated-390.png'), fullPage: true });
      report.overlap = { fixture: 'Synthetic identical Blue Day / Red paths and bus positions', beforeZoom, afterZoom };
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally { await browser.close(); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
