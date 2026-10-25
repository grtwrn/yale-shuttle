// Recorded Green/Purple stands and source-bound reconstructed Pink regression,
// actual SPA, intercepted APIs only. Display consistency, not ETA accuracy.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
const captures = JSON.parse(await fs.readFile('web/src/__fixtures__/folded-standing-display.json', 'utf8'));
const pink = JSON.parse(await fs.readFile('web/src/__fixtures__/pink-standing-travel-20261023.json', 'utf8'));
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
      const nextStop = feed.stop_names[bus.route_id === 9 ? 23 : 24];
      const nextRow = page.getByRole('button', { name: `Alert me when ${line} reaches ${nextStop}`, exact: true }).locator('..');
      assert.match(await nextRow.innerText(), /NEXT/, `${line} NEXT follows this bus's actual call sequence`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reflow');
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/${line.toLowerCase()}-${width}.png`, fullPage: true });
      results.push({ line, width, bus: bus.bus_name, stop, nextStop, passed: true });
      console.log(`PASS ${line} ${width}px: ${bus.bus_name} badge and stand at ${stop}`);
    } finally { await ctx.close(); }
  }
  // Pink's published twelve stops are unique, while the repaired ring has
  // extra physical passes. A stand on one of them must not wrap its next-stop
  // banner around the published loop (actual 2026-10-23 #324 screenshot).
  const capture = pink.snapshots.find(s => s.sampleAt === '2026-10-23T15:43:28.701Z');
  assert(capture);
  for (const width of [307, 390, 1280]) {
    const feed = { buses: [capture.bus], routes: capture.routeStops, route_paths: capture.routePaths,
      stop_coords: capture.stopCoords, stop_names: capture.stopNames, server_eta: capture.wire,
      segments: {}, dwells: {}, announcements: [], route_active: {} };
    const ctx = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 600,
      hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block'});
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(storage => {
        localStorage.setItem('listView', 'map');
        for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
      }, pink.boardedStorage);
      const page = await ctx.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({time: new Date(capture.sampleAt)});
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== new URL(base).hostname) return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({json: feed});
        if (u.pathname === '/api/weather') return route.fulfill({status: 204});
        if (u.pathname.startsWith('/api/')) return route.fulfill({json: {results: [], reports: []}});
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({body: await fs.readFile('web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}); }
        catch { return route.fulfill({status: 404}); }
      });
      await page.goto(base, {waitUntil: 'domcontentloaded'});
      await page.getByRole('alertdialog').getByText('Get off at the next stop', {exact: true}).waitFor();
      const body = await page.locator('body').innerText();
      assert.match(body, /Get off NEXT stop!/);
      assert.doesNotMatch(body, /Your stop is 10 stops away|10 stops ·/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pink reflow');
      await page.screenshot({path: `${out}/pink-${width}.png`, fullPage: true});
      results.push({line: 'Pink', width, bus: '#324', exitStop: 123, expectedStops: 1,
        source: 'Reconstructed canonical source-bound snapshot; not original browser HTTP', passed: true});
      console.log(`PASS Pink ${width}px: next-stop banner and alert retain travel slot across VA Outbound stand`);
    } finally { await ctx.close(); }
  }
  // The badge and its clock must describe the same vehicle even when two
  // Green buses name the same curb, or only the other bus has a model rest.
  const capsule = JSON.parse(await fs.readFile('web/src/__fixtures__/route-card-bus-clock-20261025.json', 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(capsule.encoding, 'br-base64');
  const compressed = Buffer.from(capsule.data, 'base64');
  assert.equal(compressed.length, capsule.compressedBytes);
  assert.equal(hash(compressed), capsule.compressedSHA256);
  const raw = brotliDecompressSync(compressed);
  assert.equal(raw.length, capsule.rawBytes);
  assert.equal(hash(raw), capsule.rawSHA256);
  const fixture = JSON.parse(raw);
  assert.deepEqual(fixture.cases.map(c => c.seq), [290, 291, 298, 299]);
  const clockFailures = [];
  let matchingClockChecks = 0, missingOwnRestChecks = 0;
  for (const capture of fixture.cases) for (const reverse of [false, true]) for (const width of [307, 390, 1280]) {
    assert.equal(hash(capture.originalPayloadJSON), capture.sourceBodySHA256);
    const feed = JSON.parse(capture.originalPayloadJSON);
    if (reverse) feed.buses.reverse(); // Same original values; a display order control, not a new trajectory.
    const ctx = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 600,
      hasTouch: width < 600, timezoneId: 'America/New_York', serviceWorkers: 'block'});
    const detail = {line: 'Green', stop: 26, seq: capture.seq, width, rawBusOrder: reverse ? 'reversed' : 'recorded'};
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(() => localStorage.setItem('listView', 'map'));
      const page = await ctx.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({time: new Date(capture.at + 1000)});
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== new URL(base).hostname) return route.abort();
        if (u.pathname === '/api/buses') return route.fulfill({json: feed});
        if (u.pathname === '/api/weather') return route.fulfill({status: 204});
        if (u.pathname.startsWith('/api/')) return route.fulfill({json: {results: [], reports: []}});
        if (process.env.BOT_BASE_URL) return route.continue();
        const file = u.pathname === '/' ? '/index.html' : u.pathname;
        try { return route.fulfill({body: await fs.readFile('web/dist' + file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}); }
        catch { return route.fulfill({status: 404}); }
      });
      await page.goto(base, {waitUntil: 'domcontentloaded'});
      await page.locator('button[title="Show only Green"]').click();
      const row = page.getByRole('button', {name: 'Alert me when Green reaches Building 900', exact: true}).locator('..');
      await row.locator('span').filter({hasText: /^(308|330)$/}).waitFor();
      const text = await row.innerText(), badges = text.match(/\b(?:308|330)\b/g) ?? [];
      assert.equal(badges.length, 1, 'The row identifies one displayed bus');
      const displayedBus = badges[0]; detail.displayedBus = displayedBus;
      const servedBus = feed.server_eta.buses.find(bus => bus[0] === displayedBus && bus[1] === 'Green');
      assert(servedBus, 'Displayed bus must have its own original served identity');
      const rest = servedBus[3]?.stopId === 26 ? servedBus[3] : null;
      const clock = text.match(/⏸\s+(\d+):(\d{2})\s+·/);
      if (rest) {
        assert(clock, `${displayedBus} keeps its own matching rest clock`);
        const elapsed = Number(clock[1]) * 60 + Number(clock[2]);
        const now = await page.evaluate(() => Date.now());
        const expected = rest.standingSec + (now - capture.at) / 1000;
        assert(Math.abs(elapsed - expected) <= 2, `${displayedBus} clock ${elapsed}s must match its own ${expected}s, not another vehicle`);
        matchingClockChecks++;
        Object.assign(detail, {elapsed, expected, ownRestPresent: true});
      } else {
        assert.equal(clock, null, `${displayedBus} must not borrow another bus's pause clock`);
        missingOwnRestChecks++;
        detail.ownRestPresent = false;
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Green clock reflow');
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({path: `${out}/bus-clock-${capture.seq}-${reverse ? 'reversed' : 'recorded'}-${width}.png`, fullPage: true});
      results.push({...detail, passed: true});
      console.log(`PASS Green bus clock ${capture.seq} ${width}px ${detail.rawBusOrder}: ${displayedBus}`);
    } catch (error) {
      const failure = {...detail, passed: false, error: error.message};
      clockFailures.push(failure); results.push(failure);
      console.error(`FAIL Green bus clock: ${JSON.stringify(failure)}`);
    } finally { await ctx.close(); }
  }
  assert(matchingClockChecks >= 3, 'Real matching-bus clock positive controls must be observed');
  assert(missingOwnRestChecks >= 3, 'Real displayed-bus-without-rest controls must be observed');
  assert.deepEqual(clockFailures, []);
  assert.deepEqual(errors, []);
} finally { await browser.close(); await fs.writeFile(`${out}/results.json`, JSON.stringify({ scope: 'Public recorded feed, actual SPA, intercepted APIs; display consistency only', results, errors }, null, 2) + '\n'); }
