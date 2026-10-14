// Actual SPA with a recorded Red #317 snapshot and controlled later feed states.
// APIs are intercepted even for a production-bundle check; no production writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const capture = JSON.parse(await fs.readFile('web/src/__fixtures__/red-reporting-2026-10-14.json', 'utf8'));
const out = process.env.BOT_OUT ?? 'pr-preview/bus-reporting';
const base = process.env.BOT_BASE_URL ?? 'https://reporting.test';
await fs.mkdir(out, { recursive: true });
const report = { base, scope: 'Recorded Red #317 positions/forecasts with simulated outages and recovery; actual SPA, intercepted APIs, no production writes', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const mode of ['trip', 'map', 'ride']) for (const width of [307, 390, 1280]) {
    const now = capture.receivedAt;
    let phase = 'live', servedNow = now, polls = 0;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600,
      ...(width === 307 ? { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' } : {}),
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ now, mode, from }) => {
        localStorage.setItem('listView', mode === 'ride' ? 'trip' : mode);
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Prospect/Canner', fromLL: from,
          toText: 'Yale Health Center', toLL: { lat: 41.315731, lon: -72.927521 }, tripTime: '', expandedKey: null, savedAt: now }));
        if (mode === 'ride') localStorage.setItem('shuttle-boarded-ride', JSON.stringify({ routeLabel: 'Red', color: '#d00',
          busName: '317', boardStopId: 48, alightStopId: 147, startedAt: now }));
        window.permissionRequests = 0;
        Object.defineProperty(window, 'Notification', { configurable: true, value: class {
          static permission = 'default'; static async requestPermission() { window.permissionRequests++; return 'denied'; }
        } });
      }, { now, mode, from: capture.feed.stop_coords['100'] });
      const page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => report.errors.push(`${mode}/${width}: ${e.message}`));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== new URL(base).hostname) return route.abort();
        if (u.pathname === '/api/buses') {
          polls++;
          if (phase === 'fail') return route.fulfill({ status: 503, json: { error: 'simulated connection failure' } });
          const feed = structuredClone(capture.feed);
          for (const b of feed.buses) b.observed_at = servedNow;
          feed.server_eta.at = servedNow; feed.server_eta.servedAt = servedNow;
          if (phase === 'returned') feed.buses.find(b => b.bus_name === '#317').bus_id = 67698;
          if (phase === 'missing') {
            feed.buses = feed.buses.filter(b => b.bus_name !== '#317');
            const e = feed.server_eta, removed = e.buses.findIndex(b => b[0] === '317');
            const rows = e.rows.map((row, index) => ({ row, index })).filter(({ row }) => row[0] !== removed);
            e.rows = rows.map(({ row }) => [row[0] > removed ? row[0] - 1 : row[0], ...row.slice(1)]);
            if (e.distributions) e.distributions = rows.map(({ index }) => e.distributions[index]);
            e.buses.splice(removed, 1); e.travel?.splice(removed, 1);
          }
          return route.fulfill({ json: feed });
        }
        if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file),
          contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      const advance = async () => {
        const before = polls;
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        servedNow += 5500; await page.clock.runFor(5500); await (await response).finished();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(polls > before, 'new feed poll');
      };
      const notices = page.getByTestId('bus-reporting-alerts');
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      if (mode === 'trip') await page.getByTestId('route-timing-table').waitFor();
      else if (mode === 'map') await page.locator('[id="route-card-Red"]').waitFor();
      else await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      await advance(); assert.equal(await notices.count(), 0);
      phase = 'missing'; await advance(); assert.equal(await notices.count(), 0, 'single dropped poll stays quiet');
      phase = 'live'; await advance(); assert.equal(await notices.count(), 0, 'brief drop does not claim recovery');
      phase = 'fail'; await advance(); await advance();
      assert.equal(await notices.count(), 0, 'connection errors are not individual bus losses');
      phase = 'live'; await advance();
      phase = 'missing'; await advance(); await advance();
      if (!await notices.count()) {
        await fs.writeFile(`${out}/${mode}-debug-${width}.txt`, await page.locator('body').innerText());
        await page.screenshot({ path: `${out}/${mode}-debug-${width}.png`, fullPage: true });
      }
      await notices.waitFor(); assert.match(await notices.innerText(), /Red #317 stopped reporting/);
      assert.equal(await notices.getByRole('alert').count(), 1);
      assert.match(await notices.innerText(), /arrival time is unavailable/);
      if (mode === 'trip') assert.match(await notices.innerText(), /trip now shows #/);
      const dismiss = notices.getByRole('button', { name: 'Dismiss tracking update for Red #317', exact: true });
      const box = await dismiss.boundingBox(); assert(box.width >= 44 && box.height >= 44);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await page.screenshot({ path: `${out}/${mode}-lost-${width}.png` });
      await dismiss.focus(); await page.keyboard.press('Enter'); assert.equal(await notices.count(), 0);
      await advance(); assert.equal(await notices.count(), 0, 'dismissed loss does not repeat');
      phase = 'returned'; await advance(); await notices.waitFor();
      assert.match(await notices.innerText(), /Red #317 is reporting again/);
      assert.equal(await notices.getByRole('status').count(), 1);
      await page.screenshot({ path: `${out}/${mode}-returned-${width}.png` });
      assert.equal(await page.evaluate(() => window.permissionRequests), 0, 'no notification permission needed');
      if (mode === 'trip') {
        await page.getByRole('button', { name: 'View Red trip details', exact: true }).click();
        assert.equal(await notices.count(), 0, 'opening a different viewing scope clears old notice');
      }
      report.runs.push({ mode, width, polls, passed: true });
      console.log(`PASS ${mode} ${width}px: short drop, connection failure, sustained loss, dismissal, new-ID return`);
    } finally { await ctx.close(); }
  }
  assert.deepEqual(report.errors, [], 'no browser errors');
} finally {
  await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2) + '\n');
}
