import assert from 'node:assert/strict';
import {classify,cutoffFor,date,foldMaps,project,FROZEN} from './folds.ts';
import {Families} from '../checkpoint-ensemble/membership.ts';
const routes=new Map([[1,{id:1,stops:Array.from({length:20},(_,i)=>100+i)}]]);
const visits:any[]=[];
for(const day of [12,13,14])for(let i=0;i<10;i++){
 const at=Date.parse(`2026-09-${day}T16:00:00Z`)+i*1000;
 visits.push({route_id:1,stop_index:10,stop_id:110,arrived_at:at,departed_at:at+180000,known_at:at+181000,stand_sec:180,how:'departed',outcome:'stopped'});
}
assert.deepEqual(classify(routes,visits,FROZEN).waits,{1:[10]});
assert.deepEqual(classify(routes,visits.slice(1),FROZEN).waits,{1:[]});
assert.deepEqual(classify(routes,visits.map(v=>({...v,stand_sec:179.999})),FROZEN).waits,{1:[]});
assert.deepEqual(classify(routes,visits.map(v=>({...v,known_at:FROZEN})),FROZEN).waits,{1:[]});
assert.deepEqual(classify(routes,visits.slice(0,20).concat(visits.slice(0,10)),FROZEN).waits,{1:[]});
assert.deepEqual(classify(routes,[...visits,{...visits[0],known_at:FROZEN+1}],FROZEN),classify(routes,visits,FROZEN));
assert.equal(cutoffFor('2026-09-17'),FROZEN);
assert.equal(date(Date.parse('2026-09-17T03:59:59Z')),'2026-09-16');
assert.equal(date(Date.parse('2026-09-17T04:00:00Z')),'2026-09-17');
const ps=[{predicted_at:Date.parse('2026-09-17T04:01:00Z')}];
assert.deepEqual(foldMaps(routes,visits,ps)['2026-09-17'].waits,{1:[10]});

// Exact projection: universal observed sources preserve every independently
// qualified map's families, including retirement at wait+1 and repeated laps.
const maps=[{1:[10]},{1:[7,10,15]},{1:[0,5,10,15]}];
const universal=new Families(routes,{1:Array.from({length:20},(_,i)=>i)});
const controls=maps.map(w=>new Families(routes,w));
const all=[universal,...controls];
for(const f of all){f.reset('A',-600000,'fixture');f.identity('A',1,0);}
let comparisons=0;
for(let step=0;step<65;step++){
 const index=step%20,at=10000+step*10000;
 const event={kind:'visit',busName:'A',routeId:1,busId:1,anchorBusId:1,stopIndex:index,stopId:100+index,
  pinnedAt:at-2000,arrivedAt:at-2000,departedAt:at,how:'departed',outcome:'stopped'};
 for(const f of all){f.emission(event,at+1000,true);f.state('A',index,'drive',at+1000);}
 for(let mi=0;mi<maps.length;mi++)for(let target=0;target<20;target++){
  const row={route:1,bus:'A',targetIndex:target,anchorIndex:index,index,nearest:index,stopsAhead:(target-index+20)%20,
   ready:true,at:at+1000,asof:at+1000,began:at,phase:'drive'};
  assert.deepEqual(project(row,universal.snapshot('A'),routes,maps[mi]),project(row,controls[mi].snapshot('A'),routes,maps[mi]));comparisons++;
 }
}
assert.equal(universal.events.length,65);
assert.deepEqual(universal.events,controls[0].events);
for(const f of all){f.identity('renamed',1,700000);f.identity('A',1,701000);}
for(let mi=0;mi<maps.length;mi++)assert.equal(universal.snapshot('A').length,controls[mi].snapshot('A').length);
console.log(JSON.stringify({waitRuleFixtures:true,midnightFixtures:true,universalProjectionComparisons:comparisons,physicalSources:65}));
