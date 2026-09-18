/** Bounded built-SPA weather regression. All traffic is intercepted; run from
 * services/shuttle-v2 after building web, under the shared heavy lock.
 * OUT selects a fresh evidence directory; --baseline records old semantics. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const service = process.cwd();
const {chromium} = createRequire(service + '/package.json')('playwright-core');
const {seedTestId} = await import(service + '/scripts/testId.mjs');
const out = process.env.OUT || path.join(service, 'pr-preview', 'weather-controls');
const baseline = process.argv.includes('--baseline');
const desktop = process.env.DESKTOP === '1';
const now = Date.parse('2026-09-18T16:10:00Z');
const hour = 3600000;
const start = Math.floor(now / hour) * hour;
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.buses = [];
let scenario = 'dry', pending;
const weather = () => ({available: true, fetchedAtMs: now, hourly: Array.from({length: scenario === 'single' ? 1 : 10}, (_, i) => ({
  timeMs: start + i * hour, probability: scenario === 'wet' ? 85 : scenario === 'rain-only' ? 45 : 0,
  ...(scenario === 'rain-only' ? {} : {temperatureF: 68 + i, weatherCode: 0}),
}))});
const report = {source: 'Actual built SPA, fixed clock and intercepted local fixtures', baseline, checks: [], errors: [], snapshots: {}, geometry: []};
await fs.mkdir(out, {recursive: true});
const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
let ctx, page;
try {
  ctx = await browser.newContext({viewport: {width: desktop ? 1280 : 390, height: 844}, isMobile: !desktop, hasTouch: !desktop, serviceWorkers: 'block', timezoneId: 'America/New_York'});
  await seedTestId(ctx);
  await ctx.addInitScript(() => { try { localStorage.setItem('listView', 'trip'); } catch {} });
  await ctx.addInitScript(() => {
    sessionStorage.removeItem('shuttle-trip-draft');
    localStorage.removeItem('shuttle-recent-trips');
    const code = Number(new URL(location.href).searchParams.get('geo') || 1);
    const fail = cb => queueMicrotask(() => cb?.({code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'Fixture location failure'}));
    window.geoCalls = [];
    Object.defineProperty(navigator, 'geolocation', {value: {
      watchPosition(ok, err, options) { window.geoCalls.push({action: 'watch', options}); fail(err); return 1; },
      clearWatch() {},
      getCurrentPosition(ok, err, options) { window.geoCalls.push({action: 'request', options}); fail(err); },
    }});
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.clock.install({time: now});
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'shuttle.test') return route.abort();
    if (u.pathname === '/api/buses') return route.fulfill({json: feed});
    if (u.pathname === '/api/weather') {
      if (scenario === 'pending') { pending = route; return; }
      if (scenario === 'failed') return route.fulfill({status: 503, json: {}});
      if (scenario === 'missing') return route.fulfill({json: {available: false}});
      if (scenario === 'expired') return route.fulfill({json: {available: true, hourly: [{timeMs: start - 2 * hour, probability: 90}]}});
      return route.fulfill({json: weather()});
    }
    if (u.pathname === '/api/geocode') return route.fulfill({json: {results: [{display_name: 'Sterling Memorial Library', lat: 41.3113, lon: -72.9288, class: 'amenity', type: 'library'}, {display_name: 'Sterling Hall of Medicine', lat: 41.3037, lon: -72.9322, class: 'amenity', type: 'library'}]}});
    if (u.pathname.startsWith('/api/')) return route.fulfill({json: {results: [], reports: [], routes: []}});
    const file = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({body: await fs.readFile((process.env.DIST_ROOT || service + '/web/dist') + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}); }
    catch { return route.fulfill({status: 404}); }
  });
  const unit = () => page.getByRole('button', {name: /^Show temperature in/});
  const line = () => unit().locator('..').locator('button').first();
  const panel = () => page.getByRole('region', {name: 'Hourly weather forecast', exact: true});
  const focused = async locator => assert(await locator.evaluate(e => e === document.activeElement), 'expected focused control');
  async function load(mode) {
    scenario = mode;
    await page.goto('https://shuttle.test', {waitUntil: 'domcontentloaded'});
    await page.getByRole('combobox', {name: 'To', exact: true}).waitFor();
    if (!['missing', 'expired', 'failed', 'pending'].includes(mode)) await unit().waitFor();
  }

  for (const [code, expected] of [[1, 'Location permission denied'], [2, 'Location unavailable'], [3, 'Location request timed out']]) {
    scenario = 'dry';
    await page.goto('https://shuttle.test/?geo=' + code, {waitUntil: 'domcontentloaded'});
    await unit().waitFor();
    await page.getByRole('button', {name: 'Union Station', exact: true}).click();
    const toSummary = page.getByRole('button', {name: /^To 🏁/});
    const fromSummary = page.getByRole('button', {name: /^From 📍/});
    await toSummary.waitFor(); await fromSummary.waitFor();
    await fromSummary.focus(); await page.keyboard.press('Enter');
    const from = page.getByRole('combobox', {name: 'From', exact: true});
    await from.waitFor();
    await from.press('ArrowDown'); await from.press('Enter');
    await page.getByText(new RegExp(expected)).waitFor();
    assert.equal(await page.getByText('Getting your location…', {exact: true}).count(), 0);
    assert(!(await fromSummary.innerText()).includes('Locating'));
    await fromSummary.focus(); await page.keyboard.press('Space'); await from.waitFor();
    await from.fill('Sterling'); await page.clock.runFor(400);
    await page.getByRole('option').nth(1).waitFor();
    await from.press('ArrowDown'); await from.press('Enter');
    await page.getByRole('button', {name: /^From 📍 Sterling Memorial Library/}).waitFor();
    assert.equal(await page.getByText(new RegExp(expected)).count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')).fromLL), {lat: 41.3113, lon: -72.9288});
    assert.equal(await page.getByText('Getting your location…', {exact: true}).count(), 0);
    report.checks.push(expected + ': explicit current-location request settles; typed From selects correct coordinates and clears stale error/spinner');
    // This selected destination exercises the non-input weather focus fallback.
    const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    await unit().focus(); scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
    await focused(toSummary);
    const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
    assert.deepEqual(after.fromLL, draft.fromLL); assert.deepEqual(after.toLL, draft.toLL);
    report.checks.push('Weather removal restores selected To summary without changing either endpoint, location case ' + code);
    await page.waitForTimeout(500);
  }
  await page.clock.setSystemTime(now); await load('dry');
  await line().click(); await panel().focus();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
  const left = await panel().evaluate(e => e.scrollLeft);
  await page.clock.fastForward(600001); await page.waitForTimeout(150);
  await focused(panel()); assert.equal(await panel().evaluate(e => e.scrollLeft), left);
  report.checks.push('Ordinary weather refresh preserves strip focus and horizontal scroll');
  const map = page.getByRole('button', {name: 'map', exact: true});
  await map.focus(); await page.keyboard.press('Enter');
  scenario = 'missing'; await page.clock.fastForward(600001); await focused(map);
  const trip = page.getByRole('button', {name: 'trip', exact: true});
  await trip.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(150); await focused(trip);
  report.checks.push('Leaving and reopening Trip does not steal focus from navigation');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = String(error);
  if (page && !page.isClosed()) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
  throw error;
} finally {
  if (pending) await pending.abort().catch(() => {});
  if (page) await page.close().catch(() => {});
  if (ctx) await ctx.close();
  await browser.close(); report.closed = true;
  await fs.writeFile(out + '/report.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
