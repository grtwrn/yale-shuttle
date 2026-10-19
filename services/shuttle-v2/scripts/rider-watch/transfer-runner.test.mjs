import {test,afterEach,vi}from'vitest';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import os from'node:os';
import{attach}from'./runner.mjs';
const a={lat:41.31,lon:-72.92},b={lat:41.311,lon:-72.92},c={lat:41.311,lon:-72.921},d={lat:41.312,lon:-72.921};
const trip={kind:'random',origin:{...a,label:'Origin',stopId:1},destination:{...d,display_name:'Destination',stopId:4}};
const first={routeLabel:'Blue Day',boardStopId:1,exitStopId:2},second={routeLabel:'Orange Day',boardStopId:3,exitStopId:4};
let active;
afterEach(async()=>{await active?.watcher.stop();vi.useRealTimers();if(active)await fs.rm(active.dir,{recursive:true,force:true});active=null;});
function storage(){const s={};Object.defineProperties(s,{getItem:{value:k=>s[k]??null},setItem:{value:(k,v)=>{s[k]=v;}},removeItem:{value:k=>{delete s[k];}}});return s;}
async function harness({initialRun,wrongOnward=false,feedAgeMs=0,controlText='Arrives in ~1 min, ~1 min range',controls=true}={}){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));
 const h={dir:await fs.mkdtemp(path.join(os.tmpdir(),'transfer-rider-')),handlers:{},clicks:[],geo:[],local:storage(),session:storage(),stage:0,ui:'waiting',controlText,controls};
 let buses=[{bus_name:'#41',route_id:1,lat:41.3107,lon:a.lon,stationary:false},{bus_name:'#42',route_id:2,...c,stationary:true,at_stop_id:3}];
 const feed=()=>({buses:buses.map(x=>({...x,observed_at:Date.now()})),routes:{1:[1,2,5],2:[3,4,6]},stop_names:{1:'Origin',2:'First exit',3:'Second pickup',4:'Destination',5:'Other A',6:'Other B'},stop_coords:{1:a,2:b,3:c,4:d,5:d,6:a}});
 const sections=()=>h.ui==='waiting'||h.ui==='handoff'?[{...(h.stage===0?first:second),controls:h.controls,boardBusName:h.stage===0?'41':'42',countdownBusName:h.stage===0?'39':'42',boardingStopsAhead:0,text:'Original scoped transfer text',controlText:h.controlText,buttons:h.stage===0?["🚌 I'm on #41","🚌 I'm on #39"]:["🚌 I'm on it"]},...(h.stage===0?[{...second,controls:false,text:'Second bus preview\nArrives in ~80 min, 60–90 min range'}]:[])]:[];
 const evaluate=async(fn,arg)=>{const pl=globalThis.localStorage,ps=globalThis.sessionStorage;globalThis.localStorage=h.local;globalThis.sessionStorage=h.session;try{return fn(arg);}finally{globalThis.localStorage=pl;globalThis.sessionStorage=ps;}};
 const button=name=>({isVisible:async()=>name==='End first ride'?h.ui==='riding'&&h.stage===0:name==='Done'?h.ui==='riding'&&h.stage===1:name.startsWith('🚌 I')?['waiting','handoff'].includes(h.ui):false,
  click:async()=>{h.clicks.push(name);if(name.startsWith('🚌 I')){
   const leg=h.stage===0?first:second,ride={routeLabel:leg.routeLabel,busName:h.stage===0?'41':'42',boardStopId:leg.boardStopId,alightStopId:leg.exitStopId,startedAt:Date.now(),toLat:d.lat,toLon:d.lon};
   if(h.stage===0)ride.onward={next:{routeLabel:'Orange Day',boardStopId:3,alightStopId:wrongOnward?6:4},destination:{...d,text:'Destination'}};
   h.local.setItem('shuttle-boarded-ride',JSON.stringify(ride));h.ui='riding';
  }else if(name==='End first ride'){h.local.removeItem('shuttle-boarded-ride');h.stage=1;h.ui='handoff';}
  else if(name==='Done'){h.local.removeItem('shuttle-boarded-ride');h.ui='finished';}}});
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},locator:selector=>({innerText:async()=>h.ui==='riding'?`${h.stage===0?'Blue Day':'Orange Day'} · Bus #${h.stage===0?'41':'42'}`:(h.bodyText??'Original visible transfer itinerary'),evaluateAll:async()=>selector==='[data-feedback-transfer-ride]'?sections():[]}),
  getByRole:(role,{name}={})=>role==='alertdialog'?{getByRole:(_,{name})=>button(name)}:button(name),
  getByTestId:id=>({getByRole:(_,{name})=>button(name),waitFor:async()=>{if(id==='transfer-handoff')assert.equal(h.ui,'handoff');}}),
  evaluate,waitForFunction:async(_,name)=>{assert.equal(JSON.parse(h.local.getItem('shuttle-boarded-ride')).busName,String(name).replace(/^#/,''));},
  addLocatorHandler:async()=>{},removeLocatorHandler:async()=>{},screenshot:async()=>Buffer.from('fixture-jpeg')};
 h.watcher=await attach({page,ctx:{setGeolocation:async p=>h.geo.push(p)},initialFeed:feed(),initialFeedAt:Date.now()-feedAgeMs,initialTrip:trip,initialLine:{label:'Blue Day',busRouteIds:[1]},initialTransfer:{legs:[first,second]},initialRun,outputDir:h.dir,randomLines:true});
 h.poll=async({dt=10000,nextBuses=buses,fresh=true}={})=>{vi.setSystemTime(Date.now()+dt);buses=nextBuses;if(fresh)await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feed()});await h.watcher.tick();};
 h.journeys=async()=>(await fs.readFile(path.join(h.dir,'journeys.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 return h;
}
test('the real rider loop boards both exact buses, observes both exits and walks between pickups before completing',async()=>{
 const h=active=await harness();assert.equal(h.watcher.status().run.phase,'waiting');
 await h.poll({nextBuses:[{bus_name:'#41',route_id:1,...a,stationary:true,at_stop_id:1},{bus_name:'#42',route_id:2,...c,stationary:true,at_stop_id:3}]});
 assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.busName,'#41');assert.deepEqual(h.clicks,["🚌 I'm on #41"]);
 await h.poll({dt:40000,nextBuses:[{bus_name:'#41',route_id:1,...b,stationary:true,at_stop_id:2},{bus_name:'#42',route_id:2,...c,stationary:true,at_stop_id:3}]});
 assert.equal(h.watcher.status().run.phase,'arrived');
 await h.poll({dt:20000});const next=h.watcher.status().run;assert.equal(next.transfer.stage,1);assert.equal(next.phase,'waiting');assert.equal(next.busName,undefined);assert.equal(next.arrivalObservation,undefined);
 assert.equal(next.transfer.completedLegs[0].busName,'#41');assert.equal(next.trip.origin.lat,b.lat);assert.equal(next.trip.origin.lon,b.lon);
 await h.poll();assert.equal(h.watcher.status().run.phase,'waiting');
 await h.poll({dt:20000});const mid=h.geo.at(-1);assert(mid.longitude<b.lon&&mid.longitude>c.lon);assert.equal(h.watcher.status().run.phase,'waiting');
 await h.poll({dt:100000});assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.busName,'#42');
 await h.poll({dt:40000,nextBuses:[{bus_name:'#41',route_id:1,...b,stationary:true,at_stop_id:2},{bus_name:'#42',route_id:2,...d,stationary:true,at_stop_id:4}]});
 assert.equal(h.watcher.status().run.phase,'arrived');await h.poll({dt:20000});assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();assert.equal(journey.result,'completed');assert.equal(journey.excludeAccuracy,true);assert.equal(journey.instrumentVersion,'transfer-v1');
 assert.deepEqual(journey.transfer.completedLegs.map(l=>l.busName),['#41','#42']);assert.deepEqual(journey.transfer.completedLegs.map(l=>l.arrivalObservation.stopId),[2,4]);assert.deepEqual(journey.transfer.originalTrip,trip);
 assert.deepEqual(h.clicks,["🚌 I'm on #41",'End first ride',"🚌 I'm on it",'Done']);const events=await h.events();assert.equal(events.filter(e=>e.kind==='transfer-handoff').length,1);
 assert.equal(events.find(e=>e.kind==='journey-started').line,'Blue Day');assert.equal(events.find(e=>e.kind==='transfer-handoff').line,'Orange Day');assert.equal(events.find(e=>e.kind==='journey-finished').line,'Orange Day');
});
test('a wrong onward target is retained and ends the run without declaring a transfer completion',async()=>{
 const h=active=await harness({wrongOnward:true});await h.poll({nextBuses:[{bus_name:'#41',route_id:1,...a,stationary:true,at_stop_id:1},{bus_name:'#42',route_id:2,...c,stationary:true,at_stop_id:3}]});
 assert.equal(h.watcher.status().run,null);const[journey]=await h.journeys();assert.equal(journey.result,'wrong-transfer-state-excluded');assert((await h.events()).some(e=>e.kind==='candidate-transfer-boarded-state'));assert(!h.clicks.includes('End first ride'));
});
test('stale feed prevents transfer boarding even if its old controls remain visible',async()=>{
 const h=active=await harness();await h.poll({dt:31000,fresh:false});assert.equal(h.watcher.status().run.phase,'waiting');assert.deepEqual(h.clicks,[]);
});

test('a current-style 44 minute pickup quote lets a transfer board at 47.6 minutes',async()=>{
 const h=active=await harness({controlText:'Arrives in ~44 min, 33–60 min range'});
 h.controlText='Arrives in ~80 min, 60–90 min range';
 await h.poll({dt:45*60000+10000});
 assert.equal(h.watcher.status().run?.phase,'waiting');
 assert.equal(h.watcher.status().run.waitCapMin,66);
 await h.poll({dt:146000,nextBuses:[{bus_name:'#41',route_id:1,...a,stationary:true,at_stop_id:1},{bus_name:'#42',route_id:2,...c,stationary:true,at_stop_id:3}]});
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.equal(h.watcher.status().run.boardedAt,'2026-10-18T12:47:36.000Z');
 assert.equal(h.watcher.status().run.waitCapMin,66);
 assert.deepEqual(await h.journeys(),[]);
});
test('later transfer ETA jumps do not extend the original quote cap indefinitely',async()=>{
 const h=active=await harness({controlText:'Arrives in ~44 min, 33–60 min range'});
 h.controlText='Arrives in ~80 min, 60–90 min range';
 await h.poll({dt:66*60000+1000});
 assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();assert.equal(journey.result,'waiting-timeout-needs-review');assert.equal(journey.waitCapMin,66);
});
test('an unmatched active transfer never borrows a quote from the body or onward preview',async()=>{
 const h=active=await harness({controls:false});h.bodyText='Arrives in ~80 min, 60–90 min range';
 await h.poll();assert.equal(h.watcher.status().run.waitCapMin,undefined);
 await h.poll({dt:45*60000});assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();assert.equal(journey.result,'transfer-screen-timeout-needs-review');assert.equal(journey.waitCapMin,undefined);
});
