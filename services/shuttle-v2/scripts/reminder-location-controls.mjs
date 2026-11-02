// Preserve useful stationary/manual reminders while qualifying Leave recovery.
// Synthetic provider/clock/forecast controls; no production requests or truth claim.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';

const original = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
const base = process.env.BOT_BASE_URL ?? 'https://reminder-location.test';
const out = (process.env.BOT_OUT ?? 'pr-preview/trip-intent-navigation') + '/location/controls';
await fs.mkdir(out, { recursive: true });
const report = { scope: 'Controlled actual SPA stationary location and reminder recovery; software only', cases: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const kind of ['leave', 'minutes', 'stops', 'manual-leave']) {
    const manual = kind === 'manual-leave', timing = manual ? 'leave' : kind;
    const feed = structuredClone(original), now = feed.server_eta.servedAt;
    const row = feed.server_eta.rows.find(r => r[0] === 2 && r[1] === 100 && r[5] === 11); assert(row);
    let servedNow = now, polls = 0;
    const ctx = await browser.newContext({ viewport: { width: 307, height: 900 }, isMobile: true, hasTouch: true,
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
    let page;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ feed, now, manual }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: manual ? '517 Prospect Street' : 'Current location',
          fromLL: feed.from, toText: 'Rosenkranz Hall', toLL: feed.to, tripTime: '', expandedKey: null, savedAt: now }));
        let next = 0; const watches = new Map(); window.locationSamples = 0; window.reminderBuzzes = 0;
        const fix = () => { window.locationSamples++; return { coords: { latitude: feed.from.lat, longitude: feed.from.lon,
          accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() }; };
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
          watchPosition(ok, fail, options) { const id = ++next; watches.set(id, { ok, fail, options });
            queueMicrotask(() => { if (watches.has(id)) manual ? fail({ code: 1 }) : ok(fix()); }); return id; },
          clearWatch(id) { watches.delete(id); },
          getCurrentPosition(ok, fail) { queueMicrotask(() => manual ? fail({ code: 1 }) : ok(fix())); },
        } });
        window.locationFail = () => { for (const watch of watches.values()) watch.fail({ code: 1 }); };
        window.locationVisibility = hidden => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'denied'; } });
        Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { window.reminderBuzzes++; return true; } });
      }, { feed, now, manual });
      page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => report.errors.push(e.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.origin !== new URL(base).origin) return route.abort();
        if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 204 });
        if (u.pathname === '/api/buses') {
          polls++; const payload = structuredClone(feed);
          for (const bus of payload.buses) bus.observed_at = servedNow;
          payload.server_eta.at = servedNow; payload.server_eta.servedAt = servedNow;
          return route.fulfill({ json: payload });
        }
        if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file),
          contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      const tick = async ms => { servedNow += ms; await page.clock.runFor(ms); await new Promise(r => setTimeout(r, 20)); };
      const advance = async () => {
        const before = polls, response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await advanceUntilResponse(page, before, () => polls, ms => { servedNow += ms; });
        await waitForResponseBody(page, await response); await new Promise(r => setTimeout(r, 50)); await tick(1100);
      };
      const buzzes = () => page.evaluate(() => window.reminderBuzzes);
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'View Blue Day trip details', exact: true }).click();
      const actions = page.getByRole('group', { name: 'Trip actions', exact: true });
      await actions.getByRole('button', { name: '🔔 Remind me for #44', exact: true }).click();
      const settings = actions.getByRole('group', { name: 'Pickup reminder settings', exact: true });
      await settings.getByLabel('Reminder timing', { exact: true }).selectOption(timing);
      if (timing !== 'leave') await settings.getByLabel(timing === 'minutes' ? 'Minutes before pickup' : 'Stops before pickup', { exact: true }).selectOption(timing === 'minutes' ? '10' : '3');
      await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await tick(1100);
      const samplesBefore = await page.evaluate(() => window.locationSamples);
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: /^issues$/i }).click();
      // A healthy stationary watch may stay quiet. Never fabricate periodic
      // provider callbacks merely to keep a freshness-gated test passing.
      for (let ms = 0; ms < 61000; ms += 5000) await tick(Math.min(5000, 61000 - ms));
      await advance();
      assert.equal(await page.evaluate(() => window.locationSamples), samplesBefore, 'no artificial stationary GPS refresh');
      assert.equal(await buzzes(), 0, 'no threshold crossed during the stationary control');
      const waiting = page.getByRole('status', { name: 'Pickup reminder waiting for location', exact: true });
      if (!manual) {
        assert.equal(await waiting.count(), 0, 'age alone never expires continuous stationary tracking');
        await page.evaluate(() => window.locationFail()); await tick(1100);
        if (timing === 'leave') {
          await waiting.waitFor(); assert.match(await waiting.innerText(), /Leave-time reminder paused/);
          assert.equal(await page.getByTestId('trip-detail-panel').count(), 0, 'inactive Trip UI remains removed');
          for (const button of await waiting.getByRole('button').all()) { const box = await button.boundingBox(); assert(box.width >= 44 && box.height >= 44); }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await waiting.screenshot({ path: `${out}/paused-location-${kind}.png` });
        } else assert.equal(await waiting.count(), 0, 'custom bus timing remains usable after location loss');
      }
      if (timing === 'stops') row[5] = 3; else row[3] = timing === 'minutes' ? 480 : 300;
      await advance();
      if (!manual && timing === 'leave') {
        assert.equal(await buzzes(), 0, 'lost location cannot produce a walk-based leave ping');
        await waiting.getByRole('button', { name: 'Update location', exact: true }).click(); await advance();
        assert.equal(await waiting.count(), 0); assert.equal(await buzzes(), 1, 'qualified recovery delivers the pending heads-up once');
        await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).click();
        row[3] = 0;
        const hiddenResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await page.evaluate(() => window.locationVisibility(true));
        // Hidden pages use the existing 30 s polling cadence. Preserve that
        // product policy and the ordinary response helper's 5.5 s bound.
        for (let ms = 0; ms < 31000; ms += 5000) await tick(Math.min(5000, 31000 - ms));
        await waitForResponseBody(page, await hiddenResponse); await tick(1100);
        await waiting.waitFor(); assert.equal(await buzzes(), 1, 'hidden-page interruption preserves fired history and pauses Leave');
        await page.evaluate(() => window.locationVisibility(false)); await advance();
        assert.equal(await buzzes(), 2, 'visible qualified tracking delivers the final Leave ping once');
      } else assert.equal(await buzzes(), 1, manual ? 'manual-origin Leave never requires GPS' : 'fresh custom threshold delivers despite no new location');
      await tick(1100);
      assert.equal(await buzzes(), timing === 'leave' && !manual ? 2 : 1, 'no repeated completed reminder');
      const facts = { kind, stationaryWithoutNewFix: true, samplesBefore, manualOriginGpsIndependent: manual,
        locationLossPausedOnlyLeave: !manual, freshRecoveryPreservedHistory: kind === 'leave', delivered: await buzzes(), polls };
      report.cases.push(facts); console.log('[reminder-location control]', JSON.stringify(facts));
    } catch (e) {
      report.errors.push(`${kind}: ${e.message}`);
      if (page && !page.isClosed()) {
        console.error('[reminder-location control failure]', kind, e.message, (await page.locator('body').innerText()).slice(0, 8192));
        await page.screenshot({ path: `${out}/${kind}-failure.png`, fullPage: true }).catch(() => {});
      }
      throw e;
    } finally { await ctx.close(); }
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2) + '\n');
}
