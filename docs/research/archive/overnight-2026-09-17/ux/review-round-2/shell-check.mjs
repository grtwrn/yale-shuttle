import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const service=process.cwd();
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const out=path.dirname(new URL(import.meta.url).pathname);
const feed=JSON.parse(await fs.readFile(service+'/web/src/__fixtures__/buses-payload.json','utf8'));
feed.buses=[];
feed.stop_names=Object.fromEntries(JSON.parse(await fs.readFile(service+'/src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
const report={source:'Built SPA; checked-in network fixture; empty fleet; all requests intercepted',checks:[],controls:[],errors:[],requests:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
const ctx=await browser.newContext({viewport:{width:360,height:800},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
await seedTestId(ctx);
await ctx.addInitScript(()=>{
 const now=Date.parse('2026-09-17T14:00:00-04:00');
 sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'Winchester / Mansfield',fromLL:{lat:41.324769,lon:-72.923522},toText:'Laboratory of Epidemiology and Public Health / 60 College Street',toLL:{lat:41.303735,lon:-72.932155},tripTime:'2026-09-17T15:00',tripTimeSetAt:now,expandedKey:null,arriveBy:'2026-09-17T15:20',classBufferMin:5,savedAt:now}));
});
const page=await ctx.newPage();page.setDefaultTimeout(12000);
page.on('pageerror',e=>report.errors.push(e.message));
await page.clock.install({time:new Date('2026-09-17T14:00:00-04:00')});
await page.route('**/*',async route=>{
const u=new URL(route.request().url());
if(u.hostname!=='shuttle.test')return route.abort();
if(u.pathname.startsWith('/api/'))report.requests.push({method:route.request().method(),path:u.pathname});
if(u.pathname==='/api/buses')return route.fulfill({json:feed});
if(u.pathname==='/api/weather')return route.fulfill({status:204});
if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[],routes:[]}});
const file=u.pathname==='/'?'/index.html':u.pathname;
try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'});}catch{return route.fulfill({status:404});}
});
await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(300);
report.initialText=await page.locator('body').innerText();
const departure=page.getByLabel('Departure time',{exact:true});await departure.waitFor();
const notice=page.getByText(/Planning for .*Estimated from service hours/);await notice.waitFor();
assert.doesNotMatch(await notice.innerText(),/½|headway/);
const panel=page.getByRole('region',{name:'Arrive by class'});await panel.waitFor();
await panel.getByRole('heading',{name:'Live shuttle times unavailable',exact:true}).waitFor();
report.futurePanel=await panel.innerText();
assert.doesNotMatch(report.futurePanel,/Red · #/,'future plan must not invent a bus identity');
for(const width of [360,390,430,1280,640]){
 await page.setViewportSize({width,height:width===640?422:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at '+width);
 await departure.scrollIntoViewIfNeeded();
 if(width===360||width===390)await page.screenshot({path:out+'/after-shell-future-'+width+'.png'});
}
report.checks.push('future/no live window and long destination in real SPA at 360/390/430/1280px','640 CSS-pixel reflow equivalent to 1280px desktop at 200% zoom');
const nowButton=page.getByRole('button',{name:'Now',exact:true});
for(const el of [departure,nowButton]){
const box=await el.boundingBox();assert(box.height>=44&&box.width>=44);report.controls.push({name:await el.getAttribute('aria-label')||await el.innerText(),...box});
}
assert.equal(await departure.evaluate(e=>getComputedStyle(e).fontSize),'16px');
await departure.focus();
let tabs=0;
while(!(await nowButton.evaluate(e=>e===document.activeElement))&&tabs<12){await page.keyboard.press('Tab');tabs++;}
assert(await nowButton.evaluate(e=>e===document.activeElement));report.departureTabsToNow=tabs;
await page.keyboard.press('Enter');
const later=page.getByRole('button',{name:'Plan for later…',exact:true});await later.waitFor();
report.focusAfterNow=await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,60)}));
assert(await later.evaluate(e=>e===document.activeElement),'focus retained on reused departure button');
const box=await later.boundingBox();assert(box.height>=44&&box.width>=44);report.controls.push({name:'Plan for later…',...box});
await later.focus();await page.keyboard.press('Space');await departure.waitFor();
await departure.fill('2026-09-17T15:00');await notice.waitFor();
await page.reload({waitUntil:'domcontentloaded'});await notice.waitFor();
assert.equal(await departure.inputValue(),'2026-09-17T15:00');
report.checks.push('Now and Plan for later keyboard actions','departure datetime is 16px; all touched controls >=44px','future trip draft restored after reload');
await page.setViewportSize({width:360,height:800});
await panel.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/after-shell-class-360.png'});
await panel.getByLabel('Class starts · local time').fill('2026-01-01T10:00');
assert.match(await panel.getByRole('alert').innerText(),/passed/);assert.equal(await panel.getByRole('heading').count(),0);
report.checks.push('invalid deadline remains authoritative in full shell');
assert.deepEqual(report.errors,[]);
assert(!report.requests.some(r=>r.path==='/api/report'));
await page.close();await ctx.close();
}finally{await browser.close();await fs.writeFile(out+'/shell-browser.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
