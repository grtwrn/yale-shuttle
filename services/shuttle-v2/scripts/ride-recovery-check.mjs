// Bounded built-SPA checks. Run from services/shuttle-v2 under heavy.lock.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const service = process.cwd(), out = process.env.OUT, probe = process.env.PROBE === '1';
if (!out) throw new Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = feed.routes['3'], exit = seq.indexOf(121);
const ride = { routeLabel: 'Red', color: '#e53935', busName: '307', boardStopId: 48, alightStopId: 121, startedAt: now,
  toText: 'Destination east of Union Station with a long building name', toLat: feed.stop_coords[121].lat, toLon: feed.stop_coords[121].lon + .0017 };
let mode = 'fresh', remaining = 5, requests = 0, exitOffset = 0, servedNow = now;
function payload() {
  const index = (exit - remaining + seq.length) % seq.length;
  const buses = mode === 'empty' ? [] : [{ bus_name: '307', bus_id: 1, route_id: 3, ...feed.stop_coords[seq[index]], lat: feed.stop_coords[seq[index]].lat + exitOffset, last_stop_id: seq[index], heading: 180, observed_at: servedNow }];
  const rows = [];
  for (let h = 1; h <= seq.length * 2; h++) rows.push([0, seq[(index + h) % seq.length], h * 90, h * 90 - 30, h * 90 + 90, h, 0, h * 90 - 30, h * 90 - 30]);
  return { ...feed, buses, server_eta: mode === 'missing' ? undefined : { v: 2, at: servedNow, servedAt: servedNow + (mode === 'stale' ? 60000 : 0), buses: [['307', 'Red', index, null]], rows } };
}
const report = { scope: 'Actual built SPA, persisted physical ride and synthetic wire on the checked-in route network', probe, states: [], checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let context, page;
try {
  await checkPositionWithoutForecast();
  context = await browser.newContext({ viewport: { width: process.env.DESKTOP ? 1280 : 390, height: 844 }, isMobile: !process.env.DESKTOP, hasTouch: !process.env.DESKTOP, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await seedTestId(context);
  await context.addInitScript(({ ride }) => {
    if (!sessionStorage.getItem('ride-fixture-seeded')) {
      localStorage.setItem('shuttle-boarded-ride', JSON.stringify(ride));
      sessionStorage.setItem('ride-fixture-seeded', 'yes');
    }
    window.testNotifications = [];
    window.Notification = class { static permission = 'granted'; constructor(title) { window.testNotifications.push(title); } };
    navigator.vibrate = () => true;
  }, { ride });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.clock.install({ time: new Date(now) });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'ride.test') return route.abort();
    if (url.pathname === '/api/buses') { requests++; return mode === 'failed' ? route.fulfill({ status: 503 }) : route.fulfill({ json: payload() }); }
    if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + name), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  const dialog = () => page.getByRole('alertdialog');
  const done = () => page.getByRole('button', { name: 'Done', exact: true });
  async function poll() {
    servedNow = await page.evaluate(() => Date.now());
    const before = requests;
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
    await advanceUntilResponse(page, before, () => requests, ms => { servedNow += ms; });
    await waitForResponseBody(page, await response);
    await page.clock.runFor(100);
  }
  async function state(name) {
    const result = { name, dialog: await dialog().count() ? await dialog().innerText() : null, focus: await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent?.slice(0, 100) })), body: await page.locator('body').innerText(), notifications: await page.evaluate(() => window.testNotifications) };
    report.states.push(result); return result;
  }
  await page.goto('https://ride.test'); await done().waitFor(); await page.getByText(/5 stops/).first().waitFor();
  assert.equal(await dialog().count(), 0);
  await done().focus(); remaining = 2; await poll(); await dialog().waitFor();
  assert.match(await dialog().innerText(), /Get off in 2 stops/);
  assert(await page.getByRole('button', { name: 'Got it', exact: true }).evaluate(e => e === document.activeElement));
  for (const key of ['Tab', 'Shift+Tab']) { await page.keyboard.press(key); assert(await page.getByRole('button', { name: 'Got it', exact: true }).evaluate(e => e === document.activeElement)); }
  remaining = 1; await poll(); assert.match(await dialog().innerText(), /Get off at the next stop/);
  remaining = 0; exitOffset = .0017; await poll();
  assert.match(await dialog().innerText(), /Watch for your stop/);
  assert.match(await page.locator('body').innerText(), /Watch for Union Station/);
  assert(!/Get off here|Arriving at Union Station/.test(await page.locator('body').innerText()));
  await state('off-pole-approach');
  await page.screenshot({ path: out + '/off-pole-approach.png' });
  exitOffset = 0; await poll(); assert.match(await dialog().innerText(), /Get off here/);
  exitOffset = .0017; await poll(); assert.match(await dialog().innerText(), /Watch for your stop/);
  exitOffset = 0; await poll(); assert.match(await dialog().innerText(), /Get off here/);
  report.checks.push('Two/one/zero stops retain early warning; off-pole zero asks the rider to watch for the stop, near exit says here, and an open prompt follows both directions without another notification; focus stays inside');
  await state('here');
  // Restoring an already-boarded ride at the off-pole anchor must also use
  // the cautious wording in the initial system notification, not only the
  // updated in-page prompt. Arrival updates the prompt without another buzz.
  exitOffset = .0017; await page.reload(); await dialog().waitFor();
  assert.match(await dialog().innerText(), /Watch for your stop/);
  assert.deepEqual(await page.evaluate(() => window.testNotifications), ['Watch for your stop']);
  exitOffset = 0; await poll(); assert.match(await dialog().innerText(), /Get off here/);
  assert.equal((await page.evaluate(() => window.testNotifications)).length, 1);
  report.checks.push('Restored off-pole ride sends a cautious system notification; actual near-stop arrival updates the prompt without a second notification');
  mode = 'stale'; await poll(); const stale = await state('stale');
  await page.screenshot({ path: out + '/stale-prompt.png', fullPage: false });
  if (!probe) { assert.match(stale.dialog, /Live stop position unavailable/); assert(!/Get off here/.test(stale.dialog)); assert.match(stale.dialog, /Check the stop signs/); }
  mode = 'missing'; await poll(); const missing = await state('missing');
  if (!probe) assert.match(missing.dialog, /Live stop position unavailable/);
  mode = 'empty'; await poll(); const empty = await state('empty');
  if (!probe) assert.match(empty.dialog, /Live stop position unavailable/);
  mode = 'fresh'; remaining = 5; await poll(); const farther = await state('farther');
  if (!probe) assert.match(farther.dialog, /Your stop is 5 stops away/);
  remaining = 1; await poll(); assert.match(await dialog().innerText(), /Get off at the next stop/);
  assert.equal((await page.evaluate(() => window.testNotifications)).length, 1);
  await page.keyboard.press('Escape'); assert.equal(await dialog().count(), 0); assert(await done().evaluate(e => e === document.activeElement));
  report.checks.push(probe ? 'Recorded stale/missing/empty/farther prompt behavior without candidate assertions' : 'Open prompt follows missing/stale/empty/recovered and farther-away evidence; one notification only; Escape returns to Done');
  // Restored rides may prompt before there is a focused control to return to.
  await page.reload(); await dialog().waitFor();
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
  if (process.env.DESKTOP) await gotIt.click(); else await gotIt.tap();
  const restored = await state('restored-dismiss');
  if (!probe) assert(await done().evaluate(e => e === document.activeElement));
  // A programmatic/assistive focus move outside the dialog must not be undone.
  remaining = 5; await page.reload(); await done().waitFor(); await page.getByText(/5 stops/).first().waitFor();
  await done().focus(); remaining = 2; await poll(); await dialog().waitFor();
  const refresh = page.getByRole('button', { name: /Refresh/ }).first(); await refresh.focus();
  await page.getByRole('button', { name: 'Got it', exact: true }).evaluate(e => e.click());
  const external = await state('external-dismiss');
  if (!probe) assert(await refresh.evaluate(e => e === document.activeElement));
  report.checks.push(probe ? 'Recorded restored and external dismissal focus without candidate assertions' : 'Restored prompt dismissal has a persistent focus target; external focus is preserved');
  // A failed poll eventually expires the retained track; it must not keep an imperative.
  remaining = 1; await page.reload(); await dialog().waitFor(); mode = 'failed'; await page.clock.runFor(50000); await page.waitForTimeout(100);
  const failed = await state('failed-expired');
  if (!probe) assert.match(failed.dialog, /Live stop position unavailable/);
  mode = 'fresh'; await poll(); assert.match(await dialog().innerText(), /Get off at the next stop/);
  for (const width of process.env.DESKTOP ? [1280, 640] : [360, 390, 430, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const box = await page.getByRole('button', { name: 'Got it', exact: true }).boundingBox(); assert(box.height >= 44 && box.width >= 44);
  }
  await page.screenshot({ path: out + '/recovered-prompt.png' });
  await page.keyboard.press('Escape'); await done().focus(); await page.keyboard.press('Enter');
  const finish = page.getByRole('region', { name: 'Finish your trip' }); await finish.waitFor();
  const walking = new URL(await finish.getByRole('link', { name: /Walking directions/ }).getAttribute('href'));
  assert.equal(walking.searchParams.get('destination'), `${ride.toLat},${ride.toLon}`); assert(!walking.searchParams.has('origin'));
  await state('finish');
  if (!probe) assert(await finish.evaluate(e => e === document.activeElement), 'Done moves focus to the final trip actions');
  await page.screenshot({ path: out + '/ride-finish.png', fullPage: false });
  await finish.getByRole('button', { name: 'Dismiss', exact: true }).focus(); await page.keyboard.press('Enter');
  if (!probe) assert(await page.locator('nav [aria-current="page"]').evaluate(e => e === document.activeElement), 'Dismiss returns focus to the current view');
  async function restoreRide(ageMs = 0) {
    await page.evaluate(({ ride, ageMs }) => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() - ageMs })), { ride, ageMs });
    remaining = 5; await page.reload(); await done().waitFor(); await page.getByText(/5 stops/).first().waitFor();
  }
  await restoreRide(); await done().focus(); await page.keyboard.press('Enter'); await finish.waitFor();
  await finish.getByRole('button', { name: 'Find another shuttle', exact: true }).focus(); await page.keyboard.press('Enter');
  if (!probe) assert(await page.getByRole('button', { name: /^trip$/i }).evaluate(e => e === document.activeElement), 'Find another shuttle returns focus to Trip');
  assert.equal(await finish.count(), 0);
  // Replanning commits asynchronously after the Trip tab receives focus.
  // The chosen destination is a compact button until the rider edits it.
  const destination = page.getByRole('button', { name: /^To 🏁 Destination east of Union Station/ });
  await destination.waitFor();
  assert((await destination.innerText()).includes(ride.toText));
  // Automatic ride endings must preserve a surviving control's focus.
  await restoreRide(2 * 3600000 - 15000); await refresh.focus(); await page.clock.runFor(20000); await page.waitForTimeout(100); await finish.waitFor();
  assert.match(await finish.innerText(), /Tracking stopped after 2 hours/);
  assert(await refresh.evaluate(e => e === document.activeElement), 'automatic ending preserves surviving external focus');
  await state('auto-end-external');
  await restoreRide(2 * 3600000 - 15000); await done().focus(); await page.clock.runFor(20000); await page.waitForTimeout(100); await finish.waitFor();
  if (!probe) assert(await finish.evaluate(e => e === document.activeElement), 'automatic ending restores focus lost with the ride');
  await state('auto-end-owned');
  // Loading and unusable initial snapshots must not fire a get-off prompt.
  for (const initial of ['missing', 'stale', 'empty']) {
    mode = initial;
    await page.evaluate(({ ride }) => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() })), { ride });
    remaining = 1; await page.reload(); await done().waitFor(); await poll();
    assert.equal(await dialog().count(), 0); assert.equal((await page.evaluate(() => window.testNotifications)).length, 0);
    assert(!/Arriving at|Get off NEXT|Get off in 2/.test(await page.locator('body').innerText()));
    await state('initial-' + initial);
  }
  mode = 'fresh'; await poll(); await dialog().waitFor(); assert.match(await dialog().innerText(), /Get off at the next stop/);
  // A ride can return to Map as well as Trip; replan still chooses Trip.
  await page.keyboard.press('Escape'); await done().click(); await finish.waitFor();
  await page.getByRole('button', { name: /^map$/i }).click();
  await finish.getByRole('button', { name: 'Dismiss', exact: true }).focus(); await page.keyboard.press('Enter');
  if (!probe) assert(await page.getByRole('button', { name: /^map$/i }).evaluate(e => e === document.activeElement));
  await restoreRide(); await done().click(); await finish.waitFor();
  await finish.getByRole('button', { name: 'Find another shuttle', exact: true }).focus(); await page.keyboard.press('Enter');
  if (!probe) assert(await page.getByRole('button', { name: /^trip$/i }).evaluate(e => e === document.activeElement));
  report.checks.push('Failed feed expires, recovery retains one-shot behavior, mobile/reflow controls fit, final destination survives Done');
  report.checks.push(probe ? 'Recorded finish and automatic-end focus without candidate assertions' : 'Done/Dismiss/replan/automatic end maintain focus without stealing surviving external focus');
  report.checks.push('Initial missing/stale/empty snapshots do not instruct getting off; recovery prompts; touch dismissal and Map-to-Trip finish paths exercised');
  assert.deepEqual(report.errors, []); report.completed = true;
} finally {
  if (!report.completed && page) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
  if (page) await page.close(); if (context) await context.close(); await browser.close();
  report.resourcesClosed = true; report.requests = requests;
  await fs.writeFile(out + '/ride-recovery.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ completed: report.completed, resourcesClosed: report.resourcesClosed, checks: report.checks, errors: report.errors }, null, 2));

async function checkPositionWithoutForecast() {
  const fixture = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/ride-position-without-eta-20261025.json', 'utf8'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const original = fixture.snapshots.map(snapshot => {
    const r = snapshot.response, packed = Buffer.from(r.body, 'base64'), raw = gunzipSync(packed);
    assert.equal(packed.length, r.gzipBytes); assert.equal(digest(packed), r.gzipSHA256);
    assert.equal(raw.length, r.decodedBytes); assert.equal(digest(raw), r.decodedSHA256);
    const keys = ['v', 'runId', 'route', 'sourceKind', 'receivedAt', 'status', 'headers', 'decodedBytes', 'decodedSHA256', 'gzipBytes', 'gzipSHA256'];
    assert.equal(digest(JSON.stringify(Object.fromEntries(keys.map(k => [k, r[k]])))), r.id);
    const header = JSON.parse(r.headers['x-shuttle-snapshot']);
    assert.equal(header.sha256, digest(raw)); assert.equal(header.bytes, raw.length);
    return { ...snapshot, raw, feed: JSON.parse(raw) };
  });
  const expected = 'Bus location available · arrival estimate unavailable';
  for (const mode of ['original-gps-only', 'second-original-gps-only', 'missing-gps', 'old-gps', 'future-gps', 'wrong-route', 'whole-eta-missing', 'expired-position']) {
    const initial = original[mode === 'second-original-gps-only' ? 1 : 0];
    let current = initial, failed = false;
    const ctx = await browser.newContext({ viewport: { width: process.env.DESKTOP ? 1280 : 390, height: 844 },
      isMobile: !process.env.DESKTOP, hasTouch: !process.env.DESKTOP, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    let p;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(ride => {
        localStorage.setItem('shuttle-boarded-ride', JSON.stringify(ride));
        window.testNotifications = [];
        window.Notification = class { static permission = 'granted'; constructor(title) { window.testNotifications.push(title); } };
        navigator.vibrate = () => true;
      }, fixture.ride);
      p = await ctx.newPage(); p.setDefaultTimeout(8000);
      p.on('pageerror', e => report.errors.push(e.message));
      await p.clock.install({ time: new Date(initial.response.receivedAt) });
      await p.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'position.test') return route.abort();
        if (url.pathname === '/api/buses') {
          if (failed) return route.fulfill({ status: 503 });
          let raw = current.raw;
          if (current === initial && !mode.includes('original') && mode !== 'expired-position') {
            const feed = structuredClone(current.feed), bus = feed.buses.find(b => b.bus_name === '#44');
            if (mode === 'missing-gps') feed.buses = feed.buses.filter(b => b !== bus);
            if (mode === 'old-gps') bus.observed_at = feed.server_eta.servedAt - 45000;
            if (mode === 'future-gps') bus.observed_at = feed.server_eta.servedAt + 5001;
            if (mode === 'wrong-route') bus.route_id = 3;
            if (mode === 'whole-eta-missing') { Object.assign(bus, feed.stop_coords[106]); delete feed.server_eta; }
            raw = Buffer.from(JSON.stringify(feed));
          }
          return route.fulfill({ body: raw, contentType: 'application/json' });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
        const name = url.pathname === '/' ? '/index.html' : url.pathname;
        try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + name), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      await p.goto('https://position.test'); await p.getByRole('button', { name: 'Done', exact: true }).waitFor();
      await p.clock.runFor(100);
      if (mode === 'expired-position') { failed = true; await p.clock.runFor(46000); }
      const text = await p.locator('body').innerText();
      report.states.push({ name: 'position-' + mode, body: text, originalResponseID: initial.response.id,
        sourceClockUnmodified: true, syntheticVariation: !mode.includes('original') });
      if (mode === 'original-gps-only') await p.screenshot({ path: out + '/position-without-forecast.png' });
      const available = mode.includes('original') || mode === 'whole-eta-missing';
      if (!probe) assert(text.includes(available ? expected : 'Looking for your bus…'), mode + ': ' + text.split('\n')[0]);
      assert(!/Get off NEXT|Get off in 2|Arriving at |Get off here/.test(text));
      assert.equal(await p.getByRole('alertdialog').count(), 0);
      assert.deepEqual(await p.evaluate(() => window.testNotifications), []);
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (mode === 'original-gps-only') {
        if (!process.env.DESKTOP) {
          for (const width of [320, 360, 430]) {
            await p.setViewportSize({ width, height: 844 });
            assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const doneBox = await p.getByRole('button', { name: 'Done', exact: true }).boundingBox();
            assert(doneBox.width >= 44 && doneBox.height >= 44);
            if (width === 320) await p.screenshot({ path: out + '/position-without-forecast-320.png' });
          }
        }
        current = original[2]; await p.clock.setFixedTime(new Date(current.response.receivedAt));
        const response = p.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await p.clock.runFor(5100); await waitForResponseBody(p, await response); await p.clock.runFor(100);
        const recovered = await p.locator('body').innerText();
        assert(recovered.includes('8 stops · 14 min')); assert(!recovered.includes(expected));
        report.states.push({ name: 'position-original-recovery', body: recovered, originalResponseID: current.response.id, sourceClockUnmodified: true });
      }
    } finally { if (p) await p.close(); await ctx.close(); }
  }
  report.checks.push('Original Blue Night GPS-only bodies distinguish position from ETA loss; a later original body restores8stops. Missing/stale/future/wrong-route/expired GPS never claims a current position; no missing ETA state instructs getting off.');
}
