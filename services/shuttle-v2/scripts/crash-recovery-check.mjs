// Bounded fault-injection test of the real main.tsx ErrorBoundary. Run under heavy.lock.
// Only its Page children are substituted; no test trigger is shipped in the app.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seedTestId, TEST_ANON_ID } from './testId.mjs';
const service = process.cwd(), out = process.env.OUT, probe = process.env.PROBE === '1';
if (!out) throw Error('Set OUT to an evidence directory');
await fs.mkdir(out, { recursive: true });
const require = createRequire(service + '/web/package.json');
const { build } = require('esbuild');
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const main = await fs.readFile(process.env.MAIN_SOURCE || service + '/web/src/main.tsx', 'utf8');
const html = (await fs.readFile(service + '/web/index.html', 'utf8')).replace('/src/main.tsx', '/app.js');
const bundle = await build({
  stdin: { contents: main, resolveDir: service + '/web/src', loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'true' },
  plugins: [{ name: 'bounded-render-fault', setup(b) {
    b.onResolve({ filter: /^\.\/(TransitMap|MinimapReview|BerthReview)$/ }, () => ({ path: 'page', namespace: 'fault' }));
    b.onLoad({ filter: /.*/, namespace: 'fault' }, () => ({ loader: 'tsx', resolveDir: service + '/web/src', contents: `
      import {useState} from 'react';
      export default function Page() {
        const [failed,fail] = useState(false);
        window.failPage = () => fail(true);
        if(failed || localStorage.getItem('test-corrupt') === 'yes') {
          const error = new Error('Synthetic render failure');
          error.stack = 'Synthetic render failure\\n' + 'VeryLongSyntheticStackFrame'.repeat(45);
          throw error;
        }
        return <main><h1>Recovered app fixture</h1><button onClick={()=>fail(true)}>Trigger test crash</button></main>;
      }` }));
  } }],
});
await fs.writeFile(out + '/fault-bundle.js', bundle.outputFiles[0].text);
const report = { scope: 'Real main.tsx ErrorBoundary with fault-injected Page children; no live network', probe, checks: [], states: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
let context, page;
try {
  context = await browser.newContext({ viewport: { width: process.env.DESKTOP ? 1280 : 390, height: 844 }, isMobile: !process.env.DESKTOP, hasTouch: !process.env.DESKTOP, serviceWorkers: 'block' });
  await seedTestId(context);
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('fixture-seeded')) {
      localStorage.setItem('shuttle-recent-trips', '["synthetic saved place"]');
      localStorage.setItem('shuttle.tempUnit', 'C');
      localStorage.setItem('shuttle.stopAlerts', '["synthetic alert"]');
      sessionStorage.setItem('shuttle-trip-draft', 'synthetic existing draft');
      sessionStorage.setItem('fixture-seeded', 'yes');
    }
    const clear = Storage.prototype.clear;
    Storage.prototype.clear = function () {
      if (this === localStorage) {
        sessionStorage.setItem('clear-count', String(Number(sessionStorage.getItem('clear-count') || '0') + 1));
        if (sessionStorage.getItem('block-clear') === 'yes') throw new DOMException('Synthetic blocked storage', 'SecurityError');
      }
      const result = clear.call(this);
      if (this === localStorage) sessionStorage.setItem('identity-after-clear', this.getItem('shuttle-anon-id') ?? 'absent');
      return result;
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'crash.test') return route.abort();
    if (url.pathname === '/app.js') return route.fulfill({ body: bundle.outputFiles[0].text, contentType: 'text/javascript' });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    return route.abort();
  });
  const reload = () => page.getByRole('button', { name: 'Reload', exact: true });
  const reset = () => page.getByRole('button', { name: /Reset .*reload/ });
  const heading = () => page.getByRole('heading', { name: 'The shuttle app couldn’t open' });
  async function state(name) {
    report.states.push({ name, text: await page.locator('body').innerText(), focus: await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent })), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), clearCount: await page.evaluate(() => sessionStorage.getItem('clear-count')) });
  }
  async function trigger() {
    const button = page.getByRole('button', { name: 'Trigger test crash' });
    await button.focus(); await page.keyboard.press('Enter'); await reload().waitFor();
  }
  async function openReset() {
    if (!probe) {
      const summary = page.locator('summary').filter({ hasText: 'Still having trouble?' });
      await summary.focus(); await page.keyboard.press('Enter');
      assert(await reset().isVisible());
    }
  }
  await page.goto('https://crash.test'); await trigger(); await state('initial-crash');
  await page.screenshot({ path: out + '/initial-crash.png' });
  assert.equal(await page.evaluate(() => sessionStorage.getItem('clear-count')), null);
  if (!probe) {
    assert(await heading().evaluate(e => e === document.activeElement));
    assert.equal(await page.locator('pre').isVisible(), false);
    assert.equal(await reset().isVisible(), false);
    await page.keyboard.press('Tab'); assert(await reload().evaluate(e => e === document.activeElement));
  }
  await reload().focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Recovered app fixture' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle.tempUnit')), 'C');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('shuttle-trip-draft')), 'synthetic existing draft');
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle-anon-id')), TEST_ANON_ID);
  report.checks.push('Ordinary reload recovers from a transient render failure and preserves stored preferences, identity and tab draft');
  await page.evaluate(() => localStorage.setItem('test-corrupt', 'yes')); await page.reload(); await reload().waitFor();
  await reload().click(); await reload().waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('test-corrupt')), 'yes');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('clear-count')), null);
  await openReset(); await state('reset-explanation');
  if (!probe) {
    const details = reset().locator('..');
    assert.match(await details.innerText(), /saved places|recent places/);
    assert.match(await details.innerText(), /Your reports/);
    const summary = page.locator('summary').filter({ hasText: 'Technical details' });
    await summary.focus(); await page.keyboard.press('Space');
    assert.match(await page.locator('pre').innerText(), /Synthetic render failure/);
    for (const width of process.env.DESKTOP ? [1280, 640] : [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow at ' + width);
      for (const target of [reload(), reset(), ...await page.locator('summary').all()]) {
        const box = await target.boundingBox(); assert(box.width >= 44 && box.height >= 44, 'Touch target at ' + width);
      }
    }
    await page.screenshot({ path: out + '/expanded-details.png' });
  }
  await reset().focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Recovered app fixture' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('test-corrupt')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle.tempUnit')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle.stopAlerts')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle-recent-trips')), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('clear-count')), '1');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('identity-after-clear')), 'absent');
  // The tester helper seeds its excluded identity again on the next document.
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle-anon-id')), TEST_ANON_ID);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('shuttle-trip-draft')), 'synthetic existing draft');
  report.checks.push('Persistent synthetic storage failure survives ordinary reload; explicit reset clears local storage once and preserves the existing session-storage scope');
  // Same production catch-and-reload behavior when clearing storage itself throws.
  await trigger(); await openReset();
  await page.evaluate(() => { localStorage.setItem('shuttle.tempUnit', 'C'); sessionStorage.setItem('block-clear', 'yes'); });
  if (process.env.DESKTOP) await reset().click(); else await reset().tap();
  await page.getByRole('heading', { name: 'Recovered app fixture' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('shuttle.tempUnit')), 'C');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('clear-count')), '2');
  report.checks.push('Blocked storage clear still reloads; mobile touch reset and keyboard reload/reset exercised');
  await trigger(); await openReset();
  await page.evaluate(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Synthetic blocked storage access', 'SecurityError'); } }));
  await reset().click(); await page.getByRole('heading', { name: 'Recovered app fixture' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('clear-count')), '2');
  report.checks.push('A blocked localStorage getter also still permits reset-triggered reload');
  if (!probe) {
    await page.evaluate(() => {
      const outside = document.createElement('button'); outside.textContent = 'Outside fixture';
      document.body.append(outside); outside.focus(); window.failPage();
    });
    await reload().waitFor();
    assert(await page.getByRole('button', { name: 'Outside fixture' }).evaluate(e => e === document.activeElement));
    report.checks.push('A surviving external focus target is not stolen by crash recovery');
  }
  if (!probe) report.checks.push('Recovery heading receives focus; reload is first tab action; reset and technical details disclose independently; 44px controls and long-stack reflow pass');
  // Caught React render errors are console errors, not unhandled page errors.
  assert.deepEqual(report.errors, []); report.completed = true;
} finally {
  if (page && !report.completed) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
  if (page) await page.close(); if (context) await context.close(); await browser.close();
  report.resourcesClosed = true;
  await fs.writeFile(out + '/crash-recovery.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ completed: report.completed, resourcesClosed: report.resourcesClosed, checks: report.checks, errors: report.errors }, null, 2));
