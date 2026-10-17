import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { completeArrival } from './rider-watch/complete-arrival.mjs';

// Real Playwright actionability over a modeled arrival screen. No network,
// real journey, physical service or ETA accuracy is evaluated here.
const out=process.env.BOT_OUT??path.join(os.tmpdir(),'rider-completion-'+Date.now());
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.BOT_CHROMIUM_PATH??chromium.executablePath(),args:['--no-sandbox','--disable-gpu']});
const results=[];
const showPrompt=page=>page.evaluate(()=>{
 const dialog=document.createElement('div');dialog.setAttribute('role','alertdialog');dialog.setAttribute('aria-modal','true');
 dialog.style.cssText='position:fixed;inset:0;z-index:1000;background:white;padding:30px';
 dialog.innerHTML='<h2>Get off here</h2><button>Got it</button>';
 dialog.querySelector('button').onclick=()=>{window.dismissals++;dialog.remove();};document.body.append(dialog);
});
try{
 for(const timing of ['already-visible','during-screenshot']){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try{
   const page=await context.newPage();page.setDefaultTimeout(5000);
   await page.route('**/*',route=>route.abort());
   await page.setContent('<!doctype html><h1>Arriving at Target</h1><button id="done" onclick="window.completions++">Done</button><script>window.completions=0;window.dismissals=0;</script>');
   if(timing==='already-visible')await showPrompt(page);
   await completeArrival(page,async()=>{
    await page.screenshot({path:path.join(out,timing+'.png')});
    if(timing==='during-screenshot')await showPrompt(page);
   });
   const actual=await page.evaluate(()=>({completions:window.completions,dismissals:window.dismissals}));
   assert.deepEqual(actual,{completions:1,dismissals:1});
   // Completion's temporary handler must not acknowledge a later prompt.
   await showPrompt(page);let blocked=false;
   try{await page.getByRole('button',{name:'Done',exact:true}).click({timeout:300});}catch(error){blocked=error.name==='TimeoutError';}
   assert(blocked,'Later prompts must no longer be handled by completion');
   assert.deepEqual(await page.evaluate(()=>({completions:window.completions,dismissals:window.dismissals})),actual);
   results.push({timing,...actual,temporaryHandlerRemoved:true});
  }finally{await context.close();}
 }
}finally{await browser.close();}
await fs.writeFile(path.join(out,'result.json'),JSON.stringify({source:'Real Playwright and arrival-completion helper over a modeled screen; no production requests',results},null,2)+'\n');
console.log(JSON.stringify({arrivalCompletion:results}));
