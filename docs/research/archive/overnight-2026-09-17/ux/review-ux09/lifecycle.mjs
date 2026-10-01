// Independent review fixture: full actual app, only an outer render fault injected in memory.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const service=process.cwd(), out=process.env.OUT;
assert(out); await fs.mkdir(out,{recursive:true});
const {build}=await import(path.join(service,'web/node_modules/vite/dist/node/index.js'));
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId,TEST_ANON_ID}=await import(service+'/scripts/testId.mjs');
const entry=service+'/web/src/main.tsx';
const main=await fs.readFile(entry,'utf8');
const original='import TransitMap from "./TransitMap";';
assert(main.includes(original));
const faultMain=main.replace(original, `import ActualTransitMap from "./TransitMap";
import {useState} from "react";
function TransitMap() {
 const [failed, fail] = useState(false);
 window.__reviewCrash = () => fail(true);
 if (failed || localStorage.getItem('review-startup-failure') === 'yes') throw new Error('Independent synthetic render failure');
 return <ActualTransitMap />;
}`);
const dist=path.join(out,'fault-dist');
await build({root:service+'/web',configFile:service+'/web/vite.config.ts',plugins:[{name:'review-only-boundary-fault',enforce:'pre',load(id){if(id===entry)return faultMain;}}],build:{outDir:dist,emptyOutDir:true}});
const feed=JSON.parse(await fs.readFile(service+'/web/src/__fixtures__/buses-payload.json','utf8'));
feed.stop_names=Object.fromEntries(JSON.parse(await fs.readFile(service+'/src/server/__fixtures__/stops.json','utf8')).map(s=>[s.id,s.name]));
feed.buses=[];delete feed.server_eta;
const now=Date.parse('2026-09-17T14:00:00-04:00');
const draft={fromText:'Independent origin',fromLL:feed.stop_coords[48],toText:'Independent destination',toLL:feed.stop_coords[121],tripTime:'',expandedKey:null,savedAt:now};
const report={scope:'Full Vite SPA with review-only outer Page fault injection; current real main boundary/recovery, actual saved trip',checks:[],errors:[],requests:0,states:[]};
let browser,context,page;
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
 await seedTestId(context);
 await context.addInitScript(({draft,now})=>{
  const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
  if(!sessionStorage.getItem('review-seeded')){
   sessionStorage.setItem('review-seeded','yes');sessionStorage.setItem('shuttle-trip-draft',JSON.stringify(draft));
   localStorage.setItem('shuttle.tempUnit','C');localStorage.setItem('review-retained','yes');
  }
  const clear=Storage.prototype.clear;
  Storage.prototype.clear=function(){const result=clear.call(this);if(this===localStorage)sessionStorage.setItem('review-id-after-clear',this.getItem('shuttle-anon-id')??'absent');return result;};
 },{draft,now});
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.hostname!=='review-recovery.test')return r.abort();
  if(u.pathname==='/api/buses'){report.requests++;assert.equal(r.request().headers()['x-anon-id'],TEST_ANON_ID);return r.fulfill({json:feed});}
  if(u.pathname==='/api/weather')return r.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return r.fulfill({json:{reports:[],results:[],routes:[]}});
  const file=u.pathname==='/'?'/index.html':u.pathname;
  try{return r.fulfill({body:await fs.readFile(dist+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return r.fulfill({status:404});}
 });
 const heading=()=>page.getByRole('heading',{name:'The shuttle app couldn’t open',exact:true});
 const reload=()=>page.getByRole('button',{name:'Reload',exact:true});
 const reset=()=>page.getByRole('button',{name:'Reset saved data & reload',exact:true});
 const details=()=>page.locator('summary').filter({hasText:'Still having trouble?'});
 async function trip(){await page.getByRole('navigation',{name:'Main'}).waitFor();await page.getByRole('button',{name:'To 🏁 Independent destination Save this destination',exact:true}).waitFor();assert.equal(await heading().count(),0);}
 async function crash(){await page.getByRole('button',{name:'Refresh the app',exact:true}).focus();await page.evaluate(()=>window.__reviewCrash());await heading().waitFor();assert(await heading().evaluate(e=>e===document.activeElement));}
 async function capture(name){report.states.push({name,aria:await page.locator('body').ariaSnapshot(),draft:await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')))});}
 await page.goto('https://review-recovery.test');await trip();await capture('restored real trip');
 await crash();assert.equal(await reset().isVisible(),false);assert.equal(await page.locator('pre').isVisible(),false);
 await page.keyboard.press('Tab');assert(await reload().evaluate(e=>e===document.activeElement));await page.keyboard.press('Enter');await trip();
 assert.equal(await page.evaluate(()=>localStorage.getItem('review-retained')),'yes');
 assert.equal(await page.evaluate(()=>localStorage.getItem('shuttle.tempUnit')),'C');
 report.checks.push('Runtime crash unmounts actual app control, focuses recovery heading; keyboard Reload restores actual destination and retains local preferences');
 await page.evaluate(()=>localStorage.setItem('review-startup-failure','yes'));await page.reload();await heading().waitFor();
 assert(await heading().evaluate(e=>e===document.activeElement));await reload().click();await heading().waitFor();
 await details().tap();assert(await reset().isVisible());assert.equal(await page.locator('pre').isVisible(),false);
 const description=await reset().getAttribute('aria-describedby');assert.equal(description,'crash-reset-effects crash-reset-reports');
 for(const id of description.split(' '))assert.equal(await page.locator('#'+id).count(),1);
 await capture('startup crash with reset explanation');
 for(const width of [320,360,390,430,1280]) {await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'actual app recovery reflow '+width);}
 await page.evaluate(()=>document.documentElement.style.zoom='2');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'actual recovery at 200% CSS zoom');
 assert(await reset().isVisible());await page.evaluate(()=>document.documentElement.style.zoom='');await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:out+'/actual-app-reset.png'});
 // Disclosure does not itself clear anything, and can be closed by keyboard.
 assert.equal(await page.evaluate(()=>localStorage.getItem('review-retained')),'yes');
 await details().focus();await page.keyboard.press('Space');assert.equal(await reset().isVisible(),false);
 await page.keyboard.press('Enter');assert(await reset().isVisible());
 await reset().tap();await trip();
 assert.equal(await page.evaluate(()=>localStorage.getItem('review-startup-failure')),null);
 assert.equal(await page.evaluate(()=>localStorage.getItem('review-retained')),null);
 assert.equal(await page.evaluate(()=>localStorage.getItem('shuttle.tempUnit')),null);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('review-id-after-clear')),'absent');
 const retained=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')));
 assert.equal(retained.toText,draft.toText);assert.deepEqual(retained.toLL,draft.toLL);assert.deepEqual(retained.fromLL,draft.fromLL);
 await capture('explicit reset restores actual trip');
 report.checks.push('Startup-persistent synthetic fault survives Reload; native reset disclosure/touch explicitly clears storage and report identity; actual TripPlanner restores valid session draft with both endpoints');
 // Recovery button is intentionally distinct from header refresh clearing the trip.
 await page.getByRole('button',{name:'Refresh the app',exact:true}).focus();await page.keyboard.press('Enter');
 await page.getByRole('navigation',{name:'Main'}).waitFor();assert.equal(await page.getByRole('button',{name:'To 🏁 Independent destination Save this destination',exact:true}).count(),0);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('shuttle-trip-draft')),null);
 report.checks.push('After recovery, intentional app-header Refresh still clears the trip (existing policy preserved)');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{
 if(page&&!report.completed)report.failureSnapshot=await page.locator('body').ariaSnapshot().catch(()=>null);
 if(page)await page.close();if(context)await context.close();if(browser)await browser.close();report.resourcesClosed=true;
 await fs.writeFile(out+'/lifecycle.json',JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
