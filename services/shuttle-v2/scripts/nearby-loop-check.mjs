import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service = process.cwd();
const out = process.env.NEARBY_LOOP_OUT ?? 'pr-preview/nearby-loop';
const published = process.env.NEARBY_LOOP_PRODUCTION_ASSETS === '1';
const base = process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev';
const expected = process.env.NEARBY_LOOP_EXPECTED_BUILD;
await fs.mkdir(out, { recursive: true });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const blue = await read('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json');
const red = await read('web/src/__fixtures__/red-reporting-2026-10-14.json');
async function health() {
  const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(12000) });
  assert(r.ok);
  const h = await r.json();
  assert(h.ok);
  if (expected) assert.equal(h.build, expected);
  return h.build;
}
const build = published ? await health() : 'local-build';
const assets = new Map(), manifest = {}, results = [];
const shell = new Set(['/manifest.webmanifest', '/sw.js', '/icons/icon-180.png',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']);
async function asset(route, url) {
  assert.equal(route.request().method(), 'GET');
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  assert(key === '/index.html' || shell.has(key) || /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key), key);
  let pending = assets.get(key);
  if (!pending) {
    assert(assets.size < 20);
    pending = (async () => {
      let bytes;
      if (published) {
        const r = await fetch(base + (key === '/index.html' ? '/' : key), { signal: AbortSignal.timeout(12000) });
        assert(r.ok);
        bytes = Buffer.from(await r.arrayBuffer());
      } else bytes = await fs.readFile(service + '/web/dist' + key);
      assert(bytes.length < 2 * 1024 * 1024);
      const retained = out + '/assets' + key;
      await fs.mkdir(path.dirname(retained), { recursive: true });
      await fs.writeFile(retained, bytes, { flag: 'wx', mode: 0o600 });
      manifest[key] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), retained };
      return bytes;
    })();
    assets.set(key, pending);
  }
  return route.fulfill({ body: await pending, contentType: key.endsWith('.js') ? 'text/javascript'
    : key.endsWith('.css') ? 'text/css' : key.endsWith('.png') ? 'image/png'
      : key.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html' });
}
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
let failure;
try {
  for (const width of [368, 1280]) for (const scenario of ['nearby-loop', 'closest-blue']) {
    const feed = scenario === 'nearby-loop' ? red.feed : blue;
    const now = scenario === 'nearby-loop' ? red.receivedAt : blue.server_eta.servedAt;
    const from = scenario === 'nearby-loop'
      ? { lat: blue.to.lat + 75 / 111000, lon: blue.to.lon } : blue.from;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500,
      hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    const errors = [];
    let page;
    try {
      await seedTestId(ctx);
      await ctx.grantPermissions(['notifications']);
      await ctx.addInitScript(({ from, to, now }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Recorded-corridor origin', fromLL: from,
          toText: 'Rosenkranz Hall', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
      }, { from, to: blue.to, now });
      page = await ctx.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'nearby-loop.test') return route.abort();
        if (url.pathname === '/api/buses') return route.fulfill({ json: feed });
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        return asset(route, url);
      });
      await page.goto('https://nearby-loop.test', { waitUntil: 'domcontentloaded' });
      const label = scenario === 'nearby-loop' ? 'Red' : 'Blue Day';
      const choose = page.getByRole('button', { name: `View ${label} trip details`, exact: true });
      await page.locator('tbody[data-route="Walk"]').waitFor();
      // Let the live update zero pickup walking before checking visibility.
      await page.clock.runFor(5500);
      await page.waitForTimeout(80);
      if (scenario === 'nearby-loop') {
        assert.equal(await choose.count(), 0, 'A long nearby loop must stay under Show more after the live at-stop update');
        const more = page.getByRole('button', { name: /Show \d+ more route/ });
        await more.waitFor();
        await page.screenshot({ path: out + `/${width}-${scenario}-overview.png`, fullPage: true });
        await more.click();
        await choose.waitFor();
      } else {
        await choose.waitFor();
        await page.getByRole('button', { name: 'View Blue Day trip details from Whitney/Canner', exact: true }).waitFor();
        assert.match(await page.locator('tbody[data-route="Blue Day"][data-pickup="100"]').innerText(), /Closest stop/);
      }
      const overview = await page.getByTestId('map-trip-panel').innerText();
      await choose.focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('trip-detail-panel').waitFor();
      const stop = scenario === 'nearby-loop' ? '130 Prospect Street (N)' : 'Prospect/Canner';
      const directions = page.getByTitle('Walking directions to ' + stop, { exact: true });
      await directions.waitFor();
      await page.getByRole('button', { name: /^🔔 Remind me for / }).click();
      await page.getByRole('group', { name: 'Pickup reminder settings', exact: true })
        .getByRole('button', { name: 'Set reminder', exact: true }).click();
      await page.getByRole('button', { name: /^🔔 Reminding you for / }).waitFor();
      await page.clock.runFor(5500);
      assert(await directions.isVisible());
      assert(await page.getByRole('button', { name: /^🔔 Reminding you for / }).isVisible());
      await page.screenshot({ path: out + `/${width}-${scenario}-selected.png`, fullPage: true });
      await page.getByRole('button', { name: '← All routes', exact: true }).click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('tbody[data-route="Walk"]').waitFor();
      await page.clock.runFor(5500);
      await page.waitForTimeout(80);
      if (scenario === 'nearby-loop') assert.equal(await choose.count(), 0);
      else assert(await choose.isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      results.push({ width, scenario, overview, selectedPickup: stop, explicitSelectionAndReminderRetained: true,
        freshOverviewPolicyRetained: true, pageErrors: errors });
    } catch (error) {
      if (page) {
        await fs.writeFile(out + `/failure-${width}-${scenario}.txt`, await page.locator('body').innerText().catch(() => ''));
        await page.screenshot({ path: out + `/failure-${width}-${scenario}.png`, fullPage: true }).catch(() => {});
      }
      throw error;
    } finally {
      if (page) await page.unrouteAll({ behavior: 'wait' });
      await ctx.close();
    }
  }
} catch (error) { failure = error; }
finally {
  await browser.close();
  await fs.writeFile(out + '/assets.json', JSON.stringify({ productionBuild: build, assets: manifest,
    productionApiWrites: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (published) assert.equal(await health(), build);
await fs.writeFile(out + '/result.json', JSON.stringify({ at: new Date().toISOString(), ok: !failure,
  productionBuild: build, localBuild: !published, browserCases: results.length, resourcesClosed: true, results,
  scope: 'Published or locally built SPA with retained public feeds and constructed origins. Checks nearby-loop overview visibility, access through Show more, explicit selection/reminder retention, and both Blue pickup choices. No original September GPS/ETA replay, live rider view, production report mutation or message.',
  ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (failure) throw failure;
assert.equal(results.length, 4);
console.log('Nearby loop: four phone/desktop cases keep a long nearby ride under Show more; explicit selections/reminders and both Blue pickups stay available.');
