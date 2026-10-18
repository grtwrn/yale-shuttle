/** Bounded CombinedTripMap browser regression. Run from v2 with OUT set. All network is intercepted. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), require = createRequire(service + '/package.json');
const { build } = require('esbuild'), { chromium } = require('playwright-core');
const { readPauseMaps, auditPauseMaps, confirmPauseMaps } = await import(service + '/scripts/rider-watch/map-pause.mjs');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = process.env.OUT;
if (!out)
    throw Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const baseline = process.argv.includes('--baseline'), prefix = baseline ? 'before' : 'after';
const desktop = !!process.env.DESKTOP;
const from = { lat: 41.321, lon: -72.927 }, to = { lat: 41.307, lon: -72.926 };
const base = { label: 'Red', segCoords: [from, to], bus: { ...from, name: '307' }, passedBus: { lat: 41.3207, lon: -72.927, name: '309' }, boardEta: '2–19 min', arriveAt: '12:59–1:32 PM', busWait: { compact: 'Stopped 3:21 · leaves in 1-5 min', elapsed: 'Waiting 3:21', departure: 'leaves in 1-5 min', typical: 'Usual total stop duration: ~5 min', overdue: false } };
const cedar = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/cedar-map-wait-20261017.json', 'utf8'));
const source = baseline ? process.env.BASELINE_SOURCE : service + '/web/src/TransitMap.tsx';
if (!source)
    throw Error('Set BASELINE_SOURCE when using --baseline');
const code = `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {CombinedTripMap} from './TransitMap'; import {ROUTE_COLOR} from './routes'; import {mapWaitLabel} from './mapLabels';
const colors=options=>options.map(o=>({...o,color:ROUTE_COLOR[o.label]}));function App(){const [options,setOptions]=useState(colors(${JSON.stringify([base])}));window.setOptions=next=>setOptions(colors(next));window.setPause=(standing,tables,network)=>setOptions(colors([{...${JSON.stringify(base)},label:'Orange Night',bus:{...${JSON.stringify(from)},name:'53'},passedBus:null,busWait:mapWaitLabel(standing,tables,network)}]));return <><button>Before map</button><CombinedTripMap from={${JSON.stringify(from)}} to={${JSON.stringify(to)}} options={options}/><button>After map</button></>};createRoot(document.getElementById('root')).render(<App/>);`;
const bundle = await build({ stdin: { contents: code, resolveDir: service + '/web/src', loader: 'tsx' }, outdir: out + '/virtual', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'actual-map', setup(b) {
                b.onLoad({ filter: /\/TransitMap\.tsx$/ }, async () => ({ contents: (await fs.readFile(source, 'utf8')).replace('const CombinedTripMap:', 'export const CombinedTripMap:').replaceAll('mapRef.current = map;\n    L.tileLayer', 'mapRef.current = map; window.fixtureMap = map;\n    L.tileLayer'), loader: 'tsx', resolveDir: service + '/web/src' }));
                b.onResolve({ filter: /^\.\.?\// }, async (a) => { for (const ext of ['.ts', '.tsx', '.js']) {
                    const p = path.resolve(a.resolveDir, a.path + ext);
                    try {
                        await fs.access(p);
                        return { path: p };
                    }
                    catch { }
                } });
            } }] });
const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text, css = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
const report = { phase: prefix, desktop, source: 'Actual mapWaitLabel and CombinedTripMap with captured Cedar calibration and controlled standing inputs; test-only export/map reference; not an original report replay or arrival truth; all network intercepted', states: [], checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let ctx;
try {
    ctx = await browser.newContext({ viewport: { width: desktop ? 1280 : 360, height: 800 }, isMobile: !desktop, hasTouch: !desktop, serviceWorkers: 'block' });
    await seedTestId(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', async (r) => { const u = new URL(r.request().url()); if (u.hostname !== 'minimap.test')
        return r.abort(); if (u.pathname === '/app.js')
        return r.fulfill({ contentType: 'text/javascript', body: js }); if (u.pathname === '/app.css')
        return r.fulfill({ contentType: 'text/css', body: css }); if (u.pathname === '/')
        return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="font-family:Arial,sans-serif"><main id="root"></main><script src="/app.js"></script></body></html>' }); return r.abort(); });
    await page.goto('https://minimap.test');
    await page.locator('.bus-wait-label').waitFor();
    await page.waitForTimeout(200);
    async function capture(name, screenshot = false) {
        const state = await page.evaluate(() => { const rect = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }; return { width: innerWidth, map: rect(document.querySelector('.leaflet-container')), labels: [...document.querySelectorAll('.eta-tip')].map(e => ({ text: e.textContent, wait: !!e.querySelector('.bus-wait-label'), ...rect(e) })), buses: [...document.querySelectorAll('.bus-pin-sm')].map(e => ({ text: e.textContent, name: e.getAttribute('aria-label'), title: e.title, role: e.getAttribute('role'), ...rect(e) })), overflow: document.documentElement.scrollWidth > innerWidth }; });
        report.states.push({ name, ...state });
        if (screenshot)
            await page.screenshot({ path: path.join(out, `${prefix}-${name}.png`) });
        return state;
    }
    for (const width of [320, 360, 390, 430, 640, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.fixtureMap.invalidateSize());
        await page.waitForTimeout(100);
        const state = await capture('explicit-pause-' + width, width === 360);
        const label = state.labels.find(l => l.wait);
        assert(label.text.includes('Stopped 3:21 · leaves in 1-5 min'));
        assert(!/usual|typical|total/i.test(label.text));
        const bus = state.buses.find(b => b.name?.includes('307'));
        assert(bus?.name.includes('leaves in 1-5 min'));
        assert(bus.name.includes('Usual total stop duration: ~5 min'));
        assert(label.left >= state.map.left && label.right <= state.map.right, 'pause label fits map');
        assert(!state.overflow, 'no phone overflow');
    }
    for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.fixtureMap.invalidateSize());
        for (const [name, seconds, support, approach] of [
            ['short-hold', 179, 'captured', false],
            ['threshold', 180, 'captured', false],
            ['long-cedar-pause', 601, 'captured', false],
            ['missing-departure', 240, 'missing', false],
            ['thin-departure', 240, 'thin', false],
            ['nearby-unknown', 240, 'missing', true],
            ['moving', null, 'captured', false],
        ]) {
            const tables = support === 'captured' ? cedar.routeDwells : support === 'thin' ? { 10: { ...cedar.routeDwells['10'], n: 2 } } : {};
            const network = support === 'captured' ? cedar.dwellsByRoute : undefined;
            const standing = seconds === null ? null : { stopId: 10, standingSec: seconds, approach };
            await page.evaluate(({ standing, tables, network }) => window.setPause(standing, tables, network), { standing, tables, network });
            // Leaflet fades the removed permanent tooltip for 200 ms.
            await page.waitForTimeout(350);
            const state = await capture(`${name}-${width}`, width === 320 && seconds === 601);
            const label = state.labels.find(l => l.wait);
            const bus = state.buses.find(b => b.name?.includes('53'));
            assert(bus, 'Orange Night marker remains present');
            if (seconds === null || seconds < 180) {
                assert(!label, 'moving or short usual hold clears permanent pause label');
                assert(!/Waiting|Stopped|departure time unavailable/i.test(bus.name), 'accessible marker clears old pause');
            } else {
                const clock = seconds === 601 ? '10:01' : seconds === 180 ? '3:00' : '4:00';
                assert(label?.text.includes(`Stopped${approach ? ' nearby' : ''} ${clock}`));
                assert(bus.name.includes(`Waiting${approach ? ' nearby' : ''} ${clock}`));
                assert(label.left >= state.map.left && label.right <= state.map.right, 'observed pause fits map');
                if (support !== 'captured') {
                    assert(label.text.includes('departure time unavailable'));
                    assert(bus.name.includes('Usual stop duration unavailable'));
                    assert(!/leaves in|leaving/i.test(label.text), 'unknown support never becomes a departure forecast');
                } else assert(!label.text.includes('departure time unavailable'));
            }
            assert(!state.overflow, 'no phone overflow');
        }
    }
    // Exercise the live rider's independent DOM auditor against the actual map.
    // Fault injection removes the permanent label, matching the old suppression;
    // this is a controlled browser regression, not a historical screen replay.
    const modelAt = 1_000_000;
    const monitorFeed = (offset = 0) => ({ buses: [{ bus_name: '#53', route_id: 14, observed_at: modelAt + offset }],
        server_eta: { v: 2, at: modelAt + offset, servedAt: modelAt + offset,
            buses: [['53', 'Orange Night', 0, { stopId: 10, standingSec: 601 + offset / 1000, approach: false }]],
            rows: [[0, 2, 300, 120, 540, 1, 0, 120, 120]] } });
    report.pauseMonitor = [];
    for (const width of [320, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.fixtureMap.invalidateSize());
        await page.evaluate(({ tables, network }) => window.setPause({ stopId: 10, standingSec: 601 }, tables, network),
            { tables: cedar.routeDwells, network: cedar.dwellsByRoute });
        await page.waitForTimeout(350);
        const healthy = auditPauseMaps(await readPauseMaps(page), monitorFeed(), modelAt, modelAt + 2000);
        assert.equal(healthy.checked, 1); assert.deepEqual(healthy.findings, []);
        await page.evaluate(base => window.setOptions([{ ...base, label: 'Orange Night', bus: { ...base.bus, name: '53' }, passedBus: null, busWait: null }]), base);
        await page.waitForTimeout(350);
        const suppressed = auditPauseMaps(await readPauseMaps(page), monitorFeed(), modelAt, modelAt + 2000);
        assert.equal(suppressed.findings.length, 1);
        assert.deepEqual(suppressed.findings[0].missing, ['accessible-clock', 'visible-clock']);
        const pending = confirmPauseMaps(null, suppressed.findings, modelAt + 2000);
        assert.deepEqual(pending.alerts, []);
        const next = auditPauseMaps(await readPauseMaps(page), monitorFeed(10000), modelAt + 10000, modelAt + 12000);
        const confirmed = confirmPauseMaps(pending.state, next.findings, modelAt + 12000);
        assert.equal(confirmed.alerts.length, 1);
        await page.evaluate(() => window.setPause({ stopId: 10, standingSec: 601 }, {}, undefined));
        await page.waitForTimeout(350);
        const recovered = auditPauseMaps(await readPauseMaps(page), monitorFeed(20000), modelAt + 20000, modelAt + 22000);
        assert.equal(recovered.checked, 1); assert.deepEqual(recovered.findings, []);
        assert.deepEqual(confirmPauseMaps(confirmed.state, recovered.findings, modelAt + 22000).state, {});
        report.pauseMonitor.push({ width, healthy, suppressed, confirmed, recovered });
    }
    assert.deepEqual(report.errors, []);
    report.completed = true;
} finally {
    await browser.close();
    await fs.writeFile(out + '/map-pause-labels.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
