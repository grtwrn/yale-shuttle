/** Bounded CombinedTripMap browser regression. Run from v2 with OUT set. All network is intercepted. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), require = createRequire(service + '/package.json');
const { build } = require('esbuild'), { chromium } = require('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = process.env.OUT;
if (!out)
    throw Error('Set OUT to a fresh evidence directory');
await fs.mkdir(out, { recursive: true });
const baseline = process.argv.includes('--baseline'), prefix = baseline ? 'before' : 'after';
const desktop = !!process.env.DESKTOP;
const from = { lat: 41.321, lon: -72.927 }, to = { lat: 41.307, lon: -72.926 };
const base = { label: 'Red', segCoords: [from, to], bus: { ...from, name: '307' }, passedBus: { lat: 41.3207, lon: -72.927, name: '309' }, boardEta: '2–19 min', arriveAt: '12:59–1:32 PM', busWait: { compact: 'Stopped 3:21 · usual ~5m total', elapsed: 'Waiting 3:21', typical: 'Usually ~5 min total', overdue: false } };
const source = baseline ? process.env.BASELINE_SOURCE : service + '/web/src/TransitMap.tsx';
if (!source)
    throw Error('Set BASELINE_SOURCE when using --baseline');
const code = `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {CombinedTripMap} from './TransitMap'; import {ROUTE_COLOR} from './routes';
const colors=options=>options.map(o=>({...o,color:ROUTE_COLOR[o.label]}));function App(){const [options,setOptions]=useState(colors(${JSON.stringify([base])}));window.setOptions=next=>setOptions(colors(next));return <><button>Before map</button><CombinedTripMap from={${JSON.stringify(from)}} to={${JSON.stringify(to)}} options={options}/><button>After map</button></>};createRoot(document.getElementById('root')).render(<App/>);`;
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
const report = { phase: prefix, desktop, source: 'Actual CombinedTripMap with synthetic props; test-only export/map reference; no estimator or live network', states: [], checks: [], errors: [] };
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
    for (const width of [360, 390, 430, 640, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.fixtureMap.invalidateSize());
        await page.waitForTimeout(100);
        const state = await capture('explicit-pause-' + width, width === 360);
        const label = state.labels.find(l => l.wait);
        assert(label.text.includes('Stopped 3:21 · usual ~5m total'));
        assert(label.left >= state.map.left && label.right <= state.map.right, 'pause label fits map');
        assert(!state.overflow, 'no phone overflow');
    }
    assert.deepEqual(report.errors, []);
    report.completed = true;
} finally {
    await browser.close();
    await fs.writeFile(out + '/map-pause-labels.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
