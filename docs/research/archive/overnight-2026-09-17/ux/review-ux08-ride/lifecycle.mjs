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
    window.Notification = class { static permission = 'denied'; constructor(title) { window.testNotifications.push(title); } };
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

  const finish = page.getByRole('region', { name: 'Finish your trip' });
  const refresh = page.getByRole('button', { name: /Refresh/ }).first();
  await page.goto('https://ride.test'); await done().waitFor();
  for (const previousFocus of ['body', 'done', 'refresh']) {
    mode = 'fresh'; remaining = previousFocus === 'body' ? 1 : 5;
    await page.evaluate(({ ride }) => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() - 2 * 3600000 + 30000 })), { ride });
    await page.reload(); await done().waitFor();
    if (previousFocus !== 'body') {
      await page.getByText(/5 stops/).first().waitFor();
      await (previousFocus === 'done' ? done() : refresh).focus();
      remaining = 1; await poll();
    }
    await dialog().waitFor();
    assert.match(await dialog().innerText(), /Get off at the next stop/);
    assert.equal(await dialog().getAttribute('aria-describedby'), 'get-off-prompt-description');
    assert.equal(await page.locator('#get-off-prompt-title').getAttribute('aria-live'), 'polite');
    assert.match(await page.locator('#get-off-prompt-description').innerText(), /Red #307.*Union Station/);
    assert.equal((await page.evaluate(() => window.testNotifications)).length, 0);
    await page.clock.runFor(35000); await page.waitForTimeout(100); await finish.waitFor();
    assert.equal(await dialog().count(), 0);
    assert.equal(await done().count(), 0);
    if (previousFocus === 'refresh') assert(await refresh.evaluate(e => e === document.activeElement), 'popup cleanup restores the surviving pre-dialog focus on automatic ending');
    else assert(await finish.evaluate(e => e === document.activeElement), 'popup cleanup and finish effect cooperate when prior focus disappears');
    await state('automatic end with dialog and previous ' + previousFocus);
    await refresh.focus();
    await finish.getByRole('button', { name: 'Dismiss', exact: true }).evaluate(e => e.click());
    assert(await refresh.evaluate(e => e === document.activeElement), 'programmatic dismissal preserves external focus');
  }
  // A ride can end after the bus has disappeared while the prompt is still open.
  remaining = 1; mode = 'fresh';
  await page.evaluate(({ ride }) => localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...ride, startedAt: Date.now() })), { ride });
  await page.reload(); await dialog().waitFor();
  mode = 'empty'; await poll();
  assert.match(await dialog().innerText(), /Live stop position unavailable/);
  await page.clock.runFor(605000); await page.waitForTimeout(100); await finish.waitFor();
  assert.match(await finish.innerText(), /missing from live updates for 10 min/);
  assert.match(await finish.innerText(), /You may still be on board/);
  assert(await finish.evaluate(e => e === document.activeElement));
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle-boarded-ride')), null);
  await state('bus-gone ends open unavailable prompt with honest recovery');
  // Missing final coordinates still leave a useful focusable section and replan.
  mode = 'fresh'; remaining = 5;
  await page.evaluate(({ ride }) => {
    const { toText, toLat, toLon, ...withoutDestination } = ride;
    localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ ...withoutDestination, startedAt: Date.now() }));
  }, { ride });
  await page.reload(); await done().waitFor(); await done().focus(); await page.keyboard.press('Space');
  await finish.waitFor(); assert(await finish.evaluate(e => e === document.activeElement));
  assert.equal(await finish.getByRole('link').count(), 0);
  await page.keyboard.press('Tab');
  assert(await finish.getByRole('button', { name: 'Find another shuttle', exact: true }).evaluate(e => e === document.activeElement));
  await page.keyboard.press('Space');
  assert(await page.getByRole('button', { name: /^trip$/i }).evaluate(e => e === document.activeElement));
  assert.equal(await finish.count(), 0);
  await state('no destination finish remains keyboard reachable');
  report.checks.push('Denied notification permission retains live prompt with route/bus/exit and linked dynamic description');
  report.checks.push('Age ending with an open prompt restores the appropriate target for body/Done/Refresh ownership');
  report.checks.push('Bus-gone ending removes unavailable prompt, preserves destination and focuses recovery');
  report.checks.push('External finish dismissal does not steal focus; absent destination retains keyboard replan');
  assert.deepEqual(report.errors, []); report.completed = true;
} finally {
  if (!report.completed && page) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
  if (page) await page.close(); if (context) await context.close(); await browser.close();
  report.resourcesClosed = true; report.requests = requests;
  await fs.writeFile(out + '/ride-recovery.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ completed: report.completed, resourcesClosed: report.resourcesClosed, checks: report.checks, errors: report.errors }, null, 2));
