import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';
import { seedTestId } from './testId.mjs';

const service = process.cwd();
const out = process.env.TRANSFER_TRIP_OUT ?? 'pr-preview/transfer-trip';
const published = process.env.TRANSFER_TRIP_PRODUCTION_ASSETS === '1';
const base = process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev';
const expected = process.env.TRANSFER_TRIP_EXPECTED_BUILD;
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
  for (const width of [368, 1280]) {
    const feed = structuredClone(blue), now = feed.server_eta.servedAt;
    const from = feed.stop_coords[11], to = feed.stop_coords[94];
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500,
      hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block', permissions: ['geolocation'] });
    const errors = [], states = [], submissions = [];
    let page, phase = 'fresh', missedBus = '', requests = 0;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ from, to, now }) => {
        if (!sessionStorage.getItem('transfer-fixture-seeded')) {
          localStorage.setItem('listView', 'trip');
          sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Private diagnostic origin', fromLL: from,
            toText: 'Orange / Willow', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
          sessionStorage.setItem('transfer-fixture-seeded', 'yes');
        }
        const listeners = new Map(); let next = 1, position = from;
        const fix = () => ({ coords: { latitude: position.lat, longitude: position.lon, accuracy: 10,
          altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
        Object.defineProperty(navigator, 'geolocation', { value: {
          getCurrentPosition(ok) { queueMicrotask(() => ok(fix())); },
          watchPosition(ok) { const id = next++; listeners.set(id, ok); queueMicrotask(() => ok(fix())); return id; },
          clearWatch(id) { listeners.delete(id); }
        } });
        window.__transferGeoWatchCount = () => listeners.size;
        window.__transferMoveTo = point => { position = point; for (const ok of listeners.values()) ok(fix()); return listeners.size; };
        window.__transferNotifications = [];
        window.Notification = class { static permission = 'granted'; constructor(title, options) { window.__transferNotifications.push({ title, body: options?.body }); } };
        navigator.vibrate = () => true;
      }, { from, to, now });
      page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'transfer-trip.test') return route.abort();
        if (url.pathname === '/api/report') { submissions.push(route.request().postDataJSON()); return route.fulfill({ status: 503, json: { error: 'Constructed unavailable response' } }); }
        if (url.pathname === '/api/buses') {
          requests++;
          if (phase === 'failed') return route.fulfill({ status: 503, json: { error: 'Constructed unavailable response' } });
          const payload = structuredClone(feed), at = await page.evaluate(() => Date.now());
          payload.server_eta.at = at; payload.server_eta.servedAt = at;
          for (const bus of payload.buses) bus.observed_at = at;
          if (phase === 'missing') {
            payload.buses = payload.buses.filter(b => b.bus_name.replace(/^#/, '') !== missedBus);
            const index = payload.server_eta.buses.findIndex(b => b[0].replace(/^#/, '') === missedBus);
            payload.server_eta.rows = payload.server_eta.rows.filter(r => r[0] !== index);
          }
          return route.fulfill({ json: payload });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        return asset(route, url);
      });
      async function poll() {
        const before = requests, response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await advanceUntilResponse(page, before, () => requests, () => {});
        await waitForResponseBody(page, await response); await page.clock.runFor(100);
      }
      async function feedback() {
        await page.getByRole('button', { name: '💬 Send feedback', exact: true }).click();
        await page.getByRole('textbox', { name: 'Feedback', exact: true }).fill('Constructed transfer diagnostic, intercepted locally');
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/report');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await response;
        await page.getByRole('alert').getByText("Couldn't send — try again", { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        return submissions.at(-1).screen;
      }
      const persisted = () => page.evaluate(() => ({ ride: JSON.parse(localStorage.getItem('shuttle-boarded-ride') ?? 'null'),
        handoff: JSON.parse(localStorage.getItem('shuttle-transfer-handoff') ?? 'null'),
        selection: JSON.parse(sessionStorage.getItem('shuttle-transfer-selection') ?? 'null') }));
      const state = async name => {
        const s = { name, ...await persisted(), body: await page.locator('body').innerText() };
        states.push(s); return s;
      };
      const checkWidth = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      await page.goto('https://transfer-trip.test', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('map-trip-panel').waitFor();
      const show = page.getByRole('button', { name: /^Show \d+( more)? transfer options$/ });
      if (await show.count()) await show.click();
      const choose = page.getByRole('button', { name: /^View Red to Orange Day transfer from / }).first();
      await choose.waitFor(); await choose.focus(); await page.keyboard.press('Enter');
      const detail = page.getByTestId('transfer-detail'); await detail.waitFor();
      await state('first-pickup'); await checkWidth();
      await page.screenshot({ path: `${out}/detail-${width}.png`, fullPage: true });
      assert.match(await detail.innerText(), /First bus/); assert.match(await detail.innerText(), /Second bus/);
      assert.match(await detail.innerText(), /if you make the connection/);
      assert.equal(await detail.getByRole('button', { name: /Remind me/ }).count(), 1);
      const first = (await persisted()).selection;
      assert(first?.secondBusName); assert(first.firstBusName);
      const diagnostic = await feedback();
      assert(diagnostic.tripDetail); assert.equal(diagnostic.rows.length, 2);
      assert.deepEqual(diagnostic.rows.map(r => [r.route, r.boardStopId, r.alightStopId]),
        [[first.path.first.routeLabel, first.path.first.boardStopId, first.path.first.alightStopId],
          [first.path.second.routeLabel, first.path.second.boardStopId, first.path.second.alightStopId]]);
      assert.match(diagnostic.rows[0].board, /At pickup now/); assert.match(diagnostic.rows[1].board, /range/);
      assert(!JSON.stringify(diagnostic).includes('Private diagnostic origin'));
      missedBus = first.secondBusName; phase = 'missing'; await poll(); await poll();
      await page.getByText(`Orange Day #${missedBus} stopped reporting`, { exact: true }).waitFor();
      assert.equal((await persisted()).selection.path.key, first.path.key);
      assert.equal(await detail.getByRole('button', { name: /I.m on/ }).count(), 1);
      assert(!/Typical trip/.test(await detail.innerText()));
      await state('second-bus-lost'); phase = 'fresh'; await poll();
      await page.getByText(`Orange Day #${missedBus} is reporting again`, { exact: true }).waitFor();
      missedBus = first.firstBusName; phase = 'missing'; await poll(); await poll();
      await page.getByText(`Red #${missedBus} stopped reporting`, { exact: true }).waitFor();
      assert((await persisted()).selection.firstBusName !== missedBus);
      assert.match(await detail.innerText(), /The trip now shows #/);
      await state('first-bus-lost'); phase = 'fresh'; await poll();
      await page.getByText(`Red #${missedBus} is reporting again`, { exact: true }).waitFor();
      phase = 'failed'; await poll();
      assert.match(await detail.innerText(), /Live pickup timing unavailable/);
      assert.equal(await detail.getByRole('button', { name: /I.m on/ }).count(), 0);
      phase = 'fresh'; await poll();
      const remind = detail.getByRole('button', { name: /Remind me/ }); await remind.click();
      await detail.getByLabel('Reminder timing', { exact: true }).selectOption('stops');
      await detail.getByLabel('Stops before pickup', { exact: true }).selectOption('2');
      await detail.getByRole('button', { name: 'Set reminder', exact: true }).click(); await page.clock.runFor(100);
      assert.equal((await page.evaluate(() => window.__transferNotifications)).length, 1);
      assert.match((await page.evaluate(() => window.__transferNotifications))[0].body, /Red/);
      await poll(); assert.equal((await page.evaluate(() => window.__transferNotifications)).length, 1);
      await page.reload(); await detail.waitFor();
      assert.equal((await persisted()).selection.path.key, first.path.key);
      await detail.getByRole('button', { name: /I.m on/ }).first().click();
      await page.getByTestId('transfer-onward-banner').waitFor();
      const ride1 = (await persisted()).ride;
      assert.equal(ride1.onward.destination.text, 'Orange / Willow');
      assert.equal(ride1.onward.next.routeLabel, 'Orange Day'); assert.equal(ride1.routeLabel, 'Red');
      await page.reload(); await page.getByTestId('transfer-onward-banner').waitFor();
      assert.deepEqual((await persisted()).ride, ride1);
      const prompt = page.getByRole('alertdialog');
      if (await prompt.count()) await prompt.getByRole('button', { name: 'Got it', exact: true }).click();
      await page.getByRole('button', { name: 'End first ride', exact: true }).click();
      const handoff = page.getByTestId('transfer-handoff'); await handoff.waitFor();
      const next = await persisted(); assert.equal(next.ride, null); assert(next.handoff.ready);
      assert.equal(next.handoff.onward.destination.text, 'Orange / Willow');
      assert.match(await handoff.innerText(), /The bus could reach pickup before you do/);
      await state('second-pickup'); await checkWidth();
      await page.screenshot({ path: `${out}/handoff-${width}.png`, fullPage: true });
      await page.reload(); await handoff.waitFor(); assert.deepEqual((await persisted()).handoff, next.handoff);
      await page.waitForFunction(() => window.__transferGeoWatchCount() > 0);
      await page.evaluate(point => window.__transferMoveTo(point), feed.stop_coords[next.handoff.onward.next.boardStopId]);
      await handoff.getByText('You are near the pickup.', { exact: true }).waitFor();
      assert(!/The bus could reach pickup before you do/.test(await handoff.innerText()));
      const secondDiagnostic = await feedback(); assert(secondDiagnostic.tripDetail); assert.equal(secondDiagnostic.rows.length, 1);
      assert.equal(secondDiagnostic.rows[0].route, 'Orange Day');
      await handoff.getByRole('button', { name: /Remind me/ }).click();
      await handoff.getByLabel('Reminder timing', { exact: true }).selectOption('minutes');
      await handoff.getByLabel('Minutes before pickup', { exact: true }).selectOption('15');
      await handoff.getByRole('button', { name: 'Set reminder', exact: true }).click(); await page.clock.runFor(100);
      assert.equal((await page.evaluate(() => window.__transferNotifications)).length, 1);
      assert.match((await page.evaluate(() => window.__transferNotifications))[0].body, /Orange Day/);
      await handoff.getByRole('button', { name: /I.m on/ }).first().click();
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      const ride2 = (await persisted()).ride;
      assert.equal(ride2.routeLabel, 'Orange Day'); assert(!ride2.onward); assert.equal(ride2.toText, 'Orange / Willow');
      assert.equal((await persisted()).handoff, null);
      await state('second-ride');
      await page.reload(); await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      assert.deepEqual((await persisted()).ride, ride2);
      if (await prompt.count()) await prompt.getByRole('button', { name: 'Got it', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await state('finished'); await checkWidth(); assert.equal((await persisted()).ride, null);
      assert.match(await page.locator('body').innerText(), /Orange \/ Willow/);
      // Closed-page age recovery retains the destination but requires the
      // rider to confirm the transition before any second-pickup control.
      await page.evaluate(ride => {
        const at = Date.now() - 2 * 3600_000;
        localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: at, onward: { ...ride.onward, plannedAtMs: at } }));
      }, ride1);
      await page.reload(); await handoff.waitFor();
      assert.match(await handoff.innerText(), /position at the transfer stop is unconfirmed/);
      assert.equal(await handoff.getByRole('button', { name: /I.m on|Remind me/ }).count(), 0);
      await state('expired-first-ride'); await handoff.getByRole('button', { name: 'Continue to next pickup', exact: true }).click();
      await handoff.getByRole('button', { name: /Remind me/ }).waitFor();
      await page.reload(); await handoff.waitFor(); assert((await persisted()).handoff.ready);
      await handoff.getByRole('button', { name: 'End this trip', exact: true }).click();
      assert.equal((await persisted()).handoff, null);
      // A live vehicle loss retires tracking only after the existing absence
      // cap, and must not infer that the first exit was reached.
      await page.evaluate(ride => {
        const at = Date.now();
        localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: at, onward: { ...ride.onward, plannedAtMs: at } }));
      }, ride1);
      await page.reload(); await page.getByTestId('transfer-onward-banner').waitFor();
      phase = 'missing'; missedBus = ride1.busName.replace(/^#/, ''); await poll();
      assert.equal(await handoff.count(), 0);
      const absentResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
      await page.clock.fastForward(10 * 60_000 + 5000);
      await waitForResponseBody(page, await absentResponse); await page.clock.runFor(100);
      await handoff.waitFor(); assert.match(await handoff.innerText(), /You may still be on board/);
      assert.equal(await handoff.getByRole('button', { name: /I.m on|Remind me/ }).count(), 0);
      await state('missing-first-ride-auto-end'); phase = 'fresh'; await poll();
      await handoff.getByRole('button', { name: 'Continue to next pickup', exact: true }).click();
      await handoff.getByRole('button', { name: 'Find another route', exact: true }).click();
      await page.getByTestId('map-trip-panel').waitFor();
      assert.equal(await detail.count(), 0); assert.equal((await persisted()).handoff, null);
      assert.match(await page.locator('body').innerText(), /Orange \/ Willow/);
      assert.equal((await persisted()).selection, null);
      // Explicit future planning has typical waits, no live bus names or
      // boarding/reminder actions, and can return to live mode.
      const current = await page.evaluate(() => Date.now());
      const later = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(current + 3600_000)).replace(' ', 'T');
      await page.evaluate(({ from, to, current, later }) => {
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Future diagnostic origin', fromLL: from,
          toText: 'Orange / Willow', toLL: to, tripTime: later, tripTimeSetAt: current, expandedKey: null, savedAt: current }));
      }, { from, to, current, later });
      await page.reload(); await page.getByTestId('map-trip-panel').waitFor();
      if (await show.count()) await show.click();
      await choose.waitFor(); await choose.click(); await detail.waitFor();
      assert.match(await detail.innerText(), /Typical trip/); assert(!/#\d+/.test(await detail.innerText()));
      assert.equal(await detail.getByRole('button', { name: /I.m on|Remind me/ }).count(), 0);
      assert.match(await detail.innerText(), /Runs/); await state('future-typical'); await checkWidth();
      await detail.getByRole('button', { name: 'Plan for now to use live boarding and reminders', exact: true }).click();
      await page.getByTestId('map-trip-panel').waitFor(); assert.equal(await detail.count(), 0);
      assert.deepEqual(errors, []);
      results.push({ width, checks: ['Actual route pair selected with keyboard', 'Only current leg has boarding/reminder controls',
        'First ride, handoff, and second ride each survive refresh', 'Final destination survives both rides; normal completion', 'Both buses lost/returned independently; failed poll withholds timing',
        'Pickup reminders use current leg and selected lead', 'Expired and missing first ride require an explicit onward action', 'Replanning clears stale transfer selection and retains final destination', 'Future mode uses typical waits and requires Plan for now before boarding', 'Feedback captures both public legs and current pickup without the rider address'], states, errors });
    } catch (error) {
      if (page) {
        await fs.writeFile(`${out}/failure-${width}.txt`, await page.locator('body').innerText().catch(() => ''));
        await page.screenshot({ path: `${out}/failure-${width}.png`, fullPage: true }).catch(() => {});
        await fs.writeFile(`${out}/failure-state-${width}.json`, JSON.stringify({ states, errors }, null, 2));
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
  if (published) assert.equal(await health(), build);
  await fs.writeFile(out + '/asset-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(out + '/result.json', JSON.stringify({ ok: !failure, build, results, error: failure?.stack }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ ok: true, build, cases: results.length, out }));
