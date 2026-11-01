// Real SPA with a recorded software fixture and controlled service changes.
// Every API is intercepted; this checks UI behavior, not physical ETA accuracy.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';

const capture = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
const now = capture.server_eta.servedAt;
const base = process.env.BOT_BASE_URL ?? 'https://route-admission.test';
const out = process.env.BOT_OUT ?? 'pr-preview/new-route-admission';
await fs.mkdir(out, { recursive: true });
const report = { scope: 'Controlled route appearance/loss with actual SPA, intercepted APIs and fixed manual endpoints; no production writes or physical accuracy claim', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });

function feedFor(phase, at) {
  const feed = structuredClone(capture);
  const labels = new Set(phase === 'red' ? ['Red'] : ['Red', 'Blue Day']);
  feed.buses = feed.buses.filter(b => b.route_id === 3 || phase !== 'red' && b.route_id === 1);
  for (const bus of feed.buses) bus.observed_at = at;
  const wire = feed.server_eta;
  const indexes = wire.buses.flatMap((bus, index) => labels.has(bus[1]) ? [index] : []);
  const remap = new Map(indexes.map((index, next) => [index, next]));
  const rows = wire.rows.map((row, index) => ({ row, index })).filter(({ row }) => remap.has(row[0]));
  wire.rows = rows.map(({ row }) => [remap.get(row[0]), ...row.slice(1)]);
  if (wire.distributions) wire.distributions = rows.map(({ index }) => wire.distributions[index]);
  if (wire.travel) wire.travel = indexes.map(index => wire.travel[index]);
  wire.buses = indexes.map(index => wire.buses[index]);
  wire.at = at; wire.servedAt = at;
  return feed;
}

try {
  for (const scenario of [{ width: 307 }, { width: 390 }, { width: 1280 }, { width: 390, future: true }]) {
    const { width, future = false } = scenario;
    let phase = future ? 'unavailable' : 'red', servedNow = now, polls = 0;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600,
      hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    let page;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ from, to, now, future }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: '517 Prospect Street', fromLL: from,
          toText: 'Rosenkranz Hall', toLL: to, tripTime: future ? '2026-10-12T10:00' : '', expandedKey: null, savedAt: now }));
      }, { from: capture.from, to: capture.to, now, future });
      page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => report.errors.push(`${width}/${future}: ${error.message}`));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin) return route.abort();
        if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.fulfill({ status: 204 });
        if (url.pathname === '/api/buses') {
          polls++;
          if (phase === 'unavailable') return route.fulfill({ status: 503, json: { error: 'Controlled initial connection failure' } });
          return route.fulfill({ json: feedFor(phase, servedNow) });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = url.pathname === '/' ? '/index.html' : url.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file),
          contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      const advance = async () => {
        const before = polls;
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await advanceUntilResponse(page, before, () => polls, ms => { servedNow += ms; });
        await waitForResponseBody(page, await response);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(polls > before, 'a new feed poll completed');
      };
      const blue = page.getByRole('button', { name: 'View Blue Day trip details', exact: true });
      const farther = page.getByRole('button', { name: 'View Blue Day trip details from Whitney/Canner', exact: true });
      const red = page.getByRole('button', { name: 'View Red trip details', exact: true });
      const redRow = page.locator('tbody[data-route="Red"]').filter({ has: red });
      const nearRow = page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');
      const farRow = page.locator('tbody[data-route="Blue Day"][data-pickup="129"]');
      const initialResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const initial = await initialResponse;
      await waitForResponseBody(page, initial);
      assert.equal(initial.status(), future ? 503 : 200, 'controlled initial service state');
      if (future) {
        const when = page.locator('input[type="datetime-local"]');
        await when.waitFor();
        assert.equal(await when.inputValue(), '2026-10-12T10:00');
        assert.equal(await blue.count(), 0, 'no route metadata was available initially');
        phase = 'both'; await advance();
        await blue.waitFor();
        assert.equal(await when.inputValue(), '2026-10-12T10:00', 'future selection survives first metadata arrival');
        await advance(); await blue.waitFor();
      } else {
        await red.waitFor();
        const originalRedPickup = await redRow.getAttribute('data-pickup');
        assert(originalRedPickup, 'initial Red pickup is explicit');
        assert.equal(await blue.count(), 0, 'initial nonempty plan has no Blue service');
        await red.click();
        await page.getByTestId('trip-detail-panel').waitFor();
        await page.getByRole('button', { name: '← All routes', exact: true }).click();
        phase = 'both'; await advance();
        await blue.waitFor(); await farther.waitFor();
        assert.match(await nearRow.innerText(), /Closest stop/);
        assert.match(await farRow.innerText(), /Arrive sooner/);
        assert.equal(await redRow.getAttribute('data-pickup'), originalRedPickup, 'new Blue does not reset existing Red pickup');
        await page.screenshot({ path: `${out}/blue-added-${width}.png`, fullPage: true });
        await farther.click();
        await page.getByTitle('Walking directions to Whitney/Canner', { exact: true }).waitFor();
        await advance();
        assert(await page.getByTitle('Walking directions to Whitney/Canner', { exact: true }).isVisible(), 'explicit farther pickup stays pinned on the next poll');
        await page.getByRole('button', { name: '← All routes', exact: true }).click();
        phase = 'red'; await advance(); await advance();
        const notices = page.getByTestId('bus-reporting-alerts');
        await notices.waitFor();
        assert.match(await notices.innerText(), /Blue Day #48 stopped reporting/);
        assert.equal(await nearRow.count(), 1, 'closest Blue pickup stays in the catalog after reporting loss');
        assert.equal(await farRow.count(), 1, 'selected farther Blue pickup also survives loss');
        assert.equal(await redRow.getAttribute('data-pickup'), originalRedPickup, 'removing Blue does not replan Red');
        phase = 'both'; await advance();
        await nearRow.waitFor(); await farRow.waitFor();
        await nearRow.getByRole('button', { name: /^View Blue Day trip details/ }).click();
        await page.getByTitle('Walking directions to Prospect/Canner', { exact: true }).waitFor();
      }
      const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
      assert.deepEqual(draft.fromLL, capture.from, 'manual origin stays locked');
      assert.deepEqual(draft.toLL, capture.to, 'destination stays locked');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await page.screenshot({ path: `${out}/${future ? 'future-bootstrap' : 'blue-restored'}-${width}.png`, fullPage: true });
      report.runs.push({ width, future, polls, passed: true });
      console.log(`PASS new route admission ${width}px ${future ? 'future metadata bootstrap' : 'Red → Blue closest/alternative → loss → return'}`);
    } catch (error) {
      report.errors.push(`${width}/${future}: ${error.message}`);
      if (page && !page.isClosed()) {
        try {
          const body = Buffer.from(await page.locator('body').innerText());
          await fs.writeFile(`${out}/failure-${width}-${future}.json`, JSON.stringify({ phase, polls,
            message: error.message, bodyBytes: body.length, truncated: body.length > 65536,
            body: body.subarray(0, 65536).toString() }, null, 2));
          console.error('[new-route-admission failure]', JSON.stringify({ width, future, phase, polls,
            message: error.message, bodyBytes: body.length, truncated: body.length > 8192,
            body: body.subarray(0, 8192).toString() }));
          await page.screenshot({ path: `${out}/failure-${width}-${future}.png`, fullPage: true });
        } catch (diagnosticError) { report.errors.push(`Failure diagnostic: ${diagnosticError.message}`); }
      }
      throw error;
    } finally { await ctx.close(); }
  }
  assert.deepEqual(report.errors, [], 'no browser errors');
} finally {
  await browser.close();
  await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2) + '\n');
}
