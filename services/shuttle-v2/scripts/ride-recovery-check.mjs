// Bounded built-SPA checks. Run from services/shuttle-v2 under heavy.lock.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
let mode = 'fresh', remaining = 5, requests = 0;
function payload() {
  const index = (exit - remaining + seq.length) % seq.length;
  const buses = mode === 'empty' ? [] : [{ bus_name: '307', bus_id: 1, route_id: 3, ...feed.stop_coords[seq[index]], last_stop_id: seq[index], heading: 180, observed_at: now }];
  const rows = [];
  for (let h = 1; h <= seq.length * 2; h++) rows.push([0, seq[(index + h) % seq.length], h * 90, h * 90 - 30, h * 90 + 90, h, 0, h * 90 - 30, h * 90 - 30]);
  return { ...feed, buses, server_eta: mode === 'missing' ? undefined : { v: 2, at: now, servedAt: now + (mode === 'stale' ? 60000 : 0), buses: [['307', 'Red', index, null]], rows } };
}
const report = { scope: 'Actual built SPA, persisted physical ride and synthetic wire on the checked-in route network', probe, states: [], checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let context, page;
try {
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
  async function poll() { await page.clock.runFor(5500); await page.waitForTimeout(100); }
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
  remaining = 0; await poll(); assert.match(await dialog().innerText(), /Get off here/);
  report.checks.push('Approach updates through two/one/zero stops; focus enters prompt and Tab stays inside');
  await state('here');
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
  assert.match(await page.locator('body').innerText(), /Destination east of Union Station/);
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
