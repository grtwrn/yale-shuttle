/** Exercise the built operator page against the isolated preview helper. */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const {values} = parseArgs({options:{base:{type:"string",default:"http://127.0.0.1:8098"},study:{type:"string"},out:{type:"string",default:"store/stop-data-preview/screenshots"}}});
const out=path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??"/usr/bin/chromium",args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]});
const errors=[]; const checks=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:"Asia/Tokyo"});
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  page.on("request",request=>{assert.equal(new URL(request.url()).origin,new URL(values.base).origin,"operator page must make only same-origin requests");});
  await page.goto(`${values.base}/stats/stops`,{waitUntil:"domcontentloaded",timeout:60_000});
  await page.getByRole("heading",{name:"Operator sign in"}).waitFor();checks.push("Unauthenticated page requires operator sign-in");
  await page.getByLabel("Operator token").fill("preview-only-token");
  await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.getByLabel("Date",{exact:true}).waitFor();
  await page.getByLabel("Date",{exact:true}).selectOption("2026-09-08");
  await page.getByLabel("Route",{exact:true}).selectOption("3");
  await page.locator(".ledger tbody tr").first().waitFor();
  await page.getByRole("heading",{name:"Standing time through the day"}).waitFor();
  await page.waitForFunction(()=>document.querySelector(".ledger tbody")?.textContent?.includes("stopped"));
  assert.equal(await page.locator("input[type=password]").count(),0);checks.push("Existing session unlocks retained data; token input removed");
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).length),0);checks.push("No admin token stored in localStorage");
  await page.screenshot({path:path.join(out,"retained-desktop.png"),fullPage:true});
  if(values.study){
    await page.locator('input[type="file"]').setInputFiles(path.resolve(values.study));
    await page.getByRole("heading",{name:"Saved algorithm comparison"}).waitFor({timeout:30_000});
    await page.waitForFunction(()=>document.querySelector(".source-bar")?.textContent?.includes("Saved study"));
    const rows=await page.locator(".ledger tbody tr").count();assert(rows>0);
    await page.locator(".ledger .visit-button").nth(Math.min(3,rows-1)).click();
    await page.getByRole("heading",{name:"What did the algorithms say?"}).waitFor();
    await page.getByRole("button",{name:"Total stand",exact:true}).click();
    await page.locator('input[type="range"]').fill("1");
    await page.screenshot({path:path.join(out,"study-desktop.png"),fullPage:true});
    await page.getByRole("button",{name:"Downstream ETA",exact:true}).click();
    await page.locator(".visit-detail").screenshot({path:path.join(out,"study-arrival.png")});
    checks.push("Saved study imported locally; visit selection, target switch and query scrubber work");
    const bus=page.getByLabel("Bus",{exact:true});
    const busOptions=await bus.locator("option").evaluateAll(options=>options.map(o=>o.value));
    if(busOptions.length>1){await bus.selectOption(busOptions[1]);await page.waitForTimeout(100);assert((await page.locator(".ledger tbody tr").count())<=rows);await bus.selectOption("all");}
    const route=page.getByLabel("Route",{exact:true});const routeOptions=await route.locator("option").evaluateAll(options=>options.map(o=>o.value));
    if(routeOptions.length>1){await route.selectOption(routeOptions.find(v=>v!=="3"));await page.waitForTimeout(150);await route.selectOption("3");}
    checks.push("Bus and route filters work across saved observations");
    await page.locator('input[type="file"]').setInputFiles({name:"invalid.json",mimeType:"application/json",buffer:Buffer.from('{"schemaVersion":999}')});
    await page.getByRole("alert").filter({hasText:"Could not open study"}).waitFor();
    assert(await page.getByRole("heading",{name:"Saved algorithm comparison"}).isVisible());checks.push("Malformed study is rejected without replacing the valid study");
    await page.locator('input[type="file"]').setInputFiles(path.resolve(values.study));
    await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));
    await page.locator(".ledger tbody tr").first().waitFor();
    await page.locator(".visit-detail .clocks").waitFor();
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:path.join(out,"mobile.png"),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"page must not overflow the phone viewport");
  checks.push("390px phone layout has no page-level horizontal overflow");
  assert.equal(errors.length,0,errors.join("\n"));
  fs.writeFileSync(path.join(out,"checks.json"),JSON.stringify({checks,pageErrors:errors,study:values.study?path.basename(values.study):null},null,2)+"\n");
  console.log(JSON.stringify({checks,pageErrors:errors,out},null,2));
}finally{await browser.close();}
