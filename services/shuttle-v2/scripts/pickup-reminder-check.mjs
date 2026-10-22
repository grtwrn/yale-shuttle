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
  for (const width of [307, 320, 390, 1280]) {
    const feed = structuredClone(original), now = feed.server_eta.servedAt;
    let feedMode = 'fresh';
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600,
      ...(width === 307 ? { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' } : {}),
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
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
        if (u.pathname === '/api/buses') {
          if (feedMode === 'http-failed') return route.fulfill({ status: 503, json: { error: 'Fixture connection failure' } });
          const payload = structuredClone(feed), at = await page.evaluate(() => Date.now());
          for (const bus of payload.buses) bus.observed_at = at;
          if (feedMode === 'missing-forecast') delete payload.server_eta;
          else {
            const sourceAt = feedMode === 'stale-forecast' ? at - 60000 : at;
            payload.server_eta.at = sourceAt; payload.server_eta.servedAt = at;
          }
          return route.fulfill({ json: payload });
        }
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
      assert.deepEqual(await minutes().locator('option').evaluateAll(es => es.map(e => e.value)), ['1', '3', '5', '10', '15']);
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
      assert.deepEqual(await settings.getByLabel('Stops before pickup', { exact: true }).locator('option').evaluateAll(es => es.map(e => e.value)), ['1', '2', '3', '4', '5']);
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
      // Loss of live evidence must pause the chosen reminder and its ping
      // history. These are constructed API/clock transitions, not service truth.
      const advance = async ms => {
        for (let n = 0; n < ms; n += 500) {
          await page.clock.runFor(Math.min(500, ms - n));
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      const waiting = page.getByRole('status', { name: 'Pickup reminder waiting for live updates', exact: true });
      const buzzes = () => page.evaluate(() => window.reminderBuzzes);
      const armTiming = async timing => {
        await trigger.click(); await mode.selectOption(timing);
        await settings.getByLabel(timing === 'stops' ? 'Stops before pickup' : 'Minutes before pickup', { exact: true }).selectOption(timing === 'stops' ? '3' : '1');
        await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await armed.waitFor();
      };
      const resetThreshold = async () => { row[5] = 11; row[3] = 480; feedMode = 'fresh'; await advance(6500); };
      const recoveryCases = [];
      for (const [failure, timing] of [['http-failed', 'stops'], ['missing-forecast', 'stops'], ['stale-forecast', 'stops'], ['http-failed', 'minutes']]) {
        await resetThreshold(); const before = await buzzes(); await armTiming(timing); await advance(1100);
        feedMode = failure; await advance(6500); await waiting.waitFor();
        assert.equal(await buzzes(), before, 'unavailable or stale evidence must never notify');
        assert.match(await waiting.innerText(), timing === 'stops' ? /3 stops before pickup/ : /1 min before pickup/);
        const cancel = waiting.getByRole('button', { name: 'Cancel pickup reminder', exact: true });
        const box = await cancel.boundingBox(); assert(box.width >= 44 && box.height >= 44);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await waiting.screenshot({ path: out + '/waiting-' + failure + '-' + timing + '-' + width + '.png' });
        if (timing === 'stops') row[5] = 3; else row[3] = 30;
        feedMode = 'fresh'; await advance(6500);
        await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).waitFor();
        assert.equal(await waiting.count(), 0); assert.equal(await buzzes(), before + 1);
        await advance(1100); assert.equal(await buzzes(), before + 1, 'recovery must not repeat a completed ping');
        await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).click();
        recoveryCases.push({ failure, timing, heldWithoutAlert: true, resumedOnceOnFreshData: true, cancelAvailableWhileWaiting: true });
      }
      await resetThreshold(); const leaveBefore = await buzzes(); row[3] = 300; await advance(6500);
      await trigger.click(); await mode.selectOption('leave');
      await settings.getByRole('button', { name: 'Set reminder', exact: true }).click(); await advance(1100);
      assert.equal(await buzzes(), leaveBefore + 1, 'leave-time heads-up control');
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).click();
      feedMode = 'http-failed'; await advance(6500); await waiting.waitFor(); assert.equal(await buzzes(), leaveBefore + 1);
      feedMode = 'fresh'; await advance(6500); assert.equal(await waiting.count(), 0);
      assert.equal(await buzzes(), leaveBefore + 1, 'recovery must preserve the fired heads-up');
      row[3] = 0; await advance(6500);
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).waitFor();
      assert.equal(await buzzes(), leaveBefore + 2, 'the final leave-time ping still fires once');
      await page.getByRole('button', { name: 'Dismiss reminder', exact: true }).click();
      await advance(1100); assert.equal(await buzzes(), leaveBefore + 2);
      await resetThreshold(); let before = await buzzes(); await armTiming('stops'); feedMode = 'http-failed'; await advance(6500); await waiting.waitFor();
      await waiting.getByRole('button', { name: 'Cancel pickup reminder', exact: true }).click(); await advance(1100); assert.equal(await waiting.count(), 0);
      row[5] = 3; feedMode = 'fresh'; await advance(6500); assert.equal(await buzzes(), before, 'a canceled pending reminder must not resume');
      await resetThreshold(); before = await buzzes(); await armTiming('stops'); feedMode = 'http-failed'; await advance(6500); await waiting.waitFor();
      await page.getByTitle('Back to all routes', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Swap start and destination', exact: true }).click(); await advance(1100);
      assert.equal(await waiting.count(), 0, 'changing the trip must cancel the old reminder');
      row[5] = 3; feedMode = 'fresh'; await advance(6500); assert.equal(await buzzes(), before, 'the old trip must not notify after recovery');
      report.runs.push({ width, androidCompact: await page.evaluate(() => document.documentElement.dataset.androidCompact === 'true'), settings: ['1/3/5/10/15 min', '1–5 stops', 'time to leave'], permissionAskedOnlyOnSet: true, keyboardFocus: true, wrongBusIgnored: true, stopAndMinuteDelivery: true, repeatedPing: false, overflow: false, recoveryCases, leavePingHistoryPreserved: true, canceledPendingNeverResumed: true, changedTripNeverResumed: true });
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
