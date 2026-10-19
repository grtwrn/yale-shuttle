import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { waitForResponseBody } from './browser-response.mjs';
import { attach } from './rider-watch/runner.mjs';
import { readTransferSections, selectTransferTrip } from './rider-watch/transfer-journey.mjs';

const out = process.env.RIDER_TRANSFER_OUT ?? 'pr-preview/rider-transfer';
const published = process.env.RIDER_TRANSFER_PRODUCTION_ASSETS === '1';
const base = process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await read('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json');
await fs.mkdir(out, { recursive: true });
const assets = new Map(), manifest = {}, results = [];
const shell = new Set(['/manifest.webmanifest', '/sw.js', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']);
async function asset(route, url) {
  assert.equal(route.request().method(), 'GET');
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  assert(key === '/index.html' || shell.has(key) || /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key), key);
  let pending = assets.get(key);
  if (!pending) {
    assert(assets.size < 20);
    pending = (async () => {
      let bytes;
      if (published) { const r = await fetch(base + (key === '/index.html' ? '/' : key), { signal: AbortSignal.timeout(12000) }); assert(r.ok); bytes = Buffer.from(await r.arrayBuffer()); }
      else bytes = await fs.readFile('web/dist' + key);
      assert(bytes.length < 2 * 1024 * 1024);
      const retained = out + '/assets' + key; await fs.mkdir(path.dirname(retained), { recursive: true });
      await fs.writeFile(retained, bytes, { flag: 'wx', mode: 0o600 }); manifest[key] = { bytes: bytes.length, sha256: sha(bytes), retained };
      return bytes;
    })(); assets.set(key, pending);
  }
  return route.fulfill({ body: await pending, contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css'
    : key.endsWith('.png') ? 'image/png' : key.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html' });
}
let productionBuild = null;
if (published) { const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(12000) }); assert(r.ok); const h = await r.json(); assert(h.ok); productionBuild = h.build; }
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
let failure;
try {
  for (const width of [368, 1280]) {
    const feed = structuredClone(source), from = feed.stop_coords[100], to = feed.stop_coords[94];
    let now = feed.server_eta.servedAt, requests = 0, lastResponse, watcher;
    const states = [], errors = [], ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500,
      hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block', permissions: ['geolocation'] });
    let page;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ from, to, now }) => {
        if (!sessionStorage.getItem('rider-transfer-seeded')) {
          localStorage.setItem('listView', 'trip');
          sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Prospect / Canner', fromLL: from, toText: 'Orange / Willow', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
          sessionStorage.setItem('rider-transfer-seeded', 'yes');
        }
        const listeners = new Map(); let id = 0, position = from;
        const fix = () => ({ coords: { latitude: position.lat, longitude: position.lon, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
        Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok) { queueMicrotask(() => ok(fix())); },
          watchPosition(ok) { const key = ++id; listeners.set(key, ok); queueMicrotask(() => ok(fix())); return key; }, clearWatch(key) { listeners.delete(key); } } });
        window.__riderTransferMoveTo = p => { position = p; for (const ok of listeners.values()) ok(fix()); return listeners.size; };
        window.__riderTransferWatchCount = () => listeners.size;
        window.Notification = class { static permission = 'denied'; }; navigator.vibrate = () => true;
      }, { from, to, now });
      page = await ctx.newPage(); page.setDefaultTimeout(10000); await page.clock.install({ time: new Date(now) });
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (new URL(response.url()).pathname === '/api/buses') lastResponse = response; });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()); if (url.hostname !== 'rider-transfer.test') return route.abort();
        if (url.pathname === '/api/buses') {
          requests++; const payload = structuredClone(feed), at = await page.evaluate(() => Date.now());
          payload.server_eta.at = at; payload.server_eta.servedAt = at; for (const bus of payload.buses) bus.observed_at = at;
          return route.fulfill({ json: payload });
        }
        if (url.pathname === '/api/report') throw Error('The virtual rider must not submit a report');
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        return asset(route, url);
      });
      async function advance(ms) {
        const before = requests;
        for (let elapsed = 0; elapsed < ms; elapsed += 500) { const step = Math.min(500, ms - elapsed); now += step; await page.clock.runFor(step); await new Promise(resolve => setTimeout(resolve, 2)); }
        if (requests > before && lastResponse) await waitForResponseBody(page, lastResponse);
        await page.clock.runFor(100); now = await page.evaluate(() => Date.now());
        if (watcher) { for (let i = 0; i < 50 && now - watcher.status().feedAt >= 5000; i++) await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      async function state(name) {
        await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
        states.push({ name, at: now, run: structuredClone(watcher?.status().run ?? null),
          storage: await page.evaluate(() => ({ ride: JSON.parse(localStorage.getItem('shuttle-boarded-ride') ?? 'null'), handoff: JSON.parse(localStorage.getItem('shuttle-transfer-handoff') ?? 'null') })) });
      }
      function place(name, leg, stop) {
        const bus = feed.buses.find(b => b.bus_name.replace(/^#/, '') === name.replace(/^#/, ''));
        assert(bus); const point = feed.stop_coords[stop], seq = feed.routes[bus.route_id], index = seq.indexOf(stop); assert(point && index >= 0);
        Object.assign(bus, point, { stationary: true, at_stop_id: stop, last_stop_id: stop, at_stop_since: new Date(now - 20000).toISOString().slice(0, -1), stationary_since: new Date(now - 20000).toISOString().slice(0, -1), last_moved_at: new Date(now - 20000).toISOString().slice(0, -1) });
        const wire = feed.server_eta, bi = wire.buses.findIndex(b => b[0].replace(/^#/, '') === name.replace(/^#/, '') && b[1] === leg.routeLabel); assert(bi >= 0);
        wire.buses[bi] = [name.replace(/^#/, ''), leg.routeLabel, index, { stopId: stop, standingSec: 20, approach: false }];
        if (wire.travel) wire.travel[bi] = index;
        const retained = wire.rows.map((r, i) => ({ row: r, dots: wire.distributions?.[i] ?? [] })).filter(r => r.row[0] !== bi);
        wire.repeatVisits = (wire.repeatVisits ?? []).filter(r => r[0] !== bi);
        for (let h = 0; h < 2 * seq.length; h++) {
          const sid = seq[(index + h) % seq.length], eta = h * 60;
          retained.push({ row: [bi, sid, eta, Math.round(eta * .8), Math.round(eta * 1.2), h, 0, eta, Math.round(eta * .8)], dots: Array.from({ length: 50 }, (_, i) => Math.round(eta * (.8 + i / 49 * .4))) });
          if (h >= seq.length) wire.repeatVisits.push([bi, sid, h]);
        }
        wire.rows = retained.map(r => r.row); wire.distributions = retained.map(r => r.dots);
      }
      await page.goto('https://rider-transfer.test', { waitUntil: 'domcontentloaded' }); await advance(5500);
      await page.getByRole('button', { name: 'View Blue Day trip details', exact: true }).waitFor();
      const selected = await selectTransferTrip(page, feed, { label: 'Blue Day', busRouteIds: [1] }, ['Blue Day', 'Orange Day'], true);
      assert(selected, 'No eligible Blue Day to Orange Day transfer in the constructed fixture');
      const initial = await readTransferSections(page); assert(initial[0].boardBusName);
      const firstBus = initial[0].boardBusName, first = selected.legs[0], second = selected.legs[1];
      assert.notEqual(first.routeLabel, 'Red'); assert.notEqual(second.routeLabel, 'Red');
      // Reproduce the long pickup quote using the actual ArrivalDetails UI.
      // Shift the constructed Blue forecasts together to preserve bus ranking.
      const wire = feed.server_eta, bi = wire.buses.findIndex(b => b[0].replace(/^#/, '') === firstBus.replace(/^#/, ''));
      const pickupRows = wire.rows.filter(r => r[0] === bi && r[1] === first.boardStopId).sort((a, b) => a[5] - b[5]);
      assert(pickupRows.length); const delay = 45 * 60 - pickupRows[0][2];
      for (let i = 0; i < wire.rows.length; i++) if (wire.buses[wire.rows[i][0]][1] === first.routeLabel) {
        for (const column of [2, 3, 4, 7, 8]) wire.rows[i][column] = Math.max(0, wire.rows[i][column] + delay);
        if (wire.distributions?.[i]) wire.distributions[i] = wire.distributions[i].map(sec => Math.max(0, sec + delay));
      }
      await advance(5500);
      const longQuote = await readTransferSections(page);
      assert.match(longQuote[0].controlText, /Arrives in ~44 min/);
      const simCtx = { setGeolocation: async p => { await ctx.setGeolocation(p); await page.evaluate(point => window.__riderTransferMoveTo(point), { lat: p.latitude, lon: p.longitude }); } };
      const trip = { kind: 'constructed-transfer', origin: { ...from, stopId: 100, label: 'Prospect / Canner' }, destination: { ...to, stopId: 94, display_name: 'Orange / Willow' } };
      watcher = await attach({ page, ctx: simCtx, initialTrip: trip, initialLine: { label: 'Blue Day', busRouteIds: [1] }, initialTransfer: selected,
        initialFeed: structuredClone(feed), initialFeedAt: now, outputDir: `${out}/rider-${width}`, allowedLabels: ['Blue Day', 'Orange Day'], randomLines: true, clockNow: () => now, autoTick: false });
      assert.equal(watcher.status().run?.waitCapMin, 66, 'Current visible 44 minute quote must allow a 66 minute wait');
      await state('selected');
      place(firstBus, first, first.boardStopId); await advance(10000); await watcher.tick();
      for (let attempt = 0; watcher.status().run?.phase === 'waiting' && attempt < 12; attempt++) { await advance(30000); await watcher.tick(); }
      assert.equal(watcher.status().run?.phase, 'riding'); assert.equal(watcher.status().run.busName.replace(/^#/, ''), firstBus.replace(/^#/, '')); assert.equal(watcher.status().run.waitCapMin, 66); await state('first-ride');
      await page.reload(); await advance(5500); await page.getByRole('button', { name: 'End first ride', exact: true }).waitFor();
      place(firstBus, first, first.exitStopId); await advance(40000); await watcher.tick(); assert.equal(watcher.status().run?.phase, 'arrived'); await state('first-arrived');
      await advance(20000); await watcher.tick(); assert.equal(watcher.status().run?.transfer.stage, 1); assert.equal(watcher.status().run.phase, 'waiting'); await state('handoff');
      const next = await readTransferSections(page); assert.equal(next.length, 1); assert(next[0].boardBusName); const secondBus = next[0].boardBusName;
      await page.reload(); await advance(5500); await page.getByTestId('transfer-handoff').waitFor();
      place(secondBus, second, second.boardStopId); await advance(10000); await watcher.tick();
      for (let attempt = 0; watcher.status().run?.phase === 'waiting' && attempt < 20; attempt++) { await advance(30000); await watcher.tick(); }
      assert.equal(watcher.status().run?.phase, 'riding'); assert.equal(watcher.status().run.busName.replace(/^#/, ''), secondBus.replace(/^#/, '')); assert.equal(watcher.status().run.waitCapMin, 45); await state('second-ride');
      place(secondBus, second, second.exitStopId); await advance(40000); await watcher.tick(); assert.equal(watcher.status().run?.phase, 'arrived');
      await advance(20000); await watcher.tick(); assert.equal(watcher.status().run, null); await state('finished');
      const journeys = (await fs.readFile(`${out}/rider-${width}/journeys.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); assert.equal(journeys.length, 1);
      const journey = journeys[0]; assert.equal(journey.result, 'completed'); assert.equal(journey.excludeAccuracy, true); assert.equal(journey.transfer.completedLegs.length, 2);
      assert.deepEqual(journey.transfer.completedLegs.map(l => l.arrivalObservation.stopId), [first.exitStopId, second.exitStopId]); assert.equal(journey.transfer.originalTrip.destination.display_name, 'Orange / Willow');
      const last = states.at(-1).storage; assert.equal(last.ride, null); assert.equal(last.handoff, null); assert.deepEqual(errors, []);
      results.push({ width, selected: selected.legs, firstBus, secondBus, checks: ['Actual built SPA and normal transfer selection helper', 'Current visible 44 minute pickup quote sets 66 minute cap', 'First quote stays fixed through boarding; second pickup gets its own cap', 'First bus and onward storage verified', 'First source arrival retained', 'Normal first-ride end and onward controls', 'Reload retains each stage', 'Timed walking precedes second boarding', 'Second source arrival retained', 'Final ride completes through Done', 'Both leg receipts and final destination retained', 'Excluded from one-seat accuracy aggregates', 'No report submission or external page/API traffic'], states, errors });
    } finally { await watcher?.stop(); if (page) await page.unrouteAll({ behavior: 'wait' }); await ctx.close(); }
  }
} catch (error) { failure = error; }
finally { await browser.close(); await fs.writeFile(`${out}/asset-manifest.json`, JSON.stringify({ published, productionBuild, assets: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
await fs.writeFile(`${out}/result.json`, JSON.stringify({ ok: !failure, scope: 'Constructed source and GPS replay through the actual SPA and real virtual-rider loop; not independent physical arrival truth.', results, ...(failure ? { failure: { message: failure.message, stack: failure.stack } } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (failure) throw failure;
console.log(JSON.stringify({ ok: true, viewports: results.length, checksPerViewport: results[0]?.checks.length, out }));
