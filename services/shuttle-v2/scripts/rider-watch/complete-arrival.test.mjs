import {test}from'vitest';import assert from'node:assert/strict';import{completeArrival}from'./complete-arrival.mjs';
// Model Playwright's actionability retry over the visible screen. A separate
// retained real-browser reproduction verifies the same late-overlay race.
function screen({prompt=false,latePrompt=false,done=true,obstruction=false}={}){
 const s={prompt,dismissals:0,completed:0,handlers:new Map(),captures:0};
 const got={isVisible:async()=>s.prompt,click:async()=>{assert(s.prompt);s.prompt=false;s.dismissals++;}};
 const finish={isVisible:async()=>done,click:async()=>{if(latePrompt)s.prompt=true;if(s.prompt){const handler=s.handlers.get(got);if(handler)await handler();}if(s.prompt||obstruction)throw Error('Done obstructed');s.completed++;}};
 const page={getByRole:role=>role==='alertdialog'?{getByRole:()=>got}:finish,addLocatorHandler:async(l,h)=>s.handlers.set(l,h),removeLocatorHandler:async l=>s.handlers.delete(l)};
 return{s,page,capture:async()=>{s.captures++;}};
}
test('acknowledges an existing arrival prompt before capturing and completing',async()=>{const h=screen({prompt:true});await completeArrival(h.page,async()=>{assert.equal(h.s.prompt,false);await h.capture();});assert.equal(h.s.dismissals,1);assert.equal(h.s.completed,1);assert.equal(h.s.handlers.size,0);});
test('a prompt revealed during the completion screenshot does not block Done',async()=>{const h=screen();await completeArrival(h.page,async()=>{await h.capture();h.s.prompt=true;});assert.equal(h.s.dismissals,1);assert.equal(h.s.completed,1);assert.equal(h.s.handlers.size,0);});
test('a prompt revealed while Done waits is acknowledged through its real control',async()=>{const h=screen({latePrompt:true});await completeArrival(h.page,h.capture);assert.equal(h.s.dismissals,1);assert.equal(h.s.completed,1);assert.equal(h.s.handlers.size,0);});
test('a screen that already ended the ride still retains its completion capture',async()=>{const h=screen({done:false});await completeArrival(h.page,h.capture);assert.equal(h.s.captures,1);assert.equal(h.s.completed,0);assert.equal(h.s.dismissals,0);assert.equal(h.s.handlers.size,0);});
test('an unrelated obstruction remains a failure and removes the temporary handler',async()=>{const h=screen({obstruction:true});await assert.rejects(completeArrival(h.page,h.capture),/Done obstructed/);assert.equal(h.s.completed,0);assert.equal(h.s.handlers.size,0);});
test('a failed evidence capture remains a failure and removes the temporary handler',async()=>{const h=screen();await assert.rejects(completeArrival(h.page,async()=>{throw Error('Screenshot unavailable');}),/Screenshot unavailable/);assert.equal(h.s.completed,0);assert.equal(h.s.handlers.size,0);});
test('first-leg completion uses the actual End first ride control and its late-overlay handling',async()=>{const h=screen({latePrompt:true}),original=h.page.getByRole;h.page.getByRole=(role,options)=>{if(role==='button')assert.equal(options.name,'End first ride');return original(role,options);};await completeArrival(h.page,h.capture,{buttonName:'End first ride'});assert.equal(h.s.completed,1);assert.equal(h.s.dismissals,1);assert.equal(h.s.handlers.size,0);});
