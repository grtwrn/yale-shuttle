// Built-SPA keyboard focus regression. All APIs and non-GET requests are
// intercepted; this check needs no bus or ETA fixture and makes no server writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const out = process.env.BOT_OUT ?? 'pr-preview/departure-focus';
const base = process.env.BOT_BASE_URL ?? 'https://departure-focus.test';
const origin = new URL(base).origin;
await fs.mkdir(out, { recursive: true });
const report = { scope: 'Built SPA departure-picker focus with API503; no ETA or physical-arrival claim',
  base, runs: [], errors: [], interceptedAPI: 0, blockedNonGET: 0, blockedForeign: 0, realServerWrites: 0 };
let outputBytes = 0;
async function screenshot(page, name) {
  const bytes = await page.screenshot({ fullPage: false });
  assert(bytes.length <= 2 * 1024**2 && outputBytes + bytes.length <= 16 * 1024**2 - 65536, 'Focus screenshot output cap');
  await fs.writeFile(path.join(out, name), bytes); outputBytes += bytes.length;
}
async function open(browser, width, restoredDate = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600,
    hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block' });
  try {
    await seedTestId(context);
    await context.addInitScript(({ restoredDate }) => {
      const now = Date.now(), d = new Date(now + 2 * 3600000), pad = n => String(n).padStart(2, '0');
      const tripTime = restoredDate
        ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
      // Public manual-origin/destination literals from tripDraft.test.ts.
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({
        fromText: 'Division / Prospect', fromLL: { lat: 41.324769, lon: -72.923522 },
        toText: 'Yale Public Health', toLL: { lat: 41.303735, lon: -72.932155 },
        tripTime, tripTimeSetAt: now, expandedKey: null, savedAt: now,
      }));
      localStorage.setItem('listView', 'trip');
    }, { restoredDate });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => { if (report.errors.length < 32) report.errors.push(error.message.slice(0, 500)); });
    let requests = 0;
    await page.route('**/*', async route => {
      assert(++requests <= 256, 'Focus page request cap');
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') {
        report.blockedNonGET++;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      }
      if (url.origin !== origin) { report.blockedForeign++; return route.abort(); }
      if (url.pathname.startsWith('/api/')) {
        report.interceptedAPI++;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      }
      if (process.env.BOT_BASE_URL) return route.continue();
      const name = url.pathname === '/' ? '/index.html' : url.pathname;
      if (name.split('/').includes('..')) return route.fulfill({ status: 404 });
      try {
        return route.fulfill({ body: await fs.readFile('web/dist' + name),
          contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css'
            : name.endsWith('.png') ? 'image/png' : 'text/html' });
      } catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    return { context, page, input: page.getByLabel('Departure time', { exact: true }),
      later: page.getByRole('button', { name: 'Plan for later…', exact: true }),
      now: page.getByRole('button', { name: 'Now', exact: true }) };
  } catch (error) { await context.close(); throw error; }
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function focused(locator, message) {
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction(element => element === document.activeElement, await locator.elementHandle());
  assert(await locator.evaluate(element => element === document.activeElement), message);
}
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
try {
  for (const width of [320, 390, 1280]) {
    for (const key of ['Enter', 'Space']) {
      const { context, page, input, later, now } = await open(browser, width);
      try {
        await later.waitFor({ state: 'visible' }); await later.focus(); await page.keyboard.press(key);
        await focused(input, 'Plan for later transfers focus to the new date input');
        const original = await input.inputValue();
        assert.match(original, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
        // Editing an existing date keeps the same input focused; it is not a
        // transition to a different control and must not jump to Plan for later.
        const edited = original.slice(0, -2) + (original.endsWith('15') ? '30' : '15');
        await input.fill(edited); await settle(page);
        assert.equal(await input.inputValue(), edited);
        assert(await input.evaluate(element => element === document.activeElement), 'Ordinary date editing retains input focus');
        // Returning to Now already preserved focus before this fix. Retain it.
        await now.focus(); await page.keyboard.press(key);
        await focused(later, 'Now restores focus to Plan for later');
        await page.keyboard.press(key); await focused(input, 'Plan for later can be activated again');
        await input.fill(''); await focused(later, 'Clearing the date restores focus to Plan for later');
        assert.equal(await input.count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Departure controls overflow');
        await screenshot(page, `departure-${width}-${key.toLowerCase()}.png`);
        report.runs.push({ width, key, planFocusesInput: true, ordinaryDateEditRetainsFocus: true,
          nowRestoresPlanFocus: true, clearRestoresPlanFocus: true, overflow: false });
      } catch (error) {
        report.failure = { width, key, message: error.message,
          active: await page.evaluate(() => ({ tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.trim().slice(0, 160) })) };
        await screenshot(page, `failure-${width}-${key.toLowerCase()}.png`).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
    const { context, page, input, now } = await open(browser, width, true);
    try {
      await input.waitFor({ state: 'visible' }); await settle(page);
      assert.notEqual(await input.inputValue(), '', 'Fresh restored draft retains its selected date');
      assert.equal(await input.evaluate(element => element === document.activeElement), false, 'Restoring a draft does not autofocus the date input');
      assert.equal(await now.evaluate(element => element === document.activeElement), false, 'Restoring a draft does not autofocus Now');
      const save = page.getByRole('button', { name: 'Save this destination', exact: true });
      await save.focus(); await settle(page);
      assert(await save.evaluate(element => element === document.activeElement), 'A useful existing control keeps focus after restoration');
      await screenshot(page, `restored-${width}.png`);
      report.runs.push({ width, restoredDraft: true, dateRetained: true, noPickerAutofocus: true, existingControlFocusRetained: true });
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []); report.completed = true;
} finally {
  await browser.close();
  const raw = JSON.stringify(report, null, 2); assert(Buffer.byteLength(raw) <= 65536);
  await fs.writeFile(path.join(out, 'browser-results.json'), raw);
}
console.log(JSON.stringify(report));
