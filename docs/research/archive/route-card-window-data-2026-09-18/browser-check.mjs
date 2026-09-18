import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const service = process.cwd();
const out = new URL('.', import.meta.url).pathname;
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const now = Date.parse('2026-09-18T10:00:00-04:00');
const base = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
base.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const seq = base.routes['3'], start = seq.indexOf(48), previous = (start + seq.length - 1) % seq.length;
base.buses = ['307', '309'].map((bus_name, i) => ({ bus_name, bus_id: i + 1, route_id: 3,
  ...base.stop_coords[seq[previous]], last_stop_id: seq[previous], heading: 180, observed_at: now }));
const rows = [];
for (let i = 0; i < 2; i++) for (let h = 0; h < seq.length * 2; h++) {
  const eta = 300 + i * 900 + h * 90;
  rows.push([i, seq[(start + h) % seq.length], eta, eta - 120, eta + 240, h + 1, 0, eta - 120, eta - 120]);
}
base.server_eta = { v: 2, at: now, servedAt: now, buses: ['307', '309'].map(b => [b, 'Red', previous, null]), rows };
const report = { scope: 'Built SPA, synthetic warm-server forecast fixture, all external requests blocked', runs: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
try {
  for (const width of [360, 390, 1280]) {
    const feed = structuredClone(base);
    const refreshDots = () => {
      feed.server_eta.rows.sort((a, b) => a[2] - b[2]);
      feed.server_eta.distributions = feed.server_eta.rows.map(r => Array.from({ length: 50 }, (_, i) => r[3] + i * (r[4] - r[3]) / 49));
    };
    refreshDots();
    const run = { width, states: [], requests: [], errors: [] };
    report.runs.push(run);
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 600,
      timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(context);
    await context.addInitScript(({ now, fromLL, toLL }) => {
      const D = Date;
      window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: 'Division / Prospect', fromLL,
        toText: 'Union Station and the final walking destination', toLL, tripTime: '', expandedKey: null, savedAt: now }));
    }, { now, fromLL: { lat: feed.stop_coords[48].lat, lon: feed.stop_coords[48].lon - 0.0017 }, toLL: feed.stop_coords[121] });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', e => run.errors.push(e.message));
    await page.route('**/*', async r => {
      const u = new URL(r.request().url());
      if (u.hostname !== 'arrival-card.test') return r.abort();
      if (u.pathname.startsWith('/api/')) run.requests.push({ method: r.request().method(), path: u.pathname });
      if (u.pathname === '/api/buses') return r.fulfill({ json: feed });
      if (u.pathname === '/api/weather') return r.fulfill({ status: 204 });
      if (u.pathname.startsWith('/api/')) return r.fulfill({ json: { reports: [], results: [], routes: [] } });
      const file = u.pathname === '/' ? '/index.html' : u.pathname;
      try { return r.fulfill({ body: await fs.readFile(service + '/web/dist' + file),
        contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return r.fulfill({ status: 404 }); }
    });
    await page.goto('https://arrival-card.test', { waitUntil: 'domcontentloaded' });
    const card = () => page.getByRole('button', { name: 'View Red trip details', exact: true });
    await card().waitFor();
    async function option(expected) {
      await page.waitForFunction(expected => {
        const root = document.getElementById('root'), key = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
        if (!key) return false;
        const stack = [root[key].stateNode?.current ?? root[key]];
        let count = 0;
        while (stack.length && count++ < 10000) {
          const f = stack.pop();
          if (f.child) stack.push(f.child);
          if (f.sibling) stack.push(f.sibling);
          let h = f.memoizedState, n = 0;
          while (h && typeof h === 'object' && n++ < 500) {
            const m = h.memoizedState;
            if (Array.isArray(m) && Array.isArray(m[0])) for (const o of m[0]) {
              if (o?.mode === 'shuttle' && o.routeLabel === 'Red' && (Object.hasOwn(o, 'departed') || o.etaUnavailable)
                && Boolean(o.etaUnavailable) === Boolean(expected.unavailable)
                && Boolean(o.journeyArrival) === expected.journey
                && (!expected.bus || o.journeyArrival?.busName === expected.bus)
                && (!expected.relation || o.livePickupSelection?.relation === expected.relation)) {
                window.__arrivalOption = o;
                return true;
              }
            }
            h = h.next;
          }
        }
        return false;
      }, expected);
      return page.evaluate(() => window.__arrivalOption);
    }
    async function capture(name, expected) {
      const selected = await option(expected);
      await page.waitForTimeout(80);
      const row = card(), display = row.getByTestId('destination-arrival');
      const text = await row.innerText();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow: ' + name);
      if (expected.unavailable) {
        assert.equal(await display.count(), 0);
        assert.match(text, /ETA unavailable/);
      } else {
        assert.equal(await display.getAttribute('data-kind'), expected.journey ? 'window' : 'point');
        if (expected.journey) {
          const range = await page.evaluate(a => {
            const fmt = at => { const d = new Date(at); return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() >= 12 ? 'p' : 'a'}`; };
            return `${fmt(Math.floor(a.lowMs / 60000) * 60000)}–${fmt(Math.ceil(a.highMs / 60000) * 60000)}`;
          }, selected.journeyArrival);
          assert.match(await display.innerText(), new RegExp(range));
          assert.match(await display.getAttribute('aria-label'), /Estimated arrival at Union Station/);
          assert.match(await display.getAttribute('title'), new RegExp('shuttle #' + selected.journeyArrival.busName));
        }
        const bounds = await display.boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width, 'destination text outside viewport');
        assert(await display.evaluate(e => e.scrollWidth <= e.clientWidth), 'clipped destination content');
        assert(await display.locator('span[style*="white-space"]').evaluateAll(es => es.every(e => { const r = document.createRange(); r.selectNodeContents(e); return r.getClientRects().length === 1; })), 'clock digits wrap');
      }
      run.states.push({ name, selected, text });
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}${name}-${width}.png` });
      return selected;
    }
    const refresh = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await capture('same-bus', { journey: true, bus: '307', relation: 'same-visit' });
    const walking = page.getByRole('button', { name: 'View Walk trip details', exact: true }).getByTestId('destination-arrival');
    assert.equal(await walking.getAttribute('data-kind'), 'point');
    assert.match(await walking.innerText(), /~/);

    for (const r of feed.server_eta.rows) if (r[0] === 0) {
      r[2] -= 280; r[3] = Math.max(0, r[3] - 280); r[4] -= 280; r[7] = Math.max(0, r[7] - 280); r[8] = Math.max(0, r[8] - 280);
    }
    refreshDots(); await refresh();
    const distinct = await capture('different-bus', { journey: true, bus: '309', relation: 'different-bus' });
    const savedRows = structuredClone(feed.server_eta.rows);
    feed.server_eta.rows = savedRows.filter(r => r[1] !== distinct.alightStopId);
    refreshDots(); await refresh();
    const missing = await capture('missing-destination', { journey: false, relation: 'different-bus' });
    assert.equal(missing.waitSec, distinct.waitSec);
    assert.equal(missing.busEtaSec, distinct.busEtaSec);
    feed.server_eta.rows = savedRows.filter(r => r[0] === 0);
    refreshDots(); await refresh();
    await capture('same-bus-later-visit', { journey: true, bus: '307', relation: 'same-bus-later-visit' });
    feed.server_eta.rows = savedRows; refreshDots(); await refresh();
    await capture('recovered', { journey: true, bus: '309', relation: 'different-bus' });
    await card().focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '← All routes', exact: true }).waitFor();
    assert.equal(await page.getByTestId('destination-arrival').getAttribute('data-kind'), 'window');
    assert.equal(await page.getByRole('button', { name: /I'm on #309/ }).count(), 1);
    await page.getByTestId('destination-arrival').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}expanded-${width}.png` });
    await page.getByRole('button', { name: '← All routes', exact: true }).click();
    feed.server_eta.servedAt = now + 45000; await refresh();
    await capture('stale', { journey: false, unavailable: true });
    feed.server_eta.servedAt = now; await refresh();
    await capture('fresh-again', { journey: true, bus: '309', relation: 'different-bus' });
    await page.getByRole('button', { name: 'Plan for later…', exact: true }).click();
    await page.getByLabel('Departure time', { exact: true }).fill('2026-09-18T11:00');
    await page.getByText(/Estimated from service hours and typical wait and travel times/).waitFor();
    await card().waitFor();
    const future = card().getByTestId('destination-arrival');
    assert.equal(await future.getAttribute('data-kind'), 'point');
    assert.match(await future.innerText(), /~/);
    assert.doesNotMatch(await future.innerText(), /–/);
    await card().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}future-${width}.png` });
    run.future = await card().innerText();
    assert.deepEqual(run.errors, []);
    assert(!run.requests.some(r => r.path === '/api/report'));
    await context.close();
  }
} catch (e) {
  report.errors.push(String(e.stack));
  throw e;
} finally {
  await browser.close();
  await fs.writeFile(out + 'browser-results.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ widths: report.runs.map(r => r.width), states: report.runs.map(r => r.states.length), errors: report.errors }));
