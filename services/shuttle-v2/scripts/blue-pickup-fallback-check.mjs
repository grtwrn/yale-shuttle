// Bounded built-SPA regression. Later state is the captured September 28
// Blue feed; the earlier catchable visit is constructed, not report history.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const service = process.cwd();
const snapshot = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-pickup-2026-09-28.json', 'utf8'));
const base = JSON.parse(await fs.readFile('web/src/__fixtures__/buses-payload.json', 'utf8'));
const names = Object.fromEntries(JSON.parse(await fs.readFile('src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const now = snapshot.server_eta.servedAt;
const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']});
try {
  for (const protectedRoute of [false, true]) {
    const feed = {...base, ...structuredClone(snapshot), stop_names: names};
    const later = structuredClone(feed.server_eta);
    const bus = feed.server_eta.buses.findIndex(b => b[0] === '38');
    for (const row of feed.server_eta.rows) if (row[0] === bus) for (const column of [2, 3, 4, 7, 8]) row[column] += 600;
    const ctx = await browser.newContext({viewport: {width: 368, height: 854}, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', serviceWorkers: 'block'});
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({from, to, now, protectedRoute}) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({fromText: '517 Prospect Street', fromLL: from, toText: 'Rosenkranz Hall', toLL: to, tripTime: '', expandedKey: protectedRoute ? 'Blue Day' : null, savedAt: now}));
      }, {...snapshot, now, protectedRoute});
      const page = await ctx.newPage(); page.setDefaultTimeout(10_000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({time: new Date(now)});
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== 'pickup.test') return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({json: feed});
        if (u.pathname === '/api/weather') return route.fulfill({status: 204});
        if (u.pathname.startsWith('/api/')) return route.fulfill({json: {reports: [], results: []}});
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({body: await fs.readFile(service + '/web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}); }
        catch { return route.fulfill({status: 404}); }
      });
      await page.goto('https://pickup.test');
      if (protectedRoute) await page.getByTitle('Walking directions to Whitney/Canner', {exact: true}).waitFor();
      else {
        await page.getByRole('button', {name: /Show 1 more route/}).waitFor();
        assert.equal(await page.getByRole('button', {name: 'View Blue Day trip details', exact: true}).count(), 0);
      }
      feed.server_eta = later;
      await page.clock.runFor(5500);
      if (protectedRoute) assert(await page.getByTitle('Walking directions to Whitney/Canner', {exact: true}).isVisible());
      else {
        await page.getByRole('button', {name: 'View Blue Day trip details', exact: true}).click();
        await page.getByTitle('Walking directions to Prospect/Canner', {exact: true}).waitFor();
        await page.clock.runFor(5500);
        assert(await page.getByTitle('Walking directions to Prospect/Canner', {exact: true}).isVisible(), 'opening the fallback must not restore the old pickup');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
console.log('Blue pickup fallback: unopened route recovers close pickup; watched route and opened fallback stay pinned.');
