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
feed.buses = [];
feed.server_eta = { v: 2, at: now, servedAt: now, buses: [], rows: [], distributions: [] };
// The exact result currently returned by the production geocoder.
const milford = { display_name: "Trader Joe's (Milford)", lat: 41.251309, lon: -73.017729, type: 'supermarket', class: 'yale' };
const report = { errors: [], runs: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  for (const width of [320, 390]) {
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
    for (const query of ['trader joes milford', 'Trader Joe’s Milford', 'TJ Milford']) {
      await input.fill(query);
      await notice.waitFor();
      assert.match(await notice.innerText(), /Milford service ended Sep 19, 2026/);
      assert.match(await notice.innerText(), /Use Grocery Ham for Trader Joe’s in Hamden/);
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
    report.runs.push({ width, explicitQuery: true, resultNotice: true, selectedAndRestored: true, fromAndTo: true, unrelatedQueriesClear: true });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(String(error.stack)); throw error; }
finally { await browser.close(); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
