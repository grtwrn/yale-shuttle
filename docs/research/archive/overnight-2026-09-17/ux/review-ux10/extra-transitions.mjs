/** Bounded actual-SPA keyboard/touch regression. Build web, then run under
 * the shared heavy lock with OUT=/path/to/fresh/evidence. All traffic mocked. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const service=process.cwd(), out=process.env.OUT || path.join(service,'pr-preview','saved-places');
const {chromium}=createRequire(service+'/package.json')('playwright-core');
const {seedTestId}=await import(service+'/scripts/testId.mjs');
const entry=(id,toText,toLat,toLon)=>({id,toText,name:toText,toLat,toLon,fromText:'',fromLat:0,fromLon:0});
const saved=[entry('s1','Sterling Memorial Library',41.3113,-72.9288),entry('s2','School of Management — Evans Hall classroom and library',41.315,-72.920)];
const recent=[entry('r1','Union Station — main concourse and shuttle pickup',41.2988,-72.925),entry('r2','Science Hill — laboratory classroom and library',41.320,-72.922)];
const feed=JSON.parse(await fs.readFile(service+'/web/src/__fixtures__/buses-payload.json','utf8'));feed.buses=[];
const report={source:'Built SPA, local intercepted fixtures, no production traffic',checks:[],errors:[],sizes:[]};
await fs.mkdir(out,{recursive:true});
const desktop=process.env.DESKTOP==='1';
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
let ctx,page;
try {
 ctx=await browser.newContext({viewport:{width:desktop?1280:390,height:844},isMobile:!desktop,hasTouch:!desktop,serviceWorkers:'block',timezoneId:'America/New_York',geolocation:{latitude:41.31,longitude:-72.925},permissions:['geolocation']});
 await seedTestId(ctx);
 await ctx.addInitScript(({saved,recent})=>{
   if(!sessionStorage.getItem('saved-places-fixture')) {
     localStorage.setItem('shuttle-saved-trips',JSON.stringify(saved));localStorage.setItem('shuttle-recent-trips',JSON.stringify(recent));localStorage.setItem('listView','trip');sessionStorage.setItem('saved-places-fixture','1');
   }
 },{saved,recent});
 page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(e.message));
 let feedMode='empty';
 await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='shuttle.test')return route.abort();
   if(u.pathname==='/api/buses')return route.fulfill(feedMode==='failed'?{status:503,json:{}}:{json:feed});
   if(u.pathname==='/api/weather')return route.fulfill({status:204});
   if(u.pathname.startsWith('/api/'))return route.fulfill({json:{results:[],reports:[],routes:[]}});
   const file=u.pathname==='/'?'/index.html':u.pathname;
   try{return route.fulfill({body:await fs.readFile((process.env.DIST_ROOT || service+'/web/dist')+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'});}catch{return route.fulfill({status:404});}
 });
 const savedRegion=()=>page.getByRole('region',{name:'Saved destinations',exact:true});
 const recentRegion=()=>page.getByRole('region',{name:'Recent places',exact:true});
 const button=(name)=>page.getByRole('button',{name,exact:true});
 const focused=async locator=>assert(await locator.evaluate(e=>e===document.activeElement),'expected focus: '+await locator.getAttribute('aria-label'));
 const read=key=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),key);
 const savedData=()=>read('shuttle-saved-trips');
 const recentData=()=>read('shuttle-recent-trips');
 async function reset(s=saved,r=recent) {
   await page.evaluate(({s,r})=>{localStorage.setItem('shuttle-saved-trips',JSON.stringify(s));localStorage.setItem('shuttle-recent-trips',JSON.stringify(r));sessionStorage.removeItem('shuttle-trip-draft');}, {s,r});
   // Header refresh is the established app action that clears a planned trip.
   const refresh=page.getByRole('button',{name:/Refresh/});
   await refresh.first().click();
   await page.getByRole('combobox',{name:'To',exact:true}).waitFor();
 }

 await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});await savedRegion().waitFor();
 const edit=()=>button('Edit saved destinations'), done=()=>button('Done editing saved destinations');
 const rename=text=>page.getByRole('textbox',{name:'Rename '+text,exact:true});
 const activate=async locator=>desktop?locator.click():locator.tap();
 await activate(edit());await rename(saved[0].toText).fill('  Main Library  ');await activate(done());
 assert.equal((await savedData())[0].toText,'Main Library');await focused(edit());
 await page.reload();await button('Plan trip to Main Library').waitFor();
 await activate(edit());await rename('Main Library').fill('discard on Escape');await rename('Main Library').press('Escape');
 await activate(rename(saved[1].toText));assert.equal((await savedData())[0].toText,'Main Library');
 report.checks.push('Pointer Done commits a dirty trimmed name before replacing inputs; reload retains it; Escape remains cancelled after tapping another input');
 const three=[...saved,entry('s3','Third classroom',41.318,-72.931)];
 await reset(three,[]);await activate(edit());
 await button('Delete saved destination '+saved[1].toText).focus();await page.keyboard.press('Enter');
 assert.deepEqual((await savedData()).map(x=>x.id),['s1','s3']);await focused(rename('Third classroom'));
 await button('Delete saved destination Third classroom').focus();await page.keyboard.press('Space');
 assert.deepEqual((await savedData()).map(x=>x.id),['s1']);await focused(rename(saved[0].toText));
 report.checks.push('Deleting middle and final rows preserves exact identities and focuses next then previous surviving input');
 await reset(three,[]);await activate(edit());await rename(saved[0].toText).fill('Pending first label');
 await activate(button('Delete saved destination '+saved[1].toText));
 await focused(rename(saved[0].toText));assert.equal(await rename(saved[0].toText).inputValue(),'Pending first label');
 assert.equal((await savedData())[0].toText,saved[0].toText);assert.deepEqual((await savedData()).map(x=>x.id),['s1','s3']);
 await activate(done());assert.equal((await savedData())[0].toText,'Pending first label');
 report.checks.push('Pointer deletion of a different row retains active dirty input and delays its commit until ordinary blur');
 await reset(saved,recent);await activate(edit());await rename(saved[0].toText).fill('Saved through promotion');
 await activate(button('Save destination '+recent[0].toText));
 assert.equal((await savedData())[0].toText,'Saved through promotion');assert.equal((await savedData()).length,3);
 await focused(rename(recent[0].toText));assert.equal((await recentData()).length,1);
 report.checks.push('Pointer recent promotion while renaming commits first name, preserves both entries and focuses new saved input');
 const twins=[entry('tw1','Library',41.31,-72.92),entry('tw2','Library',41.32,-72.93)];
 await reset(twins,[]);
 const twinsButtons=savedRegion().getByRole('button',{name:'Plan trip to Library',exact:true});
 await twinsButtons.nth(1).focus();await page.keyboard.press('Enter');
 const summary=page.getByRole('button',{name:/^To 🏁/});await summary.waitFor();
 assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')).toLL),{lat:41.32,lon:-72.93});
 report.checks.push('Duplicate display names retain separate destination coordinates when selected');
 await reset(saved,recent);
 await page.setViewportSize({width:320,height:844});
 for(const region of [savedRegion(),recentRegion()]) for(const control of await region.locator('button,input').all()){
  const b=await control.boundingBox();assert(b.width>=44 && b.height>=44);
 }
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:640,height:844});await page.evaluate(()=>document.body.style.zoom='2');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await activate(edit());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>document.body.style.zoom='');
 report.checks.push('320px and 640px at 200% CSS zoom preserve readable controls and horizontal reflow');
 assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error){report.failure=String(error);if(page && !page.isClosed())report.snapshot=await page.locator('body').ariaSnapshot().catch(()=>null);throw error;}
finally {await browser.close();report.closed=true;await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
