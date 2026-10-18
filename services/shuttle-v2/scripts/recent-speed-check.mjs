import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service = process.cwd();
const out = process.env.RECENT_SPEED_OUT ?? 'pr-preview/recent-speed';
const published = process.env.RECENT_SPEED_PRODUCTION_ASSETS === '1';
const base = process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev';
const expected = process.env.RECENT_SPEED_EXPECTED_BUILD;
await fs.mkdir(out, { recursive: true });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const blue = await read('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json');
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
  for (const width of [368, 1280]) for (const mode of ['trip', 'map', 'ride']) {
    const now = blue.server_eta.servedAt;
    let phase = 'fresh', servedNow = now, frozenAt = now, polls = 0;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500,
      hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    const errors = [], checks = [];
    let page;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ from, to, now, mode }) => {
        localStorage.setItem('listView', mode === 'ride' ? 'trip' : mode);
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Prospect/Canner', fromLL: from,
          toText: 'Rosenkranz Hall', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
        if (mode === 'ride') localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ routeLabel: 'Red',
          color: '#C62828', busName: '119', boardStopId: 48, alightStopId: 11, startedAt: now }));
      }, { from: blue.from, to: blue.to, now, mode });
      page = await ctx.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'recent-speed.test') return route.abort();
        if (url.pathname === '/api/buses') {
          polls++;
          if (phase === 'fail') return route.fulfill({ status: 503, json: { error: 'constructed outage' } });
          const feed = structuredClone(blue);
          for (const b of feed.buses) {
            b.observed_at = phase === 'expiry' ? frozenAt : servedNow;
            if (phase === 'legacy') delete b.recent_speed;
            else b.recent_speed = phase === 'unknown' ? null : {
              mph: phase === 'slow' ? 0 : b.bus_name === '#119' ? 65 : 17.2,
              at: b.observed_at, window_sec: 30,
              expires_at: b.observed_at + (phase === 'expiry' ? 1500 : 20_000),
            };
          }
          feed.server_eta.at = servedNow; feed.server_eta.servedAt = servedNow;
          return route.fulfill({ json: feed });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        return asset(route, url);
      });
      await page.goto('https://recent-speed.test', { waitUntil: 'domcontentloaded' });
      if (mode === 'trip') {
        await page.getByRole('button', { name: 'View Blue Day trip details', exact: true }).click();
        await page.getByTestId('trip-detail-panel').waitFor();
      }
      const readout = mode === 'trip' ? page.getByTestId('trip-recent-speed')
        : mode === 'ride' ? page.getByTestId('ride-recent-speed') : null;
      const marker = () => page.locator('.bus-marker[title^="#119 ·"]');
      async function shown() {
        if (readout) return await readout.innerText();
        await marker().waitFor();
        assert.equal(await marker().getAttribute('tabindex'), '0');
        await marker().focus();
        const tooltip = page.locator('.leaflet-tooltip').filter({ hasText: '#119 ·' });
        await tooltip.waitFor();
        return await tooltip.innerText();
      }
      async function advance(ms = 5500) {
        servedNow += ms;
        await page.clock.runFor(ms);
        await page.waitForTimeout(80);
        // Leaflet removes a closed tooltip after its 200ms fade. Advance the
        // installed browser clock after React has committed the marker update.
        await page.clock.runFor(250);
        servedNow += 250;
        await page.waitForTimeout(80);
      }
      const initial = await shown();
      assert.match(initial, mode === 'trip' ? /Recent speed ≈15 mph/ : /Recent speed ≈65 mph/);
      assert.match(initial, /30s GPS average/);
      checks.push('fresh rounded per-bus estimate with its GPS averaging window');
      if (mode === 'map') {
        const box = await page.locator('.leaflet-tooltip').filter({ hasText: '#119 ·' }).boundingBox();
        assert(box && box.width >= 150 && box.width <= 240, 'Speed tooltip must wrap at a readable width');
        assert(box.x >= 0 && box.x + box.width <= width, 'Speed tooltip must fit the viewport');
        await page.screenshot({ path: out + `/${width}-${mode}-viewport.png` });
      }
      await page.screenshot({ path: out + `/${width}-${mode}-fresh.png`, fullPage: true });
      phase = 'slow'; await advance();
      assert.match(await shown(), /Recent speed <5 mph/);
      assert.doesNotMatch(await shown(), /stopped/i);
      checks.push('supported below-5 reading never claims stopped');
      phase = 'expiry'; frozenAt = servedNow + 5500; await advance();
      assert.match(await shown(), /Recent speed ≈/);
      // No new HTTP poll is needed: the app clock must expire an open tooltip.
      await advance(2600);
      if (mode === 'map') assert.equal(await page.locator('.leaflet-tooltip').filter({ hasText: /Recent speed ≈/ }).count(), 0);
      assert.match(await shown(), /Recent speed unavailable/);
      checks.push('provider deadline expires a retained observation on the screen clock');
      phase = 'fresh'; await advance(); assert.match(await shown(), /Recent speed ≈/);
      phase = 'fail'; await advance(); assert.match(await shown(), /Recent speed unavailable/);
      phase = 'fresh'; await advance(); assert.match(await shown(), /Recent speed ≈/);
      checks.push('transport failure hides speed and recovery restores it');
      phase = 'unknown'; await advance(); assert.match(await shown(), /Recent speed unavailable/);
      phase = 'legacy'; await advance();
      if (readout) assert.equal(await readout.count(), 0);
      else { assert.doesNotMatch(await shown(), /Recent speed/); }
      checks.push('unknown is unavailable and an older server omits the feature');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert(polls >= 7);
      results.push({ width, mode, initial, polls, checks, pageErrors: errors });
    } catch (error) {
      if (page) {
        await fs.writeFile(out + `/failure-${width}-${mode}.txt`, await page.locator('body').innerText().catch(() => ''));
        await page.screenshot({ path: out + `/failure-${width}-${mode}.png`, fullPage: true }).catch(() => {});
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
  scope: 'Actual built SPA with retained public feed and constructed recent-speed metadata, fix deadlines and transport failures. Tests display behavior, not physical speed or ETA accuracy. All APIs are intercepted; no production writes or rider messages.',
  ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (failure) throw failure;
assert.equal(results.length, 6);
console.log('Recent speed: six phone/desktop trip, fleet-map and on-bus cases passed fresh, low, expired, unavailable, recovery and legacy behavior.');
