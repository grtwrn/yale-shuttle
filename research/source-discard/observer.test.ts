import assert from 'node:assert/strict';
import {Observer,filterFlags,physicalReasons,requested} from './observer.ts';
import {planTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {replay} from './replay.ts';

const routes=new Map([[1,{id:1,stops:Array.from({length:20},(_,i)=>i+11)}],[2,{id:2,stops:[11,12,13]}]]),waits={1:[2],2:[2]};
const emission=(extras:any={})=>({kind:'visit',busName:'42',busId:1,anchorBusId:1,routeId:1,stopId:12,stopIndex:1,
  anchoredAt:999000,pinnedAt:1000000,arrivedAt:1000000,departedAt:1001000,outcome:'stopped',how:'far',...extras});
const origin={route:1,departed:1001000,knownAt:1002000};
const row=(at=3701000,origins:any={1:origin})=>({at,asof:at,bus:'42',route:1,target:14,targetIndex:3,
  ready:true,index:2,began:at,origins});
const state=(at:number,extra:any={})=>({busName:'42',busId:1,routeId:1,lastObservedAt:at,...extra});
const warm=(at:number,extra:any={})=>({first:0,last:at,route:1,...extra});
const obs=(at:number,extra:any={})=>({busName:'42',busId:1,routeId:1,collectedAt:at,...extra});
let tests=0;
function check(name:string,fn:()=>void){fn();tests++;console.log('PASS '+name);}
function withSource(){const o=new Observer(routes,waits);o.emission(emission(),1002000,warm(1002000));return o;}
function snap(o:Observer,r:any,h:any=new Map([[1,origin]]),s:any=state(r.at),w:any=warm(r.at),v:any=null){return o.snapshot(r,s,v,w,h).ks[1];}

check('45min inclusive; solely expired immediately beyond',()=>{
 const o=withSource();assert.equal(snap(o,row()).category,'strict physical source retained');
 const r=row(3701001,{}),d=snap(o,r);assert.equal(d.category,'strict physical source expired solely by45min cap');
 assert.deepEqual(d.filterFlags,['age exceeds45min']);assert.equal(d.historyPhysicalProof,'unique strict emission');
});
check('combined failure cannot be called age-only',()=>{
 const o=withSource(),r={...row(3701001,{}),began:1000000};
 assert.equal(snap(o,r).category,'model history fails other/combined filters');
 assert.deepEqual(filterFlags({...origin,route:2,knownAt:r.asof+1},r),['route mismatch','emission after asof','departure after phase start','age exceeds45min']);
});
check('future emission unavailable and observer rejects lookahead',()=>{
 const r=row(3701001,{}),o=new Observer(routes,waits),h=new Map([[1,{...origin,knownAt:r.asof+1}]]);
 const d=snap(o,r,h);assert.equal(d.historyPhysicalProof,'unproven');assert(d.filterFlags.includes('emission after asof'));
 o.emission(emission(),r.asof+1,warm(r.asof));assert.throws(()=>snap(o,r,h),/future evidence/);
});
check('null/nonfinite/unpinned/unresolved/gap/noncanonical not physical',()=>{
 for(const extras of [{pinnedAt:null},{arrivedAt:null},{departedAt:null},{pinnedAt:NaN},{how:'gap'},{outcome:'unresolved'},
  {stopId:13},{arrivedAt:1002000},{departedAt:1003000}]){
   const e=emission(extras),o=new Observer(routes,waits);assert(physicalReasons(e,1002000,routes).length);
   o.emission(e,1002000,warm(1002000));assert.equal(o.emissions[0].physical,false);
   const d=snap(o,row(3701000,{}),new Map());assert.equal(d.strictPhysicalEmissionId,null);
   assert.equal(d.category,'no physical source emitted; only invalid visit evidence');
 }
 const o=new Observer(routes,waits);o.emission(emission({pinnedAt:null}),1002000,warm(1002000));
 assert.equal(snap(o,row()).category,'model history physically unproven/ambiguous');assert.equal(snap(o,row()).retained,true);
});
check('open pin and left-censored absence are not physical departures',()=>{
 const o=new Observer(routes,waits),r=row(3701000,{});
 assert.equal(snap(o,r,new Map()).category,'no physical source emitted in observed prefix; left-censored unknown');
 const v={routeId:1,pass:{stopIndex:1,anchoredAt:999000,pinnedAt:1000000,arrivedAt:1000000}};
 assert.equal(snap(o,r,new Map(),state(r.at),warm(r.at),v).category,'no physical departure emitted; pinned visit still open');
 assert.equal(o.emissions.length,0);
});
check('initial epoch distinct from observed gap/route/contention reset combinations',()=>{
 const o=withSource(),first=obs(1100000),plan=planTracks([first]);
 o.beforeReset(first,1100000,null,plan,null,new Map());assert.deepEqual(o.resets[0].reasons,['first observed warm epoch / left boundary unknown']);
 const next=obs(1300000,{routeId:2}),contention=planTracks([next,obs(1300000,{busId:2,routeId:2})]);
 o.beforeReset(next,1300000,{first:0,last:1200000,route:1},contention,new Map([[1,origin]]),new Map());
 assert.deepEqual(o.resets[1].reasons,['observation gap above60s','route change','simultaneous public-name contention']);
 const d=snap(o,row(3701000,{}),new Map());assert.equal(d.category,'known physical source cleared by observed model reset');
 assert.deepEqual(d.clearedBy[0].reasons,o.resets[1].reasons);
});
check('departure before warm epoch is explicitly rejected, not recovered',()=>{
 const o=new Observer(routes,waits);o.emission(emission(),1002000,warm(1002000,{first:1001500}));
 assert.equal(snap(o,row(3701000,{}),new Map()).category,'known physical source rejected before warm epoch');
});
check('pin lost at an observed reset is retained as nonphysical evidence only',()=>{
 const o=new Observer(routes,waits),a=obs(1002500),p={stopId:12,stopIndex:1,anchoredAt:999000,pinnedAt:1000000,arrivedAt:1000000};
 o.beforeReset(a,1002500,warm(800000),planTracks([a]),new Map(),new Map([['42',state(800000)]]),new Map([['42',{routeId:1,pass:p}]]));
 const d=snap(o,row(3701000,{}),new Map());assert.equal(d.category,'no physical source emitted; prior pinned visit lost at reset');
 assert.equal(d.strictPhysicalEmissionId,null);assert.equal(d.openPinnedLostAtReset.confirmedDepartureKnown,false);
});
check('sequential provider reissue does not assert reset',()=>{
 const o=withSource(),a=obs(1002500),b=obs(1003000,{busId:2});
 o.observePoll([a],planTracks([a]),a.collectedAt);o.observePoll([b],planTracks([b]),b.collectedAt);
 const d=snap(o,row());assert.equal(d.category,'strict physical source retained');
 assert.equal(d.historyContext.sequentialProviderReissues,1);assert.equal(d.historyContext.identityAmbiguous,false);assert.equal(o.resets.length,0);
});
check('contention and provider-to-name changes remain identity ambiguity',()=>{
 const o=withSource(),a=obs(1002500),b=obs(1003000,{busId:2});
 const a2=obs(b.collectedAt);
 o.observePoll([a],planTracks([a]),a.collectedAt);o.observePoll([a2,b],planTracks([a2,b]),b.collectedAt);
 assert.equal(snap(o,row()).historyContext.identityAmbiguous,true);
 const p=withSource(),c=obs(1003000,{busName:'43'});
 p.observePoll([a],planTracks([a]),a.collectedAt);p.observePoll([c],planTracks([c]),c.collectedAt);
 const r={...row(3701000,{}),bus:'43'};const d=snap(p,r,new Map(),state(r.at,{busName:'43'}));
 assert.equal(d.category,'no same-name source; other-name evidence ambiguous');assert.equal(d.strictPhysicalEmissionId,null);
});
check('duplicate matching emission does not become unique physical origin proof',()=>{
 const o=withSource();o.emission(emission({busId:2}),1002000,warm(1002000));
 assert.equal(snap(o,row()).category,'model history physically unproven/ambiguous');
});
check('repeated stops use exact occurrence and cyclic previous wait',()=>{
 const rs=new Map([[1,{stops:[11,12,13,12,14]}]]),ws={1:[1,3]};
 assert.equal(requested({...row(),targetIndex:4},1,rs,ws).source,2);
 assert.equal(requested({...row(),targetIndex:2},1,rs,ws).source,0);
 assert.equal(requested({...row(),targetIndex:1},1,rs,ws).source,2);
 assert.equal(requested({...row(),targetIndex:null},1,rs,ws).reason,'ambiguous target occurrence');
 assert.equal(requested(row(),5,rs,ws).reason,'K outside single loop');
 assert(physicalReasons(emission({stopId:12,stopIndex:3}),1002000,rs).length===0);
});
check('readiness records warmup/freshness causes without modifying source history',()=>{
 const o=withSource(),r={...row(3701000,{}),ready:false,index:-1},s=state(r.at-15001,{routeId:2});
 const d=o.snapshot(r,s,null,warm(r.at,{first:r.at-100000}),new Map([[1,origin]]));
 assert.deepEqual(d.readinessFlags,['state route mismatch','observation older than15s','warm span below10min','unknown phase/index']);
 assert.equal(d.ks[1].category,'current row not ready');assert(d.ks[1].history);
});
check('actual reducer replay does not close an open EOF visit or read future observations',()=>{
 const top={stops:[{id:11,name:'A',lat:41.31,lon:-72.93},{id:12,name:'B',lat:41.31,lon:-72.92},{id:13,name:'C',lat:41.31,lon:-72.91}],
  routes:[{id:1,name:'Test',shortName:'T',color:'#000',stops:[11,12,13]}]};
 const raw=[0,5000,10000].map(t=>({collected_at:t+1000000,bus_id:1,bus_name:'42',route_id:1,lat:41.31,lon:-72.93,heading:90}));
 const preds=[{predicted_at:1010000,bus_name:'42',route_id:1,to_stop_id:12,stops_ahead:1,from_stop_id:11,predicted_sec:100,predicted_low_sec:60,predicted_high_sec:180}];
 const net=TransitNetwork.build(top.stops,top.routes),a=replay(net,top,{1:[2]},raw,preds);
 assert.equal(a.observer.emissions.length,0);assert.equal(a.rawConsumed,3);
 const b=replay(net,top,{1:[2]},[...raw,{...raw[0],collected_at:1020000,lon:-72.92}],preds);
 assert.deepEqual(a.rows,b.rows);assert.deepEqual(a.diagnostics,b.diagnostics);assert.equal(b.rawConsumed,3);
});
console.log(JSON.stringify({fixtureGroups:tests,passed:true}));
