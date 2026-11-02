// Real SPA location-provider controls. All feeds/notifications/network are mocked;
// public fixture geography is evaluated only by the Linux browser, not field truth.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';

const original = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
const base = process.env.BOT_BASE_URL ?? 'https://reminder-location.test';
const out = (process.env.BOT_OUT ?? 'pr-preview/trip-intent-navigation') + '/location';
await fs.mkdir(out, { recursive: true });
const report = { scope: 'Real SPA with controlled provider callbacks and public fixture feeds; software behavior only', cases: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const badFix of ['older-cached', 'current-approximate']) {
    const feed = structuredClone(original), now = feed.server_eta.servedAt;
    const row = feed.server_eta.rows.find(row => row[0] === 2 && row[1] === 100 && row[5] === 11);
    assert(row, 'controlled feed names #44 at pickup100');
    let servedNow = now, polls = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true,
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
    let page;
    try {
      await seedTestId(context);
      await context.addInitScript(({ from, to, now, badFix }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Current location', fromLL: from,
          toText: 'Rosenkranz Hall', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
        let position = from, next = 0;
        const watches = new Map(); window.locationWatches = []; window.reminderBuzzes = 0;
        const fix = (point, accuracy = 10, ageMs = 0) => ({ coords: { latitude: point.lat, longitude: point.lon,
          accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() - ageMs });
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
          watchPosition(ok, fail, options) {
            const id = ++next; watches.set(id, { ok, fail, options });
            window.locationWatches.push({ id, options, cleared: false });
            queueMicrotask(() => {
              if (!watches.has(id)) return;
              ok(options.enableHighAccuracy ? fix(position) : fix(from,
                badFix === 'current-approximate' ? 200 : 10, badFix === 'older-cached' ? 30000 : 0));
            }); return id;
          },
          clearWatch(id) { watches.delete(id); window.locationWatches.find(w => w.id === id).cleared = true; },
          getCurrentPosition(ok) { queueMicrotask(() => ok(fix(position))); },
        } });
        window.locationMove = point => { position = point; for (const watch of watches.values()) watch.ok(fix(point)); };
        window.locationBadFix = () => { for (const watch of watches.values()) watch.ok(fix(from,
          badFix === 'current-approximate' ? 200 : 10, badFix === 'older-cached' ? 30000 : 0)); };
        window.locationFail = () => { for (const watch of watches.values()) watch.fail({ code: 1, PERMISSION_DENIED: 1 }); };
        Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'denied'; } });
        Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { window.reminderBuzzes++; return true; } });
      }, { from: feed.from, to: feed.to, now, badFix });
      page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => report.errors.push(e.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(base).origin) return route.abort();
        if (!['GET', 'HEAD'].includes(route.request().method())) return route.fulfill({ status: 204 });
        if (url.pathname === '/api/buses') {
          polls++; const payload = structuredClone(feed);
          for (const bus of payload.buses) bus.observed_at = servedNow;
          payload.server_eta.at = servedNow; payload.server_eta.servedAt = servedNow;
          return route.fulfill({ json: payload });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = url.pathname === '/' ? '/index.html' : url.pathname;
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
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'View Blue Day trip details', exact: true }).click();
      const nav = page.getByRole('navigation', { name: 'Main', exact: true });
      const tab = name => nav.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });
      const actions = page.getByRole('group', { name: 'Trip actions', exact: true });
      const trigger = actions.getByRole('button', { name: '🔔 Remind me for #44', exact: true });
      await trigger.click();
      const settings = actions.getByRole('group', { name: 'Pickup reminder settings', exact: true });
      await settings.getByLabel('Reminder timing', { exact: true }).selectOption('leave');
      await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await tick(1100);
      assert.equal(await page.evaluate(() => window.reminderBuzzes), 0, 'positive control: initial pickup window is outside leave threshold');
      await page.evaluate(point => window.locationMove(point), feed.stop_coords[100]); await tick(1100);
      const atPickup = await page.evaluate(() => JSON.parse(localStorage.getItem('lastUserLatLon')));
      assert.equal(atPickup.lat, feed.stop_coords[100].lat); assert.equal(atPickup.lon, feed.stop_coords[100].lon);
      // Same threshold used by the existing leave heads-up browser control.
      row[3] = 300;
      await tab('map').click(); await advance();
      assert.equal(await page.evaluate(() => window.reminderBuzzes), 0, 'Map control: no leave prompt after reaching the pickup');
      await tab('issues').click(); await advance();
      // Also deliver the unwanted provider value on the CURRENT watch. This
      // exercises acceptance even after the precision-intent defect is fixed.
      await page.evaluate(() => window.locationBadFix()); await tick(1100);
      const facts = await page.evaluate(() => ({ buzzes: window.reminderBuzzes,
        activeWatches: window.locationWatches.filter(w => !w.cleared).map(w => w.options),
        cachedPosition: JSON.parse(localStorage.getItem('lastUserLatLon')) }));
      facts.badFix = badFix; facts.polls = polls; facts.body = (await page.locator('body').innerText()).slice(0, 8192);
      report.cases.push(facts); await page.screenshot({ path: `${out}/${badFix}-issues.png`, fullPage: true });
      console.log('[reminder-location observation]', JSON.stringify(facts));
    } catch (e) {
      report.errors.push(`${badFix}: ${e.message}`);
      if (page && !page.isClosed()) await page.screenshot({ path: `${out}/${badFix}-failure.png`, fullPage: true }).catch(() => {});
      throw e;
    } finally { await context.close(); }
  }
  for (const result of report.cases) {
    assert.equal(result.activeWatches.length, 1, 'one live watch for the retained reminder');
    assert.equal(result.activeWatches[0].enableHighAccuracy, true, 'armed Current-location reminder stays precise on Issues');
    assert.equal(result.cachedPosition.lat, original.stop_coords[100].lat, 'bad provider callback cannot roll the watched trip back from pickup');
    assert.equal(result.cachedPosition.lon, original.stop_coords[100].lon);
    assert.equal(result.buzzes, 0, 'neither cached rollback nor approximate current fix may produce a leave prompt at pickup');
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2) + '\n');
}

// Separate positive controls run after both original counterexample oracles.
await import('./reminder-location-controls.mjs');
