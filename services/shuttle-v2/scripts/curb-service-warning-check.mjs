import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {seedTestId} from './testId.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Recorded curb observations must not lose their closing caution when the
 * forecast temporarily contains only the next lap by that same vehicle. */
export async function checkCurbServiceWarning({browser, production = false, out, assetDirectory = 'web/dist'}) {
  await fs.mkdir(out, {recursive: true});
  const fixture = JSON.parse(await fs.readFile('web/src/__fixtures__/blue-weekend-curb-warning-20261024.json', 'utf8'));
  const frames = fixture.frames.map(frame => {
    const raw = gunzipSync(Buffer.from(frame.jsonGzipBase64, 'base64'));
    assert.equal(hash(raw), frame.sha256);
    return {...frame, raw: raw.toString(), derived: false};
  });
  const first = JSON.parse(frames[0].raw), scenario = {
    from: first.stop_coords[fixture.pickupStop], to: first.stop_coords[fixture.destinationStop],
    fromName: first.stop_names[fixture.pickupStop], toName: first.stop_names[fixture.destinationStop],
  };
  const results = [];
  for (const width of [368, 1280]) {
    for (const mode of ['cold', 'continuous']) {
      for (const selected of mode === 'cold' ? frames.map(frame => [frame]) : [frames]) {
        results.push(...await render(selected, width, mode, true));
      }
    }
    // A constructed second bus reaching the same stop before closing is
    // evidence against this caution. Keep the literal current curb pickup.
    const feed = JSON.parse(frames[0].raw), wire = feed.server_eta;
    const currentIndex = wire.buses.findIndex(row => row[0].replace(/^#/, '') === fixture.bus);
    assert(currentIndex >= 0);
    const originalBus = feed.buses.find(bus => bus.bus_name.replace(/^#/, '') === fixture.bus);
    assert(originalBus);
    const other = {...originalBus, bus_id: originalBus.bus_id + 1000000, bus_name: '#999', stationary: false};
    for (const name of ['at_stop_id', 'at_stop_since', 'stationary_since', 'last_moved_at']) delete other[name];
    const previous = feed.stop_coords[other.last_stop_id];
    assert(previous); other.lat = previous.lat; other.lon = previous.lon;
    const otherIndex = wire.buses.length;
    feed.buses.push(other); wire.buses.push(['999', fixture.route, 0, null]);
    if (wire.travel) wire.travel.push(0);
    const following = [otherIndex, fixture.pickupStop, 300, 240, 360, 2, 0, 300, 240];
    wire.rows.push(following);
    if (wire.distributions) wire.distributions.push(Array.from({length: 50}, (_, i) => 240 + i * 120 / 49));
    const raw = JSON.stringify(feed);
    results.push(...await render([{...frames[0], raw, sha256: hash(raw), derived: true}], width, 'following-before-close', false));
  }
  assert.equal(results.length, 14);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({productionAssets: production, results,
    literalSnapshots: frames.map(({seq, sha256}) => ({seq, sha256})), literalSourceClocksPreserved: true,
    scope: 'Recorded three-snapshot UI regression and a derived earlier-following-bus control; no physical ETA or service-end truth claim.'}, null, 2) + '\n');
  return results;

  async function render(selected, width, mode, shouldWarn) {
    let active = selected[0], page;
    const errors = [], receipts = [], views = [];
    const ctx = await browser.newContext({viewport: {width, height: 854}, isMobile: width < 500,
      hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block'});
    try {
      await seedTestId(ctx);
      await ctx.addInitScript(({scenario, now}) => {
        localStorage.setItem('listView', 'trip');
        sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({fromText: scenario.fromName, fromLL: scenario.from,
          toText: scenario.toName, toLL: scenario.to, tripTime: '', expandedKey: null, savedAt: now}));
      }, {scenario, now: active.at + 1250});
      page = await ctx.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.clock.install({time: new Date(active.at)});
      await page.clock.pauseAt(new Date(active.at + 1250));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'curb-warning.test') return route.abort();
        if (url.pathname === '/api/buses') {
          receipts.push({seq: active.seq, bodySHA256: active.sha256, receivedAt: await page.evaluate(() => Date.now())});
          return route.fulfill({body: active.raw, contentType: 'application/json'});
        }
        if (url.pathname === '/api/weather') return route.fulfill({status: 204});
        if (url.pathname.startsWith('/api/')) return route.fulfill({json: {reports: [], results: [], ok: true}});
        if (route.request().method() !== 'GET') return route.abort();
        if (production) {
          const response = await route.fetch({url: 'https://yale-shuttle.fly.dev' + url.pathname + url.search});
          return route.fulfill({response});
        }
        const name = url.pathname === '/' ? '/index.html' : url.pathname;
        assert(!name.includes('..'));
        try {
          return route.fulfill({body: await fs.readFile(assetDirectory + name), contentType:
            name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
        } catch { return route.fulfill({status: 404}); }
      });
      for (let index = 0; index < selected.length; index++) {
        active = selected[index];
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
        if (index === 0) await page.goto('https://curb-warning.test', {waitUntil: 'domcontentloaded'});
        else await page.clock.runFor(5200);
        await (await response).finished();
        const receipt = receipts.findLast(row => row.seq === active.seq); assert(receipt);
        await page.waitForFunction(receivedAt => {
          const root = document.getElementById('root'), key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
          const host = key && root[key], start = host?.stateNode?.current ?? host, pending = start ? [start] : [];
          while (pending.length) {
            const fiber = pending.pop(), props = fiber.memoizedProps;
            if (props && Array.isArray(props.buses) && props.lastBusUpdateAt === receivedAt) return true;
            if (fiber.child) pending.push(fiber.child); if (fiber.sibling) pending.push(fiber.sibling);
          }
          return false;
        }, receipt.receivedAt);
        await page.clock.runFor(800);
        const row = page.locator(`tbody[data-route="${fixture.route}"][data-pickup="${fixture.pickupStop}"][data-alight="${fixture.destinationStop}"]`);
        await row.waitFor();
        const text = await row.innerText();
        const screen = `${mode}-${active.seq}-${width}.png`;
        await page.screenshot({path: path.join(out, screen), fullPage: true});
        assert.equal(await row.getAttribute('data-countdown-bus'), fixture.bus);
        assert.match(await row.getByTestId('route-pickup').innerText(), /At stop/);
        assert.equal(text.includes('Could be the last bus'), shouldWarn, `${mode}/${width}/${active.seq}: ${text}`);
        const following = row.getByTestId('route-next-arrival');
        if (!active.derived) assert.equal(await following.count(), 0,
          'The later same-bus warning evidence must not be advertised as Next in');
        else if (await following.count()) assert.match(await following.innerText(), /~[45] min/,
          'Any ordinary following label must describe the earlier real bus');
        assert.deepEqual(errors, []);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        views.push({mode, width, seq: active.seq, derivedEarlierBusControl: active.derived,
          bodySHA256: active.sha256, sourceCommitted: true, receipt, cautionVisible: shouldWarn,
          currentPickupRetained: true, summary: text, screen, pageErrors: [...errors]});
      }
    } catch (error) {
      if (page) await fs.writeFile(path.join(out, `failure-${mode}-${active.seq}-${width}.json`), JSON.stringify({
        error: String(error.stack ?? error), receipts, errors, body: await page.locator('body').innerText().catch(() => '')}, null, 2));
      throw error;
    } finally { await ctx.unrouteAll({behavior: 'wait'}); await ctx.close(); }
    return views;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true});
  try {
    const results = await checkCurbServiceWarning({browser, out: process.env.FOLLOWING_CURB_OUT ?? 'pr-preview/curb-service-warning',
      production: process.env.FOLLOWING_PICKUP_PRODUCTION_ASSETS === '1', assetDirectory: process.env.FOLLOWING_CURB_ASSET_DIR ?? 'web/dist'});
    console.log(JSON.stringify({ok: true, screens: results.length, literalScreens: results.filter(row => !row.derivedEarlierBusControl).length}));
  } finally { await browser.close(); }
}
