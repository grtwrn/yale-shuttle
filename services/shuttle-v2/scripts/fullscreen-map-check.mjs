/** Bounded actual-component fullscreen map regression. Run from v2 with OUT.
 * --baseline requires BASELINE_DIR with the two *.baseline.tsx source files.
 * Use the shared heavy lock. All network is intercepted; no server required. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const service = process.cwd(), require = createRequire(service + '/package.json');
const { build } = require('esbuild'), { chromium } = require('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const out = process.env.OUT, baseline = process.argv.includes('--baseline'), desktop = !!process.env.DESKTOP;
if (!out || (baseline && !process.env.BASELINE_DIR))
    throw Error('Set OUT and (for baseline) BASELINE_DIR');
await fs.mkdir(out, { recursive: true });
const prefix = baseline ? 'before' : 'after';
const code = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {TripMap,CombinedTripMap} from './TransitMap';import {BerthDisclosure} from './BerthDisclosure';import {BERTHS} from './berths';import {ROUTE_COLOR} from './routes';
const from={lat:41.325,lon:-72.923},to={lat:41.307,lon:-72.926};const option={label:'Red',color:ROUTE_COLOR.Red,segCoords:[from,to],bus:{...from,name:'307'},passedBus:{...to,name:'309'},boardEta:'2–19 min',arriveAt:'12:59–1:32 PM'};
function App(){const [mode,setMode]=useState('fresh'),[visible,setVisible]=useState(true);window.setMode=setMode;window.setVisible=setVisible;return <><button id="outside">Outside map</button>{visible&&<>
<section id="combined"><h2>Trip overview</h2><CombinedTripMap from={from} to={to} options={mode==='empty'?[]:[{...option,...(mode==='missing'?{boardEta:null,arriveAt:null}:{})}]}/></section>
<section id="walk"><h2>Final walk</h2><TripMap from={from} to={to} color={ROUTE_COLOR.Red}/></section>
<section id="berth"><h2>Pickup location</h2><BerthDisclosure berth={BERTHS.find(b=>b.stopId===48)} published={from} routeLabel="Red" color={ROUTE_COLOR.Red} stopName="Division / Prospect — northbound toward Science Hill" boardName="Division / Prospect" path={[[from.lat,from.lon],[to.lat,to.lon]]} navHref="https://directions.test/"/></section>
</>}<button id="after">After maps</button></>};createRoot(document.getElementById('root')).render(<App/>);`;
const bundle = await build({ stdin: { contents: code, resolveDir: service + '/web/src', loader: 'tsx' }, outdir: out + '/virtual', bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'actual-maps', setup(b) {
                b.onLoad({ filter: /\/(TransitMap|BerthInset)\.tsx$/ }, async (a) => { const name = path.basename(a.path, '.tsx'); let source = await fs.readFile(baseline ? path.join(process.env.BASELINE_DIR, name + '.baseline.tsx') : a.path, 'utf8'); source = source.replace('const TripMap:', 'export const TripMap:').replace('const CombinedTripMap:', 'export const CombinedTripMap:'); return { contents: source, loader: 'tsx', resolveDir: service + '/web/src' }; });
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
const report = { baseline, desktop, scope: 'Actual three map components and berth disclosure; synthetic props; intercepted network', checks: [], states: [], errors: [] };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let ctx, page;
try {
    ctx = await browser.newContext({ viewport: { width: desktop ? 1280 : 360, height: 800 }, isMobile: !desktop, hasTouch: !desktop, serviceWorkers: 'block' });
    await seedTestId(ctx);
    page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', async (r) => { const u = new URL(r.request().url()); if (u.hostname !== 'fullscreen.test')
        return r.abort(); if (u.pathname === '/app.js')
        return r.fulfill({ contentType: 'text/javascript', body: js }); if (u.pathname === '/app.css')
        return r.fulfill({ contentType: 'text/css', body: css }); if (u.pathname === '/')
        return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="font-family:Arial,sans-serif"><main id="root"></main><script src="/app.js"></script></body></html>' }); return r.abort(); });
    await page.goto('https://fullscreen.test');
    const disclosure = page.locator('#berth').getByRole('button', { name: /show where/ });
    assert.equal(await page.locator('#berth .leaflet-container').count(), 0);
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await page.locator('#berth .leaflet-container').waitFor();
    assert.match(await page.locator('#berth').innerText(), /Directions to published stop/);
    for (const kind of ['combined', 'walk', 'berth']) {
        const section = page.locator('#' + kind), name = kind === 'berth' ? 'Full map' : 'Fullscreen';
        const toggle = () => section.getByRole('button', { name, exact: true }), back = () => section.getByRole('button', { name: 'Back', exact: true });
        await section.locator('.leaflet-container').evaluate(e => window.originalMap = e);
        const open = async () => { await toggle().focus(); await page.keyboard.press('Enter'); await section.locator('.map-fs').waitFor(); await page.waitForTimeout(100); };
        const closed = async (method) => { assert.equal(await section.locator('.map-fs').count(), 0); const focused = await page.evaluate(() => ({ tag: document.activeElement.tagName, name: document.activeElement.getAttribute('aria-label') || (document.activeElement.tagName === 'BODY' ? 'BODY' : document.activeElement.textContent) })); report.states.push({ kind, method, focused }); if (!baseline)
            assert(await toggle().evaluate(e => e === document.activeElement), kind + ' ' + method + ' restores toggle focus');
        else if (method === 'Back Enter' || method === 'Escape from Back')
            assert.equal(focused.tag, 'BODY'); assert(await section.locator('.leaflet-container').evaluate(e => e === window.originalMap), 'same map retained'); };
        await open();
        const box = await section.locator('.map-fs').boundingBox();
        assert(box.width >= (desktop ? 1280 : 360) - 1 && box.height >= 799);
        for (const control of [back(), section.getByRole('button', { name: 'Exit fullscreen', exact: true })]) {
            const b = await control.boundingBox();
            assert(b.width >= 44 && b.height >= 44);
        }
        await back().focus();
        await page.keyboard.press('Enter');
        await closed('Back Enter');
        await open();
        await back().focus();
        await page.keyboard.press('Escape');
        await closed('Escape from Back');
        if (!baseline) {
            await open();
            await back().focus();
            await back().evaluate(e => e.addEventListener('keydown', event => event.preventDefault(), { once: true }));
            await page.keyboard.press('Escape');
            assert.equal(await section.locator('.map-fs').count(), 1, 'consumed Escape leaves map open');
            await page.keyboard.press('Escape');
            await closed('Unconsumed Escape');
        }
        await open();
        await section.getByRole('button', { name: 'Zoom in', exact: true }).focus();
        await page.keyboard.press('Escape');
        await closed('Escape from zoom');
        await open();
        await section.getByRole('button', { name: 'Exit fullscreen', exact: true }).focus();
        await page.keyboard.press('Space');
        await closed('Close Space');
        await open();
        await back().focus();
        await page.keyboard.press('Space');
        await closed('Back Space');
        if (!baseline) {
            await page.keyboard.press('Tab');
            assert(await page.evaluate(() => document.activeElement !== document.body), 'Tab resumes after returned map toggle');
        }
        if (!desktop) {
            await toggle().tap();
            await back().tap();
            await closed('Back touch');
        }
        await open();
        await page.locator('#outside').focus();
        await page.keyboard.press('Escape');
        assert.equal(await section.locator('.map-fs').count(), 0);
        assert(await page.locator('#outside').evaluate(e => e === document.activeElement), 'external focus preserved');
        report.checks.push(kind + ': Back, close, Escape, touch/keyboard, external focus and stable Leaflet instance');
        if (kind === 'berth') {
            await page.waitForTimeout(100);
            assert(!await section.locator('.leaflet-container').evaluate(e => e.classList.contains('leaflet-touch-drag')), 'closed inset inert');
            assert.equal(await section.getByRole('button', { name: /Tap the map to zoom and pan/ }).getAttribute('aria-pressed'), 'false');
        }
    }
    for (const width of [360, 390, 430, 1280, 640]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(100);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reflow ' + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#berth').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, prefix + '-berth-390.png') });
    const combined = page.locator('#combined'), toggle = combined.getByRole('button', { name: 'Fullscreen', exact: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await combined.getByRole('button', { name: 'Back', exact: true }).focus();
    await page.evaluate(() => window.setMode('missing'));
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    assert.equal(await combined.locator('.map-fs').count(), 0);
    if (!baseline)
        assert(await toggle.evaluate(e => e === document.activeElement));
    await page.evaluate(() => window.setMode('empty'));
    await page.waitForTimeout(250);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    if (!baseline)
        assert(await toggle.evaluate(e => e === document.activeElement));
    report.checks.push('Missing times and empty options retain usable fullscreen return');
    await disclosure.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#berth .leaflet-container').count(), 0);
    assert(await disclosure.evaluate(e => e === document.activeElement));
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#berth .map-fs').count(), 0);
    report.checks.push('Berth disclosure unmounts and reopens collapsed/inert; disclosure focus retained');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.setVisible(false));
    await page.locator('#outside').focus();
    await page.keyboard.press('Escape');
    assert(await page.locator('#outside').evaluate(e => e === document.activeElement));
    assert.equal(await page.locator('.leaflet-container').count(), 0);
    report.checks.push('Unmount removes maps/listener without stealing external focus');
    assert.deepEqual(report.errors, []);
    report.completed = true;
}
finally {
    if (page) {
        if (!report.completed)
            report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => null);
        await page.close();
    }
    if (ctx)
        await ctx.close();
    await browser.close();
    report.resourcesClosed = true;
    await fs.writeFile(path.join(out, prefix + '-browser.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
