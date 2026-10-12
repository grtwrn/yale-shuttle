import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service=process.cwd();
const feed=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json','utf8'));
const now=feed.server_eta.servedAt;
const out=process.env.BOT_OUT??'pr-preview/feedback-140-141';
const viewport=process.env.BOT_DESKTOP?{width:1280,height:900}:{width:368,height:854};
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
const ctx=await browser.newContext({viewport,isMobile:!process.env.BOT_DESKTOP,hasTouch:!process.env.BOT_DESKTOP,timezoneId:'America/New_York',serviceWorkers:'block'});
try{
 await seedTestId(ctx);
 await ctx.grantPermissions(['notifications']);
 await ctx.addInitScript(({from,to,now})=>{
  localStorage.setItem('listView','trip');
  sessionStorage.setItem('shuttle-trip-draft',JSON.stringify({fromText:'517 Prospect Street',fromLL:from,toText:'Rosenkranz Hall',toLL:to,tripTime:'',expandedKey:null,savedAt:now}));
 },{from:feed.from,to:feed.to,now});
 const page=await ctx.newPage(),errors=[];page.setDefaultTimeout(10000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date(now)});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.hostname!=='overview.test')return route.abort();
  if(u.pathname==='/api/buses')return route.fulfill({json:feed});
  if(u.pathname==='/api/weather')return route.fulfill({status:204});
  if(u.pathname.startsWith('/api/'))return route.fulfill({json:{reports:[],results:[]}});
  const file=u.pathname==='/'?'/index.html':u.pathname;
  try{return route.fulfill({body:await fs.readFile(service+'/web/dist'+file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}
  catch{return route.fulfill({status:404});}
 });
 await page.goto('https://overview.test',{waitUntil:'domcontentloaded'});
 const blue=page.getByRole('button',{name:'View Blue Day trip details',exact:true});
 const farther=page.getByRole('button',{name:'View Blue Day trip details from Whitney/Canner',exact:true});
 await blue.waitFor();await farther.waitFor();
 const nearRow=page.locator('tbody[data-route="Blue Day"][data-pickup="100"]');
 const farRow=page.locator('tbody[data-route="Blue Day"][data-pickup="129"]');
 assert.match(await nearRow.innerText(),/Closest stop/);
 assert.match(await nearRow.getByTestId('pickup-range').innerText(),/~21/);
 assert.match(await farRow.innerText(),/Arrive sooner/);
 assert.match(await farRow.getByTestId('pickup-range').innerText(),/~7/);
 assert(await page.getByRole('button',{name:'View Red trip details',exact:true}).isVisible());
 assert.equal(await page.getByRole('button',{name:'View Green trip details',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'View Orange Day trip details',exact:true}).count(),0);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:out+'/overview-blue-visible.png',fullPage:true});
 await blue.focus();await page.keyboard.press('Enter');
 await page.getByTitle('Walking directions to Prospect/Canner',{exact:true}).waitFor();
 assert.match(await page.locator('body').innerText(),/BOARD\s*Prospect\/Canner/);
 await page.screenshot({path:out+'/blue-close-pickup.png',fullPage:true});
 await page.getByRole('button',{name:/^🔔 Remind me for /}).click();
 await page.getByRole('button',{name:/^🔔 Reminding you for /}).waitFor();
 await page.clock.runFor(5500);
 assert(await page.getByTitle('Walking directions to Prospect/Canner',{exact:true}).isVisible());
 await page.getByRole('button',{name:'← All routes',exact:true}).click();
 await farther.focus();await page.keyboard.press('Enter');
 await page.getByTitle('Walking directions to Whitney/Canner',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/^🔔 Reminding you for /}).count(),0,'Changing pickups must cancel the old-stop reminder');
 assert.match(await page.locator('body').innerText(),/BOARD\s*Whitney\/Canner/);
 await page.clock.runFor(5500);
 assert(await page.getByTitle('Walking directions to Whitney/Canner',{exact:true}).isVisible());
 await page.screenshot({path:out+'/blue-catchable-pickup.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser-results.json',JSON.stringify({capturedAt:feed.capturedAt,viewport,visible:['Red','Walk','Blue Day'],pickupChoices:[{stop:100,name:'Prospect/Canner',preference:'Closest stop',walkMin:2,nextBusMin:21},{stop:129,name:'Whitney/Canner',preference:'Arrive sooner',walkMin:8,nextBusMin:7}],directionsAndSelectionVerified:true,oldReminderCancelledOnPickupChange:true,pageErrors:errors,horizontalOverflow:false,originSource:feed.originSource},null,2));
}finally{await ctx.close();await browser.close();}
console.log('Reports #140/#141: closest Prospect/Canner and earlier Whitney/Canner pickups both visible, independently timed and selectable; directions stay pinned; changing pickup cancels its old reminder.');
