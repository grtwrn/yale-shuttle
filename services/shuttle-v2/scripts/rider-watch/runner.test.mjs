import {test,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {attach} from './runner.mjs';

// Replays of recorded 2026-10-01 waiting runs through the real tick loop.
const line={label:'Purple',busRouteIds:[10]};
const union={lat:41.297929,lon:-72.926912},b400={lat:41.255793,lon:-72.993569};
const trip={kind:'random',origin:{label:'Union Station (S)',...union,stopId:122},destination:{display_name:'Building 400',...b400,stopId:22}};
const feedWith=buses=>({buses,routes:{10:[122,127,22]},stop_names:{122:'Union Station (S)',127:'West Haven Train Station',22:'Building 400'},stop_coords:{122:union,22:b400}});
const approaching="🚌 20 min\n🚌 #126 · 1 stop away\nBOARDUnion Station (S)\nGET OFFBuilding 400";
const dwelling="🚌 20 min\nBOARD🚌Union Station (S)⏸ 0:29\nWest Haven Train Station\nGET OFFBuilding 400";
const at126={bus_name:'#126',route_id:10,lat:41.297912,lon:-72.926694,at_stop_id:122,stationary:true};
const near126={bus_name:'#126',route_id:10,lat:41.296923,lon:-72.927685,stationary:false};

async function harness(initialFeed){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 vi.setSystemTime(Date.parse('2026-10-01T11:00:00Z'));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-'));
 const h={text:approaching,clicks:[],handlers:{}};
 const button=name=>({isVisible:async()=>name==="🚌 I'm on it",click:async()=>h.clicks.push(name)});
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},locator:()=>({innerText:async()=>h.text}),
  getByRole:(_,{name})=>button(name),screenshot:async()=>Buffer.from('jpg'),
  evaluate:async()=>({}),waitForFunction:async()=>{}};
 const ctx={setGeolocation:async()=>{}};
 h.watcher=await attach({page,ctx,initialTrip:trip,initialLine:line,initialFeed,outputDir:dir});
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
