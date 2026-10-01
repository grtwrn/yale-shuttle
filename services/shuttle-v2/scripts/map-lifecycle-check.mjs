/** Real-clock built-SPA zoom/unmount regression. From shuttle-v2 under heavy.lock:
 * OUT=/fresh/evidence node scripts/map-lifecycle-check.mjs
 * DESKTOP=1, SCENARIOS=ride and DIST_ROOT=/frozen/build are optional.
 * All network intercepted, tester identity seeded, all resources closed.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const service = process.cwd(), out = process.env.OUT, desktop = !!process.env.DESKTOP;
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
const report = { scope: 'Built SPA, real browser clock, synthetic current wire; all network intercepted', desktop, scenarios: [], errors: [], errorStacks: [], requests: 0 };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let context, page;
try {
  for (const scenario of (process.env.SCENARIOS || 'system,ride').split(',')) {
    assert(['system', 'ride'].includes(scenario));
    context = await browser.newContext({ viewport: { width: desktop ? 1280 : 390, height: 844 }, isMobile: !desktop, hasTouch: !desktop, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(context);
    if (scenario === 'ride') await context.addInitScript(ride => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() })), ride);
    page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => { report.errors.push(e.message); if (report.errorStacks.length < 5) report.errorStacks.push(e.stack); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'map-lifecycle.test') return route.abort();
      if (url.pathname === '/api/buses') { report.requests++; return route.fulfill({ json: payload() }); }
      if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
      const name = url.pathname === '/' ? '/index.html' : url.pathname;
      try { return route.fulfill({ body: await fs.readFile(dist + name), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    const result = { name: scenario, iterations: 0, checks: [] }; report.scenarios.push(result);
    await page.goto('https://map-lifecycle.test');
    const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });
    const map = () => page.locator('.leaflet-container').first();
    const zoom = direction => map().getByRole('button', { name: 'Zoom ' + direction, exact: true });
    const waitMap = async () => { await map().waitFor(); await map().locator('.leaflet-overlay-pane path').first().waitFor(); };
    if (scenario === 'system') await nav('map').click();
    else await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
    await waitMap();
    const shape = () => map().locator('.leaflet-overlay-pane path').first().getAttribute('d');
    const original = await shape(); await zoom('in').focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(350);
    assert.notEqual(await shape(), original, scenario + ' keyboard zoom changes route geometry');
    await zoom('out').click(); await page.waitForTimeout(350);
    await map().focus(); const pane = () => map().locator('.leaflet-map-pane').getAttribute('style');
    const beforePan = await pane(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(350);
    assert.notEqual(await pane(), beforePan, scenario + ' keyboard pan moves map');
    result.checks.push('Settled keyboard zoom and pan remain functional');
    for (const width of desktop ? [640, 1280] : [320, 360, 430, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(100);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), scenario + ' reflow at ' + width);
    }
    const beforeGesture = await shape(), box = await map().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    if (desktop) {
      await page.mouse.move(cx, cy); await page.mouse.wheel(0, -180);
    } else {
      // Real browser touch handling (including Leaflet's touch-zoom handler),
      // without replacing timers or touching private Leaflet state.
      const client = await context.newCDPSession(page);
      try {
        const points = gap => [{ x: cx - gap, y: cy, id: 1 }, { x: cx + gap, y: cy, id: 2 }];
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(25) });
        for (const gap of [32, 40, 50, 65]) {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(gap) });
          await page.waitForTimeout(20);
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally { await client.detach(); }
    }
    await page.waitForTimeout(350);
    assert.notEqual(await shape(), beforeGesture, scenario + ' touch pinch / mouse wheel changes geometry');
    result.checks.push('Phone/desktop reflow and touch pinch or mouse-wheel zoom remain functional');
    await page.screenshot({ path: out + '/' + scenario + '-map.png' });
    for (let i = 0; i < 6; i++) {
      if (scenario === 'system') {
        if (i) { await nav('map').focus(); await page.keyboard.press('Enter'); await waitMap(); }
        // Enter Leaflet's animation frame, then unmount inside its 250ms timer.
        await zoom('in').evaluate(e => e.click()); await page.waitForTimeout(40);
        await nav('trip').click();
        await nav('map').focus(); await page.keyboard.press('Enter'); await waitMap();
        await zoom('out').evaluate(e => e.click()); await page.waitForTimeout(40);
        await page.getByRole('button', { name: 'Hide all', exact: true }).click();
        await page.getByRole('button', { name: 'Show all routes', exact: true }).click();
        assert.equal(await page.locator('.leaflet-container').count(), 1);
        assert(await page.getByRole('button', { name: /^(Running now|Every route)$/ }).evaluate(e => e === document.activeElement));
        await nav('trip').click(); assert.equal(await page.locator('.leaflet-container').count(), 0);
      } else {
        if (i) { await page.reload(); await page.getByRole('button', { name: 'Done', exact: true }).waitFor(); await waitMap(); }
        await zoom(i % 2 ? 'out' : 'in').evaluate(e => e.click()); await page.waitForTimeout(40);
        const done = page.getByRole('button', { name: 'Done', exact: true });
        if (desktop) { await done.focus(); await page.keyboard.press('Enter'); } else await done.tap();
        const finish = page.getByRole('region', { name: 'Finish your trip' }); await finish.waitFor();
        assert(await finish.evaluate(e => e === document.activeElement));
        assert.equal(await page.locator('.leaflet-container').count(), 0);
        const directions = new URL(await finish.getByRole('link', { name: /Walking directions/ }).getAttribute('href'));
        assert.equal(directions.searchParams.get('destination'), `${ride.toLat},${ride.toLon}`);
      }
      result.iterations = i + 1;
      await page.waitForTimeout(350);
      if (report.errors.length) break;
    }
    await page.screenshot({ path: out + '/' + scenario + '-finished.png' });
    assert.equal(await page.getByRole('heading', { name: 'The shuttle app couldn’t open' }).count(), 0);
    assert.deepEqual(report.errors, []);
    result.checks.push('Six rapid zoom/teardown cycles; no duplicate or leftover map; recovery focus and final destination preserved');
    result.passed = true;
    await page.close(); page = null; await context.close(); context = null;
  }
  report.completed = true;
} finally {
  if (page && !report.completed) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
  if (page) await page.close(); if (context) await context.close(); await browser.close();
  report.resourcesClosed = true;
  await fs.writeFile(out + '/map-lifecycle.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
