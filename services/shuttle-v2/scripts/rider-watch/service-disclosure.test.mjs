import {test} from 'vitest';
import assert from 'node:assert/strict';
import {publishedPickupRequirement,auditPickupDisclosure,confirmPickupDisclosure} from './service-disclosure.mjs';
const at=Date.parse('2026-10-23T16:00:00Z');
const row={routeLabel:'Purple',stopId:122,visible:true,text:'On request. Call Dispatch: 203-281-5470 · option 1',callLinks:['tel:+12032815470'],hasPickupTime:false,hasNextTime:false,hasDestinationTime:false};
const audit=(rows=[row],text='',time=at)=>auditPickupDisclosure({routeLabel:'Purple',stopId:122,at:time,rows,text});
const receipt=(id,receivedAt)=>({state:'captured',id:id.repeat(64),runId:'1234',receivedAt,file:'feed-responses/1234.jsonl',sourceKind:'page-response'});
const bad=()=>audit([{...row,text:'About <1 min',callLinks:[],hasPickupTime:true}]);
const observed=(time,id='a')=>({at:time,feedResponse:receipt(id,time)});
test.each([
 ['2026-10-23T15:59:59.999Z',false],['2026-10-23T16:00:00Z',true],
 ['2026-11-01T16:59:59.999Z',false],['2026-11-01T17:00:00Z',true],
 ['2026-03-08T15:59:59.999Z',false],['2026-03-08T16:00:00Z',true]
])('published pickup rule uses Eastern noon including DST at %s',(date,required)=>{
 assert.equal(!!publishedPickupRequirement('Purple',122,Date.parse(date)),required);
 assert.equal(!!publishedPickupRequirement('Purple',121,Date.parse(date)),required);
});
test('unrelated route, scheduled stop and invalid clocks have no inferred request requirement',()=>{
 for(const args of [['Red',122,at],['Purple',1,at],['Purple',122,NaN],['Purple',122,Infinity],['Purple',122,9e18]])assert.equal(publishedPickupRequirement(...args),null);
});
test('correct visible instructions pass even without a product service-state attribute',()=>{
 assert.equal(audit().state,'disclosed');
 assert.equal(audit([{...row,callLinks:['tel:+1 (203) 281-5470;ext=1']}]).state,'disclosed');
});
test.each([
 [{text:'About <1 min',callLinks:[],hasPickupTime:true},'request-only-label-missing'],
 [{callLinks:[]},'dispatch-call-instructions-missing'],
 [{callLinks:['tel:+12035550000']},'dispatch-call-instructions-missing'],
 [{text:'On request. Call Dispatch: 203-281-5470'},'dispatch-option-missing'],
 [{hasPickupTime:true},'unconditional-time-visible'],
 [{hasNextTime:true},'unconditional-time-visible'],
 [{hasDestinationTime:true},'unconditional-time-visible']
])('rendered contradiction is retained with its reason %s',(change,reason)=>{
 const result=audit([{...row,...change}]);assert.equal(result.state,'contradiction');assert(result.issues.includes(reason));
});
test('detail pickup promises and reminders remain contradictions with correct table instructions',()=>{
 const result=audit([row],'BOARDUnion Station (S)\nArrival: About <1 min\n🔔 Remind me for #330');
 assert.deepEqual(result.issues,['unconditional-detail-time-visible','pickup-reminder-visible']);
});
test('another route, another stop, or a hidden row cannot supply the selected disclosure',()=>{
 for(const change of [{routeLabel:'Red'},{stopId:121},{visible:false}])assert.equal(audit([{...row,...change}]).state,'unassessed');
});
test('two fresh response observations confirm a contradiction and retain both receipts',()=>{
 const first=confirmPickupDisclosure(null,bad(),observed(at));assert.equal(first.alert,null);
 const second=confirmPickupDisclosure(first.state,bad(),observed(at+10000,'b'));
 assert.equal(second.alert.v,1);assert.equal(second.alert.policy.stopId,122);assert.equal(second.alert.observations.length,2);
 assert.deepEqual(second.alert.observations.map(o=>o.feedResponse.id),['a'.repeat(64),'b'.repeat(64)]);
 assert.equal(confirmPickupDisclosure(second.state,bad(),observed(at+20000,'c')).alert,null);
});
test('a repeated receipt, an older delivery, or observations less than five seconds apart cannot confirm',()=>{
 const first=confirmPickupDisclosure(null,bad(),observed(at));
 for(const observation of [observed(at+10000),{at:at+10000,feedResponse:receipt('b',at)},observed(at+4999,'b')])assert.equal(confirmPickupDisclosure(first.state,bad(),observation).alert,null);
});
test('a response gap, recovery and date transition each clear the prior contradiction',()=>{
 const first=confirmPickupDisclosure(null,bad(),observed(at));
 assert.equal(confirmPickupDisclosure(first.state,bad(),observed(at+150001,'b')).alert,null);
 assert.equal(confirmPickupDisclosure(first.state,audit(),observed(at+10000,'b')).state,null);
 const tomorrow=Date.parse('2026-10-24T16:00:00Z');assert.equal(confirmPickupDisclosure(first.state,audit([{...row,callLinks:[]}],'',tomorrow),observed(tomorrow,'b')).alert,null);
});
test('unavailable or stale original responses are explicitly unassessed',()=>{
 for(const feedResponse of [{state:'unavailable'},receipt('b',at-30001),receipt('b',at+5001)]){
  const checked=confirmPickupDisclosure(null,bad(),{at,feedResponse});assert.equal(checked.state,null);assert.equal(checked.alert,null);assert(checked.unassessedReason);
 }
});
test('a different journey or malformed response reference cannot confirm the earlier observation',()=>{
 const first=confirmPickupDisclosure(null,bad(),observed(at));
 const next=observed(at+10000,'b');next.feedResponse.runId='9999';next.feedResponse.file='feed-responses/9999.jsonl';
 assert.equal(confirmPickupDisclosure(first.state,bad(),next).alert,null);
 for(const change of [{id:'bad'},{file:'../different.jsonl'},{runId:'not-a-run'}])assert(confirmPickupDisclosure(first.state,bad(),{at:at+10000,feedResponse:{...receipt('b',at+10000),...change}}).unassessedReason);
});
