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
    await page.addInitScript(() => {
      window.reviewKeyListeners = new Set();
      const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
      window.addEventListener = function(type, listener, options) { if(type === 'keydown') window.reviewKeyListeners.add(listener); return add(type,listener,options); };
      window.removeEventListener = function(type, listener, options) { if(type === 'keydown') window.reviewKeyListeners.delete(listener); return remove(type,listener,options); };
    });
    await page.goto('https://fullscreen.test');

    const disclosure=page.locator('#berth').getByRole('button',{name:/show where/});
    await disclosure.click();
    await page.locator('#berth .leaflet-container').waitFor();
    const initialListeners=await page.evaluate(()=>window.reviewKeyListeners.size);
    report.initialListeners=initialListeners;
    const listeners=async (n)=>page.waitForFunction(expected=>window.reviewKeyListeners.size===expected,initialListeners+n);
    for(const kind of ['combined','walk','berth']) {
      const section=page.locator('#'+kind), name=kind==='berth'?'Full map':'Fullscreen';
      const expand=()=>section.getByRole('button',{name,exact:true});
      const back=()=>section.getByRole('button',{name:'Back',exact:true});
      await section.locator('.leaflet-container').evaluate(e=>window.reviewMap=e);
      for(let cycle=0;cycle<3;cycle++) {
        await expand().focus(); await page.keyboard.press('Space');
        await section.locator('.map-fs').waitFor(); await listeners(1);
        await page.keyboard.press('Shift+Tab');
        assert(await back().evaluate(e=>e===document.activeElement),'natural reverse Tab reaches Back: '+kind);
        await page.keyboard.press(cycle===1?'Escape':'Enter');
        await listeners(0);
        assert.equal(await section.locator('.map-fs').count(),0);
        assert(await expand().evaluate(e=>e===document.activeElement),'keyboard cycle restores focus: '+kind);
        assert(await section.locator('.leaflet-container').evaluate(e=>e===window.reviewMap),'same Leaflet element: '+kind);
        report.states.push({kind,cycle,naturalBackNavigation:true,listeners:0,focusReturned:true});
      }
      await expand().click(); await listeners(1);
      await page.locator('#after').focus(); await page.keyboard.press('x');
      assert.equal(await section.locator('.map-fs').count(),1,'unrelated key ignored');
      await page.keyboard.press('Escape'); await listeners(0);
      assert(await page.locator('#after').evaluate(e=>e===document.activeElement),'external focus preserved');
      await page.keyboard.press('Escape');
      assert(await page.locator('#after').evaluate(e=>e===document.activeElement),'closed map does not steal focus');
      await expand().click(); await listeners(1);
      const zoom=section.getByRole('button',{name:'Zoom in',exact:true});
      await zoom.focus();
      await zoom.evaluate(e=>e.addEventListener('keydown',event=>event.stopPropagation(),{once:true}));
      await page.keyboard.press('Escape');
      assert.equal(await section.locator('.map-fs').count(),1,'child-owned Escape ignored');
      await page.keyboard.press('Escape'); await listeners(0);
      assert(await expand().evaluate(e=>e===document.activeElement),'unconsumed Escape from child restores focus');
      report.checks.push(kind+': three true-keyboard reopen cycles, external/closed focus ownership, child event ownership, exact listener balance');
    }
    const combined=page.locator('#combined');
    await combined.getByRole('button',{name:'Fullscreen',exact:true}).click(); await listeners(1);
    await combined.getByRole('button',{name:'Back',exact:true}).focus();
    await page.evaluate(()=>window.setMode('missing')); await page.waitForTimeout(100);
    assert(await combined.getByRole('button',{name:'Back',exact:true}).evaluate(e=>e===document.activeElement),'poll missing preserves active Back');
    await listeners(1);
    await page.evaluate(()=>window.setMode('empty')); await page.waitForTimeout(100);
    await page.keyboard.press('Escape'); await listeners(0);
    assert(await combined.getByRole('button',{name:'Fullscreen',exact:true}).evaluate(e=>e===document.activeElement));
    report.checks.push('Fresh to missing to empty while fullscreen keeps Back and a single listener; Escape restores persistent toggle');
    await disclosure.click();
    await disclosure.click();
    const berth=page.locator('#berth');
    await berth.getByRole('button',{name:'Full map',exact:true}).click(); await listeners(1);
    await disclosure.focus(); await page.keyboard.press('Space'); await listeners(0);
    assert.equal(await berth.locator('.leaflet-container').count(),0);
    assert(await disclosure.evaluate(e=>e===document.activeElement));
    await page.keyboard.press('Escape');
    assert(await disclosure.evaluate(e=>e===document.activeElement));
    report.checks.push('Collapsing the berth disclosure during fullscreen tears down its listener and preserves disclosure focus');
    await combined.getByRole('button',{name:'Fullscreen',exact:true}).click(); await listeners(1);
    await page.evaluate(()=>window.setVisible(false)); await listeners(0);
    assert.equal(await page.locator('.leaflet-container').count(),0);
    await page.locator('#outside').focus(); await page.keyboard.press('Escape');
    assert(await page.locator('#outside').evaluate(e=>e===document.activeElement));
    await page.evaluate(()=>window.setVisible(true));
    await combined.getByRole('button',{name:'Fullscreen',exact:true}).waitFor();
    assert.equal(await page.locator('.map-fs').count(),0); await listeners(0);
    assert.equal(await page.locator('#berth .leaflet-container').count(),0);
    await combined.getByRole('button',{name:'Fullscreen',exact:true}).click(); await listeners(1);
    await combined.getByRole('button',{name:'Back',exact:true}).focus();
    await page.screenshot({path:path.join(out,'review-fullscreen-keyboard.png')});
    await page.keyboard.press('Escape'); await listeners(0);
    report.checks.push('Unmount while fullscreen removes listener; remount starts closed with no stale berth instance and can reopen/close normally');
    assert.deepEqual(report.errors,[]);
    report.finalListeners=await page.evaluate(()=>window.reviewKeyListeners.size);
    report.completed=true;

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
    await fs.writeFile(path.join(out, 'review-lifecycle.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
