import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { seedTestId } from './testId.mjs';

const service=process.cwd();
const feed=JSON.parse(await fs.readFile('web/src/__fixtures__/blue-hidden-feedback-2026-10-12.json','utf8'));
const now=feed.server_eta.servedAt;
const out=process.env.BOT_OUT??'pr-preview/feedback-140-141';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
const ctx=await browser.newContext({viewport:{width:368,height:854},isMobile:true,hasTouch:true,timezoneId:'America/New_York',serviceWorkers:'block'});
try{
 await seedTestId(ctx);
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
 await blue.waitFor();
 assert(await page.getByRole('button',{name:'View Red trip details',exact:true}).isVisible());
 assert.equal(await page.getByRole('button',{name:'View Green trip details',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'View Orange Day trip details',exact:true}).count(),0);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:out+'/overview-blue-visible.png',fullPage:true});
 await blue.focus();await page.keyboard.press('Enter');
 await page.getByTitle('Walking directions to Whitney/Canner',{exact:true}).waitFor();
 assert.match(await page.locator('body').innerText(),/BOARD\s*Whitney\/Canner/);
 await page.screenshot({path:out+'/blue-catchable-pickup.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await fs.writeFile(out+'/browser-results.json',JSON.stringify({capturedAt:feed.capturedAt,viewport:{width:368,height:854},visible:['Red','Blue Day','Walk'],pickup:129,pickupName:'Whitney/Canner',pageErrors:errors,horizontalOverflow:false,originSource:feed.originSource},null,2));
}finally{await ctx.close();await browser.close();}
console.log('Reports #140/#141: Blue visible in overview; catchable Whitney/Canner pickup retained; walking-heavy alternatives hidden.');
