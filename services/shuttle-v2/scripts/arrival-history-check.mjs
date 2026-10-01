/** Bounded actual-component browser regression. Run from v2; OUT must name an evidence directory. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seedTestId } from './testId.mjs';
const service = process.cwd(), require = createRequire(service + '/package.json');
const { build } = require('esbuild'), { chromium } = require('playwright-core');
const out = process.env.OUT;
if (!out)
    throw Error('Set OUT');
await fs.mkdir(out, { recursive: true });
const baseline = process.argv.includes('--baseline'), prefix = baseline ? 'before' : 'after', desktop = !!process.env.DESKTOP;
const now = Date.parse('2026-09-17T14:00:00-04:00');
// Fabricated completed journeys exercise presentation only, not cohort selection.
function fixture(mode = 'standing', count = 8) {
    const trips = Array.from({ length: count }, (_, i) => {
        const actualSec = [30, 300, 540, 660, 720, 840, 1200, 2700][i % 8];
        const arrivedAt = now - 86400000 * (1 + Math.floor(i / 4)) - i * 60000;
        const startedAt = arrivedAt - actualSec * 1000;
        return { busName: String(300 + i), startedAt,
            departedAt: startedAt + (mode === 'standing' ? 10000 : 0), arrivedAt, actualSec };
    });
    return { asOf: now, days: 30, journey: {
        fromStopId: 48, fromName: 'Winchester / Mansfield', toStopId: 121,
        toName: 'Laboratory of Epidemiology and Public Health / 60 College Street',
        mode, elapsedSec: mode === 'standing' ? 120 : null,
        serviceDates: Math.ceil(count / 4), trips,
    }, recent: [{ busName: '316', arrivedAt: now - 3600000 }] };
}
const code = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrivalDetails} from './ArrivalDetails';
const base = {routeLabel:'Red', busName:'307', etaSec:600, lowSec:120, highSec:1500,
    computedAtMs:${now}, nextSec:1800, nextBusName:'309', stopId:121, stopsAway:4,
    holdingAt:'Winchester / Mansfield', distributionSec:Array.from({length:50}, (_,i)=>120+i*30)};
function App() {
    const [props,setProps] = useState(base);
    window.changeProps = p => setProps(old => ({...old,...p}));
    return <ArrivalDetails {...props}/>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle = await build({
    stdin: { contents: code, resolveDir: service + '/web/src', loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // Preserve the distinction between ArrivalDetails.tsx and arrivalDetails.ts.
    plugins: [{ name: 'exact-case', setup(b) {
        b.onResolve({ filter: /^\.\.?\// }, async a => {
            for (const ext of ['.ts', '.tsx', '.js']) {
                const file = path.resolve(a.resolveDir, a.path + ext);
                try { await fs.access(file); return { path: file }; } catch { /* next extension */ }
            }
        });
    }}],
});
const report = { phase: prefix, desktop, requests: [], checks: [], errors: [], states: [] };
let response = fixture(), status = 200, pending = false;
const releases = [];
const browser = await chromium.launch({ executablePath: process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
    const ctx = await browser.newContext({ viewport: { width: desktop ? 1280 : 360, height: 800 }, isMobile: !desktop, hasTouch: !desktop, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await seedTestId(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.clock.install({ time: new Date(now) });
    await page.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === '/app.js')
            return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
        if (u.pathname === '/')
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif"><main id="root"></main><script src="/app.js"></script></body></html>' });
        if (u.pathname === '/api/journey-history') {
            report.requests.push(Object.fromEntries(u.searchParams));
            const saved = response, savedStatus = status;
            if (pending)
                await new Promise(r => releases.push(r));
            return route.fulfill({ status: savedStatus, contentType: 'application/json', body: JSON.stringify(saved) });
        }
        return route.abort();
    });
    await page.goto('https://history.test');
    const trigger = page.getByRole('button', { name: /Red arrival details/ });
    await trigger.waitFor();
    assert.equal(report.requests.length, 0);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Red arrival', exact: true }), history = dialog.getByRole('region', { name: 'Recorded arrival history' });
    await history.getByRole('img').waitFor();
    const initialText = await history.innerText();
    report.states.push({ scenario: 'standing', text: initialText });
    await page.screenshot({ path: path.join(out, prefix + '-standing.png') });
    if (!baseline) {
        await history.evaluate(e => e.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(out, 'after-history.png') });
    }
    assert.match(initialText, /remaining stop wait and travel/);
    assert.match(initialText, /Winchester \/ Mansfield/);
    assert.match(await dialog.innerText(), /Following shuttle · #309/);
    assert.equal(await history.locator('circle').count(), 8);
    assert.deepEqual(await history.locator('circle').evaluateAll(es => es.map(e => e.getAttribute('fill'))), Array(8).fill('#fff'));
    if (!baseline) {
        assert.match(initialText, /Typical past trip/);
        assert.match(initialText, /8 recorded trips across 2 dates/);
        assert.match(initialText, /Sep 15.*Sep 16/);
        assert(!await history.getByText(/weight halves every/).isVisible());
        assert(await history.getByText(/Comparison captured/).evaluate(e => e.getBoundingClientRect().top) < await history.getByRole('img').evaluate(e => e.getBoundingClientRect().top));
    }
    const tableSummary = history.locator('summary').filter({ hasText: 'Dates and recorded times' });
    await tableSummary.focus();
    await page.keyboard.press('Space');
    assert.equal(await history.getByRole('row').count(), 9);
    assert.match(await history.getByRole('table').innerText(), /<1 min/);
    assert.match(await history.getByRole('table').innerText(), /45 min/);
    for (const width of [360, 390, 430, 1280, 640]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'dialog overflow ' + width);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow ' + width);
    }
    await page.setViewportSize({ width: desktop ? 1280 : 360, height: 800 });
    const about = history.locator('summary').filter({ hasText: 'About these records' });
    await about.focus();
    await page.keyboard.press('Enter');
    assert.match(await history.innerText(), /median/);
    if (!baseline)
        assert(await history.getByText(/weight halves every/).isVisible());
    const forecast = dialog.locator('summary').filter({ hasText: 'Forecast for this shuttle' });
    assert(!await forecast.locator('..').evaluate(e => e.open));
    await forecast.focus();
    await page.keyboard.press('Space');
    const forecastPlot = dialog.getByRole('img', { name: /Model estimate for this shuttle/ });
    await forecastPlot.waitFor();
    assert.equal(await forecastPlot.locator('circle').count(), 50);
    assert.deepEqual(await forecastPlot.locator('circle').evaluateAll(es => [...new Set(es.map(e => e.getAttribute('fill')))]), ['#3567a8']);
    const refresh = history.getByRole('button', { name: 'Refresh comparison', exact: true });
    pending = true;
    await refresh.focus();
    await page.keyboard.press('Enter');
    await history.getByText('Loading recorded trips…').waitFor();
    report.refreshFocusWhilePending = await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent }));
    if (!baseline) {
        const busy = history.getByRole('button', { name: 'Refreshing comparison…' });
        assert(await busy.evaluate(e => e === document.activeElement));
        assert.equal(await busy.getAttribute('aria-disabled'), 'true');
        const n = report.requests.length;
        await page.keyboard.press('Enter');
        assert.equal(report.requests.length, n);
        assert.equal(await history.getByRole('status').count(), 1);
    }
    pending = false;
    releases.splice(0).forEach(r => r());
    await history.getByRole('img').waitFor();
    if (!baseline)
        assert(await refresh.evaluate(e => e === document.activeElement));
    report.checks.push('lazy loading, standing context, keyboard disclosures, hollow history / filled forecast, short and long trips, 360/390/430/1280/640 CSS-pixel reflow');
    if (!baseline) {
        for (const scenario of ['departure', 'few', 'one', 'many', 'dominant', 'midnight', 'empty', 'unmatched', 'failed', 'malformed', 'old-snapshot']) {
            response = fixture(scenario === 'departure' ? 'departure' : 'standing', scenario === 'few' ? 2 : scenario === 'one' ? 1 : scenario === 'many' || scenario === 'dominant' ? 100 : scenario === 'empty' ? 0 : 8);
            status = 200;
            if (scenario === 'dominant') {
                response.journey.serviceDates = 2;
                response.journey.trips.forEach((t, i) => { const shift = i ? 29 * 86400000 : 0; const end = now - shift; t.startedAt = end - t.actualSec * 1000; t.departedAt = t.startedAt + 10000; t.arrivedAt = end; });
            }
            if (scenario === 'midnight') {
                response.journey.trips.forEach((t,i) => {
                    t.startedAt = Date.parse(i < 4 ? '2026-09-15T23:59:50-04:00' : '2026-09-16T23:59:50-04:00');
                    t.departedAt = t.startedAt + 10000;
                    t.arrivedAt = t.startedAt + t.actualSec * 1000;
                });
            }
            if (scenario === 'unmatched')
                response.journey = null;
            if (scenario === 'failed')
                status = 503;
            if (scenario === 'malformed')
                response = { asOf: 'bad' };
            if (scenario === 'old-snapshot')
                response.asOf = now - 3600000;
            const n = report.requests.length;
            await refresh.click();
            await page.waitForFunction(() => !document.querySelector('[aria-label="Recorded arrival history"]')?.textContent.includes('Loading recorded trips'));
            assert.equal(report.requests.length, n + 1);
            const text = await history.innerText();
            report.states.push({ scenario, text });
            if (scenario === 'departure')
                assert.match(text, /full stop-to-stop times/);
            if (['few', 'one', 'dominant'].includes(scenario)) {
                assert(!text.includes('Typical past trip:'));
                assert.match(text, /Not enough comparable evidence/);
            }
            if (scenario === 'one') {
                assert.match(text, /1 recorded trip across 1 date/);
                assert(!/Sep 16 – Sep 16/.test(text));
            }
            if (scenario === 'many') {
                assert.equal(await history.locator('circle').count(), 100);
                await tableSummary.focus();
                await page.keyboard.press('Space');
                assert.equal(await history.getByRole('row').count(), 101);
                assert(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
            }
            if (scenario === 'departure') {
                await history.evaluate(e => e.scrollIntoView({ block: 'start' }));
                await page.screenshot({ path: path.join(out, 'after-departure.png') });
            }
            if (scenario === 'midnight') assert.match(text, /2 dates · Sep 15 – Sep 16/, 'date range uses service starts, not next-day arrivals');
            if (scenario === 'empty')
                assert.match(text, /No comparable completed journeys/);
            if (scenario === 'unmatched')
                assert.match(text, /cannot be matched/);
            if (['failed', 'malformed'].includes(scenario))
                assert.match(await history.getByRole('alert').innerText(), /unavailable/);
            assert.match(await dialog.innerText(), /Following shuttle · #309/);
            if (scenario === 'old-snapshot') {
                assert.match(text, /1:00 PM/);
                const n = report.requests.length;
                await page.evaluate(() => window.changeProps({ etaSec: 480 }));
                await page.waitForTimeout(30);
                assert.equal(report.requests.length, n);
            }
        }
        // Timeout recovery and an older in-flight comparison cannot replace a newer bus's result.
        response = fixture();
        status = 200;
        pending = true;
        await refresh.click();
        await history.getByRole('status').waitFor();
        await page.clock.runFor(10001);
        await history.getByRole('alert').waitFor();
        assert(await refresh.evaluate(e => e === document.activeElement));
        pending = false;
        releases.splice(0).forEach(r => r());
        await refresh.click();
        await history.getByRole('img').waitFor();
        pending = true;
        response = fixture('standing');
        await refresh.click();
        await history.getByRole('status').waitFor();
        pending = false;
        response = fixture('departure');
        await page.evaluate(() => window.changeProps({ busName: '410' }));
        await history.getByText(/full stop-to-stop times/).waitFor();
        releases.splice(0).forEach(r => r());
        await page.waitForTimeout(30);
        assert.match(await history.innerText(), /full stop-to-stop times/);
        assert.equal(report.requests.at(-1).bus, '410');
        await page.evaluate(() => window.changeProps({ nextBusName: '410', nextSec: 2400 }));
        assert.match(await dialog.innerText(), /Next pass by this shuttle/);
        await page.evaluate(() => window.changeProps({ nextSec: null, distributionSec: undefined }));
        assert.match(await dialog.innerText(), /Next arrival\s+Not available/);
        assert.equal(await dialog.getByRole('img', { name: /Likely arrival window/ }).count(), 1);
        report.controls = await history.locator('button,summary').evaluateAll(es => es.map(e => ({ name: e.textContent, height: e.getBoundingClientRect().height })));
        assert(report.controls.every(b => b.height >= 44));
        await dialog.getByRole('button', { name: 'Close arrival details' }).click();
        assert(await trigger.evaluate(e => e === document.activeElement));
        pending = true;
        if (desktop)
            await trigger.click();
        else
            await trigger.tap();
        await history.getByRole('status').waitFor();
        await page.keyboard.press('Escape');
        pending = false;
        releases.splice(0).forEach(r => r());
        assert.equal(await page.getByRole('dialog').count(), 0);
        report.checks.push('refresh focus/reentry guard, loading/error status, retry/timeout/older-request race, one/few/100/dominant/empty/unmatched/old snapshots, stable snapshot on ETA update, following/same-bus/missing arrival, touch open, Escape pending close');
    }
    assert.deepEqual(report.errors, []);
    await page.close();
    await ctx.close();
}
finally {
    releases.splice(0).forEach(r => r());
    await browser.close();
    await fs.writeFile(path.join(out, prefix + '-browser.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
