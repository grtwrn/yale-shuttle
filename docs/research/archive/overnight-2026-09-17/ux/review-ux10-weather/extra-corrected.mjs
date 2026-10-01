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
  await load('dry');
  // The hidden retained strip must not be reachable from the unit switch.
  await unit().focus(); await page.keyboard.press('Tab');
  assert(!(await page.evaluate(() => document.activeElement?.id === 'trip-weather-hours')));
  assert.equal(await page.locator('#trip-weather-hours').getAttribute('hidden'), '');
  report.checks.push('Collapsed controlled region remains hidden and outside Tab sequence');
  // Whole-panel removal while the scroll container owns focus (not only summary/unit).
  await line().click(); await panel().focus();
  scenario = 'missing'; await page.clock.fastForward(600001);
  await unit().waitFor({state: 'hidden'});
  const to = page.getByRole('combobox', {name: 'To', exact: true});
  await focused(to);
  report.checks.push('Complete forecast removal while strip is focused restores To');
  // Repeated disappearance/recovery may not retain a stale reference.
  for (let i = 0; i < 2; i++) {
    scenario = 'dry'; await page.clock.fastForward(600001); await unit().waitFor();
    await line().focus(); scenario = 'missing'; await page.clock.fastForward(600001);
    await unit().waitFor({state: 'hidden'}); await focused(to);
  }
  report.checks.push('Repeated unavailable/recovered weather leaves no stale focus ownership');
  await page.clock.setSystemTime(now); await load('dry');
  await line().click(); await panel().focus();
  await to.focus(); await to.fill('Review Library');
  scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
  await focused(to); assert.equal(await to.inputValue(), 'Review Library');
  report.checks.push('Forecast removal preserves deliberately focused place input and typed query');
  // Expiry driven by clock/current-hour filtering, not explicit unavailable payload.
  await page.clock.setSystemTime(now); await load('dry');
  await line().click(); await panel().focus(); scenario = 'failed';
  await page.clock.fastForward(11 * hour); await unit().waitFor({state: 'hidden'});
  await focused(to);
  report.checks.push('Expired failed-refresh forecast restores focus from removed strip');
  await page.clock.setSystemTime(now); await load('single');
  const box = await line().boundingBox(); assert(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); assert.equal(await panel().count(), 0);
  await unit().focus(); await page.keyboard.press('Space'); assert.match(await line().innerText(), /20°C/);
  assert.equal(await line().getAttribute('aria-expanded'), null);
  report.checks.push('Single-hour pointer no-op remains inert while unit action works');
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
