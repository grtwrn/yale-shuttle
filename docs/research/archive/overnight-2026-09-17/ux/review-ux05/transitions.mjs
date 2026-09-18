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
const baseline = false, prefix = 'review';
const desktop = !!process.env.DESKTOP;
const from = { lat: 41.321, lon: -72.927 }, to = { lat: 41.307, lon: -72.926 };
const base = { label: 'Red', segCoords: [from, to], bus: { ...from, name: '307' }, passedBus: { lat: 41.3207, lon: -72.927, name: '309' }, boardEta: '2–19 min', arriveAt: '12:59–1:32 PM', busWait: { compact: '3:21/~5m', elapsed: 'Waiting 3:21', typical: 'Usually ~5 min total', overdue: false } };
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
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
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
    async function set(options) {
        await page.evaluate(options => window.setOptions(options), options);
        await page.waitForTimeout(350);
    }
    const current = page.getByRole('button', {name: /^Red #307/});
    await current.focus();
    await page.evaluate(() => window.reviewOriginal = document.querySelector('.bus-pin-sm'));
    await set([{...base, busWait:null}]);
    assert(await current.evaluate(e => e === window.reviewOriginal && e === document.activeElement));
    assert.equal(await current.getAttribute('aria-label'), 'Red #307');
    assert.equal(await current.getAttribute('title'), 'Red #307');
    assert.equal(await page.locator('.bus-wait-label').count(), 0);
    assert(!await page.locator('.leaflet-container').innerText().then(t=>t.includes('3:21')));
    await set([{...base, busWait:{...base.busWait,compact:'41:07/~5m',elapsed:'Waiting nearby 41:07',overdue:true}}]);
    assert(await current.evaluate(e=>e===window.reviewOriginal && e===document.activeElement));
    assert.match(await current.getAttribute('aria-label'), /Waiting nearby 41:07.*not time remaining/);
    assert.equal(await page.locator('.bus-wait-label').innerText(), 'Red #307 41:07/~5m');
    report.checks.push('Wait→moving→long nearby wait keeps focused marker, clears obsolete text/title, preserves untrimmed observed elapsed and historical-total meaning');
    await page.getByRole('button',{name:'After map',exact:true}).focus();
    await set([{...base,bus:{...base.bus,name:'309'},passedBus:{...base.passedBus,name:'307'}}]);
    assert.equal(await page.getByRole('button',{name:/^Red #307 — just passed$/}).count(),1);
    assert.equal(await page.getByRole('button',{name:/^Red #309\. Waiting/}).count(),1);
    assert.equal(await page.locator('.bus-pin-sm').count(),2);
    assert.equal(await page.locator('.bus-wait-label').innerText(),'Red #309 3:21/~5m');
    assert(await page.getByRole('button',{name:'After map',exact:true}).evaluate(e=>e===document.activeElement));
    report.checks.push('Shuttle replacement moves wait identity to #309 and marks #307 passed without stale markers or focus stealing');
    await set([{...base,bus:{...base.bus,name:''},passedBus:{...base.passedBus,name:''}}]);
    assert.equal(await page.locator('.bus-wait-label').innerText(),'Red 3:21/~5m');
    assert.equal(await page.getByRole('button',{name:'Red — just passed',exact:true}).count(),1);
    assert(!await page.locator('.leaflet-container').innerText().then(t=>t.includes('undefined')));
    report.checks.push('Missing bus number retains route identity with no invented number');
    const blue={...base,label:'Blue Day',passedBus:null,busWait:null};
    await set([blue]);
    assert.match(await page.locator('.leaflet-container').innerText(),/\(B\) 2–19 min/);
    await set([blue,{...blue,label:'Brown',bus:{...blue.bus,name:'507'},boardEta:'41–119 min',arriveAt:'2:37 PM'}]);
    let text=await page.locator('.leaflet-container').innerText();
    assert(text.includes('(Blue Day) 2–19 min') && text.includes('(Brown) 41–119 min') && !text.includes('(B)'));
    await capture('review-identity-transition',true);
    await set([blue]);
    text=await page.locator('.leaflet-container').innerText();
    assert(text.includes('(B) 2–19 min') && !text.includes('Brown') && !text.includes('(Blue Day)'));
    report.checks.push('Adding/removing a same-initial route expands/restores both endpoint tags and removes dropped route/bus names');
    await set([{...blue,busWait:null,boardEta:null,arriveAt:null}]);
    const touchBus=page.getByRole('button',{name:'Blue Day #307',exact:true});
    await touchBus.tap();
    assert.equal(await page.locator('.eta-tip').innerText(),'Blue Day #307');
    await page.getByRole('button',{name:'Before map',exact:true}).focus();
    await page.keyboard.press('Tab');
    const visited=[];
    for(let i=0;i<12;i++) {
      visited.push(await page.evaluate(()=>({tag:document.activeElement.tagName,name:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent?.trim()})));
      await page.keyboard.press('Tab');
    }
    assert(visited.some(e=>e.name==='Blue Day #307'));
    report.tabOrder=visited;
    report.checks.push('Touch reveals bus tooltip and ordinary Tab traversal reaches the named moving marker');
    await set([]);
    assert.equal(await page.locator('.bus-pin-sm').count(),0);
    assert.equal(await page.locator('.eta-tip').count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    report.checks.push('Clearing routes removes hovered/focused identity and tooltip layers');
    assert.deepEqual(report.errors, []);
    await page.close();
}
finally {
    if (ctx)
        await ctx.close();
    await browser.close();
    await fs.writeFile(path.join(out, prefix + '-browser.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
