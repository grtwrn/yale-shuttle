/**
 * Bounded built-SPA navigation and place-search regression; all requests are
 * intercepted and the existing tester identity is seeded. Build web first.
 * Run from services/shuttle-v2 under the shared overnight heavy lock:
 *   OUT=/path/to/evidence node scripts/navigation-search-check.mjs
 * Optional --baseline records old semantics without requiring new labels/focus.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const service = process.cwd();
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = process.env.OUT || path.join(service, 'pr-preview', 'navigation-search');
await fs.mkdir(out, {recursive: true});
const baseline = process.argv.includes('--baseline');
const mode = baseline ? 'before' : 'after';
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.buses = [];
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const matches = [
  {display_name: 'Sterling Memorial Library', lat: 41.3113, lon: -72.9288, class: 'amenity', type: 'library'},
  {display_name: 'Sterling Hall of Medicine / Medical Historical Library', lat: 41.3037, lon: -72.9322, class: 'amenity', type: 'library'},
];
const report = {source: 'Built SPA with intercepted API fixture; no external requests', mode, checks: [], snapshots: {}, errors: [], requests: []};
const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
try {
  const ctx = await browser.newContext({viewport: {width: 360, height: 800}, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block'});
  await seedTestId(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.errors.push(e.message));
  let searchState = 'matches';
  let releaseSearch;
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'shuttle.test') return route.abort();
    if (u.pathname.startsWith('/api/')) report.requests.push({path: u.pathname, method: route.request().method()});
    if (u.pathname === '/api/buses') return route.fulfill({json: feed});
    if (u.pathname === '/api/weather') return route.fulfill({status: 204});
    if (u.pathname === '/api/geocode') {
      if (searchState === 'pending') await new Promise(resolve => { releaseSearch = resolve; });
      if (searchState === 'failed') return route.fulfill({status: 503, json: {}});
      return route.fulfill({json: {results: searchState === 'empty' ? [] : searchState === 'single' ? matches.slice(0, 1) : matches}});
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({json: {reports: [], results: [], routes: []}});
    const file = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({body: await fs.readFile(service + '/web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html'}); }
    catch { return route.fulfill({status: 404}); }
  });
  await page.goto('https://shuttle.test', {waitUntil: 'domcontentloaded'});
  const to = page.getByRole('combobox');
  await to.waitFor();
  report.snapshots.initial = await to.ariaSnapshot();
  report.snapshots.navigation = await page.locator('.app-tabs').ariaSnapshot();
  if (!baseline) {
    assert.equal(await page.getByRole('combobox', {name: 'To', exact: true}).count(), 1);
    assert.equal(await page.getByRole('navigation', {name: 'Main'}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'trip', exact: true}).getAttribute('aria-current'), 'page');
  }
  await to.fill('Sterling');
  const options = page.getByRole('option');
  await options.nth(1).waitFor();
  assert.equal(await to.getAttribute('aria-expanded'), 'true');
  await to.press('ArrowDown');
  assert.equal(await to.getAttribute('aria-activedescendant'), 'to-suggestions-0');
  await to.press('ArrowUp');
  assert.equal(await to.getAttribute('aria-activedescendant'), 'to-suggestions-1');
  report.snapshots.matches = await page.getByRole('listbox').ariaSnapshot();
  if (!baseline) assert.equal(await page.getByRole('listbox', {name: 'To suggestions'}).count(), 1);
  for (const width of [360, 390, 430, 1280, 640]) {
    await page.setViewportSize({width, height: width === 640 ? 422 : 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
    const box = await to.boundingBox();
    assert(box.height >= 44);
    assert.equal(await to.evaluate(e => getComputedStyle(e).fontSize), '16px');
    if (width === 360) await page.screenshot({path: out + '/' + mode + '-search-360.png'});
  }
  await to.press('Escape');
  assert.equal(await options.count(), 0);
  assert.equal(await to.getAttribute('aria-expanded'), 'false');
  assert.equal(await to.getAttribute('aria-activedescendant'), null);
  assert(await to.evaluate(e => e === document.activeElement));
  report.checks.push('ArrowDown/ArrowUp wrap the displayed destination matches; Escape closes suggestions with focus retained; no dangling active descendant', '360/390/430/1280px and 640 CSS-pixel reflow, 16px inputs and >=44px height');
  await to.fill('Sterling Library');
  await options.nth(1).waitFor();
  await to.press('ArrowDown');
  await to.press('Enter');
  const toPill = page.getByRole('button', {name: /^To 🏁 Sterling Memorial Library/});
  await toPill.waitFor();
  if (!baseline) await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'button' && document.activeElement.textContent.includes('Sterling Memorial Library'));
  report.snapshots.afterPickFocus = await page.evaluate(() => ({tag: document.activeElement.tagName, text: document.activeElement.textContent?.slice(0, 60)}));
  if (!baseline) {
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', {name: 'Save this destination', exact: true}).evaluate(e => e === document.activeElement), true);
    report.checks.push('Destination suggestion pick focuses its summary; Tab continues to Save this destination');
  }
  const fromPill = page.getByRole('button', {name: /^From 📍/});
  await fromPill.focus(); await page.keyboard.press('Enter');
  const from = page.locator('input[aria-controls="from-suggestions"]');
  await from.waitFor();
  report.snapshots.from = await from.ariaSnapshot();
  if (!baseline) assert.equal(await page.getByRole('combobox', {name: 'From', exact: true}).count(), 1);
  assert(await from.evaluate(e => e === document.activeElement));
  await page.getByRole('option').nth(1).waitFor();
  await from.press('ArrowDown');
  assert.equal(await from.getAttribute('aria-activedescendant'), 'from-suggestions-0');
  await from.press('ArrowDown');
  assert.match(await page.locator('#from-suggestions-1').innerText(), /Sterling/);
  // Freeze browser timers across the quick reopen so the old 180ms blur
  // callback is still pending even on a slow test host.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  await from.press('Enter');
  await page.clock.runFor(32);
  await page.getByRole('button', {name: /^From 📍 Sterling Memorial Library/}).waitFor();
  if (!baseline) await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'button' && document.activeElement.textContent.includes('From'));
  report.checks.push('From editor opens by Enter; Current location plus recent place are navigable; Enter picks recent origin');
  // Typed origin uses the same listbox contract as recents.
  await fromPill.focus(); await page.keyboard.press('Space');
  await from.waitFor();
  await from.fill('Sterling');
  await page.clock.runFor(350);
  await page.clock.resume();
  await page.getByRole('option').nth(1).waitFor();
  if (!baseline) assert.equal(await page.getByRole('listbox', {name: 'From suggestions'}).count(), 1);
  await from.press('ArrowUp');
  assert.equal(await from.getAttribute('aria-activedescendant'), 'from-suggestions-1');
  await from.press('Enter');
  const chosenFrom = page.getByRole('button', {name: /^From 📍 Sterling Hall of Medicine/});
  await chosenFrom.waitFor();
  if (!baseline) {
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'button' && document.activeElement.textContent.includes('From'));
    await page.keyboard.press('Tab');
    assert(await page.getByRole('button', {name: 'Swap start and destination', exact: true}).evaluate(e => e === document.activeElement));
  }
  report.checks.push('Typed From ArrowUp/Enter picks the final match; summary focus continues by Tab to Swap');
  for (const [view, key] of [['map', 'Enter'], ['issues', 'Space'], ['trip', 'Enter']]) {
    const button = page.getByRole('button', {name: view, exact: true});
    const box = await button.boundingBox();
    assert(box.height >= 44 && box.width >= 44, view + ' target must be >=44px');
    await button.focus(); await page.keyboard.press(key);
    if (!baseline) {
      assert.equal(await button.getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('.app-tabs [aria-current="page"]').count(), 1);
    }
    assert(await button.evaluate(e => e === document.activeElement));
  }
  await toPill.waitFor();
  await page.reload({waitUntil: 'domcontentloaded'});
  await toPill.waitFor();
  report.checks.push('Trip/Map/Issues keyboard navigation retains button focus and planned endpoints; draft survives reload');
  await toPill.focus(); await page.keyboard.press('Space');
  const editor = page.getByRole('combobox');
  await editor.waitFor();
  searchState = 'pending';
  await editor.fill('Unresolved');
  await page.getByText('Finding places…', {exact: true}).waitFor();
  report.snapshots.loading = await page.getByText('Finding places…', {exact: true}).locator('..').ariaSnapshot();
  searchState = 'empty'; releaseSearch();
  await page.getByText('No matches found — try another name or address.', {exact: true}).waitFor();
  assert.equal(await editor.getAttribute('aria-expanded'), 'false');
  report.snapshots.empty = await page.getByText('No matches found — try another name or address.', {exact: true}).ariaSnapshot();
  if (!baseline) assert.match(await page.getByRole('alert').innerText(), /No matches found/);
  searchState = 'failed';
  await editor.fill('Failed search');
  await page.getByText('Search is unavailable — please try again.', {exact: true}).waitFor();
  report.snapshots.failed = await page.getByText('Search is unavailable — please try again.', {exact: true}).ariaSnapshot();
  if (!baseline) assert.match(await page.getByRole('alert').innerText(), /Search is unavailable/);
  searchState = 'matches';
  await editor.fill('Recovered search');
  await page.getByRole('option').nth(1).waitFor();
  assert.equal(await editor.getAttribute('aria-expanded'), 'true');
  report.checks.push('Pending, empty, failed and recovered geocode responses keep suggestion state consistent');
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('option').first().tap();
  await toPill.waitFor();
  if (!baseline) {
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'button' && document.activeElement.textContent.includes('To'));
    assert.equal(await page.getByRole('listbox').count(), 0);
  }
  report.checks.push('Mobile tap commits a suggestion and closes the list without reopening the keyboard');
  // A click from an assistive technology can select a result while another
  // control has focus. The result must not drag focus away from that control.
  await toPill.click(); await editor.waitFor(); await editor.fill('Sterling');
  await page.getByRole('option').nth(1).waitFor();
  const trip = page.getByRole('button', {name: 'trip', exact: true});
  await trip.focus();
  await page.getByRole('option').first().evaluate(e => e.click());
  await toPill.waitFor();
  await page.waitForTimeout(220);
  assert(await trip.evaluate(e => e === document.activeElement));
  report.checks.push('Selecting a result after focus moved to navigation does not steal focus');
  await page.mouse.move(0, 0);
  await chosenFrom.focus(); await page.keyboard.press('Enter'); await from.waitFor();
  await from.press('ArrowDown');
  // Hover can seed the active row. Reach and assert the actual GPS option,
  // rather than assuming one ArrowDown always starts at index zero.
  for (let i = 0; await from.getAttribute('aria-activedescendant') !== 'from-suggestions-0' && i < 8; i++) await from.press('ArrowDown');
  assert.equal(await from.getAttribute('aria-activedescendant'), 'from-suggestions-0');
  assert.match(await page.locator('#from-suggestions-0').innerText(), /Current location/);
  await from.press('Enter');
  // This fixture has no location permission: the summary may ask for a
  // start again after GPS fails. Selecting Current location is not a fix.
  const current = page.getByRole('button', {name: /^From 📍/});
  await current.waitFor();
  report.snapshots.currentLocationWithoutGps = await current.innerText();
  if (!baseline) await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'button' && document.activeElement.textContent.includes('From'));
  report.checks.push('Current location row remains keyboard selectable with focus on the From summary');
  await current.focus(); await page.keyboard.press('Enter'); await from.waitFor();
  await from.press('Escape');
  await current.waitFor();
  report.checks.push('Escape from the idle From list restores the original start');
  await current.focus(); await page.keyboard.press('Enter'); await from.waitFor();
  searchState = 'single';
  await from.fill('Exact starting address');
  await from.press('Tab');
  assert(await toPill.evaluate(e => e === document.activeElement));
  await page.getByRole('button', {name: /^From 📍 Sterling Memorial Library/}).waitFor();
  assert(await toPill.evaluate(e => e === document.activeElement));
  report.checks.push('Leaving a typed origin still resolves its single match; completion preserves focus on the destination');
  assert.deepEqual(report.errors, []);
  assert(!report.requests.some(r => r.path === '/api/report'));
  report.completed = true;
  await page.close(); await ctx.close();
} finally {
  if (!report.completed) {
    const failedPage = browser.contexts()[0]?.pages()[0];
    if (failedPage) report.failureSnapshot = await failedPage.locator('body').ariaSnapshot().catch(() => 'Page unavailable');
  }
  await browser.close();
  await fs.writeFile(out + '/' + mode + '-browser.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
