import {test,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {attach} from './runner.mjs';

// Replays of recorded 2026-10-01 waiting runs through the real tick loop.
const line={label:'Purple',busRouteIds:[10]};
const union={lat:41.297929,lon:-72.926912},westHaven={lat:41.271172,lon:-72.963517},b400={lat:41.255793,lon:-72.993569};
const trip={kind:'random',origin:{label:'Union Station (S)',...union,stopId:122},destination:{display_name:'Building 400',...b400,stopId:22}};
const feedWith=buses=>({buses,routes:{10:[122,127,22]},stop_names:{122:'Union Station (S)',127:'West Haven Train Station',22:'Building 400'},stop_coords:{122:union,127:westHaven,22:b400}});
const approaching="🚌 20 min\n🚌 #126 · 1 stop away\nBOARDUnion Station (S)\nGET OFFBuilding 400";
const dwelling="🚌 20 min\nBOARD🚌Union Station (S)⏸ 0:29\nWest Haven Train Station\nGET OFFBuilding 400";
const at126={bus_name:'#126',route_id:10,lat:41.297912,lon:-72.926694,at_stop_id:122,stationary:true};
const near126={bus_name:'#126',route_id:10,lat:41.296923,lon:-72.927685,stationary:false};

async function harness(initialFeed,initialTrip=trip){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 vi.setSystemTime(Date.parse('2026-10-01T11:00:00Z'));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-'));
 const h={text:approaching,clicks:[],handlers:{}};
 const button=name=>({isVisible:async()=>name==="🚌 I'm on it",click:async()=>h.clicks.push(name)});
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},locator:()=>({innerText:async()=>h.text}),
  getByRole:(_,{name})=>button(name),screenshot:async()=>Buffer.from('jpg'),
  evaluate:async()=>({}),waitForFunction:async()=>{}};
 const ctx={setGeolocation:async()=>{}};
 h.watcher=await attach({page,ctx,initialTrip,initialLine:line,initialFeed,outputDir:dir});
 // The runner's own 10 s interval drives each poll; wait for it to settle.
 h.poll=async(text,buses)=>{h.text=text;
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedWith(buses)});
  vi.advanceTimersByTime(10000);
  do await new Promise(r=>setImmediate(r)); while(h.watcher.status().busy);};
 h.journeys=async()=>(await fs.readFile(path.join(dir,'journeys.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.dir=dir;return h;
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
