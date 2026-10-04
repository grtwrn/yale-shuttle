import {test} from 'vitest';
import assert from 'node:assert/strict';
import {BoardingMissed,boardSelectedRide,OFFER_CLICK_MS} from './boarding.mjs';

// A page whose offer either takes the click or goes under it (the app's next
// poll clears it; riderpromptmiss20261004). The card's button stores `stores`.
function page({offer='🚌 On Purple #330?\nDetected near your board stop',goes=false,stays=false,stores='#330'}={}){
 const p={clicks:[],offer,stored:null};
 p.getByRole=(_,{name})=>({
  isVisible:async()=>name==="🚌 I'm on it"||(!!p.offer&&["Yes, I'm on it",'Not me'].includes(name)),
  click:async(opts={})=>{
   p.clicks.push([name,opts.timeout]);
   if(name==="🚌 I'm on it"){p.stored=stores;return;}
   if(goes||stays){if(!stays)p.offer=null;throw new Error(`locator.click: Timeout ${opts.timeout}ms exceeded.\n  - element was detached from the DOM, retrying`);}
   if(name==="Yes, I'm on it")p.stored='#'+p.offer.match(/#(\w+)\?/)[1];
   p.offer=null;
  }});
 p.locator=()=>({innerText:async()=>'BOARD🚌West Haven Train Station\n'+(p.offer??'')});
 p.waitForFunction=async(_,name)=>{if(p.stored?.replace(/^#/,'')!==name.replace(/^#/,''))throw new Error('page.waitForFunction: Timeout 5000ms exceeded.');};
 return p;
}
test('the offer naming our bus is clicked with a short timeout',async()=>{
 const p=page();
 await boardSelectedRide(p,'#330');
 assert.deepEqual(p.clicks,[["Yes, I'm on it",OFFER_CLICK_MS]]);
 assert.ok(OFFER_CLICK_MS<=3000);
});
test('an offer gone under the click falls back to the card only while the card stores our bus',async()=>{
 const p=page({goes:true});
 await boardSelectedRide(p,'#330',{cardBoards:async()=>true});
 assert.deepEqual(p.clicks,[["Yes, I'm on it",OFFER_CLICK_MS],["🚌 I'm on it",undefined]]);
 assert.equal(p.stored,'#330');
 for(const opts of [{cardBoards:async()=>false},undefined]){
  const q=page({goes:true});
  await assert.rejects(boardSelectedRide(q,'#330',opts),BoardingMissed);
  assert.deepEqual(q.clicks,[["Yes, I'm on it",OFFER_CLICK_MS]]);
  assert.equal(q.stored,null);
 }
});
test('a failed offer click with the offer still showing is not a missed boarding',async()=>{
 const p=page({stays:true});
 await assert.rejects(boardSelectedRide(p,'#330',{cardBoards:async()=>true}),e=>!(e instanceof BoardingMissed)&&/detached/.test(e.message));
 assert.deepEqual(p.clicks,[["Yes, I'm on it",OFFER_CLICK_MS]]);
});
test('an offer for another bus is declined, even when it goes under the click',async()=>{
 for(const goes of [false,true]){
  const p=page({offer:'🚌 On Purple #317?\nDetected near your board stop',goes});
  await boardSelectedRide(p,'#330');
  assert.deepEqual(p.clicks,[['Not me',OFFER_CLICK_MS],["🚌 I'm on it",undefined]]);
  assert.equal(p.stored,'#330');
 }
});
test('without an offer the card is used and a wrong stored bus still fails the wait',async()=>{
 const p=page({offer:null});
 await boardSelectedRide(p,'#330');
 assert.deepEqual(p.clicks,[["🚌 I'm on it",undefined]]);
 await assert.rejects(boardSelectedRide(page({offer:null,stores:'#317'}),'#330'),/waitForFunction/);
});
