/** Render small label-only alternatives from the actual app, on hosted CI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(service, 'web/public/minimap-options/previews');
const hash = data => createHash('sha256').update(data).digest('hex');
const sources = ['web/src/TransitMap.tsx', 'web/src/mapLabels.ts', 'scripts/__fixtures__/minimap-label-feed.json', 'scripts/minimap-label-render.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await fs.readFile(path.join(service, name)))])));
let reviewed;
try { reviewed = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (reviewed) {
  const manifest = reviewed;
  assert.deepEqual(manifest.sourceHashes, sourceHashes, 'Preview source changed: remove previews and regenerate in hosted CI');
  for (const [file, checksum] of Object.entries(manifest.images)) assert.equal(hash(await fs.readFile(path.join(out, file))), checksum, `Image changed: ${file}`);
  console.log('Reviewed preview images match their source and checksums.');
  process.exit(0);
}
await fs.mkdir(out, { recursive: true });
const feed = JSON.parse(await fs.readFile(path.join(service, 'scripts/__fixtures__/minimap-label-feed.json'), 'utf8'));
const now = feed.server_eta.servedAt;
const manifest = { recordedAt: new Date(now).toISOString(), sourceHashes, images: {}, checks: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    geolocation: { latitude: 41.324769, longitude: -72.923522 }, permissions: ['geolocation'], timezoneId: 'America/New_York', serviceWorkers: 'block' });
  await seedTestId(context);
  await context.addInitScript(now => {
    const D = Date;
    window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    // Keep this recorded example fixed across every screenshot; timeouts still
    // run for map initialization and normal UI interactions.
    window.setInterval = () => 0;
  }, now);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (['tile.openstreetmap.org', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)) return route.continue();
    if (u.hostname !== 'minimap.test') return route.abort();
    if (u.pathname === '/api/buses') return route.fulfill({ json: feed });
    if (u.pathname === '/api/geocode') return route.fulfill({ json: { results: [{ display_name: 'Rosenkranz Hall', lat: 41.314701, lon: -72.924551, type: 'college', class: 'yale' }] } });
    if (u.pathname === '/api/weather') return route.fulfill({ status: 204 });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { reports: [], results: [], routes: [] } });
    const f = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({ body: await fs.readFile(service + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto('https://minimap.test');
  await page.getByPlaceholder('Where do you want to go?').fill('Rosenkranz');
  await page.getByText('Rosenkranz Hall', { exact: true }).first().click();
  const more = page.getByRole('button', { name: /Show \d+ more route/ });
  if (await more.isVisible()) await more.click();
  const trip = page.getByRole('button', { name: 'View Red trip details', exact: true });
  await trip.focus(); await page.keyboard.press('Enter');
  await page.locator('.bus-wait-label').waitFor();
  const map = page.locator('.trip-map-wrap');
  await map.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.trip-map-wrap .leaflet-tile')];
    return images.length > 0 && images.every(i => i.complete && i.naturalWidth > 0);
  });
  // Leaflet uses Date.now() for tile fade-in. The frozen scenario clock
  // keeps that opacity at zero; finish only that animation for capture.
  await page.addStyleTag({ content: '.trip-map-wrap .leaflet-tile { opacity: 1 !important; }' });
  await page.waitForTimeout(500);
  await map.evaluate(el => {
    window.previewOriginal = [...el.querySelectorAll('.leaflet-tooltip')].map(t => ({ t, html: t.innerHTML, style: t.getAttribute('style') }));
    const legend = [...el.querySelectorAll(':scope > div')].find(n => n.style.position === 'absolute' && n.style.bottom);
    if (!legend) throw Error('Current route legend not found');
    window.previewLegend = { el: legend, html: legend.innerHTML };
  });
  const geometry = () => map.evaluate(el => ({
    size: [el.clientWidth, el.clientHeight],
    routes: [...el.querySelectorAll('path')].map(p => p.getAttribute('d')),
    markers: [...el.querySelectorAll('.leaflet-marker-icon')].map(m => m.getAttribute('style')),
    tiles: [...el.querySelectorAll('.leaflet-tile')].map(i => i.src),
  }));
  const originalGeometry = await geometry();
  for (let id = 0; id <= 10; id++) {
    await map.evaluate((el, id) => {
      for (const { t, html, style } of window.previewOriginal) { t.innerHTML = html; t.setAttribute('style', style ?? ''); }
      window.previewLegend.el.innerHTML = window.previewLegend.html;
      const wait = el.querySelector('.bus-wait-label').closest('.leaflet-tooltip');
      const label = wait.querySelector('.bus-wait-label');
      const tips = [...el.querySelectorAll('.leaflet-tooltip')].filter(t => t !== wait);
      const pickup = tips.find(t => t.textContent.includes('🚌'));
      const destination = tips.find(t => t.textContent.includes('🏁'));
      if (!pickup || !destination) throw Error('Current pickup/destination chips not found');
      const hide = node => { node.style.visibility = 'hidden'; };
      if (id === 1) hide(destination);
      if (id === 2) hide(wait);
      if (id === 3) {
        const route = label.querySelector('.bus-wait-route');
        route.textContent = route.textContent.replace(/^Red/, 'R');
      }
      if (id === 4) label.querySelector('.bus-wait-route').remove();
      if (id === 5) for (const chip of tips) chip.innerHTML = chip.innerHTML.replace(/\(R\)\s*/g, '');
      if (id === 6) hide(pickup);
      if (id === 7) { hide(destination); hide(wait); }
      if (id === 8) {
        const bus = el.querySelector('.bus-pin-sm').getBoundingClientRect();
        const box = wait.getBoundingClientRect();
        wait.style.translate = `${bus.x + bus.width / 2 - box.x - box.width / 2}px ${bus.bottom + 6 - box.top}px`;
      }
      if (id === 9) {
        hide(wait);
        const time = label.textContent.replace(/^Red\s*/, '');
        window.previewLegend.el.append(document.createTextNode(` · ${time}`));
      }
      if (id === 10) for (const tip of [wait, pickup, destination]) hide(tip);
    }, id);
    assert.deepEqual(await geometry(), originalGeometry, `Option ${id} changed map geometry`);
    const name = `option-${String(id).padStart(2, '0')}.png`;
    const bytes = await map.screenshot({ path: path.join(out, name) });
    manifest.images[name] = hash(bytes);
    manifest.checks.push({ id, geometryUnchanged: true });
  }
  assert.equal(new Set(Object.values(manifest.images)).size, 11, 'An option did not visibly change its labels');
  assert.deepEqual(errors, []);
  manifest.dimensions = originalGeometry.size;
  manifest.errors = errors;
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
} finally { await browser.close(); }
console.log('Rendered current map and 10 label-only alternatives with unchanged map geometry.');
