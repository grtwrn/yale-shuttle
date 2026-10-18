import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';
// Recorded public Red feed plus a declared downstream-delay counterfactual.
// No historical driver hold or ETA accuracy is inferred from these cases.
const service = process.cwd(), out = process.env.ALIGHTING_OUT ?? 'pr-preview/alighting-comparison';
const local = process.env.ALIGHTING_PRODUCTION_ASSETS !== '1', expected = local ? null : process.argv[2];
if (!local)
    assert.match(expected ?? '', /^[a-f0-9]{12}$/);
const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8')), sha = b => createHash('sha256').update(b).digest('hex');
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const recorded = await read(service + '/web/src/__fixtures__/red-reporting-2026-10-14.json');
if (!local) {
    const health = await fetch('https://yale-shuttle.fly.dev/healthz', { signal: AbortSignal.timeout(12000) }).then(r => r.json());
    assert(health.ok && health.build === expected);
}
const assets = new Map(), manifest = {}, results = [];
async function asset(route, u) {
    assert.equal(route.request().method(), 'GET');
    const key = u.pathname === '/' ? '/index.html' : u.pathname;
    assert(key === '/index.html' || /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(key));
    let bytes = assets.get(key);
    if (!bytes) {
        assert(assets.size < 20);
        if (local)
            bytes = await fs.readFile(service + '/web/dist' + key);
        else {
            const r = await fetch('https://yale-shuttle.fly.dev' + (key === '/index.html' ? '/' : key), { signal: AbortSignal.timeout(12000) });
            assert(r.ok);
            bytes = Buffer.from(await r.arrayBuffer());
        }
        assert(bytes.length < 2 * 1024 * 1024);
        assets.set(key, bytes);
        const retained = out + '/assets' + key;
        await fs.mkdir(path.dirname(retained), { recursive: true, mode: 0o700 });
        await fs.writeFile(retained, bytes, { flag: 'wx', mode: 0o600 });
        manifest[key] = { bytes: bytes.length, sha256: sha(bytes), retained };
    }
    return route.fulfill({ body: bytes, contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'text/html' });
}
const variants = {};
for (const variant of ['recorded', 'extra-hold']) {
    const feed = structuredClone(recorded.feed), wire = feed.server_eta;
    if (variant === 'extra-hold') {
        const bi = wire.buses.findIndex(b => b[0] === '126' && b[1] === 'Red');
        assert(bi >= 0);
        const hold = wire.rows.find(r => r[0] === bi && r[1] === 11);
        assert(hold);
        let changed = 0;
        for (const [i, row] of wire.rows.entries())
            if (row[0] === bi && row[5] > hold[5]) {
                for (const col of [2, 3, 4, 7, 8])
                    row[col] += 600;
                if (wire.distributions?.[i])
                    wire.distributions[i] = wire.distributions[i].map(s => s + 600);
                changed++;
            }
        assert(changed > 0);
    }
    variants[variant] = feed;
    await fs.writeFile(out + '/' + variant + '-feed.json', JSON.stringify(feed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
let failed;
try {
    for (const width of [368, 1280])
        for (const origin of [120, 27])
            for (const variant of ['recorded', 'extra-hold']) {
                const feed = variants[variant];
                let currentFeed = structuredClone(feed);
                const clock = recorded.receivedAt, from = feed.stop_coords[origin], to = feed.stop_coords[100], errors = [];
                const option = { boardStopId: origin, alightStopId: variant === 'recorded' ? 48 : 11 };
                const ctx = await browser.newContext({ viewport: { width, height: 854 }, isMobile: width < 500, hasTouch: width < 500, timezoneId: 'America/New_York', serviceWorkers: 'block' });
                let page;
                try {
                    await seedTestId(ctx);
                    await ctx.addInitScript(({ from, to, clock, originName }) => { localStorage.setItem('listView', 'trip'); sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({ fromText: originName, fromLL: from, toText: 'Prospect/Canner', toLL: to, tripTime: '', expandedKey: null, savedAt: clock })); }, { from, to, clock, originName: feed.stop_names[origin] });
                    page = await ctx.newPage();
                    page.setDefaultTimeout(10000);
                    page.on('pageerror', e => errors.push(e.message));
                    await page.clock.install({ time: new Date(clock) });
                    await page.route('**/*', async (route) => {
                        const u = new URL(route.request().url());
                        if (u.hostname !== 'red-exit.test')
                            return route.abort();
                        if (u.pathname === '/api/buses')
                            return route.fulfill({ json: currentFeed });
                        if (u.pathname === '/api/weather')
                            return route.fulfill({ status: 204 });
                        if (u.pathname.startsWith('/api/'))
                            return route.fulfill({ json: { reports: [], results: [] } });
                        if (route.request().method() !== 'GET')
                            return route.abort();
                        return asset(route, u);
                    });
                    await page.goto('https://red-exit.test', { waitUntil: 'domcontentloaded' });
                    const row = page.locator(`tbody[data-route="Red"][data-pickup="${origin}"]`);
                    await row.waitFor();
                    await row.getByTestId('route-pickup').waitFor();
                    assert.equal(Number(await row.getAttribute('data-alight')), option.alightStopId);
                    const overview = await row.innerText();
                    await page.getByRole('button', { name: 'View Red trip details', exact: true }).click();
                    await page.getByTestId('trip-detail-panel').waitFor();
                    assert.equal(Number(await row.getAttribute('data-alight')), option.alightStopId);
                    const comparison = page.getByTestId('alight-comparison');
                    if (variant === 'extra-hold') {
                        await comparison.waitFor();
                        assert.match(await comparison.innerText(), /7 min walk.*estimated arrival 12 min sooner.*Division\/Prospect \(1 min walk\)/);
                    }
                    else
                        assert.equal(await comparison.count(), 0);
                    const text = await page.locator('body').innerText();
                    assert(text.includes(feed.stop_names[option.alightStopId].replace(/\s*\/\s*/g, '/')));
                    assert.match(await row.getByTestId('journey-legs').innerText(), variant === 'recorded' ? /🚶 1 min/ : /🚶 7 min/);
                    assert(await page.getByRole('button', { name: "🚌 I'm on it", exact: true }).isVisible());
                    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                    assert.deepEqual(errors, []);
                    await page.screenshot({ path: `${out}/${variant}-origin${origin}-${width}.png`, fullPage: true });
                    const transitions = [];
                    if (variant === 'extra-hold') {
                        const change = async (id, next, visible) => {
                            currentFeed = next;
                            const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/buses');
                            await page.clock.runFor(5500);
                            await (await response).finished();
                            await page.waitForFunction(show => !!document.querySelector('[data-testid="alight-comparison"]') === show, visible);
                            assert.equal(Number(await row.getAttribute('data-alight')), 11);
                            assert.deepEqual(errors, []);
                            transitions.push({ id, comparisonVisible: visible, selectedExitUnchanged: true });
                            console.log(JSON.stringify({ width, origin, variant, transition: id, ok: true }));
                        };
                        const missing = structuredClone(feed);
                        const bi = missing.server_eta.buses.findIndex(b => b[0] === '126');
                        const kept = missing.server_eta.rows.map((r, i) => ({ r, i })).filter(x => x.r[0] !== bi || [origin, 11].includes(x.r[1]));
                        missing.server_eta.rows = kept.map(x => x.r);
                        if (missing.server_eta.distributions)
                            missing.server_eta.distributions = kept.map(x => missing.server_eta.distributions[x.i]);
                        await change('nearer-destination-missing', missing, false);
                        await change('source-restored', structuredClone(feed), true);
                        await change('downstream-delay-cleared', structuredClone(variants.recorded), false);
                        await change('delay-restored', structuredClone(feed), true);
                        const expired = structuredClone(feed);
                        expired.server_eta.at -= 60000;
                        await change('source-expired', expired, false);
                        await change('fresh-source-restored', structuredClone(feed), true);
                    }
                    results.push({ width, origin, variant, selectedBoard: option.boardStopId, selectedExit: option.alightStopId, exitName: feed.stop_names[option.alightStopId], overview, detailsText: text, transitions, pageErrors: errors });
                    console.log(JSON.stringify({ ok: true, width, origin, variant, exit: option.alightStopId }));
                }
                catch (error) {
                    if (page) {
                        await fs.writeFile(`${out}/${variant}-origin${origin}-${width}-failure.txt`, await page.locator('body').innerText().catch(() => ''));
                        await page.screenshot({ path: `${out}/${variant}-origin${origin}-${width}-failure.png`, fullPage: true }).catch(() => { });
                    }
                    throw error;
                }
                finally {
                    if (page)
                        await page.unrouteAll({ behavior: 'wait' });
                    await ctx.close();
                }
            }
}
catch (error) {
    failed = error;
}
finally {
    await browser.close();
    await fs.writeFile(out + '/assets.json', JSON.stringify({ productionBuild: expected, localBuild: local, assets: manifest, productionApiWrites: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (!local) {
    const after = await fetch('https://yale-shuttle.fly.dev/healthz', { signal: AbortSignal.timeout(12000) }).then(r => r.json());
    assert(after.ok && after.build === expected);
}
await fs.writeFile(out + '/result.json', JSON.stringify({ at: new Date().toISOString(), ok: !failed, productionBuild: expected, localBuild: local, browserCases: results.length, resourcesClosed: true, results, scope: 'Actual published or explicitly local-built SPA with Oct14 public Red fixture and a declared counterfactual extra600s after Winchester for bus126. Public stop endpoints, including the old PR6 recipe120→100. Not the Sep2 rider location or screen, physical rest, or ETA accuracy evidence.', ...(failed ? { error: String(failed) } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (failed)
    throw failed;
assert.equal(results.length, 8);
console.log("Alighting comparison: eight phone/desktop cases and24 source-loss/recovery transitions preserve the selected exit and explain only supported live tradeoffs.");
