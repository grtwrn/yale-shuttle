// Run on hosted CI, not the watcher Pi. Check the exact files that will ship.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(service, 'web/public/minimap-options');
const out = path.join(service, 'gallery-review');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const result = { widths: [], errors: [], requests: [] };
try {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', e => result.errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      result.requests.push(url.pathname);
      assert.equal(url.hostname, 'gallery.test');
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      const file = url.pathname.replace(/^\/minimap-options\//, '');
      assert(/^(index.html|style.css|gallery.js|previews\/option-\d\d.png)$/.test(file), `Unexpected request: ${url.pathname}`);
      const contentType = file.endsWith('.png') ? 'image/png' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
      return route.fulfill({ body: await fs.readFile(path.join(source, file)), contentType });
    });
    await page.goto('https://gallery.test/minimap-options/index.html');
    await page.locator('#option-10').waitFor();
    assert.equal(await page.locator('.concept').count(), 10);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow');
    for (let id = 1; id <= 10; id++) {
      const card = page.locator(`#option-${id}`);
      await card.scrollIntoViewIfNeeded();
      await card.locator('img').evaluate(i => i.decode());
      assert(await card.evaluate(el => el.scrollWidth <= el.clientWidth), `Card ${id} clipped at ${width}`);
      if (width === 390) await card.screenshot({ path: path.join(out, `option-${String(id).padStart(2, '0')}.png`) });
    }
    await page.screenshot({ path: path.join(out, `gallery-${width}.png`), fullPage: true });
    const compare = page.locator('[data-compare="1"]');
    await compare.focus(); await page.keyboard.press('Enter');
    assert(await page.getByRole('dialog').isVisible());
    assert.match(await page.locator('#variant-image').getAttribute('src'), /option-01.png/);
    await page.locator('#variant-image').evaluate(i => i.decode());
    await page.screenshot({ path: path.join(out, `compare-${width}.png`) });
    await page.keyboard.press('Escape');
    assert(await compare.evaluate(e => document.activeElement === e), 'Dialog did not restore focus');
    await page.locator('[data-compare="10"]').click();
    await page.getByRole('button', { name: 'Close comparison', exact: true }).click();
    await page.locator('[data-save="2"]').click();
    await page.locator('[data-save="8"]').click();
    await page.locator('#favorites').click();
    assert.equal(await page.locator('.concept:visible').count(), 2);
    await page.reload();
    assert.equal(await page.locator('#saved-count').innerText(), '2');
    await page.locator('#favorites').click();
    assert.equal(await page.locator('.concept:visible').count(), 2);
    await page.locator('[data-save="2"]').click(); await page.locator('[data-save="8"]').click();
    assert(await page.locator('#empty').isVisible());
    await page.locator('#all').click();
    assert.equal(await page.locator('.concept:visible').count(), 10);
    result.widths.push(width);
    await context.close();
  }
  assert.deepEqual(result.errors, []);
  assert(!result.requests.some(p => p.startsWith('/api/')));
} finally { await browser.close(); await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ widths: result.widths, errors: result.errors }));
