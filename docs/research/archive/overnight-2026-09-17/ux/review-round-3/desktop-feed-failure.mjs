import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const service = process.cwd();
const out = '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/ux/review-round-3';
const { chromium } = createRequire(service + '/package.json')('playwright-core');
const { seedTestId } = await import(service + '/scripts/testId.mjs');
const feed = JSON.parse(await fs.readFile(service + '/web/src/__fixtures__/buses-payload.json', 'utf8'));
feed.buses = [];
feed.stop_names = Object.fromEntries(JSON.parse(await fs.readFile(service + '/src/server/__fixtures__/stops.json', 'utf8')).map(s => [s.id, s.name]));
const draft = {fromText:'Review origin',fromLL:{lat:41.3113,lon:-72.9288},toText:'Review destination',toLL:{lat:41.3037,lon:-72.9322},tripTime:'',expandedKey:null};
const matches = [{display_name:'First review match',lat:41.3113,lon:-72.9288,class:'amenity',type:'library'}, {display_name:'Second review match with a long destination name',lat:41.3037,lon:-72.9322,class:'amenity',type:'library'}];
const report = {checks:[],errors:[],queries:[],resourcesClosed:false};
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx;
let page;
try {
  ctx = await browser.newContext({viewport:{width:1280,height:900},isMobile:false,hasTouch:false,serviceWorkers:'block',timezoneId:'America/New_York'});
  await seedTestId(ctx);
  await ctx.addInitScript(d => {
    if (!sessionStorage.getItem('review-seeded')) {
      sessionStorage.setItem('shuttle-trip-draft', JSON.stringify({...d,savedAt:Date.now()}));
      sessionStorage.setItem('review-seeded','yes');
    }
  },draft);
  page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror',e => report.errors.push(e.message));
  let failed = false;
  await page.route('**/*',async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'shuttle.test') return route.abort();
    if(u.pathname === '/api/buses') return route.fulfill({status:503,json:{}});
    if(u.pathname === '/api/weather') return route.fulfill({status:204});
    if(u.pathname === '/api/geocode') {
      report.queries.push(u.searchParams.get('q'));
      return route.fulfill(failed ? {status:503,json:{}} : {json:{results:matches}});
    }
    if(u.pathname.startsWith('/api/')) {
      assert.notEqual(u.pathname,'/api/report');
      return route.fulfill({json:{reports:[],results:[],routes:[]}});
    }
    const f = u.pathname === '/' ? '/index.html' : u.pathname;
    try { return route.fulfill({body:await fs.readFile(service+'/web/dist'+f),contentType:f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'}); }
    catch {return route.fulfill({status:404});}
  });
  await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});
  const toSummary = page.getByRole('button',{name:/^To 🏁/});
  const toInput = page.getByRole('combobox',{name:'To',exact:true});
  await toSummary.waitFor();
  await toSummary.focus(); await toSummary.press('Enter');
  await toInput.fill('search while live feed is unavailable');
  await page.getByRole('option').nth(1).waitFor();
  assert.equal(await page.getByRole('listbox',{name:'To suggestions'}).count(),1);
  report.feedFailureText = await page.locator('body').innerText();
  assert.match(report.feedFailureText,/live|update|connect|load/i);
  for (const width of [1280,640]) {
    await page.setViewportSize({width,height:width===640?450:900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await toInput.evaluate(e => getComputedStyle(e).fontSize),'16px');
    for (const view of ['trip','map','issues']) {
      const box=await page.getByRole('button',{name:view,exact:true}).boundingBox();
      assert(box.height>=44 && box.width>=44);
    }
  }
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:out+'/review-desktop-feed-failure-1280.png'});
  await toInput.press('ArrowDown'); await toInput.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role')==='button' && document.activeElement.textContent.includes('To'));
  await page.keyboard.press('Tab');
  assert(await page.getByRole('button',{name:'Save this destination',exact:true}).evaluate(e => e===document.activeElement));
  for (const view of ['map','issues','trip']) {
    const button=page.getByRole('button',{name:view,exact:true});
    await button.focus(); await button.press('Enter');
    assert.equal(await button.getAttribute('aria-current'),'page');
    assert.equal(await page.locator('nav [aria-current="page"]').count(),1);
    assert(await button.evaluate(e => e===document.activeElement));
  }
  await toSummary.waitFor();
  assert.match(await toSummary.innerText(),/First review match/);
  report.checks.push('Desktop mouse/keyboard context: search works while live feed fails; labels, selection focus, selected navigation and endpoint draft are preserved.','1280px desktop and 640px equivalent reflow have no horizontal overflow; 16px input and navigation >=44x44.');
  assert.deepEqual(report.errors,[]);
  report.completed=true;
} finally {
  if (!report.completed && page) report.failureSnapshot = await page.locator('body').ariaSnapshot().catch(() => 'unavailable');
  if (page) await page.close();
  if (ctx) await ctx.close();
  await browser.close();
  report.resourcesClosed = true;
  await fs.writeFile(out+'/desktop-feed-failure.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
