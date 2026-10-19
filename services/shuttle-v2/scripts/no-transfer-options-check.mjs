import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { attach } from './rider-watch/runner.mjs';
import { selectTransferTrip } from './rider-watch/transfer-journey.mjs';

/** Production withdrawal check, including the existing rider's ordinary-trip fallback. */
export async function checkNoTransferOptions({ rider = false } = {}) {
  const prefix = rider ? 'RIDER_TRANSFER' : 'TRANSFER_TRIP';
  const out = process.env[prefix + '_OUT'] ?? `pr-preview/${rider ? 'rider-transfer' : 'transfer-trip'}`;
  const published = process.env[prefix + '_PRODUCTION_ASSETS'] === '1';
  const base = process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev';
  const expected = process.env[prefix + '_EXPECTED_BUILD'];
  const source = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
  await fs.mkdir(out, { recursive: true });
  const assets = new Map(), manifest = {}, results = [];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let productionBuild = null;
  if (published) {
    const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(12000) });
    assert(response.ok); const health = await response.json(); assert(health.ok);
    productionBuild = health.build; if (expected) assert.equal(productionBuild, expected);
  }
  const shell = new Set(['/manifest.webmanifest', '/sw.js', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']);
  async function asset(route, url) {
    assert.equal(route.request().method(), 'GET');
    const key = url.pathname === '/' ? '/index.html' : url.pathname;
    assert(key === '/index.html' || shell.has(key) || /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key));
    let pending = assets.get(key);
    if (!pending) {
      assert(assets.size < 20);
      pending = (async () => {
        let bytes;
        if (published) { const r = await fetch(base + (key === '/index.html' ? '/' : key), { signal: AbortSignal.timeout(12000) }); assert(r.ok); bytes = Buffer.from(await r.arrayBuffer()); }
        else bytes = await fs.readFile('web/dist' + key);
        assert(bytes.length < 2 * 1024 * 1024);
        const retained = out + '/assets' + key; await fs.mkdir(path.dirname(retained), { recursive: true });
        await fs.writeFile(retained, bytes, { flag: 'wx', mode: 0o600 });
        manifest[key] = { bytes: bytes.length, sha256: sha(bytes), retained }; return bytes;
      })(); assets.set(key, pending);
    }
    return route.fulfill({ body: await pending, contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : key.endsWith('.png') ? 'image/png' : key.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html' });
  }
  const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
  let failure;
  try {
    for (const width of [368, 1280]) for (const scenario of rider ? ['live'] : ['live', 'stored-selection', 'future']) {
      const feed = structuredClone(source), from = feed.stop_coords[100], to = feed.stop_coords[94];
      let now = feed.server_eta.servedAt, watcher;
      const errors = [], ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500, hasTouch: width < 500,
        timezoneId: 'America/New_York', serviceWorkers: 'block', permissions: ['geolocation'] });
      let page;
      try {
        await seedTestId(ctx);
        await ctx.addInitScript(({ from, to, now, scenario }) => {
          localStorage.setItem('listView', 'trip');
          const tripTime = scenario === 'future' ? '2026-10-12T11:00' : '';
          sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Prospect / Canner', fromLL: from, toText: 'Orange / Willow', toLL: to, tripTime, expandedKey: null, savedAt: now }));
          if (scenario === 'stored-selection') sessionStorage.setItem('shuttle-transfer-selection', JSON.stringify({
            query: `${from.lat}|${from.lon}|${to.lat}|${to.lon}|`, firstBusName: '48', secondBusName: '58', path: {
              first: { routeLabel: 'Blue Day', routeId: '1', boardStopId: 100, alightStopId: 135, stops: [100, 135], plannedRideSec: 600 },
              second: { routeLabel: 'Orange Day', routeId: '2', boardStopId: 134, alightStopId: 95, stops: [134, 95], plannedRideSec: 300 },
              walkToSec: 0, transferWalkSec: 60, walkFromSec: 300, directWalkSec: 1600,
            } }));
          const callbacks = new Map(); let key = 0, position = from;
          const fix = () => ({ coords: { latitude: position.lat, longitude: position.lon, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
          Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok) { queueMicrotask(() => ok(fix())); },
            watchPosition(ok) { const id = ++key; callbacks.set(id, ok); queueMicrotask(() => ok(fix())); return id; }, clearWatch(id) { callbacks.delete(id); } } });
          window.__noTransferMoveTo = p => { position = p; for (const ok of callbacks.values()) ok(fix()); };
          window.Notification = class { static permission = 'denied'; }; navigator.vibrate = () => true;
        }, { from, to, now, scenario });
        page = await ctx.newPage(); page.setDefaultTimeout(10000); await page.clock.install({ time: new Date(now) });
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', async route => {
          const url = new URL(route.request().url()); if (url.hostname !== 'no-transfers.test') return route.abort();
          if (url.pathname === '/api/buses') {
            const payload = structuredClone(feed), at = await page.evaluate(() => Date.now()); payload.server_eta.at = at; payload.server_eta.servedAt = at;
            for (const bus of payload.buses) bus.observed_at = at; return route.fulfill({ json: payload });
          }
          if (url.pathname === '/api/report') throw Error('Withdrawal check must not submit a report');
          if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
          if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
          return asset(route, url);
        });
        async function advance(ms) {
          for (let elapsed = 0; elapsed < ms; elapsed += 500) { await page.clock.runFor(Math.min(500, ms - elapsed)); await new Promise(r => setTimeout(r, 2)); }
          now = await page.evaluate(() => Date.now());
        }
        async function absent() {
          assert.equal(await page.locator('[data-testid="transfer-detail"], [data-feedback-transfer-ride]').count(), 0);
          assert.equal(await page.getByRole('button', { name: /^View .+ to .+ transfer from / }).count(), 0);
          assert.equal(await page.getByRole('button', { name: /^Show \d+( more)? transfer options$/ }).count(), 0);
          assert(!/First bus ·|Second bus ·|if you make the connection/.test(await page.locator('body').innerText()));
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.goto('https://no-transfers.test', { waitUntil: 'domcontentloaded' }); await advance(5500);
        const direct = page.getByRole('button', { name: 'View Blue Day trip details', exact: true }); await direct.waitFor(); await absent();
        if (scenario === 'stored-selection') { await page.reload(); await advance(5500); await direct.waitFor(); await absent(); }
        if (rider) {
          assert.equal(await selectTransferTrip(page, feed, { label: 'Blue Day', busRouteIds: [1] }, ['Blue Day', 'Orange Day'], true), null);
        }
        await direct.focus(); await page.keyboard.press('Enter'); await absent();
        const ordinaryText = await page.locator('body').innerText(); assert.match(ordinaryText, /BOARD/); assert.match(ordinaryText, /GET OFF/);
        if (rider) {
          const simCtx = { setGeolocation: async p => { await ctx.setGeolocation(p); await page.evaluate(point => window.__noTransferMoveTo(point), { lat: p.latitude, lon: p.longitude }); } };
          watcher = await attach({ page, ctx: simCtx, initialTrip: { kind: 'withdrawal-control', origin: { ...from, stopId: 100, label: 'Prospect / Canner' }, destination: { ...to, stopId: 94, display_name: 'Orange / Willow' } },
            initialLine: { label: 'Blue Day', busRouteIds: [1] }, initialFeed: structuredClone(feed), initialFeedAt: now, outputDir: `${out}/rider-${width}`, clockNow: () => now, autoTick: false });
          const waiting = watcher.status().run; assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.transfer, undefined); assert.equal(waiting.boardStopId, 100); assert(waiting.exitStopId);
          const name = waiting.busName.replace(/^#/, ''), bus = feed.buses.find(b => b.bus_name.replace(/^#/, '') === name); assert(bus);
          Object.assign(bus, feed.stop_coords[100], { stationary: true, at_stop_id: 100, last_stop_id: 100, last_moved_at: new Date(now - 20000).toISOString().slice(0, -1) });
          const wire = feed.server_eta, bi = wire.buses.findIndex(b => b[0].replace(/^#/, '') === name), index = feed.routes[bus.route_id].indexOf(100);
          wire.buses[bi] = [name, 'Blue Day', index, { stopId: 100, standingSec: 20, approach: false }];
          if (wire.travel) wire.travel[bi] = index;
          const sequence = feed.routes[bus.route_id];
          const retained = wire.rows.map((row, i) => ({ row, dots: wire.distributions?.[i] ?? [] })).filter(r => r.row[0] !== bi);
          wire.repeatVisits = (wire.repeatVisits ?? []).filter(r => r[0] !== bi);
          for (let hop = 0; hop < 2 * sequence.length; hop++) {
            const stopId = sequence[(index + hop) % sequence.length], eta = hop * 60;
            retained.push({ row: [bi, stopId, eta, Math.round(eta * .8), Math.round(eta * 1.2), hop, 0, eta, Math.round(eta * .8)], dots: Array.from({ length: 50 }, (_, i) => Math.round(eta * (.8 + i / 49 * .4))) });
            if (hop >= sequence.length) wire.repeatVisits.push([bi, stopId, hop]);
          }
          wire.rows = retained.map(r => r.row); wire.distributions = retained.map(r => r.dots);
          for (let attempt = 0; watcher.status().run?.phase === 'waiting' && attempt < 10; attempt++) { await advance(10000); await watcher.tick(); }
          const riding = watcher.status().run; assert.equal(riding?.phase, 'riding'); assert.equal(riding.transfer, undefined);
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('shuttle-boarded-ride') ?? 'null'));
          assert.equal(stored.busName.replace(/^#/, ''), name); assert.equal(stored.onward, undefined);
        }
        await page.screenshot({ path: `${out}/${scenario}-${width}.png`, fullPage: true }); assert.deepEqual(errors, []);
        results.push({ width, scenario, ordinaryTripAvailable: true, transferOptionsAbsent: true, ...(rider ? { ordinaryRiderBoarded: true } : {}), errors });
      } finally { await watcher?.stop(); if (page) await page.unrouteAll({ behavior: 'wait' }); await ctx.close(); }
    }
  } catch (e) { failure = e; }
  finally { await browser.close(); await fs.writeFile(`${out}/asset-manifest.json`, JSON.stringify({ published, productionBuild, assets: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  await fs.writeFile(`${out}/result.json`, JSON.stringify({ ok: !failure, scope: 'Requested withdrawal: absence of new transfer choices and preservation of ordinary trips. Constructed GPS is not physical arrival or ETA accuracy truth.', results, ...(failure ? { error: failure.message, stack: failure.stack } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (failure) throw failure;
  console.log(JSON.stringify({ ok: true, rider, cases: results.length, productionBuild, out }));
}
