// Replay the retained Purple Union Station incident through the built app.
// Clock-shift controls preserve positions and forecast durations; they do not
// claim morning service observations or physical ETA accuracy.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { attach } from './rider-watch/runner.mjs';

const recorded = JSON.parse(await fs.readFile('web/src/__fixtures__/purple-union-on-demand-2026-10-23.json', 'utf8'));
const out = process.env.PICKUP_SERVICE_OUT ?? 'pr-preview/pickup-service';
const production = process.env.PICKUP_SERVICE_PRODUCTION_ASSETS === '1';
const noon = Date.parse('2026-10-23T16:00:00Z'), originalAt = recorded.server_eta.servedAt;
const results = [], errors = [];
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });

function shifted(value, delta, key = '') {
  if (Array.isArray(value)) return value.map(item => shifted(item, delta));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, delta, k)]));
  if (typeof value === 'number' && ['observed_at', 'at', 'servedAt', 'expires_at', 'validUntil', 'last_at'].includes(key)) return value + delta;
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && /(?:_at|_since)$/.test(key)) {
    const at = Date.parse(value.endsWith('Z') ? value : value + 'Z');
    if (Number.isFinite(at)) return new Date(at + delta).toISOString().replace(/Z$/, '');
  }
  return value;
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 960 }]) {
    for (const scenario of ['afternoon', 'noon-transition']) {
      const start = scenario === 'afternoon' ? originalAt : noon - 60_000;
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500,
        timezoneId: viewport.width < 500 ? 'UTC' : 'Asia/Tokyo', serviceWorkers: 'block' });
      let page, lastBusesResponse;
      try {
        await seedTestId(context);
        await context.addInitScript(({ from, to, start }) => {
          localStorage.setItem('listView', 'trip');
          sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Union Station (S)', fromLL: from,
            toText: 'Building 400', toLL: to, tripTime: '', expandedKey: null, savedAt: start }));
        }, { from: recorded.stop_coords['122'], to: recorded.stop_coords['22'], start });
        page = await context.newPage(); page.setDefaultTimeout(15_000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (new URL(response.url()).pathname === '/api/buses') lastBusesResponse = response; });
        await page.clock.install({ time: new Date(start) });
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.hostname !== 'pickup-service.test') return route.abort();
          if (url.pathname === '/api/buses') return route.fulfill({ json: shifted(recorded, await page.evaluate(() => Date.now()) - originalAt) });
          if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
          if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
          if (route.request().method() !== 'GET') return route.abort();
          if (production) return route.fulfill({ response: await route.fetch({ url: 'https://yale-shuttle.fly.dev' + url.pathname + url.search }) });
          const file = url.pathname === '/' ? '/index.html' : url.pathname;
          try { return route.fulfill({ body: await fs.readFile('web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
          catch { return route.fulfill({ status: 404 }); }
        });
        await page.goto('https://pickup-service.test', { waitUntil: 'domcontentloaded' });
        await page.getByTestId('route-timing-table').waitFor();
        const more = page.getByRole('button', { name: /Show \d+ more route/ });
        if (await more.isVisible()) await more.click();
        const row = page.locator('tbody[data-route="Purple"][data-pickup="122"]');
        await row.waitFor();
        if (scenario === 'noon-transition') {
          assert.equal(await row.getAttribute('data-pickup-service'), 'scheduled');
          assert(await row.getByTestId('pickup-range').isVisible(), 'morning pickup lost its forecast');
          await page.clock.runFor(61_000);
        }
        await page.waitForFunction(() => document.querySelector('tbody[data-route="Purple"][data-pickup="122"]')?.dataset.pickupService === 'on-demand');
        assert(await row.getByText('On request', { exact: true }).isVisible());
        assert.equal(await row.getByTestId('pickup-range').count(), 0);
        assert.equal(await row.getByTestId('route-next-arrival').count(), 0);
        assert.equal(await row.getByTestId('destination-arrival').count(), 0);
        assert.equal(await row.getByRole('link', { name: /Call Dispatch/ }).getAttribute('href'), 'tel:+12032815470');
        assert(await page.locator('tbody[data-route="Purple"][data-pickup="1"]').isVisible(), 'scheduled walking alternative disappeared');
        await row.getByRole('button', { name: 'View Purple trip details', exact: true }).click();
        await page.getByTestId('trip-stop-list').waitFor();
        assert.equal(await page.getByRole('button', { name: /🔔 Remind me/ }).count(), 0, 'request-only service offered a pickup reminder');
        assert(!/Arrival: About/.test(await page.getByTestId('trip-stop-list').innerText()), 'detail stop retained the passing-bus countdown');
        assert(await page.getByRole('button', { name: "🚌 I'm on it", exact: true }).isVisible(), 'manual boarding disappeared');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
        assert(lastBusesResponse);
        const initialFeed = await lastBusesResponse.json(), at = initialFeed.server_eta.servedAt;
        const riderDir = `${out}/rider-${scenario}-${viewport.width}`;
        const rider = await attach({ page, ctx: context, autoTick: false, clockNow: () => at,
          initialFeed, initialFeedAt: at, initialResponse: lastBusesResponse, outputDir: riderDir,
          initialLine: { label: 'Purple', busRouteIds: [10] },
          initialTrip: { kind: 'fixed', origin: { label: 'Union Station (S)', ...recorded.stop_coords['122'], stopId: 122 },
            destination: { display_name: 'Building 400', ...recorded.stop_coords['22'], stopId: 22 } } });
        try {
          // attach performs its first tick even when periodic ticking is off.
          // Do not start an unrelated idle selection after the exclusion.
          const journeys = (await fs.readFile(riderDir + '/journeys.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
          assert.equal(journeys.length, 1);
          assert.equal(journeys[0].result, 'on-demand-request-required-excluded');
          assert.equal(journeys[0].excludeAccuracy, true);
          assert.equal(journeys[0].boardedAt, undefined);
          const events = (await fs.readFile(riderDir + '/events.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
          assert(!events.some(event => event.kind === 'harness-error'), 'rider integration recorded a harness error');
        } finally { await rider.stop(); }
        await page.screenshot({ path: `${out}/${scenario}-${viewport.width}.png`, fullPage: true });
        await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'map', exact: true }).click();
        const routeCard = page.locator('#route-card-Purple');
        await routeCard.getByRole('button', { name: 'Purple', exact: true }).click();
        const stopRow = routeCard.locator('[data-service-stop="122"]');
        await stopRow.waitFor();
        assert(await stopRow.getByText('On request', { exact: true }).isVisible());
        assert.equal(await stopRow.getByTestId('route-stop-eta').count(), 0);
        assert.equal(await stopRow.getByRole('button').count(), 0, 'request-only route stop offered a new alert');
        assert(await routeCard.getByRole('link', { name: /Call Dispatch/ }).isVisible());
        await page.screenshot({ path: `${out}/route-card-${scenario}-${viewport.width}.png`, fullPage: true });
        results.push({ viewport, scenario, pickupRetained: 122, scheduledAlternativeRetained: 1,
          pickupDestinationAndNextTimesWithheld: true, reminderWithheld: true, manualBoardingRetained: true,
          requestOnlyRiderExcludedThroughRealDOM: true, routeStopAndAlertServiceStateVerified: true });
      } catch (error) {
        if (page) {
          await page.screenshot({ path: `${out}/failure-${scenario}-${viewport.width}.png`, fullPage: true }).catch(() => {});
          await fs.writeFile(`${out}/failure-${scenario}-${viewport.width}.json`, JSON.stringify({ error: String(error), text: await page.locator('body').innerText().catch(() => '') }, null, 2));
        }
        throw error;
      } finally { await context.unrouteAll({ behavior: 'wait' }); await context.close(); }
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(`${out}/result.json`, JSON.stringify({ ok: true, productionAssets: production, results,
    clockControls: 'Refresh receipt clocks only; positions and forecast durations come from the retained incident. No physical accuracy claim.', errors }, null, 2));
  console.log(JSON.stringify({ ok: true, productionAssets: production, runs: results.length }));
} finally { await browser.close(); }
