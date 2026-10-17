// Recorded report 142, actual SPA. Intercept all APIs; no production writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const capture = JSON.parse(await fs.readFile('web/src/__fixtures__/red-winchester-report-142.json', 'utf8'));
const base = process.env.BOT_BASE_URL ?? 'https://winchester.test';
const out = process.env.BOT_OUT ?? 'pr-preview/report-142';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
const results = [], errors = [];
try {
  for (const width of [307, 390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 797 }, isMobile: width < 600, hasTouch: width < 600,
      timezoneId: 'America/New_York', serviceWorkers: 'block',
      ...(width === 307 ? { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' } : {}) });
    let page;
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({ now, from }) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Division / Prospect', fromLL: from,
          toText: 'Trumbull / Hillhouse', toLL: { lat: 41.3135, lon: -72.923286 }, tripTime: '', expandedKey: null, savedAt: now }));
      }, { now: capture.receivedAt, from: capture.feed.stop_coords['48'] });
      page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({ time: new Date(capture.receivedAt) });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== new URL(base).hostname) return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({ json: capture.feed });
        if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { results: [], reports: [] } });
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({ body: await fs.readFile('web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
        catch { return route.fulfill({ status: 404 }); }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'View Red trip details', exact: true }).click();
      const text = await page.locator('body').innerText();
      assert.match(text, /#317/);
      assert.match(text, /3 stops away/);
      assert.doesNotMatch(text, /11 stops away/);
      assert.match(text, /344 Winchester/);
      assert.doesNotMatch(text, /College \/ Wall \(N\)/);
      const waitText = await page.locator('.bus-wait-label').innerText();
      const stopText = await page.getByTestId('trip-approach-stops').locator('[data-stop-id="11"]').innerText();
      const departure = /(leaves in [^\n]+|leaving any moment)/.exec(stopText)?.[1];
      assert(departure, stopText);
      assert(waitText.includes(departure), `Map and stop list must name the same departure estimate: ${waitText} versus ${departure}`);
      assert.doesNotMatch(waitText, /usual|typical|total/i);
      const marker = page.locator('.bus-pin-sm[aria-label*="317"]');
      assert((await marker.getAttribute('aria-label')).includes(departure));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reflow');
      await page.getByText(/3 stops away/).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/winchester-${width}.png`, fullPage: true });
      results.push({ width, passed: true, bus: '317', stopsAway: 3, waitText, departure,
        pickup: await page.locator('tbody[data-route="Red"]').getByTestId('route-pickup').innerText() });
      console.log(`PASS ${width}px: #317 at Winchester, 3 stops away, no obsolete College/Wall approach`);
    } catch(error) {
      if(page){
        await page.screenshot({path:`${out}/failure-${width}.png`,fullPage:true,timeout:5000}).catch(()=>{});
        await fs.writeFile(`${out}/failure-${width}.json`,JSON.stringify({error:String(error),text:await page.locator('body').innerText().catch(()=>''),
          waitText:await page.locator('.bus-wait-label').innerText().catch(()=>null)},null,2)+'\n').catch(()=>{});
      }
      throw error;
    } finally { await ctx.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify({ scope: 'Recorded public feed, actual SPA, intercepted APIs; behavior regression only', results, errors }, null, 2) + '\n'); }
