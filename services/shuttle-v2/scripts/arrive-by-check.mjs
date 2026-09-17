// Run with node --import tsx after building web/: ARRIVE_BY_FEED=payload.json ARRIVE_BY_WATCHER=watcher.jsonl node scripts/arrive-by-check.mjs
// Or use the live site: ARRIVE_BY_URL=https://yale-shuttle.fly.dev node scripts/arrive-by-check.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.ARRIVE_BY_OUT ?? path.resolve(service, '../../pr-preview/arrive-by-class');
await fs.mkdir(out, { recursive: true });
const base = process.env.ARRIVE_BY_URL ?? 'https://arrive-by.test';
const local = !process.env.ARRIVE_BY_URL;
let feed, sample;
const historyQueries = [];
const historyFixture = process.env.ARRIVE_BY_HISTORY_FILE
  ? JSON.parse(await fs.readFile(process.env.ARRIVE_BY_HISTORY_FILE, 'utf8')).historyProbe : [];

if (local) {
  feed = JSON.parse(await fs.readFile(process.env.ARRIVE_BY_FEED, 'utf8'));
  sample = JSON.parse((await fs.readFile(process.env.ARRIVE_BY_WATCHER, 'utf8')).trim().split('\n').at(-1));
  feed.buses = sample.buses;
  const { ServerEta } = await import('../src/server/serverEta.ts');
  const { ROUTE_LISTS } = await import('../web/src/routes.ts');
  const server = new ServerEta({ routes: ROUTE_LISTS.map(c => c.label) });
  feed.server_eta = server.contribute(feed, 1, Date.parse(sample.at));
}
const result = { source: local ? 'Recorded Red feed, 2026-09-16' : base, errors: [], checks: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'America/New_York', permissions: ['geolocation'],
    geolocation: { latitude: 41.324769, longitude: -72.923522 }, serviceWorkers: 'block' });
  await seedTestId(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', e => result.errors.push(e.message));
  if (local) {
    await page.clock.install({ time: new Date(sample.at) });
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname === 'yale.downtownerapp.com') return route.fulfill({ contentType: 'text/html', body: '<body>Official tracker</body>' });
      if (u.hostname !== 'arrive-by.test') return route.abort();
      if (u.pathname === '/api/buses') return route.fulfill({ json: { ...feed,
        server_eta: { ...feed.server_eta, servedAt: await page.evaluate(() => Date.now()) },
      } });
      if (u.pathname === '/api/journey-history') {
        const routeName = u.searchParams.get('route'), stop = Number(u.searchParams.get('stop')), eta = Number(u.searchParams.get('eta'));
        historyQueries.push({ route: routeName, stop, eta, limit: Number(u.searchParams.get('limit')) });
        assert.equal(u.searchParams.get('limit'), '100', 'new history readers request the larger sample');
        const match = historyFixture.find(x => x.route === routeName && x.stop === stop && Math.abs(x.eta - eta) <= 60);
        return route.fulfill({ json: match?.result ?? { asOf: Date.parse(sample.at), days: 30,
          journey: null, recent: [] } });
      }
      if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
      if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [] } });
      const file = u.pathname === '/' ? '/index.html' : u.pathname;
      try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + file),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404 }); }
    });
  }
  await page.route('**/api/geocode**', route => route.fulfill({ json: { results: [{
    display_name: 'LEPH / 60 College', lat: 41.303735, lon: -72.932155, type: 'university', class: 'yale',
  }] } }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Where do you want to go?').fill('LEPH / 60 College');
  await page.getByText('LEPH / 60 College', { exact: true }).first().click();
  await page.getByRole('button', { name: /Arrive by…/ }).click();
  const panel = page.getByRole('region', { name: 'Arrive by class' });
  await panel.waitFor();
  const datetime = await page.evaluate(() => {
    const d = new Date(Date.now() + 45 * 60_000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await panel.getByLabel('Class starts · local time').fill(datetime);
  await panel.getByLabel('Time to get inside').selectOption('10');
  await page.waitForTimeout(300);
  assert.match(await panel.innerText(), /10 min before class/);
  assert.match(await panel.innerText(), /Walk/);
  assert.match(await panel.innerText(), /Red|Blue|Orange|Green|Purple|Brown|Pink|Gold/);
  result.comparison = await panel.innerText();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/class-arrival-390.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px viewport overflow');
  await page.screenshot({ path: out + '/class-arrival-320.png' });
  result.checks.push('390px and 320px layouts', 'buffer changes destination target');
  if (local) assert.equal(historyQueries.length, 0, 'closed disclosures must not fetch history');
  await panel.getByText('See possible arrival times ▾', { exact: true }).click();
  const destinationPlot = panel.getByRole('img', { name: /^Model estimate: arrival at / });
  await destinationPlot.waitFor();
  assert.equal(await destinationPlot.locator('circle').count(), 50);
  const walkingTime = (await panel.getByText(/^About \d/).first().innerText()).replace(/^About /, '');
  assert((await panel.innerText()).includes('Walk estimate ' + walkingTime), 'walk marker and summary must agree to the minute');
  assert.match(await panel.innerText(), /Class starts|Your target/);
  await destinationPlot.scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/destination-distribution-320.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'distribution overflows 320px');
  result.checks.push('destination distribution has 50 server outcomes, deadline and walking markers');

  // A refresh keeps the class selection, and opening details keeps existing controls usable.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitFor();
  assert.equal(await panel.getByLabel('Class starts · local time').inputValue(), datetime);
  assert.equal(await panel.getByLabel('Time to get inside').inputValue(), '10');
  const trip = page.getByRole('button', { name: /^View (?!Walk ).+ trip details$/ }).first();
  const routeLabel = (await trip.getAttribute('aria-label')).replace(/^View /, '').replace(/ trip details$/, '');
  result.route = routeLabel;
  const map = page.locator('.trip-map-wrap').first();
  const pickupChip = map.locator('.eta-tip').filter({ hasText: new RegExp('\\(' + routeLabel[0] + '\\) (?:~?[<\\d]|At stop)') });
  await pickupChip.first().waitFor();
  const compactText = await pickupChip.first().innerText();
  assert.doesNotMatch(compactText, /About|Likely/);
  if (!compactText.includes('At stop')) assert.match(compactText, /(?:<1|\d+)–\d+ min|~(?:<1|\d+) min/);
  result.checks.push('mini-map shows one compact arrival window per route without width cutoffs');
  if (local) {
    const waitLabel = map.locator('.bus-wait-label').first();
    await waitLabel.waitFor();
    const waitingRoute = await waitLabel.locator('.bus-wait-route').innerText();
    assert(waitingRoute.length > 0, 'waiting label visibly identifies its route');
    assert((await waitLabel.getAttribute('title')).startsWith(waitingRoute + ' #'), 'visible route matches its bus');
    assert((await waitLabel.innerText()).startsWith(waitingRoute + ' · Waiting'), 'route shares the elapsed-time line');
    assert.match(await waitLabel.innerText(), /Waiting(?: nearby)? \d+:\d{2}\nUsually ~\d+ min total/);
    const before = await waitLabel.innerText();
    await page.clock.runFor(2000);
    const after = await waitLabel.innerText();
    assert.notEqual(after.split('\n')[0], before.split('\n')[0], 'waiting clock advances');
    assert.equal(after.split('\n')[1], before.split('\n')[1], 'typical total stays stable');
    result.checks.push('waiting label names its route on the elapsed-time line; clock advances while typical total stays stable');
  }
  await map.scrollIntoViewIfNeeded();
  const waitLabelsClear = () => map.evaluate(el => {
    const waits = [...el.querySelectorAll('.eta-tip')].filter(t => t.querySelector('.bus-wait-label'));
    const arrivals = [...el.querySelectorAll('.eta-tip')].filter(t => !t.querySelector('.bus-wait-label'));
    return waits.every(w => arrivals.every(a => {
      const x = w.getBoundingClientRect(), y = a.getBoundingClientRect();
      return x.right <= y.left || x.left >= y.right || x.bottom <= y.top || x.top >= y.bottom;
    }));
  });
  if (local) assert(await waitLabelsClear(), 'wait label must not cover arrival window at 320px');
  await page.screenshot({ path: out + '/mini-map-wait-320.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  if (local) assert(await waitLabelsClear(), 'wait label must not cover arrival window at 390px');
  await page.screenshot({ path: out + '/mini-map-wait-390.png' });
  if (local) {
    await page.setViewportSize({ width: 1701, height: 1164 });
    await page.waitForTimeout(150);
    assert(await waitLabelsClear(), 'wait label must not cover arrival window at reported desktop size');
    await page.screenshot({ path: out + '/mini-map-wait-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    result.checks.push('wait labels avoid arrival windows at phone and reported desktop sizes');
  }
  await trip.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /All routes/ }).waitFor();
  const eta = page.getByRole('button', { name: new RegExp('^' + routeLabel + ' arrival details:') });
  await eta.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Following shuttle|Next pass|Next arrival/);
  assert.doesNotMatch(await dialog.innerText(), /Estimated gap|8 in 10/);
  const pickupPlot = dialog.getByRole('img', { name: /^Model estimate for this shuttle/ });
  assert.equal(await pickupPlot.count(), 0, 'modeled pickup dots start collapsed');
  await dialog.getByRole('region', { name: 'Recorded arrival history' }).waitFor();
  await page.waitForTimeout(400);
  result.pickupDetails = await dialog.innerText();
  result.historyQueries = historyQueries;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + '/pickup-distribution-390.png' });
  const historyPlot = dialog.getByRole('img', { name: /^(Remaining wait \+ travel|Travel time after departure)/ });
  if (await historyPlot.count()) {
    assert((await historyPlot.locator('circle').count()) > 0);
    assert.equal(await historyPlot.locator('circle:not([fill="#fff"])').count(), 0);
    await historyPlot.scrollIntoViewIfNeeded();
    await page.screenshot({ path: out + '/recorded-arrivals-390.png' });
    await dialog.getByText('Dates and recorded times ▾', { exact: true }).click();
    assert((await dialog.locator('tbody tr').count()) > 0);
    await page.setViewportSize({ width: 320, height: 740 });
    assert(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth), 'recorded table overflows dialog at 320px');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'recorded table overflow');
    await page.screenshot({ path: out + '/recorded-arrivals-320.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    result.checks.push('hollow historical dots display dated observed trips');
  }
  if (local && historyFixture.length) assert(await historyPlot.count(), 'real recorded fixture must produce historical dots');
  if (local && historyFixture.length) {
    const actual = historyFixture.find(x => x.stop === historyQueries.at(-1).stop)?.result;
    assert(actual?.journey?.trips.length, 'moving context uses completed recorded journeys');
    assert.equal(await historyPlot.locator('circle').count(), actual.journey.trips.length, 'every returned historical trip gets a dot');
    assert.equal(await dialog.locator('tbody tr').count(), actual.journey.trips.length, 'every returned historical trip has a dated row');
    const moving = structuredClone(actual);
    moving.journey.mode = 'departure'; moving.journey.elapsedSec = null;
    moving.journey.trips = moving.journey.trips.map(t => ({ ...t, startedAt: t.departedAt, actualSec: (t.arrivedAt - t.departedAt) / 1000 }));
    const movingHandler = route => route.fulfill({ json: moving });
    await page.route('**/api/journey-history?**', movingHandler);
    await dialog.getByRole('button', { name: 'Refresh comparison' }).click();
    await dialog.getByRole('img', { name: /^Travel time after departure/ }).waitFor();
    assert.match(await dialog.innerText(), /full stop-to-stop times/);
    assert.doesNotMatch(await dialog.innerText(), /Matched to buses still waiting/);
    await page.screenshot({ path: out + '/departure-context-390.png' });
    await page.unroute('**/api/journey-history?**', movingHandler);
    await dialog.getByRole('button', { name: 'Refresh comparison' }).click();
    await dialog.getByRole('img', { name: /^Remaining wait \+ travel/ }).waitFor();
    result.checks.push('refresh switches timing anchors explicitly; moving history is measured from departure');
  }
  await dialog.getByText('Forecast for this shuttle ▾', { exact: true }).click();
  await pickupPlot.waitFor();
  assert.equal(await pickupPlot.locator('circle').count(), 50);
  await pickupPlot.scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/pickup-forecast-expanded-390.png' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'pickup distribution viewport overflow');
  result.checks.push('recorded waits are the primary pickup graph; current forecast expands separately', 'pickup distribution and following-shuttle wording');
  await page.keyboard.press('Escape');
  assert(await eta.evaluate(e => e === document.activeElement));
  await page.route('**/api/journey-history?**', route => route.fulfill({ status: 503, json: { error: 'test interruption' } }));
  await eta.click();
  await dialog.getByText('Recorded trips are unavailable right now.').waitFor();
  assert.equal(await pickupPlot.locator('circle').count(), 50);
  assert.match(await dialog.innerText(), /Likely arrival window/);
  await page.keyboard.press('Escape');
  result.checks.push('history failure leaves live distribution and forecast usable');
  await page.getByRole('button', { name: /All routes/ }).click();
  result.checks.push('deadline survives reload', 'trip details, pickup gap and Escape focus still work');
  await panel.getByLabel('Class starts · local time').fill('2026-01-01T10:00');
  assert.match(await panel.getByRole('alert').innerText(), /passed/);
  assert.equal(await panel.getByRole('heading').count(), 0);
  await panel.getByLabel('Class starts · local time').fill('');
  assert.match(await panel.getByRole('alert').innerText(), /Choose a class/);
  assert(await panel.getByLabel('Class starts · local time').isVisible(), 'editing must not close the panel');
  await panel.getByLabel('Class starts · local time').fill(datetime);
  if (local) {
    feed.server_eta.buses = feed.server_eta.buses.map(b => [b[0], b[1], b[2], null]);
    await page.clock.runFor(5500);
    await page.waitForFunction(() => document.querySelectorAll('.bus-wait-label').length === 0);
    result.checks.push('waiting labels disappear on the next moving-bus update');
  }
  await page.route('**/api/buses', route => route.fulfill({ status: 503, json: { error: 'Test interrupted feed' } }));
  await page.waitForTimeout(6500);
  assert.match(await panel.innerText(), /No live window/);
  assert.equal(await panel.getByRole('heading', { name: /may fit your buffer/ }).count(), 0);
  result.checks.push('passed deadline rejected', 'empty time remains editable', 'failed feed suppresses shuttle recommendation');
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: /Arrive by…/ }).waitFor();
  result.checks.push('clear returns to normal planner');
  assert.deepEqual(result.errors, []);
} finally {
  await fs.writeFile(out + '/verification.json', JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
