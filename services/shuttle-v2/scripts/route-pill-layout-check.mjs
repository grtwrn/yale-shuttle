// Built-SPA route-pill typography regression, not physical-service evidence.
// Run after web build: OUT=/tmp/pill-check node --import tsx scripts/route-pill-layout-check.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), out = process.env.OUT;
if (!out) throw new Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import('./testId.mjs');
// Read the canonical roster so a new line cannot silently escape the matrix.
const { ROUTE_LISTS } = await import(service + '/web/src/routes.ts');
const labels = [...ROUTE_LISTS.map(r => r.label), 'Walk'];
const now = Date.parse('2026-09-17T14:00:00-04:00');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = feed.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
feed.buses = ['307', '309'].map((bus_name, i) => ({bus_name, bus_id: i + 1, route_id: 3, ...feed.stop_coords[seq[previous]], last_stop_id: seq[previous], heading: 180, observed_at: now}));
const rows = [];
for (let i = 0; i < 2; i++) for (let h = 0; h < seq.length * 2; h++) {
  const eta = 300 + i * 900 + h * 90;
  rows.push([i, seq[(start + h) % seq.length], eta, eta - 120, eta + 240, h + 1, 0, eta - 120, eta - 120]);
}
rows.sort((a, b) => a[2] - b[2]);
feed.server_eta = {v: 2, at: now, servedAt: now, buses: ['307', '309'].map(b => [b, 'Red', previous, null]), rows,
  distributions: rows.map(r => Array.from({length: 50}, (_, i) => r[2] - 120 + i * 360 / 49))};
const report = {scope: 'Built SPA; frozen synthetic feed; canonical labels substituted into the shared rendered pill, unchanged layout styles', runs: [], errors: []};
const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-gpu']});
try {
  for (const width of [320, 360, 375, 390, 414, 1280]) {
    const context = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 600, hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block'});
    await seedTestId(context);
    await context.addInitScript(({now, fromLL, toLL}) => sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({fromText: 'Pickup', fromLL, toText: 'Union Station', toLL, tripTime: '', expandedKey: null, savedAt: now})), {now, fromLL: feed.stop_coords[48], toLL: feed.stop_coords[121]});
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    try {
      await page.clock.install({time: new Date(now)});
      await page.route('**/*', async r => {
        const u = new URL(r.request().url());
        if (u.hostname !== 'route-pill.test') return r.abort();
        if (u.pathname === '/api/buses') return r.fulfill({json: feed});
        if (u.pathname === '/api/weather') return r.fulfill({status: 204});
        if (u.pathname.startsWith('/api/')) return r.fulfill({json: {reports: [], results: [], routes: []}});
        const f = u.pathname === '/' ? '/index.html' : u.pathname;
        try {return r.fulfill({body: await fs.readFile(service + '/web/dist' + f), contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html'});} catch {return r.fulfill({status: 404});}
      });
      await page.goto('https://route-pill.test');
      const table = page.getByTestId('route-timing-table'); await table.waitFor();
      assert.deepEqual(await table.locator('thead th').allTextContents(), ['Route', 'Board in (min)', 'Next in', 'Arrive at']);
      const pill = table.locator('tbody[data-route="Red"]').getByTestId('route-pill');
      await pill.waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Same component/style for each label; mutate only its text, not its size,
      // parent cells, padding or font. Per-character Ranges catch actual word
      // breaks that scrollWidth alone misses (overflow-wrap:anywhere).
      for (const label of labels) {
        const measured = await pill.evaluate((p, label) => {
          p.textContent = label;
          const text = p.firstChild, brokenWords = [];
          for (const match of label.matchAll(/[^ ]+/g)) {
            const tops = new Set();
            for (let i = match.index; i < match.index + match[0].length; i++) {
              const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
              for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
            }
            if (tops.size > 1) brokenWords.push(match[0]);
          }
          const table = p.closest('table');
          const clipped = [...table.querySelectorAll('thead th,tbody tr:first-child th,tbody tr:first-child td')]
            .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText);
          const button = p.closest('button').getBoundingClientRect();
          return {brokenWords, clipped, pageOverflow: document.documentElement.scrollWidth > innerWidth,
            pillWidth: p.getBoundingClientRect().width, cellWidth: p.closest('th').getBoundingClientRect().width,
            buttonWidth: button.width, buttonHeight: button.height};
        }, label);
        report.runs.push({width, label, ...measured});
        if ((width === 320 && label === 'Green') || (width === 360 && label === 'Orange Day') || (width === 375 && label === 'Grocery Ham'))
          await table.screenshot({path: out + '/' + width + '-' + label.replaceAll(' ', '_') + '.png'});
      }
    } finally {await page.close(); await context.close();}
  }
} finally {await browser.close(); report.resourcesClosed = true; await fs.writeFile(out + '/RESULT.json', JSON.stringify(report, null, 2));}
const failures = report.runs.filter(r => r.brokenWords.length || r.clipped.length || r.pageOverflow || r.buttonWidth < 44 || r.buttonHeight < 44);
console.log(JSON.stringify({checked: report.runs.length, failures, errors: report.errors, resourcesClosed: report.resourcesClosed}, null, 2));
assert.deepEqual(report.errors, []);
assert.deepEqual(failures, [], 'All canonical route words must stay intact, without cell/page overflow or undersized route controls');
