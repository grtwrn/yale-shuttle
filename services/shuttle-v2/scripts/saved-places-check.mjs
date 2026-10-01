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
 // Real Tab sequence reaches the two destination buttons, and Enter plans.
 const edit=()=>button('Edit saved destinations');
 await edit().focus();await page.keyboard.press('Tab');await focused(button('Plan trip to '+saved[0].toText));
 await page.keyboard.press('Tab');await focused(button('Plan trip to '+saved[1].toText));
 await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
 const toSummary=()=>page.getByRole('button',{name:/^To 🏁/});
 await toSummary().waitFor();await page.waitForFunction(()=>document.activeElement?.textContent?.includes('To') && document.activeElement?.getAttribute('role')==='button');
 assert.match(await toSummary().innerText(),/Sterling Memorial Library/);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shuttle-trip-draft')).toLL),{lat:saved[0].toLat,lon:saved[0].toLon});
 report.checks.push('Tab/Shift+Tab reach saved buttons; Enter plans correct destination and focuses To summary');
 await reset();
 const recentFirst=button('Plan trip to '+recent[0].toText);
 await button('Clear all recent places').focus();await page.keyboard.press('Tab');await focused(recentFirst);await page.keyboard.press('Space');await toSummary().waitFor();await focused(toSummary());
 assert.match(await toSummary().innerText(),/Union Station/);
 report.checks.push('Tab reaches recent destination; Space selects it without activating adjacent Save/Remove');
 await reset();await edit().focus();await page.keyboard.press('Space');
 const done=()=>button('Done editing saved destinations');
 assert.equal(await done().getAttribute('aria-pressed'),'true');
 let name=page.getByRole('textbox',{name:'Rename '+saved[0].toText,exact:true});
 await done().press('Tab');await focused(name);
 await name.fill('  Library for class  ');await name.press('Enter');await focused(done());
 assert.equal((await savedData())[0].toText,'Library for class');
 assert.equal((await savedData())[0].name,'Library for class');
 assert.deepEqual((await savedData())[0],{...saved[0],toText:'Library for class',name:'Library for class'});
 name=page.getByRole('textbox',{name:'Rename Library for class',exact:true});
 await name.fill('Discard this change');await name.press('Escape');await focused(done());
 assert.equal(await name.inputValue(),'Library for class');assert.equal((await savedData())[0].toText,'Library for class');
 await name.fill('  ');await name.press('Tab');assert.equal(await name.inputValue(),'Library for class');assert.equal((await savedData())[0].toText,'Library for class');
 await name.fill('Library after blur');await done().focus();assert.equal((await savedData())[0].toText,'Library after blur');
 await done().press('Enter');await focused(edit());await page.reload({waitUntil:'domcontentloaded'});
 await button('Plan trip to Library after blur').waitFor();assert.equal((await savedData())[0].toText,'Library after blur');
 report.checks.push('Enter/blur trim and persist names without changing coordinates; Escape cancels; blank names restore; Done retains focus; reload persists rename');
 await edit().click();
 await button('Delete saved destination Library after blur').focus();await page.keyboard.press('Enter');
 assert.equal((await savedData()).length,1);await focused(page.getByRole('textbox',{name:'Rename '+saved[1].toText,exact:true}));
 await button('Delete saved destination '+saved[1].toText).focus();await page.keyboard.press('Space');
 assert.equal((await savedData()).length,0);await focused(button('Plan trip to '+recent[0].toText));
 report.checks.push('Enter/Space delete the intended saved entry; focus moves to the next input, then the first recent place');
 // Pointer deletion while a name is half typed removes without a rename write.
 await reset();await edit().click();name=page.getByRole('textbox',{name:'Rename '+saved[0].toText,exact:true});await name.fill('Do not save me');
 await page.evaluate(()=>{window.savedWrites=[];const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='shuttle-saved-trips')window.savedWrites.push(value);return original.call(this,key,value);};});
 const pointerDelete=button('Delete saved destination '+saved[0].toText);
 if(desktop)await pointerDelete.click();else await pointerDelete.tap();
 assert.equal((await savedData()).length,1);assert(!(await page.evaluate(()=>window.savedWrites)).some(value=>value.includes('Do not save me')));
 await focused(page.getByRole('textbox',{name:'Rename '+saved[1].toText,exact:true}));
 report.checks.push('Touch/click delete while editing does not persist the partial rename and keeps useful focus');
 // Recent promotion, removal, duplicate coordinates, last-row fallback.
 await reset();await button('Save destination '+recent[0].toText).focus();await page.keyboard.press('Enter');
 await focused(button('Plan trip to '+recent[0].toText));
 assert.equal((await savedData()).filter(p=>p.toLat===recent[0].toLat).length,1);assert.equal((await recentData()).length,1);
 await button('Remove recent place '+recent[1].toText).focus();await page.keyboard.press('Space');await focused(edit());assert.equal((await recentData()).length,0);
 await reset(saved,[{...saved[0],id:'duplicate',toText:'Alternate library name'}]);
 await button('Save destination Alternate library name').focus();await page.keyboard.press('Space');assert.equal((await savedData()).length,2);await focused(button('Plan trip to '+saved[0].toText));
 await reset([],recent);await button('Remove recent place '+recent[0].toText).focus();await page.keyboard.press('Enter');await focused(button('Plan trip to '+recent[1].toText));
 await button('Clear all recent places').focus();await page.keyboard.press('Enter');await focused(page.getByRole('combobox',{name:'To',exact:true}));assert.equal((await recentData()).length,0);
 report.checks.push('Save recent focuses saved destination; existing coordinates deduplicate; recent remove/clear restore focus across final rows');
 // Removing the only saved place falls back to To; later saves start in normal mode.
 await reset(saved.slice(0,1),[]);await edit().click();await button('Delete saved destination '+saved[0].toText).focus();await page.keyboard.press('Enter');
 await focused(page.getByRole('combobox',{name:'To',exact:true}));assert.equal(await savedRegion().count(),0);
 // Promoting while Saved is in edit mode focuses the matching new rename input.
 await reset();await edit().click();await button('Save destination '+recent[0].toText).focus();await page.keyboard.press('Enter');
 await focused(page.getByRole('textbox',{name:'Rename '+recent[0].toText,exact:true}));
 // Long lists scroll the next/previous keyboard destination into view.
 const many=Array.from({length:12},(_,i)=>entry('long'+i,'Class building '+i,41.31+i*0.001,-72.928));
 await reset(many,[]);await edit().focus();for(let i=0;i<12;i++)await page.keyboard.press('Tab');
 await focused(button('Plan trip to Class building 11'));
 assert(await button('Plan trip to Class building 11').evaluate(e=>{const a=e.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();return a.top>=b.top && a.bottom<=b.bottom+1;}));
 if(desktop)await button('Plan trip to Class building 11').click();else await button('Plan trip to Class building 11').tap();
 await toSummary().waitFor();await focused(toSummary());assert.match(await toSummary().innerText(),/Class building 11/);
 report.checks.push('Final saved removal focuses To; promotion while editing focuses new input; long-list Tab scrolls and touch/click selects exact destination');
 // A different control deliberately takes focus in the same task as removal.
 await reset();await button('Remove recent place '+recent[0].toText).focus();
 await button('Remove recent place '+recent[0].toText).evaluate(element=>{element.click();document.querySelector('.app-tabs button').focus();});
 assert(await page.locator('.app-tabs button').first().evaluate(e=>e===document.activeElement));
 await button('Plan trip to '+saved[0].toText).focus();
 await button('Plan trip to '+saved[0].toText).evaluate(element=>{element.click();document.querySelector('.app-tabs button').focus();});
 await toSummary().waitFor();await page.waitForTimeout(50);
 assert(await page.locator('.app-tabs button').first().evaluate(e=>e===document.activeElement));
 report.checks.push('Removal and selection do not steal focus from another control selected in the same DOM task');
 // Reflow and target geometry use actual rendered controls, including long names.
 await reset();
 for(const width of [360,390,430,1280,640]){
   await page.setViewportSize({width,height:844});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow at '+width);
   for(const region of [savedRegion(),recentRegion()]){
     for(const control of await region.locator('button,input').all()){
       const box=await control.boundingBox();assert(box.width>=44 && box.height>=44,'short target '+await control.getAttribute('aria-label'));
     }
   }
   report.sizes.push(width);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/saved-390.png'});
 await edit().click();
 for(const width of [360,390,430,1280,640]){
   await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   for(const control of await savedRegion().locator('button,input').all()){const box=await control.boundingBox();assert(box.width>=44 && box.height>=44);}
   assert.equal(await page.getByRole('textbox',{name:'Rename '+saved[0].toText,exact:true}).evaluate(e=>getComputedStyle(e).fontSize),'16px');
 }
 await page.setViewportSize({width:1280,height:844});await page.evaluate(()=>document.body.style.zoom='2');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>document.body.style.zoom='');await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/editing-390.png'});
 report.checks.push('360/390/430/640/1280px and 200% CSS zoom have no page overflow; list targets >=44px; rename input 16px');
 // Storage write failures keep in-memory lists usable; read denial gives empty UI.
 await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Blocked','SecurityError');};});
 await button('Delete saved destination '+saved[0].toText).focus();await page.keyboard.press('Enter');
 assert.equal(await savedRegion().getByRole('textbox').count(),1);
 await done().click();await button('Save destination '+recent[0].toText).focus();await page.keyboard.press('Enter');await button('Plan trip to '+recent[0].toText).waitFor();
 report.checks.push('Blocked storage writes leave delete and save usable for this visit');
 // New contexts avoid retaining the temporary storage interceptor.
 await page.close();await ctx.close();
 for(const scenario of ['failed','pending','blocked']){
   const blocked=scenario==='blocked';
   const pending=[];
   ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});await seedTestId(ctx);
   await ctx.addInitScript(({blocked,saved})=>{if(blocked)Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}});else{localStorage.setItem('shuttle-saved-trips',JSON.stringify(saved));localStorage.setItem('listView','trip');}},{blocked,saved});
   page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(e.message));
   await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname!=='shuttle.test')return route.abort();if(u.pathname==='/api/buses' && scenario==='pending'){pending.push(route);return;}if(u.pathname.startsWith('/api/'))return route.fulfill({status:503,json:{}});const file=u.pathname==='/'?'/index.html':u.pathname;try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}});
   await page.goto('https://shuttle.test',{waitUntil:'domcontentloaded'});await page.getByRole('combobox',{name:'To',exact:true}).waitFor();
   if(scenario==='pending')await page.getByText('Loading shuttle information…',{exact:true}).waitFor();
   if(blocked){assert.equal(await savedRegion().count(),0);assert.equal(await recentRegion().count(),0);}else{await button('Plan trip to '+saved[0].toText).focus();await page.keyboard.press('Enter');await toSummary().waitFor();await focused(toSummary());}
   for(const route of pending)await route.abort().catch(()=>{});
   await page.close();await ctx.close();
 }
 report.checks.push('Pending/failed initial feed and unavailable GPS do not block saved selection; denied storage access yields an intact empty trip form');
 assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error){report.failure=String(error);if(page && !page.isClosed())report.snapshot=await page.locator('body').ariaSnapshot().catch(()=>null);throw error;}
finally {await browser.close();report.closed=true;await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
