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
      if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
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
  assert.match(await panel.innerText(), /Red|Blue|Orange/);
  result.comparison = await panel.innerText();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + '/class-arrival-390.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px viewport overflow');
  await page.screenshot({ path: out + '/class-arrival-320.png' });
  result.checks.push('390px and 320px layouts', 'buffer changes destination target');
  // A refresh keeps the class selection, and opening details keeps existing controls usable.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitFor();
  assert.equal(await panel.getByLabel('Class starts · local time').inputValue(), datetime);
  assert.equal(await panel.getByLabel('Time to get inside').inputValue(), '10');
  await page.getByRole('button', { name: 'View Red trip details', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /All routes/ }).waitFor();
  const eta = page.getByRole('button', { name: /^Red arrival details:/ });
  await eta.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Next arrival/);
  await page.keyboard.press('Escape');
  assert(await eta.evaluate(e => e === document.activeElement));
  await page.getByRole('button', { name: /All routes/ }).click();
  result.checks.push('deadline survives reload', 'trip details, pickup gap and Escape focus still work');
  await panel.getByLabel('Class starts · local time').fill('2026-01-01T10:00');
  assert.match(await panel.getByRole('alert').innerText(), /passed/);
  assert.equal(await panel.getByRole('heading').count(), 0);
  await panel.getByLabel('Class starts · local time').fill('');
  assert.match(await panel.getByRole('alert').innerText(), /Choose a class/);
  assert(await panel.getByLabel('Class starts · local time').isVisible(), 'editing must not close the panel');
  await panel.getByLabel('Class starts · local time').fill(datetime);
  await page.route('**/api/buses', route => route.fulfill({ status: 503, json: { error: 'Test interrupted feed' } }));
  await page.waitForTimeout(6500);
  assert.match(await panel.innerText(), /No live window/);
  assert.equal(await panel.getByRole('heading', { name: /^Take / }).count(), 0);
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
