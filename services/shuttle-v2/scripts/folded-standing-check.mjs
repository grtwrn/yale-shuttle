// Recorded public Green/Purple stands, actual SPA, no production API writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const captures = JSON.parse(await fs.readFile('web/src/__fixtures__/folded-standing-display.json', 'utf8'));
const base = process.env.BOT_BASE_URL ?? 'https://folded-standing.test';
const out = process.env.BOT_OUT ?? 'pr-preview/stop-display-audit';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
const results = [], errors = [];
try {
  for (const capture of captures) for (const width of [307, 390, 1280]) {
    const { feed, receivedAt } = capture;
    const bus = feed.buses[0], line = bus.route_id === 9 ? 'Green' : 'Purple';
    const stop = feed.stop_names[bus.at_stop_id].replace(/\s*\/\s*/g, '/');
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 600,
      timezoneId: 'America/New_York', serviceWorkers: 'block',
      ...(width === 307 ? { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' } : {}) });
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(() => localStorage.setItem('listView', 'map'));
      const page = await ctx.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({ time: new Date(receivedAt) });
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
      await page.locator(`button[title="Show only ${line}"]`).click();
      const row = page.getByRole('button', { name: `Alert me when ${line} reaches ${stop}`, exact: true }).locator('..');
      const text = await row.innerText();
      assert.match(text, new RegExp(`\\b${bus.bus_name.replace(/^#/, '')}\\b`), `${line} badge belongs at ${stop}`);
      assert.match(text, /⏸/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reflow');
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${line.toLowerCase()}-${width}.png`, fullPage: true });
      results.push({ line, width, bus: bus.bus_name, stop, passed: true });
      console.log(`PASS ${line} ${width}px: ${bus.bus_name} badge and stand at ${stop}`);
    } finally { await ctx.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify({ scope: 'Public recorded feed, actual SPA, intercepted APIs; display consistency only', results, errors }, null, 2) + '\n'); }
