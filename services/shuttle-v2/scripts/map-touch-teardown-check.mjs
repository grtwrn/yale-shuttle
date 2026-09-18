/** Hold real browser touch gestures across map removal, then interact again.
 * From shuttle-v2 under heavy.lock: OUT=/fresh/evidence node scripts/map-touch-teardown-check.mjs
 * Optional CASES=ride-done,ride-expiry,system-filter,system-nav,ride-unmoved,system-unmoved,ride-queued,ride-cancel
 * Optional DIST_ROOT=/frozen/build; no live service or fake clock. Every resource closes.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const service = process.cwd(), out = process.env.OUT;
const dist = process.env.DIST_ROOT || service + '/web/dist';
if (!out) throw Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = feed.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
const exitId = seq[(previous + 5) % seq.length];
const ride = { routeLabel: 'Red', color: '#e53935', busName: '307', boardStopId: 48, alightStopId: exitId,
  toText: 'Fixture final destination', toLat: feed.stop_coords[exitId].lat, toLon: feed.stop_coords[exitId].lon + .002 };
function payload() {
  const now = Date.now(), rows = [];
  const buses = ['307', '309'].map((bus_name, i) => ({ bus_name, bus_id: i + 1, route_id: 3, ...feed.stop_coords[seq[previous]], last_stop_id: seq[previous], heading: 180, observed_at: now }));
  for (let b = 0; b < 2; b++) for (let h = 0; h < seq.length * 2; h++) {
    const eta = 300 + b * 900 + h * 90; rows.push([b, seq[(start + h) % seq.length], eta, eta - 120, eta + 240, h + 1, 0, eta - 120, eta - 120]);
  }
  rows.sort((a, b) => a[2] - b[2]);
  return { ...feed, buses, server_eta: { v: 2, at: now, servedAt: now, buses: ['307', '309'].map(b => [b, 'Red', previous, null]), rows } };
}

const cases = (process.env.CASES || 'ride-done,ride-expiry,system-filter,system-nav,ride-unmoved,system-unmoved,ride-queued,ride-cancel').split(',');
const report = { scope: 'Built SPA, held browser touch gesture through map removal, normal clock, synthetic intercepted feed', cases: [], errors: [] };
let browser, context, page, client;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  for (const name of cases) {
    assert(['ride-done', 'ride-expiry', 'system-filter', 'system-nav', 'ride-unmoved', 'system-unmoved', 'ride-queued', 'ride-cancel'].includes(name));
    const system = name.startsWith('system'), autoEnd = name === 'ride-expiry', unmoved = name.endsWith('unmoved');
    const result = { name, phases: [], errors: [] }; report.cases.push(result);
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', timezoneId: 'America/New_York' });
    await seedTestId(context);
    if (!system) await context.addInitScript(({ ride, autoEnd }) => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() - (autoEnd ? 7200000 - 4000 : 0) })), { ride, autoEnd });
    page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => { const error = { message: e.message, stack: e.stack, phase: result.phases.at(-1) }; result.errors.push(error); report.errors.push({ name, ...error }); });
    await page.route('**/*', async r => {
      const u = new URL(r.request().url());
      if (u.hostname !== 'map-touch.test') return r.abort();
      if (u.pathname === '/api/buses') return r.fulfill({ json: payload() });
      if (u.pathname === '/api/weather') return r.fulfill({ status: 204 });
      if (u.pathname.startsWith('/api/')) return r.fulfill({ json: { reports: [], results: [], routes: [] } });
      const file = u.pathname === '/' ? '/index.html' : u.pathname;
      try { return r.fulfill({ body: await fs.readFile(dist + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return r.fulfill({ status: 404 }); }
    });
    await page.goto('https://map-touch.test');
    const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });
    if (system) await nav('map').tap();
    const map = page.locator('.leaflet-container').first();
    await map.waitFor(); await map.locator('.leaflet-overlay-pane path').first().waitFor(); await page.waitForTimeout(400);
    const shape = () => map.locator('.leaflet-overlay-pane path').first().getAttribute('d');
    // During pinch Leaflet transforms its SVG; path data is redrawn on end.
    const before = await map.locator('.leaflet-overlay-pane path').first().boundingBox();
    const box = await map.boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const points = gap => [{ x: cx - gap, y: cy, id: 1 }, { x: cx + gap, y: cy, id: 2 }];
    client = await context.newCDPSession(page);
    const documentObject = await client.send('Runtime.evaluate', { expression: 'document' });
    const listeners = async () => {
      const { listeners } = await client.send('DOMDebugger.getEventListeners', { objectId: documentObject.result.objectId });
      return Object.fromEntries(['touchmove', 'touchend', 'touchcancel'].map(type => [type, listeners.filter(l => l.type === type).length]));
    };
    result.listenersBefore = await listeners();
    result.phases.push('pinch begins');
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(25) });
    if (!unmoved) {
      for (const gap of [30, 40, 50]) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(gap) });
        await page.waitForTimeout(40);
      }
      assert.notDeepEqual(await map.locator('.leaflet-overlay-pane path').first().boundingBox(), before, 'Browser pinch moves real map before removal');
    }
    result.listenersDuring = await listeners();
    assert(result.listenersDuring.touchmove > result.listenersBefore.touchmove, 'Held pinch installed a document movement listener');
    result.phases.push('remove map with fingers still down');
    if (system) {
      if (name === 'system-filter') await page.getByRole('button', { name: 'Hide all', exact: true }).evaluate(e => e.click());
      else await nav('trip').evaluate(e => e.click());
    } else {
      if (name === 'ride-queued') {
        // One DOM task guarantees a movement frame is queued when Done runs.
        // Native CDP touches above establish the real gesture; only this final
        // move is synthetic. No fake timers or Leaflet internals are used.
        await page.getByRole('button', { name: 'Done', exact: true }).evaluate((button, points) => {
          const target = document.querySelector('.leaflet-container');
          const touches = points.map(p => new Touch({ identifier: p.id, target, clientX: p.x, clientY: p.y }));
          document.dispatchEvent(new TouchEvent('touchmove', { touches, bubbles: true, cancelable: true }));
          button.click();
        }, points(60));
      } else if (!autoEnd) await page.getByRole('button', { name: 'Done', exact: true }).evaluate(e => e.click());
      await page.getByRole('region', { name: 'Finish your trip' }).waitFor();
    }
    if (name !== 'system-filter') assert.equal(await page.locator('.leaflet-container').count(), 0);
    await page.waitForTimeout(100);
    result.listenersAfterRemoval = await listeners();
    result.phases.push('release or cancel held fingers after removal');
    await client.send('Input.dispatchTouchEvent', { type: name === 'ride-cancel' ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    result.phases.push('normal touch on surviving page');
    if (system) {
      if (name === 'system-filter') await page.getByRole('button', { name: 'Show all routes', exact: true }).tap();
      else await nav('map').tap();
      await map.waitFor(); await map.locator('.leaflet-overlay-pane path').first().waitFor();
      const restored = await shape();
      await map.getByRole('button', { name: 'Zoom in', exact: true }).tap(); await page.waitForTimeout(100);
      assert.notEqual(await shape(), restored, 'Replacement map stays interactive');
      await nav('trip').tap();
    } else {
      const finish = page.getByRole('region', { name: 'Finish your trip' });
      const directions = new URL(await finish.getByRole('link', { name: /Walking directions/ }).getAttribute('href'));
      assert.equal(directions.searchParams.get('destination'), `${ride.toLat},${ride.toLon}`);
      await finish.getByRole('button', { name: 'Dismiss', exact: true }).tap();
      assert.equal(await finish.count(), 0);
    }
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('heading', { name: 'The shuttle app couldn’t open' }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (name === 'ride-expiry' || name === 'system-filter') await page.screenshot({ path: out + '/' + name + '.png' });
    result.phases.push('complete'); result.completed = true;
    await client.detach(); client = null; await page.close(); page = null; await context.close(); context = null;
  }
  report.completed = true;
} finally {
  if (client) await client.detach(); if (page) await page.close(); if (context) await context.close(); if (browser) await browser.close();
  report.resourcesClosed = true;
  await fs.writeFile(out + '/map-touch-teardown.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.errors, []);
for (const result of report.cases) {
  assert.deepEqual(result.listenersAfterRemoval, result.listenersBefore, result.name + ': active document listeners removed before release');
}
