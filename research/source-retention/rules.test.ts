import assert from 'node:assert/strict';
import {capFor,retain,observeRelease} from './rules.ts';
const origin={route:9,departed:1000000,knownAt:1010000};
for(const minutes of [45,90]){
 const cap=minutes*60000,at=origin.departed+cap;
 assert(retain(origin,9,at,at,at,cap));assert(!retain(origin,9,at+1,at+1,at+1,cap));
 assert(!retain({...origin,knownAt:at+1},9,at,at,at,cap));assert(!retain(origin,10,at,at,at,cap));
 assert(!retain(origin,9,at,origin.departed-1,at,cap));
}
assert.equal(capFor(3,90),2700000);assert.equal(capFor(9,90),5400000);
// K2/source0/wait2, still holding at wait after50min, with departure then confirmed.
const time=origin.departed+3000000,release={departed:time-10000,knownAt:time};
const a=new Map<string,number>(),b=new Map<string,number>();
assert(!observeRelease(a,'2/2',origin,release,2,2,2,6,'drive',time,time,2700000));
assert(observeRelease(b,'2/2',origin,release,2,2,2,6,'drive',time,time,5400000));
assert.equal(b.get('2/2'),origin.departed);
// Hold regression and subsequent index wrap cannot remove the one-way release.
assert(!observeRelease(b,'2/2',origin,null,0,2,2,6,'hold',time+1,time+1,5400000));
assert.equal(b.get('2/2'),origin.departed);
// An independent actual departure has its own identity; old release is not its release.
const fresh={...origin,departed:time,knownAt:time+1};
assert.notEqual(b.get('2/2'),fresh.departed);
assert(!observeRelease(b,'2/2',fresh,null,0,2,2,6,'hold',time+1,time+1,5400000));
assert(!observeRelease(new Map(),'2/2',origin,{...release,knownAt:time+1},2,2,2,6,'hold',time,time,5400000));
assert(!observeRelease(new Map(),'2/2',origin,release,2,2,2,6,'drive',time,time+5400001,5400000));
// Reset removes model history and latch; an observer ledger cannot supply it.
const reset=new Map<string,number>();assert(!observeRelease(reset,'2/2',undefined,release,2,2,2,6,'drive',time,time,5400000));
assert.equal(reset.size,0);
console.log('source-retention cap/chronology/release/regression/old-lap/reset fixtures passed');
