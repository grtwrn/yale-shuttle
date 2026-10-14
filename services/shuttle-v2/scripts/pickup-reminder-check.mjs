// Actual built SPA: selectable pickup timing, delivery, keyboard and reflow.
// Requests and notifications are intercepted; no production writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const original = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json', 'utf8'));
const out = process.env.BOT_OUT ?? 'pr-preview/pickup-reminder';
const base = process.env.BOT_BASE_URL ?? 'https://pickup-reminder.test';
await fs.mkdir(out, { recursive: true });
const report = { base, scope: 'Actual SPA with intercepted fixture APIs and notification delivery; no production writes or ETA accuracy claim', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const width of [320, 390, 1280]) {
    const feed = structuredClone(original), now = feed.server_eta.servedAt;
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ feed, now }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: '517 Prospect Street', fromLL: feed.from, toText: 'Rosenkranz Hall', toLL: feed.to, tripTime: '', expandedKey: null, savedAt: now }));
        window.permissionRequests = 0; window.reminderBuzzes = 0;
        Object.defineProperty(window, 'Notification', { configurable: true, value: class {
          static permission = 'default';
          static async requestPermission() { window.permissionRequests++; this.permission = 'denied'; return 'denied'; }
        } });
        Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { window.reminderBuzzes++; return true; } });
      }, { feed, now });
      const page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => report.errors.push(e.message));
      await page.clock.install({ time: new Date(now) });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== new URL(base).hostname) return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
        if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'View Blue Day trip details', exact: true }).click();
      const actions = page.getByRole('group', { name: 'Trip actions', exact: true });
      const trigger = actions.getByRole('button', { name: '🔔 Remind me for #44', exact: true });
      const settings = actions.getByRole('group', { name: 'Pickup reminder settings', exact: true });
      await trigger.focus(); await page.keyboard.press('Enter');
      await settings.waitFor();
      assert.equal(await page.evaluate(() => window.permissionRequests), 0, 'opening settings must not ask for notification permission');
      assert.equal(await trigger.getAttribute('aria-controls'), await settings.getAttribute('id'));
      const mode = settings.getByLabel('Reminder timing', { exact: true });
      assert(await mode.evaluate(el => el === document.activeElement));
      const minutes = () => settings.getByLabel('Minutes before pickup', { exact: true });
      await minutes().selectOption('1');
      assert.match(await settings.innerText(), /may be too late to walk/);
      await minutes().selectOption('10');
      for (const control of await settings.locator('button,select').all()) {
        const b = await control.boundingBox(); assert(b.width >= 44 && b.height >= 44, '44px touch targets');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'settings overflow');
      await settings.screenshot({ path: `${out}/minutes-${width}.png` });
      await page.keyboard.press('Escape'); assert.equal(await settings.count(), 0);
      assert(await trigger.evaluate(el => el === document.activeElement), 'Escape restores focus');
      await trigger.click(); await mode.selectOption('stops');
      await settings.getByLabel('Stops before pickup', { exact: true }).selectOption('3');
      await settings.screenshot({ path: `${out}/stops-${width}.png` });
      await settings.getByRole('button', { name: 'Set reminder', exact: true }).click();
      const armed = actions.getByRole('button', { name: '🔔 Reminding you for #44', exact: true });
      await armed.waitFor(); assert.match(await actions.innerText(), /3 stops before pickup/);
      assert.equal(await page.evaluate(() => window.permissionRequests), 1);
      await page.clock.runFor(1100);
      assert.equal(await page.evaluate(() => window.reminderBuzzes), 0, '#48 one stop away must not trigger the reminder for #44 eleven stops away');
      await actions.getByRole('button', { name: 'Change reminder', exact: true }).click();
      assert.equal(await mode.inputValue(), 'stops');
      assert.equal(await settings.getByLabel('Stops before pickup', { exact: true }).inputValue(), '3');
      await settings.getByRole('button', { name: 'Cancel reminder setup', exact: true }).click();
      assert.equal(await armed.getAttribute('aria-pressed'), 'true', 'cancel editing preserves the armed reminder');
      const row = feed.server_eta.rows.find(r => r[0] === 2 && r[1] === 100 && r[5] === 11);
      assert(row); row[5] = 3;
      await page.clock.runFor(5500);
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).waitFor();
      assert.match(await page.locator('body').innerText(), /Blue Day #44 is 3 stops before your pickup/);
      assert.equal(await page.evaluate(() => window.reminderBuzzes), 1);
      await page.clock.runFor(1100); assert.equal(await page.evaluate(() => window.reminderBuzzes), 1, 'one notification per arm');
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).click();
      await trigger.click(); await mode.selectOption('minutes'); await minutes().selectOption('10');
      await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await armed.waitFor();
      row[3] = 480;
      await page.clock.runFor(5500);
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).waitFor();
      assert.match(await page.locator('body').innerText(), /Blue Day #44 could arrive in .*pickup reminder/);
      assert.equal(await page.evaluate(() => window.reminderBuzzes), 2);
      assert.equal(await armed.count(), 0, 'custom reminder completes after its one ping');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${out}/fired-${width}.png`, fullPage: true });
      report.runs.push({ width, settings: ['1/3/5/10/15 min', '1–5 stops', 'time to leave'], permissionAskedOnlyOnSet: true, keyboardFocus: true, wrongBusIgnored: true, stopAndMinuteDelivery: true, repeatedPing: false, overflow: false });
    } catch (error) {
      const page = ctx.pages()[0];
      report.failure = { width, message: error.message, body: await page.locator('body').ariaSnapshot().catch(() => null) };
      await page.screenshot({ path: `${out}/failure-${width}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await ctx.close(); }
  }
  assert.deepEqual(report.errors, []); report.completed = true;
} finally { await browser.close(); await fs.writeFile(`${out}/browser-results.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
