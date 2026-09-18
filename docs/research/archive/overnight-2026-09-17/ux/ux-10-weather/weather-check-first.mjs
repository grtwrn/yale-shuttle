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
  report.snapshots.dry = await line().ariaSnapshot();
  if (baseline) {
    assert.equal(await line().getAttribute('role'), 'status');
    assert.equal(await line().getAttribute('aria-expanded'), null);
    assert.equal(await page.getByRole('button', {name: /68°F/}).count(), 0);
    await line().focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('img', {name: '0% chance of rain', exact: true}).count(), 10);
    report.snapshots.expanded = await unit().locator('../..').ariaSnapshot();
    const strip = page.getByRole('img', {name: '0% chance of rain', exact: true}).first().locator('../..');
    report.strip = await strip.evaluate(e => ({tabIndex: e.tabIndex, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, role: e.getAttribute('role')}));
    await page.screenshot({path: out + '/baseline-open-390.png'});
    await load('single'); await line().focus(); await page.keyboard.press('Space');
    assert.equal(await line().evaluate(e => e.tabIndex), 0);
    report.checks.push('Baseline reproduced: expandable weather is exposed as status without expanded state; one-hour no-op remains a keyboard stop');
    report.checks.push('Baseline hourly strip overflow and semantics captured; browser automatic scroll focus is not inferred from tabIndex');
    scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
    assert(await page.evaluate(() => document.activeElement === document.body));
    report.checks.push('Baseline forecast removal drops focused weather action to BODY');
  } else {
    assert.equal(await page.getByRole('button', {name: '68°F · Clear · no rain expected', exact: true}).count(), 1);
    assert.equal(await line().getAttribute('aria-expanded'), 'false');
    const id = await line().getAttribute('aria-controls');
    assert(id && await page.locator('[id="' + id + '"]').count() === 1);
    await line().focus(); await page.keyboard.press('Enter'); await panel().waitFor(); await focused(line());
    assert.equal(await line().getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab'); await focused(unit());
    await page.keyboard.press('Space'); await focused(unit());
    assert.match(await line().innerText(), /20°C/);
    assert.equal(await line().getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('shuttle.tempUnit')), 'C');
    await page.keyboard.press('Tab'); await focused(panel());
    assert.equal(await panel().getByRole('img', {name: '0% chance of rain', exact: true}).count(), 10);
    await page.setViewportSize({width: 390, height: 844});
    await panel().focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowRight');
    await page.clock.runFor(500);
    assert(await panel().evaluate(e => e.scrollLeft > 0), 'keyboard must scroll the hourly strip');
    report.snapshots.expanded = await unit().locator('../..').ariaSnapshot();
    await line().focus(); await page.keyboard.press('Space'); await focused(line()); assert.equal(await panel().count(), 0);
    if (desktop) await line().click(); else await line().tap(); await panel().waitFor();
    report.checks.push('Native button exposes name/expanded/controls; Enter/Space/touch open/close; unit is a separate Tab stop; hourly region scrolls by keyboard');
    await page.reload({waitUntil: 'domcontentloaded'}); await unit().waitFor();
    assert.match(await line().innerText(), /20°C/); assert.equal(await line().getAttribute('aria-expanded'), 'false');
    await unit().click();
    for (const mode of ['dry', 'wet', 'rain-only']) {
      await load(mode);
      if (mode === 'wet') assert.match(await line().innerText(), /rain by 1pm — umbrella/);
      if (mode === 'rain-only') assert.equal((await line().innerText()).includes('°'), false);
      await line().click(); await panel().waitFor();
      for (const width of [360, 390, 430, 640, 1280]) {
        await page.setViewportSize({width, height: 844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow: ' + mode + '/' + width);
        for (const control of [line(), unit()]) { const box = await control.boundingBox(); assert(box.width >= 44 && box.height >= 44); }
        if (width === 390) {
          const geometry = await line().locator('span').nth(1).evaluate(e => ({text: e.textContent, height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width, font: getComputedStyle(e).fontSize}));
          assert(geometry.height < 24, 'summary wraps at 390px'); report.geometry.push({mode, ...geometry});
        }
      }
      await page.setViewportSize({width: 1280, height: 844}); await page.evaluate(() => document.body.style.zoom = '2');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.evaluate(() => document.body.style.zoom = '');
      await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: out + '/' + mode + '-open-390.png'});
    }
    report.checks.push('Dry/wet/rain-only values preserved; units persist; 360/390/430/640/1280px and 200% CSS zoom reflow; 44px targets and single-line 390px summaries');
    await load('dry'); await line().focus();
    scenario = 'single'; await page.clock.fastForward(600001);
    await page.waitForFunction(() => document.querySelector('button[aria-disabled="true"]'));
    await focused(line());
    assert.equal(await line().getAttribute('tabindex'), '-1');
    assert.equal(await line().getAttribute('aria-expanded'), null);
    await page.keyboard.press('Enter'); assert.equal(await panel().count(), 0);
    await page.keyboard.press('Tab'); await focused(unit());
    await page.keyboard.press('Shift+Tab'); assert(!(await line().evaluate(e => e === document.activeElement)));
    scenario = 'dry'; await page.clock.fastForward(600001); await page.waitForFunction(() => document.querySelector('button[aria-controls="trip-weather-hours"]'));
    assert.equal(await line().getAttribute('aria-disabled'), null);
    report.checks.push('Async two-plus to one-hour forecast retains existing focus, disables the no-op and skips it in Tab order; recovery restores disclosure semantics');
    await line().click(); await panel().focus();
    scenario = 'single'; await page.clock.fastForward(600001); await panel().waitFor({state: 'hidden'}); await focused(line());
    scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
    await focused(page.getByRole('combobox', {name: 'To', exact: true}));
    await page.clock.setSystemTime(now); await load('dry'); await line().focus();
    const nav = page.getByRole('button', {name: 'trip', exact: true}); await nav.focus();
    scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'}); await focused(nav);
    await page.clock.setSystemTime(now); await load('dry'); await unit().focus();
    scenario = 'missing'; await page.clock.fastForward(600001); await unit().waitFor({state: 'hidden'});
    await focused(page.getByRole('combobox', {name: 'To', exact: true}));
    report.checks.push('Removing a focused strip returns to the weather action; removing focused weather/unit controls returns to To; existing outside focus is preserved');
    await page.clock.setSystemTime(now); await load('dry');
    // A failed refresh keeps the last forecast only while its hour is current.
    scenario = 'failed'; await page.clock.fastForward(600001); assert.equal(await unit().count(), 1);
    await page.clock.fastForward(11 * hour); await unit().waitFor({state: 'hidden'});
    report.checks.push('Failed refresh retains still-current data; expired forecast eventually disappears instead of remaining live');
    for (const mode of ['missing', 'expired', 'failed', 'pending']) {
      await load(mode); assert.equal(await unit().count(), 0);
      await page.getByRole('combobox', {name: 'To', exact: true}).fill('Library');
      if (mode === 'pending') {
        for (let i = 0; i < 100 && !pending; i++) await page.waitForTimeout(20);
        assert(pending, 'pending weather request observed');
        scenario = 'dry'; await pending.fulfill({json: weather()}); pending = null;
      }
    }
    // Reset time after deliberate expiry so pending recovery has current hours.
    await page.clock.setSystemTime(now); await load('dry');
    await page.evaluate(() => { Storage.prototype.setItem = function() { throw new DOMException('Blocked', 'SecurityError'); }; });
    await unit().focus(); await page.keyboard.press('Enter'); await focused(unit()); assert.match(await line().innerText(), /20°C/);
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('Blocked', 'SecurityError'); }}));
    await page.reload({waitUntil: 'domcontentloaded'}); await unit().waitFor(); assert.match(await line().innerText(), /68°F/);
    await unit().click(); assert.match(await line().innerText(), /20°C/);
    report.checks.push('Missing/expired/failed/pending initial weather leaves place entry usable; denied storage reads/writes leave unit changes usable during this visit');
  }
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
