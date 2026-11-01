// Actual SPA navigation with a recorded software fixture and controlled polls.
// All APIs/notifications are intercepted; no production writes or ETA truth claim.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
import { advanceUntilResponse, waitForResponseBody } from './browser-response.mjs';

const capture = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
const now = capture.server_eta.servedAt;
const base = process.env.BOT_BASE_URL ?? 'https://trip-navigation.test';
const out = process.env.BOT_OUT ?? 'pr-preview/trip-intent-navigation';
await fs.mkdir(out, { recursive: true });
const report = { scope: 'Real SPA, controlled navigation and pickup reminder delivery; no production writes or physical accuracy claim', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const width of [307, 390, 1280]) {
    const feed = structuredClone(capture);
    const pickup = feed.server_eta.rows.find(row => row[0] === 2 && row[1] === 100 && row[5] === 11);
    assert(pickup, 'fixture explicitly identifies #44 at Prospect/Canner, eleven stops away');
    let servedNow = now, polls = 0;
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600,
      hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    let page;
    try {
      await seedTestId(context);
      await context.addInitScript(({ from, to, now }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: '517 Prospect Street', fromLL: from,
          toText: 'Rosenkranz Hall', toLL: to, tripTime: '', expandedKey: null, savedAt: now }));
        window.reminderBuzzes = 0; window.permissionRequests = 0;
        Object.defineProperty(window, 'Notification', { configurable: true, value: class {
          static permission = 'default';
          static async requestPermission() { window.permissionRequests++; this.permission = 'denied'; return this.permission; }
        } });
        Object.defineProperty(navigator, 'vibrate', { configurable: true,
          value: () => { window.reminderBuzzes++; return true; } });
      }, { from: capture.from, to: capture.to, now });
      page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => report.errors.push(`${width}: ${error.message}`));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin) return route.abort();
        if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.fulfill({ status: 204 });
        if (url.pathname === '/api/buses') {
          polls++;
          const payload = structuredClone(feed);
          for (const bus of payload.buses) bus.observed_at = servedNow;
          payload.server_eta.at = servedNow; payload.server_eta.servedAt = servedNow;
          return route.fulfill({ json: payload });
        }
        if (url.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = url.pathname === '/' ? '/index.html' : url.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file),
          contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      const tick = async ms => { servedNow += ms; await page.clock.runFor(ms); await new Promise(resolve => setTimeout(resolve, 20)); };
      const advance = async () => {
        const before = polls, response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        await advanceUntilResponse(page, before, () => polls, ms => { servedNow += ms; });
        await waitForResponseBody(page, await response);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(polls > before, 'a new feed poll completed');
        await tick(1100); // The retained one-second engine must consume the new snapshot.
      };
      const nav = page.getByRole('navigation', { name: 'Main', exact: true });
      const tab = name => nav.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });
      const detail = page.getByTestId('trip-detail-panel');
      const actions = page.getByRole('group', { name: 'Trip actions', exact: true });
      const settings = actions.getByRole('group', { name: 'Pickup reminder settings', exact: true });
      const dismiss = page.getByRole('button', { name: 'Dismiss reminder', exact: true });
      const noTripUI = async name => {
        assert.equal(await tab(name).getAttribute('aria-current'), 'page');
        assert.equal(await detail.count(), 0, 'inactive Trip details are removed from the DOM');
        assert.equal(await actions.count(), 0, 'inactive Trip actions are removed from the DOM');
        assert.equal(await page.locator('tbody[data-route="Blue Day"]').count(), 0, 'inactive Trip table is removed, not hidden');
      };
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'View Blue Day trip details from Whitney/Canner', exact: true }).click();
      await page.getByTitle('Walking directions to Whitney/Canner', { exact: true }).waitFor();
      for (const name of ['map', 'issues']) {
        await tab(name).click(); await noTripUI(name); await advance();
        assert(await tab(name).evaluate(element => element === document.activeElement), 'polling in another view must not steal navigation focus');
      }
      await tab('trip').click(); await detail.waitFor();
      await page.getByTitle('Walking directions to Whitney/Canner', { exact: true }).waitFor();
      assert.equal(await page.getByTitle('Walking directions to Prospect/Canner', { exact: true }).count(), 0,
        'returning to Trip must retain the explicitly selected farther pickup');
      await page.getByRole('button', { name: '← All routes', exact: true }).click();
      const near = page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');
      await near.getByRole('button', { name: /^View Blue Day trip details/ }).click();
      await page.getByTitle('Walking directions to Prospect/Canner', { exact: true }).waitFor();
      const trigger = actions.getByRole('button', { name: '🔔 Remind me for #44', exact: true });
      const armed = actions.getByRole('button', { name: '🔔 Reminding you for #44', exact: true });
      const deliveryCases = [];
      for (const timing of ['stops', 'minutes']) {
        await trigger.click(); await settings.waitFor();
        await settings.getByLabel('Reminder timing', { exact: true }).selectOption(timing);
        const label = timing === 'stops' ? 'Stops before pickup' : 'Minutes before pickup';
        const value = timing === 'stops' ? '3' : '10';
        await settings.getByLabel(label, { exact: true }).selectOption(value);
        await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await armed.waitFor();
        const before = await page.evaluate(() => window.reminderBuzzes);
        await tab('map').click(); await noTripUI('map'); await advance();
        await tab('issues').click(); await noTripUI('issues'); await advance();
        assert.equal(await page.evaluate(() => window.reminderBuzzes), before, 'no threshold was crossed while navigating');
        await tab('trip').click(); await armed.waitFor();
        await actions.getByRole('button', { name: 'Change reminder', exact: true }).click();
        assert.equal(await settings.getByLabel('Reminder timing', { exact: true }).inputValue(), timing,
          'the armed timing mode survives main navigation');
        assert.equal(await settings.getByLabel(label, { exact: true }).inputValue(), value,
          'the armed timing amount survives main navigation');
        await settings.getByRole('button', { name: 'Cancel reminder setup', exact: true }).click(); await armed.waitFor();
        await tab('map').click(); await noTripUI('map');
        if (timing === 'stops') pickup[5] = 3; else pickup[3] = 480;
        await advance(); await dismiss.waitFor();
        const message = await page.getByRole('alert').filter({ has: dismiss }).innerText();
        assert.match(message, timing === 'stops' ? /Blue Day #44 is 3 stops before your pickup/ : /Blue Day #44 could arrive in .*pickup reminder/);
        assert.equal(await page.evaluate(() => window.reminderBuzzes), before + 1, 'the inactive Trip engine delivers exactly once on fresh data');
        await noTripUI('map');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'global fallback must fit this viewport');
        await page.screenshot({ path: `${out}/${timing}-on-map-${width}.png`, fullPage: true });
        await tab('issues').click(); await dismiss.waitFor(); await advance();
        assert.equal(await page.evaluate(() => window.reminderBuzzes), before + 1, 'navigation and later polls do not repeat a completed ping');
        if (timing === 'stops') await dismiss.click();
        await tab('trip').click(); await trigger.waitFor();
        assert.equal(await armed.count(), 0, 'custom reminders complete after one delivery');
        pickup[5] = 11;
        if (timing === 'stops') await advance();
        deliveryCases.push({ timing, value, keptAcrossMapAndIssues: true, deliveredOnMap: true, deliveredOnce: true });
      }
      // A real endpoint change ends the previous trip and removes its banner.
      await page.getByRole('button', { name: '← All routes', exact: true }).click();
      await page.getByRole('button', { name: 'Swap start and destination', exact: true }).click();
      assert.equal(await dismiss.count(), 0, 'a new trip clears the prior trip reminder banner');
      await tab('map').click(); await advance();
      assert.equal(await dismiss.count(), 0, 'the prior reminder cannot reappear in the new trip');
      report.runs.push({ width, fartherPickupRetained: true, inactiveTripDOMRemoved: true, focusRetained: true,
        deliveryCases, newTripClearedBanner: true, polls, passed: true });
      console.log(`PASS trip intent navigation ${width}px: pickup identity, stops/minutes delivery on Map, new-trip cleanup`);
    } catch (error) {
      report.errors.push(`${width}: ${error.message}`);
      if (page && !page.isClosed()) {
        try {
          const body = Buffer.from(await page.locator('body').innerText());
          const diagnostic = { width, polls, message: error.message, bodyBytes: body.length,
            truncated: body.length > 65536, body: body.subarray(0, 65536).toString() };
          await fs.writeFile(`${out}/failure-${width}.json`, JSON.stringify(diagnostic, null, 2));
          console.error('[trip-navigation failure]', JSON.stringify({ ...diagnostic, body: body.subarray(0, 8192).toString() }));
          await page.screenshot({ path: `${out}/failure-${width}.png`, fullPage: true });
        } catch (diagnosticError) { report.errors.push(`Failure diagnostic: ${diagnosticError.message}`); }
      }
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, [], 'no browser errors');
} finally {
  await browser.close();
  await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2) + '\n');
}

// The original navigation cases complete before these location controls.
await import('./reminder-location-check.mjs');
