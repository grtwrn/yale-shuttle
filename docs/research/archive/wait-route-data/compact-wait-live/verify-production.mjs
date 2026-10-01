import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from '/home/gwarren/projects/yale-shuttle-watcher/server-eta-2026-09-16/services/shuttle-v2/node_modules/playwright-core/index.mjs';
const local=process.argv.includes('--local');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const results=[];
try {
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['geolocation'],geolocation:{latitude:41.324769,longitude:-72.923522},timezoneId:'America/New_York',serviceWorkers:'block'});
 await ctx.addInitScript(()=>localStorage.setItem('shuttle-anon-id','00000000-0000-4000-8000-000000000000'));
 const page=await ctx.newPage();
 await page.route('**/api/geocode**',r=>r.fulfill({json:{results:[{display_name:'Rosenkranz Hall',lat:41.314701,lon:-72.924551,type:'university',class:'yale'}]}}));page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let samples=0;
 if(local && !process.argv.includes('--api')) await page.route('**/api/**', async route=> {
  if(route.request().url().includes('/api/buses')) {
   const p=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/wait-route-data/compact-wait-live/production-live-02.json','utf8'));
   const delta=Date.now()-p.server_eta.servedAt;
   p.server_eta.at+=delta;p.server_eta.servedAt+=delta;
   for(const b of p.buses) if(b.observed_at) b.observed_at+=delta;
   samples++;
   return route.fulfill({json:p});
  }
  if(route.request().url().includes('/api/geocode')) return route.fulfill({json:{results:[{display_name:'Rosenkranz Hall',lat:'41.2845',lon:'-72.9577',type:'hospital',class:'amenity'}]}});
  return route.fulfill({json:[]});
 });
 page.on('response',async r=>{if(r.url().endsWith('/api/buses')&&!local){try{const p=await r.json();assert.equal(r.headers()['cache-control'],'no-store');fs.writeFileSync(`/home/gwarren/projects/yale-shuttle-watcher/wait-route-data/compact-wait-live/live-payload-${++samples}.json`,JSON.stringify(p));}catch{}}});
 await page.goto(local?'http://127.0.0.1:8090/':'https://yale-shuttle.fly.dev/',{waitUntil:'domcontentloaded'});
 await page.getByPlaceholder('Where do you want to go?').fill('Rosenkranz Hall');
 await page.getByText('Rosenkranz Hall',{exact:true}).first().click();
 const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
 const trip=page.getByRole('button',{name:'View Red trip details',exact:true});await trip.focus();await page.keyboard.press('Enter');
 const wait=page.locator('.trip-map-wrap .bus-wait-label').filter({has:page.locator('.bus-wait-route',{hasText:'Red'})}).first();await wait.waitFor();
 const inspect=async()=>{ for(let retry=0;retry<20;retry++){const result=await wait.evaluate(el=> {
  const label=el.closest('.eta-tip'), wrap=el.closest('.trip-map-wrap');
  if(!label || !wrap || !el.isConnected) return null;
  const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
  const r=rect(label),map=rect(wrap);
  const blocks=[...wrap.querySelectorAll('button,.leaflet-control,.eta-tip')].filter(e=>e!==label&&!e.querySelector('.bus-wait-label'));
  return {at:Date.now(),text:el.innerText,title:el.title,rect:r,map,collisions:blocks.filter(e=>{const b=rect(e);return r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top}).map(e=>({text:e.getAttribute('aria-label')||e.textContent,rect:rect(e)}))};
 }); if(result)return result; await page.waitForTimeout(50); } throw new Error('label detached');};
 if(!local || process.argv.includes('--api')) for(let i=0;i<25;i++){const r=await inspect(); results.push(r);fs.writeFileSync(`/home/gwarren/projects/yale-shuttle-watcher/wait-route-data/compact-wait-live/production-${local?'local':'live'}-ticks.json`,JSON.stringify(results,null,2)); await page.waitForTimeout(700);}
 for(const width of [390,320,430]) {
  await page.setViewportSize({width,height:844});await page.waitForTimeout(500);await wait.locator('xpath=ancestor::div[contains(@class,"trip-map-wrap")]').evaluate(e=>e.scrollIntoView({block:'center'}));
  results.push({width,mode:'embedded',...await inspect()});await page.screenshot({path:`/home/gwarren/projects/yale-shuttle-watcher/wait-route-data/compact-wait-live/production-${local?'local':'live'}-${width}.png`});
  const wrap=wait.locator('xpath=ancestor::div[contains(@class,"trip-map-wrap")]');
  await wrap.getByRole('button',{name:'Fullscreen',exact:true}).click();await page.waitForTimeout(500);results.push({width,mode:'fullscreen',...await inspect()});
  await wrap.getByRole('button',{name:'Back',exact:true}).click();await page.waitForTimeout(200);
 }
 fs.writeFileSync(`/home/gwarren/projects/yale-shuttle-watcher/wait-route-data/compact-wait-live/production-${local?'local':'live'}-result.json`,JSON.stringify({results,errors,samples},null,2));
 const ticks=results.filter(r=>!r.width);assert(ticks.length>=20);const seconds=r=>{const m=r.text.match(/ (\d+):(\d+)\/~/);assert(m);return Number(m[1])*60+Number(m[2]);};
 const backsteps=ticks.slice(1).filter((r,i)=>r.title.split('.')[0]===ticks[i].title.split('.')[0] && seconds(r)<seconds(ticks[i]));
 assert.equal(backsteps.length,0,'continuing waiting clock must not step backward');assert(seconds(ticks.at(-1))>seconds(ticks[0]));
 for(const r of results.filter(r=>r.width)){assert.equal(r.collisions.length,0);assert(/^Red \d+:\d{2}\/~\d+m$/.test(r.text));assert.equal(r.text.split('\n').length,1);}
 assert.deepEqual(errors,[]);assert(samples>=2);console.log(JSON.stringify({clockSamples:ticks.length,backsteps:backsteps.length,layouts:results.filter(r=>r.width).length,pageErrors:errors,feedResponses:samples,first:ticks[0].text,last:ticks.at(-1).text}));
} finally {await browser.close();}
