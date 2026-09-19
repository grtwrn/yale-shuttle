/** Built-app search notice check. All API responses are isolated fixtures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'gallery-review/grocery-search');
await fs.mkdir(out, { recursive: true });
const now = Date.parse('2026-09-19T10:00:00-04:00');
const feed = JSON.parse(await fs.readFile(path.join(root, 'scripts/__fixtures__/minimap-label-feed.json'), 'utf8'));
const initialAnnouncements = feed.announcements;
feed.buses = [];
feed.server_eta = { v: 2, at: now, servedAt: now, buses: [], rows: [], distributions: [] };
// The exact result currently returned by the production geocoder.
const milford = { display_name: "Trader Joe's (Milford)", lat: 41.251309, lon: -73.017729, type: 'supermarket', class: 'yale' };
const race = { id: 28, title: 'Due to the Closer to free ride road race', message: 'Due to the road race the Weekend blue and the Hamden plaza service will be temporarily suspended, and Purple will be detouring please contact dispatch for further information' };
const report = { errors: [], runs: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  for (const width of [320, 390]) {
    feed.announcements = initialAnnouncements;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true,
      timezoneId: 'America/New_York', geolocation: feed.stop_coords[48] && { latitude: feed.stop_coords[48].lat, longitude: feed.stop_coords[48].lon },
      permissions: ['geolocation'], serviceWorkers: 'block' });
    await seedTestId(context);
    await context.addInitScript(now => {
      if (window.top !== window) return;
      const D = Date;
      window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    }, now);
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname !== 'grocery-search.test') return route.abort();
      if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
      if (u.pathname === '/api/geocode') {
        const q = u.searchParams.get('q') ?? '';
        return route.fulfill({ json: { results: /trader|\btj/i.test(q) && !/hamden/i.test(q) ? [milford] : [] } });
      }
      if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
      const f = u.pathname === '/' ? '/index.html' : u.pathname;
      try { return route.fulfill({ body: await fs.readFile(root + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto('https://grocery-search.test');
    const input = page.getByRole('combobox', { name: 'To', exact: true });
    const notice = page.locator('#grocery-search-notice');
    await input.waitFor();
    assert.equal(await notice.count(), 0, 'unrelated searches show a grocery warning');
    for (const query of ['trader joes milford', 'Trader Joe’s Milford', 'TJ Milford', 'Whole Foods Milford', 'Costco Milford', 'Milford grocery stores']) {
      await input.fill(query);
      await notice.waitFor();
      assert.match(await notice.innerText(), /Milford service is discontinued/);
      assert.match(await notice.innerText(), /Hamden is the main grocery route, now serving Trader Joe’s/);
      assert(await input.evaluate(e => e === document.activeElement), 'notice steals search focus');
    }
    await input.fill('trader joes milford');
    await page.getByRole('option', { name: /Trader Joe's \(Milford\)/ }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, `search-${width}.png`) });
    await input.press('Enter');
    const selected = page.getByRole('button', { name: /To.*Trader Joe's \(Milford\)/ });
    await selected.waitFor();
    assert.equal(await notice.count(), 1, 'picking the result drops or duplicates the update');
    const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    assert.deepEqual(draft.toLL, { lat: milford.lat, lon: milford.lon }, 'notice silently changes the destination');
    await page.reload();
    await selected.waitFor();
    await notice.waitFor();
    await page.screenshot({ path: path.join(out, `selected-${width}.png`) });
    await page.getByRole('button', { name: 'Swap start and destination', exact: true }).click();
    assert.equal(await notice.count(), 1, 'Milford as the starting point loses the notice');
    await page.getByRole('button', { name: 'Swap start and destination', exact: true }).click();
    await selected.click();
    for (const query of ["Trader Joe's Hamden", 'Milford Hospital', 'Rosenkranz']) {
      await input.fill(query);
      await notice.waitFor({ state: 'detached' });
    }
    await input.fill('trader joes');
    await page.getByRole('option', { name: /Trader Joe's \(Milford\)/ }).waitFor();
    await notice.waitFor();
    // A synthetic live Hamden shuttle reproduces the rider's one-route overview.
    // The service announcement itself is verbatim from the live feed.
    const sequence = feed.routes['18'];
    const previous = sequence.length - 1;
    feed.buses = [{ bus_name: '#54', bus_id: 9054, route_id: 18, ...feed.stop_coords[sequence[previous]], last_stop_id: sequence[previous], heading: 180, observed_at: now }];
    const rows = sequence.map((sid, h) => [0, sid, 300 + h * 120, 240 + h * 120, 420 + h * 120, h + 1, 0, 180 + h * 120, 180 + h * 120]);
    feed.server_eta = { v: 2, at: now, servedAt: now, buses: [['54', 'Grocery Ham', previous, null]], rows,
      distributions: rows.map(r => Array.from({ length: 50 }, (_, i) => r[3] + i * (r[4] - r[3]) / 49)) };
    feed.announcements = [...initialAnnouncements.filter(a => a.id !== race.id), race];
    await page.evaluate(({ now, fromLL }) => {
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Elm / York', fromLL,
        toText: 'Hamden Plaza, Hamden', toLL: { lat: 41.3698785, lon: -72.9209008 }, tripTime: '', expandedKey: null, savedAt: now }));
    }, { now, fromLL: feed.stop_coords[sequence[0]] });
    await page.reload();
    const hamden = page.getByRole('button', { name: 'View Grocery Ham trip details', exact: true });
    await hamden.waitFor();
    const alerts = page.getByTestId('trip-service-alerts');
    assert(await alerts.isVisible(), 'service update is hidden until route details');
    assert.equal(await alerts.getByText(race.message, { exact: true }).count(), 1);
    assert.equal(await page.getByTestId('trip-detail-panel').count(), 0);
    assert.deepEqual(await page.getByTestId('route-timing-table').locator('tbody[data-route]').evaluateAll(es => es.map(e => e.dataset.route).filter(r => r !== 'Walk')), ['Grocery Ham']);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, `hamden-overview-${width}.png`), fullPage: true });
    await hamden.click();
    assert.equal(await alerts.count(), 0);
    assert.equal(await page.getByTestId('trip-detail-panel').getByText(race.message, { exact: true }).count(), 1);
    await page.getByRole('button', { name: '← All routes', exact: true }).click();
    feed.announcements = initialAnnouncements.filter(a => a.id !== race.id);
    await page.waitForFunction(message => !document.querySelector('[data-testid="trip-service-alerts"]')?.textContent.includes(message), race.message);
    feed.buses = [];
    feed.server_eta = { v: 2, at: now, servedAt: now, buses: [], rows: [], distributions: [] };
    feed.announcements = [...feed.announcements, race];
    await page.reload();
    await alerts.getByText(race.message, { exact: true }).waitFor();
    assert.equal(await hamden.count(), 0, 'no-bus fixture still offers a live trip');
    report.runs.push({ width, explicitQuery: true, resultNotice: true, selectedAndRestored: true, fromAndTo: true, unrelatedQueriesClear: true,
      liveHamdenOverview: true, detailsRetainAlert: true, alertRemoval: true, noBusFallback: true });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(String(error.stack)); throw error; }
finally { await browser.close(); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
