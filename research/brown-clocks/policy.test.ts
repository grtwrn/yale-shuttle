import assert from 'node:assert/strict';
import {fresh,originEligible,resetReason,updateRelease} from './policy.ts';
assert(fresh(15000,0,15000));assert(!fresh(15001,0,15000));
assert(fresh(44999,0,45000));assert(!fresh(45000,0,45000));assert(!fresh(-1,0,45000));
const o={route:19,departed:0,knownAt:1000};
for(const h of [2700000,5400000]){
 assert(originEligible(o,19,h,1000,h,h));assert(!originEligible(o,19,h+1,1000,h+1,h));
 assert(!originEligible({...o,knownAt:h+1},19,h,1000,h,h));
 assert(!originEligible({...o,knownAt:NaN},19,h,1000,h,h));
 assert(!originEligible({...o,departed:2000,knownAt:1000},19,h,3000,h,h));
 assert(!originEligible(o,3,h,1000,h,h));
}
const w={first:0,last:10000,route:19,provider:1}, obs={collectedAt:20000,routeId:19,busId:1};
assert.equal(resetReason(w,obs,false),null);
assert.equal(resetReason(w,{...obs,busId:2},false),'provider change');
assert.equal(resetReason(w,{...obs,routeId:3},false),'route change');
assert.equal(resetReason(w,obs,true),'contended name');
assert.equal(resetReason(w,{...obs,collectedAt:70001},false),'raw gap');
assert.equal(resetReason(w,{...obs,collectedAt:70000},false),null);
assert.equal(resetReason(w,{...obs,busId:NaN},false),'unknown provider');
// K5 source0 / wait5. Confirmation may backdate a departure, not its knowledge.
const h=new Map([[0,o],[5,{route:19,departed:2000,knownAt:4000}]]), l=new Map<string,number>();
updateRelease(l,h,19,4,'drive',3000,3999,2700000,5,5,9);assert(!l.has('5/5'));
updateRelease(l,h,19,4,'drive',3000,4000,2700000,5,5,9);assert.equal(l.get('5/5'),0);
updateRelease(l,h,19,5,'hold',3000,5000,2700000,5,5,9);assert.equal(l.get('5/5'),0);
h.set(0,{route:19,departed:6000,knownAt:7000});
updateRelease(l,h,19,0,'drive',6000,7000,2700000,5,5,9);assert.notEqual(l.get('5/5'),6000);
// A phase-only release is irreversible; no completed wait is fabricated.
const phaseHistory=new Map([[0,o]]), phaseLatch=new Map<string,number>();
updateRelease(phaseLatch,phaseHistory,19,6,'drive',1000,3000,2700000,5,5,9);
assert.equal(phaseLatch.get('5/5'),0);
updateRelease(phaseLatch,phaseHistory,19,5,'hold',1000,4000,2700000,5,5,9);
assert.equal(phaseLatch.get('5/5'),0);assert(!phaseHistory.has(5));
// Extended origin lifetime must process last-wait releases in the same range.
const longHistory=new Map([[0,o],[5,{route:19,departed:2800000,knownAt:2800100}]]);
for(const limit of [2700000,5400000]){
 const latches=new Map<string,number>();
 updateRelease(latches,longHistory,19,4,'drive',2800000,2800100,limit,5,5,9);
 assert.equal(latches.has('5/5'),limit===5400000);
}
console.log('Clock boundary, knowledge, identity and irreversible release fixtures passed');
