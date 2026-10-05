import {test,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {attach} from './runner.mjs';
import {haversineM} from '../canary-metrics.mjs';

// Replays of recorded 2026-10-01 waiting runs through the real tick loop.
const line={label:'Purple',busRouteIds:[10]};
const union={lat:41.297929,lon:-72.926912},westHaven={lat:41.271172,lon:-72.963517},b400={lat:41.255793,lon:-72.993569};
const trip={kind:'random',origin:{label:'Union Station (S)',...union,stopId:122},destination:{display_name:'Building 400',...b400,stopId:22}};
const feedWith=buses=>({buses,routes:{10:[122,127,22]},stop_names:{122:'Union Station (S)',127:'West Haven Train Station',22:'Building 400'},stop_coords:{122:union,127:westHaven,22:b400}});
const approaching="🚌 20 min\n🚌 #126 · 1 stop away\nBOARDUnion Station (S)\nGET OFFBuilding 400";
const dwelling="🚌 20 min\nBOARD🚌Union Station (S)⏸ 0:29\nWest Haven Train Station\nGET OFFBuilding 400";
const at126={bus_name:'#126',route_id:10,lat:41.297912,lon:-72.926694,at_stop_id:122,stationary:true};
const near126={bus_name:'#126',route_id:10,lat:41.296923,lon:-72.927685,stationary:false};

async function harness(initialFeed,initialTrip=trip,{initialLine=line,feedOf=feedWith,text=approaching,at='2026-10-01T11:00:00Z'}={}){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 vi.setSystemTime(Date.parse(at));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-'));
 const h={text,clicks:[],handlers:{}};
 const button=name=>({isVisible:async()=>name==="🚌 I'm on it",click:async()=>h.clicks.push(name)});
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},locator:()=>({innerText:async()=>h.text}),
  getByRole:(_,{name})=>button(name),screenshot:async()=>Buffer.from('jpg'),
  evaluate:async()=>({}),waitForFunction:async()=>{}};
 const ctx={setGeolocation:async g=>{h.geo=g;}};
 h.watcher=await attach({page,ctx,initialTrip,initialLine,initialFeed,outputDir:dir});
 // The runner's own 10 s interval drives each poll; wait for it to settle.
 h.poll=async(text,buses)=>{h.text=text;
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf(buses)});
  vi.advanceTimersByTime(10000);
  do await new Promise(r=>setImmediate(r)); while(h.watcher.status().busy);};
 h.journeys=async()=>(await fs.readFile(path.join(dir,'journeys.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.dir=dir;h.page=page;return h;
}
let current;
afterEach(async()=>{await current?.watcher.stop();vi.useRealTimers();if(current)await fs.rm(current.dir,{recursive:true,force:true});current=undefined;});

test('Purple #126 dwelling 18 m from the stop is boarded, not an invalid sample',async()=>{
 const h=current=await harness(feedWith([near126]));
 assert.equal(h.watcher.status().run.phase,'waiting');
 await h.poll(dwelling,[at126]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'riding');
 assert.equal(run.busName,'#126');
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 assert.equal(run.invalidStopSamples,undefined);
 assert.equal(run.excludeAccuracy,undefined);
});

// wrongbusboard20261002: "I'm on it" stored Green #331 while #122 pulled in;
// the run then waited behind the ride until the 45 min cap.
const boardingTimeout=async()=>{throw new Error('page.waitForFunction: Timeout 5000ms exceeded.');};
test('a ride the app started on another bus ends the run now, not at the cap',async()=>{
 const h=current=await harness(feedWith([near126]));
 h.page.waitForFunction=boardingTimeout;h.page.evaluate=async()=>'#331';
 await h.poll(dwelling,[at126]);
 assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();
 assert.equal(journey.result,'wrong-bus-boarded-excluded');
 assert.equal(journey.excludeAccuracy,true);
 assert.equal(journey.busName,'#126');
});

test('a boarding attempt that stored no ride is retried as before',async()=>{
 const h=current=await harness(feedWith([near126]));
 h.page.waitForFunction=boardingTimeout;h.page.evaluate=async()=>null;
 await h.poll(dwelling,[at126]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'waiting');
 assert.equal(run.harnessErrors,1);
 assert.equal(run.excludeAccuracy,undefined);
});

test('our bus stored after the boarding wait is still a boarding',async()=>{
 const h=current=await harness(feedWith([near126]));
 h.page.waitForFunction=boardingTimeout;h.page.evaluate=async()=>'126';
 await h.poll(dwelling,[at126]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'riding');
 assert.equal(run.busName,'#126');
 assert.equal(run.excludeAccuracy,undefined);
});

test('an unpredicted poll is skipped without excluding the run',async()=>{
 const h=current=await harness(feedWith([{...near126,lat:41.30,lon:-72.94}]));
 await h.poll("Purple\t\nUnavailable\n\t—\nBOARDUnion Station (S)\nGET OFFBuilding 400",[{...near126,lat:41.30,lon:-72.94}]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'waiting');
 assert.equal(run.unnamedBusSamples,1);
 assert.equal(run.excludeAccuracy,undefined);
});

test('Orange Night after its last loop ends as no-service instead of a 45 min invalid wait',async()=>{
 const h=current=await harness(feedWith([near126]));
 const gone="Purple\t\nUnavailable\n⚠️ Hours ended 12am — maybe the last loop\nBOARDUnion Station (S)\nGET OFFBuilding 400";
 for(let i=0;i<35;i++)await h.poll(gone,[]);
 assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();
 assert.equal(journey.result,'no-service-excluded');
 assert.equal(journey.excludeAccuracy,true);
});

// Purple run 1790803296841, 2026-09-30T21:34:02Z then 21:34:12Z: the app
// follows #321 to West Haven; #332 sits at the stop. Never board #332.
test('recorded West Haven poll does not board another bus at the stop',async()=>{
 const fromWestHaven={...trip,origin:{label:'West Haven Train Station',...westHaven,stopId:127}};
 const b321={bus_name:'#321',route_id:10,lat:41.271634,lon:-72.96286,last_stop_id:127,stationary:false};
 const b332={bus_name:'#332',route_id:10,lat:41.27122,lon:-72.963864,last_stop_id:26,stationary:true,at_stop_id:127};
 const h=current=await harness(feedWith([b321]),fromWestHaven);
 await h.poll("🚌 9 min\n🚌 #321 · 1 stop away\nBOARDWest Haven Train Station\nGET OFFBuilding 400",[{...b321,lat:41.2735,lon:-72.9607}]);
 assert.equal(h.watcher.status().run.busName,'#321');
 await h.poll("Purple\t\n~32 (23 – 43)\n\t6:06p – 6:26p\n\n🚌 9 min\nBOARD🚌West Haven Train Station\nBuilding 900\nGET OFFBuilding 400",[b321,b332]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'waiting');
 assert.equal(run.busName,'#321');
 assert.deepEqual(h.clicks,[]);
 assert.equal(run.unnamedBusSamples,1);
});

// Purple run 1790862386350: boarded #119 at West Haven at 13:54:32Z on a card
// quoting "🚌 54 min". The fixed 50 min cap ended the run at 14:44:32Z with
// #119 914 m out; it reached Building 400 at 14:50:32Z, 56 min after boarding.
test('a quoted 54 min ride is ridden to arrival, not cut off at 50 min',async()=>{
 const fromWestHaven={...trip,origin:{label:'West Haven Train Station',...westHaven,stopId:127}};
 const b119={bus_name:'#119',route_id:10,lat:41.271266,lon:-72.963392,last_stop_id:24,stationary:true,at_stop_id:127};
 const h=current=await harness(feedWith([b119]),fromWestHaven);
 await h.poll("Purple\t\nAt stop\n\t10:35a – 11:04a\n\n🚌 54 min\nBOARD🚌West Haven Train Station⏸ 0:26\nBuilding 900\nGET OFFBuilding 400",[b119]);
 assert.equal(h.watcher.status().run.phase,'riding');
 const riding="Purple · Bus #119· ~4 min to your stop";
 vi.setSystemTime(Date.now()+50*60000);
 await h.poll(riding,[{bus_name:'#119',route_id:10,lat:41.261782,lon:-72.986077,last_stop_id:127,stationary:false}]);
 assert.equal(h.watcher.status().run?.phase,'riding');
 vi.setSystemTime(Date.now()+6*60000);
 await h.poll(riding,[{bus_name:'#119',route_id:10,lat:41.255429,lon:-72.993517,last_stop_id:23,stationary:true,at_stop_id:22}]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'arrived');
 assert.equal(run.rideCapMin,81);
 assert.deepEqual(await h.journeys(),[]);
});

// Pink run 1790893847183: boarded #324 at VA Hospital at 22:30:54Z, just past
// Pink's 6:30pm end. #324 was last in the feed at 22:42:24Z, 1.08 km short of
// Davenport/Howard, and never came back (#307 kept reporting). The app said
// "Ride tracking stopped" at 22:52:34Z; the runner rode on to its 50 min cap.
const va={lat:41.281934,lon:-72.96194},dav={lat:41.303096,lon:-72.936589};
const pinkTrip={kind:'random',origin:{label:'VA Hospital',...va,stopId:125},destination:{display_name:'Davenport / Howard',...dav,stopId:46}};
const pinkOpts={initialLine:{label:'Pink',busRouteIds:[8]},at:'2026-10-01T22:30:44Z',text:"🚌 14 min\n🚌 #324 · 1 stop away\nBOARDVA Hospital\nGET OFFDavenport / Howard",
 feedOf:buses=>({buses,routes:{8:[125,46]},stop_names:{125:'VA Hospital',46:'Davenport / Howard'},stop_coords:{125:va,46:dav}})};
const b324={bus_name:'#324',route_id:8,lat:41.28183,lon:-72.962293,at_stop_id:125,stationary:true};
const b307={bus_name:'#307',route_id:8,lat:41.299,lon:-72.94,stationary:false};
const missing="Looking for your bus…\n🚌 Pink #324 → Davenport/Howard";
test('a boarded bus gone from the feed for 10 min ends the ride, as the app does',async()=>{
 const h=current=await harness(pinkOpts.feedOf([b324]),pinkTrip,pinkOpts);
 await h.poll("🚌 14 min\nBOARD🚌VA Hospital⏸ 0:07\nGET OFFDavenport / Howard",[b324]);
 assert.equal(h.watcher.status().run.phase,'riding');
 vi.setSystemTime(Date.parse('2026-10-01T22:42:14Z'));
 await h.poll("Pink · Bus #324",[{...b324,lat:41.297971,lon:-72.947605,at_stop_id:undefined,stationary:false},b307]);
 // Gone for 9 min 50 s: the app is still looking, so is the rider.
 for(let i=0;i<59;i++)await h.poll(missing,[b307]);
 assert.equal(h.watcher.status().run?.phase,'riding');
 for(let i=0;i<2;i++)await h.poll("Ride tracking stopped\n\nYour shuttle has been missing from live updates for 10 min, so tracking stopped. You may still be on board.",[b307]);
 assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();
 assert.equal(journey.result,'bus-left-feed-excluded');
 assert.equal(journey.excludeAccuracy,true);
 assert.equal(journey.busLastSeenAt,'2026-10-01T22:42:24.000Z');
 // The first poll past 10 min, the same poll the app stopped tracking on.
 assert.equal(journey.finishedAt,'2026-10-01T22:52:34.000Z');
});

test('a boarded bus that drops out for a few minutes and returns is still ridden',async()=>{
 const h=current=await harness(pinkOpts.feedOf([b324]),pinkTrip,pinkOpts);
 await h.poll("🚌 14 min\nBOARD🚌VA Hospital⏸ 0:07\nGET OFFDavenport / Howard",[b324]);
 const moving={...b324,lat:41.297971,lon:-72.947605,at_stop_id:undefined,stationary:false};
 for(let gap=0;gap<2;gap++){
  for(let i=0;i<54;i++)await h.poll(missing,[b307]);
  await h.poll("Pink · Bus #324",[moving,b307]);
 }
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.deepEqual(await h.journeys(),[]);
});

// riderbusoffroute20261002, Pink run 1790978871687: boarded the last #324 at
// LEPH / 60 College at 22:29:48Z. Past Quigley Stadium Inbound it turned back
// and drove 7 km north off the route, still in the feed, so the app showed
// "Looking for your bus…" from 22:38:08Z, no ride end fired, and the runner
// rode to its 50 min cap at 23:19:48Z (#324 left the feed at 23:10:08Z).
const pink324=JSON.parse(await fs.readFile(new URL('./__fixtures__/pink-324-off-route-2026-10-02.json',import.meta.url),'utf8'));
const pinkFeedOf=buses=>({buses,routes:{8:pink324.route.stops},route_paths:{8:pink324.route.path},stop_names:pink324.route.stop_names,stop_coords:pink324.route.stop_coords});
const pink324At=([lat,lon,stationary,at_stop_id])=>lat==null?[]:[{bus_name:'#324',route_id:8,lat,lon,stationary,...(at_stop_id==null?{}:{at_stop_id})}];
const lookingFor="Looking for your bus…\n🚌 Pink #324 → VA Entrance Inbound";
async function boardPink324(){
 const [first,pickup]=pink324.waiting,c=pink324.route.stop_coords;
 const lephTrip={kind:'random',origin:{label:'LEPH / 60 College',...c[72],stopId:72},destination:{display_name:'VA Entrance Inbound',...c[123],stopId:123}};
 const h=current=await harness(pinkFeedOf(pink324At(first.bus)),lephTrip,{initialLine:{label:'Pink',busRouteIds:[8]},feedOf:pinkFeedOf,text:first.card,at:first.at});
 vi.setSystemTime(Date.parse(pickup.at)-10000);await h.poll(pickup.card,pink324At(pickup.bus));
 h.ride=async(at,bus,text)=>{vi.setSystemTime(Date.parse(at)-10000);await h.poll(text,bus);};
 return h;
}
const recorded=at=>pink324.riding.find(p=>p[0].startsWith(at));
test('replay: a boarded bus off its route for 10 min, with the app looking for it, ends the ride',async()=>{
 const h=await boardPink324();
 assert.equal(h.watcher.status().run.boardedAt,'2026-10-02T22:29:48.333Z');
 for(const [at,...p] of pink324.riding){
  await h.ride(at,pink324At(p),pink324.headlines[p[4]]+"\n🚌 Pink #324 → VA Entrance Inbound");
  if(!h.watcher.status().run)break;
 }
 const [journey]=await h.journeys();
 assert.equal(journey?.result,'bus-off-route-excluded');
 assert.equal(journey.excludeAccuracy,true);
 assert.equal(journey.offRouteSince,'2026-10-02T22:38:08.414Z');
 // The first poll past 10 min, 31 min before the cap ended it on master.
 assert.equal(journey.finishedAt,'2026-10-02T22:48:08.522Z');
 assert.equal(journey.busLastSeenAt,journey.finishedAt);
 const offRoute=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).find(e=>e.kind==='bus-off-route');
 assert.equal(offRoute.detail.bus,'#324');
 assert.ok(offRoute.detail.exitDistanceM>4000);
});
test('a detour off the route that comes back within 10 min is still ridden',async()=>{
 const h=await boardPink324();
 const off=pink324At(recorded('2026-10-02T22:45:08').slice(1)),on=pink324At(recorded('2026-10-02T22:34:48').slice(1));
 let t=Date.parse('2026-10-02T22:35:00Z');const next=()=>new Date(t+=10000).toISOString();
 for(let lap=0;lap<2;lap++){
  for(let i=0;i<59;i++)await h.ride(next(),off,lookingFor);
  await h.ride(next(),on,"3 stops · 5 min\n🚌 Pink #324 → VA Entrance Inbound");
 }
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.equal(h.watcher.status().run.offRouteSince,undefined);
 assert.deepEqual(await h.journeys(),[]);
});
test('the app looking for an on-route bus, or tracking an off-route one, is not excluded',async()=>{
 const h=await boardPink324();
 const off=pink324At(recorded('2026-10-02T22:45:08').slice(1)),on=pink324At(recorded('2026-10-02T22:34:48').slice(1));
 let t=Date.parse('2026-10-02T22:35:00Z');const next=()=>new Date(t+=10000).toISOString();
 // Either would be an app question for review, not an end-of-service deadhead.
 for(let i=0;i<70;i++)await h.ride(next(),on,lookingFor);
 for(let i=0;i<70;i++)await h.ride(next(),off,"Get off NEXT stop! · 25 min\n🚌 Pink #324 → VA Entrance Inbound");
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.deepEqual(await h.journeys(),[]);
});

// The dedicated Red rider (RIDER_LINE=Red RIDER_FROM=48 RIDER_TO=ysph).
const ysph={display_name:'School of Public Health (YSPH)',lat:41.303735,lon:-72.932155,type:'college',class:'yale'};
const fixedTrip={kind:'fixed',origin:{label:'Division / Prospect',lat:41.324769,lon:-72.923522,stopId:48},destination:ysph};
const red={routes:{3:[11,48,72],10:[122,127]},stop_names:{11:'344 Winchester',48:'Division / Prospect',72:'LEPH / 60 College',122:'Union Station (S)',127:'West Haven Train Station'},
 stop_coords:{11:{lat:41.3271,lon:-72.9298},48:fixedTrip.origin,72:{lat:41.30378,lon:-72.93261},122:union,127:westHaven}};
const red317={bus_name:'#317',route_id:3,lat:41.3271,lon:-72.9298,at_stop_id:11,stationary:true};
async function fixedRed(initialFeed){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 vi.setSystemTime(Date.parse('2026-10-01T15:00:00Z'));
 const h={dir:await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-')),geo:[],opened:[],handlers:{},rowShown:true};
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},reload:async()=>{},screenshot:async()=>Buffer.from('jpg'),
  locator:()=>({innerText:async()=>''}),keyboard:{press:async k=>h.opened.push(k)},waitForFunction:async()=>{},
  evaluate:async()=>({toLL:{lat:ysph.lat,lon:ysph.lon}}),
  getByPlaceholder:()=>({fill:async()=>{},press:async()=>{}}),
  getByRole:(_,{name})=>({isVisible:async()=>h.rowShown&&name==='View Red trip details',click:async()=>{},focus:async()=>h.opened.push(name)})};
 h.watcher=await attach({page,ctx:{setGeolocation:async g=>h.geo.push(g)},initialFeed,outputDir:h.dir,allowedLabels:['Red'],fixedTrip});
 h.feed=buses=>h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>({...red,buses})});
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
 return h;
}
test('a fixed Red trip waits for Red service and then starts from Division / Prospect',async()=>{
 const h=current=await fixedRed({...red,buses:[near126]});
 // Purple is live, Red is not: nothing is selected, not even an attempt.
 assert.equal(h.watcher.status().run,null);
 assert.deepEqual(h.geo,[]);
 assert.deepEqual(h.opened,[]);
 assert.deepEqual(await h.events(),[]);
 await h.feed([red317]);
 await h.watcher.tick();
 const run=h.watcher.status().run;
 assert.equal(run.line.label,'Red');
 assert.equal(run.trip,fixedTrip);
 assert.deepEqual(h.opened,['View Red trip details','Enter']);
 assert.deepEqual(h.geo,[{latitude:41.324769,longitude:-72.923522}]);
});
test('a missing Red trip row backs off instead of reloading every 10 s',async()=>{
 const g=current=await fixedRed({...red,buses:[]});
 g.rowShown=false;await g.feed([red317]);
 await g.watcher.tick();
 assert.equal(g.geo.length,1);
 for(let i=0;i<11;i++){vi.setSystemTime(Date.now()+10000);await g.watcher.tick();}
 assert.equal(g.geo.length,1);
 assert.deepEqual((await g.events()).map(e=>e.kind),['selection-unavailable']);
 vi.setSystemTime(Date.now()+10000);g.rowShown=true;await g.watcher.tick();
 assert.equal(g.geo.length,2);
 assert.equal(g.watcher.status().run.line.label,'Red');
},30000); // master reloads every poll (1.5 s each), so fail on the assertion, not the timeout

// Red run 1790956246494, 2026-10-02: the card followed #119 to Division /
// Prospect. At 16:01:52Z #119 rolled past the pole (2.6 m, moving) and the card
// dropped its name; at 16:02:02Z it stood at the stop (at_stop_id 48, 47 m from
// the pole, card "At stop" and "On Red #119?"); at 16:02:12Z it had left and
// the card moved on to #308, 17 stops away. A rider at the stop gets on.
const red119={bus_name:'#119',route_id:3,last_stop_id:49,stationary:false};
const red308={bus_name:'#308',route_id:3,lat:41.303872,lon:-72.921817,last_stop_id:121,at_stop_id:115,stationary:true};
const redCard=(head,board="BOARDDivision/Prospect")=>head+"\n"+board+"\nProspect/Hillside\nGET OFFLEPH/60 College";
test('Red #119 standing at Division / Prospect 47 m from the pole is boarded',async()=>{
 const approach=redCard("🚌 14 min\n🚌 #119 · 1 stop away\n🚌Division/Sheffield");
 const h=current=await harness({...red,buses:[{...red119,lat:41.325293,lon:-72.925228}]},fixedTrip,
  {initialLine:{label:'Red',busRouteIds:[3]},feedOf:buses=>({...red,buses}),text:approach,at:'2026-10-02T16:01:32Z'});
 await h.poll(approach,[{...red119,lat:41.324957,lon:-72.924418}]);
 assert.equal(h.watcher.status().run.busName,'#119');
 await h.poll(redCard("Red\t\n<1\n\t12:13p – 12:21p\n\n🚌 14 min","BOARD🚌Division/Prospect"),[{...red119,lat:41.324792,lon:-72.92353}]);
 await h.poll(redCard("Red\t\nAt stop\n\t~12:17p\n\n🚌 14 min","BOARD🚌Division/Prospect⏸ 0:22")+"\n🚌 On Red #119?\nDetected near your board stop",
  [{...red119,lat:41.324403,lon:-72.923236,last_stop_id:48,at_stop_id:48,stationary:true}]);
 await h.poll(redCard("Red\t\n~32 (26 – 39)\n\t12:43p – 12:58p\n\n🚌 15 min\n🚌 #308 · 17 stops away"),[{...red119,lat:41.323513,lon:-72.923354,last_stop_id:48},red308]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'riding');
 assert.equal(run.busName,'#119');
 assert.equal(run.boardedAt,'2026-10-02T16:02:02.000Z');
 assert.equal(Math.round(run.lastBoardDistanceM),47);
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
});
test('a bus standing at the stop that the card says is still stops away is not boarded',async()=>{
 const lapping=redCard("🚌 15 min\n🚌 #119 · 17 stops away");
 const h=current=await harness({...red,buses:[]},fixedTrip,
  {initialLine:{label:'Red',busRouteIds:[3]},feedOf:buses=>({...red,buses}),text:lapping,at:'2026-10-02T16:01:32Z'});
 await h.poll(lapping,[{...red119,lat:41.324403,lon:-72.923236,last_stop_id:48,at_stop_id:48,stationary:true}]);
 const run=h.watcher.status().run;
 assert.equal(run.phase,'waiting');
 assert.equal(Math.round(run.lastBoardDistanceM),47);
 assert.deepEqual(h.clicks,[]);
});

// 96f99a88, Grocery Ham run 1791026050850 (trip kind 'longest'): the first card
// quoted "About 44 min · Likely 33–60 min". #42 laid over at Aldi/Walmart, then
// held at Elm / York (TYCO) from 11:52:03Z, and the fixed 45 min cap ended the
// wait at 11:59:18Z. The next run, on the same trip, boarded it at 12:01:48Z.
const ham=JSON.parse(await fs.readFile(new URL('./__fixtures__/grocery-ham-long-wait-2026-10-03.json',import.meta.url),'utf8'));
const hamFeedOf=buses=>({buses,routes:{18:ham.route.stops},route_paths:{18:ham.route.path},stop_names:ham.route.stop_names,stop_coords:ham.route.stop_coords});
const ham42=([lat,lon,stationary,at_stop_id,last_stop_id])=>[{bus_name:'#42',route_id:18,lat,lon,stationary:!!stationary,last_stop_id,...(at_stop_id==null?{}:{at_stop_id})}];
async function waitForHam42(polls){
 const c=ham.route.stop_coords,[first]=ham.polls;
 const hamTrip={kind:'longest',origin:{label:'Elm / College',...c[54],stopId:54},destination:{display_name:'Aldi/Walmart',...c[170],stopId:170}};
 const h=current=await harness(hamFeedOf(ham42(first.slice(1))),hamTrip,{initialLine:{label:'Grocery Ham',busRouteIds:[18]},feedOf:hamFeedOf,text:ham.cards[first[6]],at:ham.startedAt});
 for(const [at,...p] of polls){
  vi.setSystemTime(Date.parse(at)-10000);await h.poll(ham.cards[p[5]],ham42(p));
  if(h.watcher.status().run?.phase!=='waiting')break;
 }
 return h;
}
test('replay: a quoted 44 min wait is waited out to boarding, not cut off at 45 min',async()=>{
 const h=await waitForHam42(ham.polls);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');
 assert.equal(run.waitCapMin,66);
 assert.equal(run.boardedAt,'2026-10-03T12:01:48.158Z');
 assert.deepEqual(await h.journeys(),[]);
});
test('a bus that never comes still ends the wait at the quoted cap',async()=>{
 const held=ham.polls.filter(([at])=>at<'2026-10-03T11:59:20');
 const [,...last]=held.at(-1);
 let t=Date.parse(held.at(-1)[0]);
 while(t<Date.parse('2026-10-03T12:21:00Z'))held.push([new Date(t+=10000).toISOString(),...last]);
 const h=await waitForHam42(held);
 const [journey]=await h.journeys();
 assert.equal(journey?.result,'waiting-timeout-needs-review');
 assert.equal(journey.waitCapMin,66);
 // The first poll past 66 min from the 11:14:10.850Z start.
 assert.ok(journey.finishedAt>'2026-10-03T12:20:10.850Z'&&journey.finishedAt<'2026-10-03T12:20:21Z',journey.finishedAt);
});

// riderpromptmiss20261004, Purple run 1791113952205: #330 stood at West Haven
// Train Station 47 m from the pole (at_stop_id from 11:50:37Z), and the
// 11:50:50Z poll showed "On Purple #330? Detected near your board stop". The
// app's next feed poll had #330 leaving, the offer went with it, and "Yes, I'm
// on it" detached under the click. Master waited out Playwright's 30 s default
// (harness-error 11:51:20Z) and the run boarded #317 at 12:06Z as "completed".
const promptMiss=JSON.parse(await fs.readFile(new URL('./__fixtures__/purple-330-offer-gone-2026-10-04.json',import.meta.url),'utf8'));
const purpleFeedOf=buses=>({buses,routes:{10:promptMiss.route.stops},route_paths:{10:promptMiss.route.path},stop_names:promptMiss.route.stop_names,stop_coords:promptMiss.route.stop_coords});
const purpleAt=rows=>rows.map(([bus_name,lat,lon,stationary,at_stop_id,last_stop_id])=>({bus_name,route_id:10,lat,lon,stationary,last_stop_id,...(at_stop_id==null?{}:{at_stop_id})}));
const promptPoll=at=>promptMiss.polls.find(p=>p[0].startsWith(at));
// The app polls every 5 s and the sampler every 10 s, so the app poll that
// cleared the offer was not recorded. Modeled: #330 20 m along its recorded
// path, pulling away 62 m from the pole; #317 as recorded at 11:50:50Z.
const pullingAway=[['#330',41.271329,-72.964228,false,null,122],promptPoll('2026-10-04T11:50:50')[2][1]];
// The card after #330 left, as recorded at 11:51:30Z: it follows #317.
const cardAfter=promptMiss.cards[promptPoll('2026-10-04T11:51:30')[1]];
async function offerGoneUnderClick(rowsAfter,{offerStays=false}={}){
 const [first]=promptMiss.polls;
 const fromWestHaven={...trip,origin:{label:'West Haven Train Station',...westHaven,stopId:127}};
 const h=current=await harness(purpleFeedOf(purpleAt(first[2])),fromWestHaven,{feedOf:purpleFeedOf,text:promptMiss.cards[first[1]],at:promptMiss.startedAt});
 const feed=buses=>h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>purpleFeedOf(buses)});
 // The offer shows while the page text has it. Clicking it, the app's next
 // poll arrives first and clears it. The card's unnamed "I'm on it" stores
 // what the app's boardingBusName does: the line's bus within 100 m of the
 // rider, the card's own if it is one of them, else the nearest; with none
 // that close, the card's bus.
 h.page.getByRole=(_,{name})=>({
  isVisible:async()=>name==="🚌 I'm on it"||(/\nYes, I'm on it\n/.test(h.text)&&["Yes, I'm on it",'Not me'].includes(name)),
  click:async(opts={})=>{
   h.clicks.push([name,opts.timeout]);
   if(name==="🚌 I'm on it"){
    const card=h.text.match(/🚌\s*(#[\w-]+)\s*·/)?.[1];
    const near=h.buses.map(b=>({name:b.bus_name,m:haversineM(b,{lat:h.geo.latitude,lon:h.geo.longitude})})).filter(b=>b.m<=100).sort((a,b)=>a.m-b.m);
    h.stored=near.length&&!near.some(b=>b.name===card)?near[0].name:card;return;
   }
   if(!offerStays){h.buses=purpleAt(rowsAfter);await feed(h.buses);h.text=cardAfter;}
   throw new Error(`locator.click: Timeout ${opts.timeout??30000}ms exceeded.\nCall log:\n  - element was detached from the DOM, retrying`);
  }});
 h.page.evaluate=async()=>h.stored??null;
 h.page.waitForFunction=async(_,name)=>{if(h.stored?.replace(/^#/,'')!==name.replace(/^#/,''))throw new Error('page.waitForFunction: Timeout 5000ms exceeded.');};
 for(const [at,card,rows] of promptMiss.polls.filter(([at])=>at<'2026-10-04T11:51')){
  vi.setSystemTime(Date.parse(at)-10000);h.buses=purpleAt(rows);await h.poll(promptMiss.cards[card],h.buses);
  if(h.watcher.status().run?.phase!=='waiting')break;
 }
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 return h;
}
test('replay: an offer gone under the click boards #330 through the card while it is within 100 m',async()=>{
 const h=await offerGoneUnderClick(pullingAway);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');
 assert.equal(run.busName,'#330');
 assert.equal(run.boardedAt,'2026-10-04T11:50:50.451Z');
 assert.equal(Math.round(run.lastBoardDistanceM),47);
 // A short offer click, then the card; never the 30 s default.
 assert.deepEqual(h.clicks,[["Yes, I'm on it",3000],["🚌 I'm on it",undefined]]);
 assert.equal(run.harnessErrors,undefined);
 assert.equal(run.excludeAccuracy,undefined);
});
test('replay: an offer gone with #330 already away ends the run as a missed boarding, not a wait for #317',async()=>{
 const h=await offerGoneUnderClick(promptPoll('2026-10-04T11:51:30')[2]);
 assert.equal(h.watcher.status().run,null);
 const [journey]=await h.journeys();
 assert.equal(journey?.result,'boarding-missed-excluded');
 assert.equal(journey.excludeAccuracy,true);
 assert.equal(journey.busName,'#330');
 assert.equal(journey.boardedAt,undefined);
 // The card's "I'm on it" would have stored #317 (480 m from #330's stop).
 assert.deepEqual(h.clicks,[["Yes, I'm on it",3000]]);
 assert.equal(h.stored,undefined);
 const missed=(await h.events()).find(e=>e.kind==='boarding-missed');
 assert.equal(missed.detail.bus,'#330');
 assert.equal(Math.round(missed.detail.observedDistanceM),47);
 assert.equal(Math.round(missed.detail.distanceNowM),480);
});
test('an offer click that fails with the offer still showing is retried as before',async()=>{
 const h=await offerGoneUnderClick(pullingAway,{offerStays:true});
 const run=h.watcher.status().run;
 assert.equal(run.phase,'waiting');
 assert.equal(run.harnessErrors,1);
 assert.equal(run.excludeAccuracy,undefined);
 assert.deepEqual(h.clicks,[["Yes, I'm on it",3000]]);
});

// riderboarddrivethrough20261005, Purple run 1791158187158: #317 drove through
// 100 Church Street South without stopping, 77 m before the pole at 00:39:24Z
// and 42 m past it at 00:39:34Z (last_stop_id 1, moving), 195 m at 00:39:44Z.
// Since #371 the card names it "15 stops away" there, and 42 m boarded it.
const church=JSON.parse(await fs.readFile(new URL('./__fixtures__/purple-church-st-drive-through-2026-10-05.json',import.meta.url),'utf8'));
async function waitAtChurch({cards,polls}){
 const c=promptMiss.route.stop_coords;
 const churchTrip={kind:'random',origin:{label:'100 Church Street South',...c[1],stopId:1},destination:{display_name:'Building 400',...c[22],stopId:22}};
 const [first]=polls;
 const h=current=await harness(purpleFeedOf(purpleAt(first[2])),churchTrip,{feedOf:purpleFeedOf,text:cards[first[1]],at:first[0]});
 for(const [at,card,rows] of polls.slice(1)){
  vi.setSystemTime(Date.parse(at)-10000);await h.poll(cards[card],purpleAt(rows));
  if(h.watcher.status().run?.phase!=='waiting')break;
 }
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 return h;
}
test('replay: #317 driving through 100 Church Street South is not boarded 42 m past the pole',async()=>{
 const h=await waitAtChurch(church.driveThrough);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'waiting');
 assert.equal(run.boardedAt,undefined);
 assert.deepEqual(h.clicks,[]);
 // The card follows #317 a lap on, 14 stops away by 00:40:34Z.
 assert.equal(run.busName,'#317');
 assert.equal(run.pastStopSamples,1);
 assert.equal(run.excludeAccuracy,undefined);
 const past=(await h.events()).filter(e=>e.kind==='waiting-bus-past-stop');
 assert.equal(past.length,1);
 assert.equal(past[0].at,'2026-10-05T00:39:34.194Z');
 assert.equal(past[0].detail.bus,'#317');
 assert.equal(Math.round(past[0].detail.distanceM),42);
 assert.equal(past[0].detail.lastStopId,1);
});
// Purple run 1791106305230: #330 was 5 m from the same pole at 09:37:29Z with
// last_stop_id already 1, then stood 66 m on (at_stop_id 1) from 09:37:39Z.
// The card then marks it at BOARD (#371), so the rider boards it standing.
test('replay: #330 rolling past the pole and standing 66 m on is boarded where it stands',async()=>{
 const h=await waitAtChurch(church.standPastPole);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');
 assert.equal(run.busName,'#330');
 assert.equal(run.boardedAt,'2026-10-04T09:37:39.037Z');
 assert.equal(Math.round(run.lastBoardDistanceM),66);
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 assert.equal(run.pastStopSamples,1);
 assert.equal(run.excludeAccuracy,undefined);
});
