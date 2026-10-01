import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from '/home/gwarren/projects/yale-shuttle-watcher/server-eta-2026-09-16/services/shuttle-v2/node_modules/playwright-core/index.mjs';
import {seedTestId} from '/home/gwarren/projects/yale-shuttle-watcher/server-eta-2026-09-16/services/shuttle-v2/scripts/testId.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const out=new URL('./production-wait/',import.meta.url);await fs.mkdir(out,{recursive:true});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['geolocation'],geolocation:{latitude:41.303784,longitude:-72.935017},timezoneId:'America/New_York',serviceWorkers:'block'});await seedTestId(ctx);
 const page=await ctx.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://yale-shuttle.fly.dev/',{waitUntil:'domcontentloaded'});
 await page.getByPlaceholder('Where do you want to go?').fill('VA Hospital');
 await page.getByText('VA Hospital',{exact:true}).first().click();
 const more=page.getByRole('button',{name:/Show \d+ more route/});if(await more.isVisible())await more.click();
 const trip=page.getByRole('button',{name:'View Pink trip details',exact:true});await trip.focus();await page.keyboard.press('Enter');
 const wait=page.locator('.trip-map-wrap .bus-wait-label').filter({has:page.locator('.bus-wait-route',{hasText:'Pink'})}).first();await wait.waitFor();
 const before=await wait.innerText();assert.match(before,/^Pink · Waiting(?: nearby)? \d+:\d{2}\nUsually ~\d+ min total$/);
 assert.match(await wait.getAttribute('title'),/^Pink #\d+\./);
 await page.waitForTimeout(2200);const after=await wait.innerText();assert.notEqual(before.split('\n')[0],after.split('\n')[0]);assert.equal(before.split('\n')[1],after.split('\n')[1]);
 await wait.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('pink-route-wait-390.png',out).pathname});assert.deepEqual(errors,[]);
 await fs.writeFile(new URL('verification.json',out),JSON.stringify({before,after,errors,route:await wait.locator('.bus-wait-route').innerText()},null,2));console.log(JSON.stringify({before,after,errors}));
}finally{await browser.close();}
