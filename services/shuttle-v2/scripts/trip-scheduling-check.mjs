/** Current trip scheduling UI check, using the built SPA and synthetic API data.
 * From services/shuttle-v2: npm --prefix web run build && node scripts/trip-scheduling-check.mjs
 * BOT_CHROMIUM_PATH overrides Chromium; TRIP_SCHEDULING_OUT overrides artifact output.
 * No server, live database, network service or persistent browser is used.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { parseOptions, hasArrivalClock } from './canary-metrics.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.env.TRIP_SCHEDULING_OUT ?? path.resolve(service, '../../pr-preview/trip-scheduling')) + path.sep;
const androidReview = process.env.TRIP_UI_ANDROID === '1';
const androidNoMobile = process.env.TRIP_UI_ANDROID_NO_MOBILE === '1';
const androidUserAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 ${androidNoMobile ? '' : 'Mobile '}Safari/537.36`;
await fs.mkdir(out, { recursive: true });
const now = Date.parse('2026-09-18T10:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const sequence = feed.routes['3'], start = sequence.indexOf(48), previous = (start + sequence.length - 1) % sequence.length;
feed.buses = ['307', '309'].map((bus_name, i) => ({ bus_name, bus_id: i + 1, route_id: 3,
  ...feed.stop_coords[sequence[previous]], last_stop_id: sequence[previous], heading: 180, observed_at: now }));
const rows = [];
for (let bus = 0; bus < 2; bus++) for (let h = 0; h < sequence.length * 2; h++) {
  const eta = 300 + bus * 900 + h * 90;
  rows.push([bus, sequence[(start + h) % sequence.length], eta, eta - 120, eta + 240, h + 1, 0, eta - 120, eta - 120]);
}
rows.sort((a, b) => a[2] - b[2]);
feed.server_eta = { v: 2, at: now, servedAt: now, buses: ['307', '309'].map(b => [b, 'Red', previous, null]), rows,
  distributions: rows.map(r => Array.from({ length: 50 }, (_, i) => r[3] + i * (r[4] - r[3]) / 49)) };
const report = { scope: 'Built SPA, isolated synthetic API fixture; external network blocked; browser closed on exit', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  for (const width of androidReview ? (androidNoMobile ? [307, 368, 1280] : [320, 368, 430]) : [320, 390, 1280]) {
    const height = androidNoMobile && width === 307 ? 711 : 844;
    const expectedCompact = androidReview && width < 600;
    const run = { width, height, userAgent: androidReview ? androidUserAgent : 'browser default', errors: [], requests: [] };
    report.runs.push(run);
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600,
      ...(androidReview ? { userAgent: androidUserAgent } : {}),
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(context);
    await context.addInitScript(({ now, fromLL, toLL }) => {
      // Draft and clock belong to the app, not the optional external tracker frame.
      if (window.top !== window) return;
      const D = Date;
      window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
      if (location.search === '?layout-home') {
        sessionStorage.removeItem('shuttle-trip-draft');
        localStorage.removeItem('shuttle-boarded-ride');
        return;
      }
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Division / Prospect', fromLL,
        toText: 'Union Station', toLL, tripTime: '', expandedKey: null, savedAt: now,
        arriveBy: '2026-09-18T10:45', classBufferMin: 10 }));
    }, { now, fromLL: { lat: feed.stop_coords[48].lat, lon: feed.stop_coords[48].lon - .0017 }, toLL: feed.stop_coords[121] });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => run.errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'trip-ui.test') return route.abort();
      if (url.pathname.startsWith('/api/')) run.requests.push({ method: route.request().method(), path: url.pathname });
      if (url.pathname === '/api/buses') return route.fulfill({ json: feed });
      if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto('https://trip-ui.test', { waitUntil: 'domcontentloaded' });
    const viewport = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;pointer-events:none;visibility:hidden';
      document.body.append(probe);
      const renderedPx = probe.getBoundingClientRect().width;
      probe.remove();
      return { width: innerWidth, height: innerHeight, scale: visualViewport?.scale ?? 1, renderedPx,
        compact: document.documentElement.dataset.androidCompact === 'true' };
    });
    run.viewport = viewport;
    assert.equal(viewport.compact, expectedCompact);
    assert(Math.abs(viewport.scale - 1) < 0.01, 'browser viewport scale should remain normal');
    assert(Math.abs(viewport.renderedPx - (expectedCompact ? 85 : 100)) < 0.1, 'layout did not render at the requested density');
    const card = page.getByRole('button', { name: 'View Red trip details', exact: true });
    const table = page.getByTestId('route-timing-table');
    const row = table.locator('[data-route="Red"]');
    const destination = row.getByTestId('destination-arrival');
    await card.waitFor();
    assert.deepEqual(await table.locator('thead th').allTextContents(), ['Route', 'Board in (min)', 'Arrive at']);
    await destination.locator('[style*="white-space"]').first().waitFor();
    async function capture(state) {
      assert.equal(await page.getByRole('button', { name: /^Arrive by/ }).count(), 0);
      assert.equal(await page.locator('[aria-label="Arrive by class"]').count(), 0);
      const text = await page.locator('body').innerText();
      assert.doesNotMatch(text, /Arrive by|Plan for class|Class starts/);
      assert.doesNotMatch(text, /When arrival timing is unclear, shorter walks and rides come first/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal page overflow');
      const box = await destination.boundingBox();
      const pickup = row.getByRole('button', { name: /^Red arrival details:/ });
      const pickupBox = await pickup.count() ? await pickup.boundingBox() : null;
      if (pickupBox) {
        assert(pickupBox.x + pickupBox.width <= box.x, 'pickup overlaps destination');
        assert(await pickup.evaluate(e => e.scrollWidth <= e.clientWidth), 'pickup text clipped');
      }
      assert(box.x >= 0 && box.x + box.width <= viewport.width, 'destination range outside viewport');
      assert(await destination.evaluate(e => e.scrollWidth <= e.clientWidth), 'clipped destination range');
      assert(await destination.locator('span[style*="white-space"]').evaluateAll(es => es.every(e => { const r = document.createRange(); r.selectNodeContents(e); return r.getClientRects().length === 1; })), 'clock digits wrap');
      await fs.writeFile(`${out}${state}-${width}.txt`, text + '\n');
      await page.screenshot({ path: `${out}${state}-${width}.png`, fullPage: true });
      run[state] = { text, card: await card.innerText(), destination: await destination.innerText(), parsed: parseOptions(text), recognizedCard: await card.getAttribute('aria-label') === 'View Red trip details' };
      assert(run[state].recognizedCard, 'watcher cannot recognize Red card');
      assert(hasArrivalClock(await destination.innerText()), 'watcher cannot recognize destination clock');
      assert.equal(await card.getByTestId('destination-arrival').count(), 0);
      assert.equal(await card.getByRole('button', { name: /arrival details:/ }).count(), 0);
      assert.doesNotMatch(await card.innerText(), /Arrives in|At destination|most direct|wait.*for/);
      assert.equal(await page.getByTestId('route-summary').count(), 0, 'separate route cards remain');
      assert.equal(await page.getByTestId('trip-detail-panel').count(), 0, 'trip details rendered before selection');
      assert.match(await row.getByTestId('journey-legs').innerText(), /🚶.*2 min[\s\S]*🚌/);
      assert.equal(await page.locator('.trip-map-canvas .eta-tip:not(.bus-wait-tip)').count(), 0, 'stop timing chips still drawn');
      assert(await table.evaluate(e => e.scrollWidth <= e.clientWidth), 'key clips horizontally');
      const mapBox = await page.locator('.trip-map-canvas').boundingBox();
      assert((await table.boundingBox()).y >= mapBox.y + mapBox.height, 'key must sit below the map');
      assert(run[state].parsed.some(o => o.routeLabel === 'Red'), 'watcher cannot parse Red card');
      assert(run[state].parsed.some(o => o.routeLabel === 'Walk'), 'watcher cannot parse walking alternative');
    }
    assert.equal(await destination.getAttribute('data-kind'), 'window');
    assert.match(await destination.innerText(), /10:21a – 10:27a/);
    const pickup = row.getByRole('button', { name: /^Red arrival details:/ });
    assert.match(await pickup.innerText(), /~5 \(3 – 9\)/);
    assert(await pickup.getByTestId('pickup-range').isVisible(), 'pickup window must remain visible in the key');
    assert.doesNotMatch(await pickup.innerText(), /Next/);
    assert.doesNotMatch(await card.innerText(), /^23 min$/m, 'total duration still occupies card');
    assert.equal(await row.getByTestId('route-pill').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(198, 40, 40)');
    await capture('live');
    await page.getByRole('button', { name: 'Collapse map', exact: true }).click();
    assert(await table.isVisible(), 'collapsing map hides arrival estimates');
    assert.equal(await page.locator('.trip-map-canvas').count(), 0);
    await page.getByRole('button', { name: 'Expand map', exact: true }).click();
    await page.locator('.trip-map-canvas').waitFor();
    if (width === 390 || androidReview) {
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.locator('.trip-map-wrap.map-fs').waitFor();
      const keyBox = await table.boundingBox(), mapBox = await page.locator('.trip-map-canvas').boundingBox();
      assert(keyBox.y >= mapBox.y + mapBox.height, 'fullscreen key covers the map');
      assert(keyBox.y + keyBox.height <= viewport.height, 'fullscreen key leaves the viewport');
      await page.screenshot({ path: `${out}fullscreen-${width}.png` });
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    }
    const parsedPickup = run.live.parsed.find(o => o.routeLabel === 'Red').eta;
    assert.equal(parsedPickup.second, null);
    assert.deepEqual(parsedPickup.first, [180, 540]);
    assert.deepEqual(parsedPickup.median, [300, 360]);
    await pickup.click();
    const details = page.getByRole('dialog');
    assert.equal(await page.getByTestId('trip-detail-panel').count(), 0, 'arrival details also selected the route');
    assert.match(await details.innerText(), /Likely arrival window: 3–9 min/);
    assert.match(await details.innerText(), /The following arrival is estimated in about 20 min from now/);
    await details.getByRole('button', { name: 'Close arrival details' }).click();
    // The destination and journey legs are part of the route's click target.
    for (const target of [destination, row.getByTestId('journey-legs')]) {
      await target.click();
      await page.getByTestId('trip-detail-panel').waitFor();
      assert.equal(await table.locator('tbody[data-route]').count(), 1);
      assert.equal(await page.getByTestId('map-trip-panel').getByTestId('trip-stop-list').count(), 1);
      await page.getByRole('button', { name: '← All routes', exact: true }).click();
      await card.waitFor();
      assert.equal(await page.getByTestId('trip-stop-list').count(), 0, 'route choices retain a previous stop list');
    }
    await page.getByRole('button', { name: 'View Walk trip details', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.getByTestId('trip-detail-panel').waitFor();
    assert.equal(await table.locator('tbody[data-route="Walk"]').count(), 1);
    await page.getByRole('button', { name: '← All routes', exact: true }).click();
    const later = page.getByRole('button', { name: 'Plan for later…', exact: true });
    assert.equal(await later.count(), 1);
    await later.focus(); await page.keyboard.press('Enter');
    const departure = page.getByLabel('Departure time', { exact: true });
    await departure.fill('2026-09-18T11:00');
    await page.getByText(/Estimated from service hours and typical wait and travel times/).waitFor();
    assert.equal(await destination.getAttribute('data-kind'), 'point');
    assert.match(await destination.innerText(), /~/);
    assert.equal(await departure.inputValue(), '2026-09-18T11:00');
    await capture('future');
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    assert.equal(saved.tripTime, '2026-09-18T11:00');
    assert(!Object.hasOwn(saved, 'arriveBy') && !Object.hasOwn(saved, 'classBufferMin'));
    run.saved = saved;
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await later.waitFor();
    assert.equal(await destination.getAttribute('data-kind'), 'window');
    assert.match(await destination.innerText(), /10:21a – 10:27a/);
    await card.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '← All routes', exact: true }).waitFor();
    assert.equal(await destination.getAttribute('data-kind'), 'window');
    run.expanded = await destination.innerText();
    assert.equal(await table.locator('tbody[data-route]').count(), 1, 'detail key must narrow to the selected route');
    const actions = page.getByRole('group', { name: 'Trip actions', exact: true });
    const panel = page.getByTestId('trip-detail-panel');
    assert.doesNotMatch(await panel.innerText(), /🚶|⏳|🚌\s*#\d+\s*·/, 'duplicate journey strip remains above Directions');
    const directions = actions.getByRole('link', { name: '🧭 Directions to stop', exact: true });
    const nav = new URL(await directions.getAttribute('href'));
    assert.equal(nav.searchParams.get('destination'), `${feed.stop_coords[48].lat},${feed.stop_coords[48].lon}`);
    assert.equal(nav.searchParams.get('travelmode'), 'walking');
    const remind = actions.getByRole('button', { name: '🔔 Remind me for #307', exact: true });
    await remind.focus(); await page.keyboard.press('Space');
    const armed = actions.getByRole('button', { name: '🔔 Reminding you for #307', exact: true });
    assert.equal(await armed.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Space');
    assert.equal(await remind.getAttribute('aria-pressed'), 'false');
    page.once('dialog', dialog => dialog.dismiss());
    await actions.getByRole('button', { name: '🚩 Report', exact: true }).click();
    const tracker = actions.getByRole('button', { name: '📱 Yale tracker', exact: true });
    assert.equal(await actions.locator('iframe').count(), 0, 'closed tracker loads an iframe');
    await tracker.focus(); await page.keyboard.press('Enter');
    const frame = actions.locator('iframe');
    assert.equal(await frame.getAttribute('src'), 'https://yale.downtownerapp.com/routes/3');
    assert.equal(await actions.getByRole('link', { name: 'Open ↗', exact: true }).getAttribute('href'), await frame.getAttribute('src'));
    assert((await frame.boundingBox()).width <= (await panel.boundingBox()).width, 'tracker overflows the action panel');
    await actions.getByTitle('Hide preview', { exact: true }).click();
    assert.equal(await actions.locator('iframe').count(), 0);
    assert(await tracker.evaluate(e => e === document.activeElement), 'closing tracker loses keyboard focus');
    const berth = actions.getByRole('button', { name: /stops about .*metres/ });
    if (await berth.count()) {
      await berth.click();
      assert.equal(await berth.getAttribute('aria-expanded'), 'true');
      assert(await actions.getByRole('link', { name: '🧭 Directions to published stop', exact: true }).isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await berth.click();
    }
    for (const button of await actions.getByRole('button').all()) {
      const box = await button.boundingBox();
      assert(box.width * viewport.scale >= 44 && box.height * viewport.scale >= 44,
        `action has a small touch target: ${await button.innerText()} (${box.width} x ${box.height}, scale ${viewport.scale})`);
      assert(await button.evaluate(e => e.scrollWidth <= e.clientWidth), 'action text clips');
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: `${out}actions-${width}.png` });
    await page.screenshot({ path: `${out}route-detail-${width}.png`, fullPage: true });
    await actions.getByRole('button', { name: "🚌 I'm on it", exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
    const ride = await page.evaluate(() => JSON.parse(localStorage.getItem('shuttle-boarded-ride')));
    assert.equal(ride.busName, '307');
    assert.equal(ride.boardStopId, 48);
    assert.equal(ride.alightStopId, 121);
    run.actions = { directions: true, reminder: true, reportCancelled: true, tracker: true, boarding: true };
    if (androidNoMobile && width === 307) {
      await page.goto('https://trip-ui.test/?layout-home', { waitUntil: 'domcontentloaded' });
      const search = page.getByPlaceholder('Where do you want to go?', { exact: true });
      await search.waitFor();
      const heading = page.getByRole('heading', { name: 'Yale Shuttle Tracker', exact: true });
      const compactHeading = await heading.boundingBox();
      await page.screenshot({ path: `${out}home-compact-${width}.png` });
      // Compare real home text, not only a blank probe, against the skipped
      // density in report #128. Toggling only this flag reproduces that layout.
      await page.evaluate(() => delete document.documentElement.dataset.androidCompact);
      const originalHeading = await heading.boundingBox();
      await page.screenshot({ path: `${out}home-before-${width}.png` });
      run.home = { compactHeading, originalHeading };
      assert(Math.abs(compactHeading.width / originalHeading.width - 0.85) < 0.02, 'home title did not shrink');
      // Normal line-height rounds with font metrics; allow one rendered pixel
      // while still requiring an actual reduction in height.
      assert(compactHeading.height < originalHeading.height
        && Math.abs(compactHeading.height - originalHeading.height * 0.85) <= 1,
      `home title height did not shrink: ${JSON.stringify(run.home)}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await search.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.androidCompact), 'true', 'compact layout lost after refresh');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'home page overflow');
    }
    assert.deepEqual(run.errors, []);
    assert(!run.requests.some(r => r.path === '/api/report'));
    await context.close();
  }
} catch (error) { report.errors.push(String(error.stack)); throw error; }
finally { await browser.close(); await fs.writeFile(out + 'browser-results.json', JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ widths: report.runs.map(r => r.width), errors: report.errors,
  parser: report.runs.map(r => ({ width: r.width, live: r.live.parsed.length, recognizesLive: r.live.recognizedCard, future: r.future.parsed.length })) }));
