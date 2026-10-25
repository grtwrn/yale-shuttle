import {test,vi,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {attach} from './runner.mjs';
import {haversineM} from '../canary-metrics.mjs';
import {verifyFeedResponseRecord} from './feed-evidence.mjs';

// Replays of recorded 2026-10-01 waiting runs through the real tick loop.
const line={label:'Purple',busRouteIds:[10]};
const union={lat:41.297929,lon:-72.926912},westHaven={lat:41.271172,lon:-72.963517},b400={lat:41.255793,lon:-72.993569};
const trip={kind:'random',origin:{label:'Union Station (S)',...union,stopId:122},destination:{display_name:'Building 400',...b400,stopId:22}};
const feedWith=buses=>({buses,routes:{10:[122,127,22]},stop_names:{122:'Union Station (S)',127:'West Haven Train Station',22:'Building 400'},stop_coords:{122:union,127:westHaven,22:b400}});
const approaching="🚌 20 min\n🚌 #126 · 1 stop away\nBOARDUnion Station (S)\nGET OFFBuilding 400";
const dwelling="🚌 20 min\nBOARD🚌Union Station (S)⏸ 0:29\nWest Haven Train Station\nGET OFFBuilding 400";
const at126={bus_name:'#126',route_id:10,lat:41.297912,lon:-72.926694,at_stop_id:122,stationary:true};
const near126={bus_name:'#126',route_id:10,lat:41.296923,lon:-72.927685,stationary:false};

async function harness(initialFeed,initialTrip=trip,{initialLine=line,feedOf=feedWith,text=approaching,at='2026-10-01T11:00:00Z',initialFeedAgeMs=0,initialResponse,initialRun,fakeTimeouts=false,pickupRows=[]}={}){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval',...(fakeTimeouts?['setTimeout','clearTimeout']:[])]});
 vi.setSystemTime(Date.parse(at));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-'));
 const h={text,clicks:[],handlers:{},pickupRows};
 const button=name=>({isVisible:async()=>name==="🚌 I'm on it",click:async()=>h.clicks.push(name)});
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},locator:selector=>({innerText:async()=>h.text,evaluateAll:async()=>selector==='tbody[data-pickup-service="on-demand"]'?h.requestStops??[]:selector==='tbody[data-route][data-pickup]'?h.pickupRows??[]:h.maps??[]}),
  getByRole:(_,{name})=>button(name),screenshot:async()=>Buffer.from('jpg'),
  evaluate:async()=>({}),waitForFunction:async()=>{}};
 const ctx={setGeolocation:async g=>{h.geo=g;}};
 h.watcher=await attach({page,ctx,initialTrip,initialLine,initialFeed,initialFeedAt:Date.now()-initialFeedAgeMs,initialResponse,initialRun,outputDir:dir});
 // The runner's own 10 s interval drives each poll; wait for it to settle.
 // receiptDelayMs models delivery within the existing 10 s poll interval;
 // recorded vehicle timestamps are unchanged, and no historical HTTP receipt is inferred.
 h.poll=async(text,buses,{receiptDelayMs=0}={})=>{h.text=text;
  assert(receiptDelayMs>=0&&receiptDelayMs<10000);
  vi.advanceTimersByTime(receiptDelayMs);
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf(buses)});
  vi.advanceTimersByTime(10000-receiptDelayMs);
  do await new Promise(r=>setImmediate(r)); while(h.watcher.status().busy);};
 h.journeys=async()=>(await fs.readFile(path.join(dir,'journeys.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.dir=dir;h.page=page;return h;
}
let current;
test('a pickup that changes to request-only service is retained as excluded instead of timing out or boarding',async()=>{
 current=await harness(feedWith([near126]));
 current.requestStops=[{routeLabel:'Purple',stopId:122,text:'On request. Call Dispatch to request Union Station.'}];
 await current.poll(approaching,[near126]);
 const [journey]=await current.journeys();
 assert.equal(journey.result,'on-demand-request-required-excluded');assert.equal(journey.excludeAccuracy,true);
 assert.equal(journey.boardedAt,undefined);assert.deepEqual(current.clicks,[]);
 const events=(await fs.readFile(path.join(current.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert(events.some(e=>e.kind==='on-demand-request-required'&&e.detail.service.stopId===122));
});
test('another route request notice cannot exclude the current scheduled pickup',async()=>{
 current=await harness(feedWith([near126]));
 current.requestStops=[{routeLabel:'Red',stopId:122,text:'Unrelated row'}];
 await current.poll(approaching,[near126]);
 assert.equal(current.watcher.status().run.phase,'waiting');assert.deepEqual(current.clicks,[]);
});
afterEach(async()=>{await current?.watcher.stop();vi.useRealTimers();if(current)await fs.rm(current.dir,{recursive:true,force:true});current=undefined;});

function rawResponse(raw){return {url:()=> 'https://example.test/api/buses',ok:()=>true,status:()=>200,
 headers:()=>({'content-type':'application/json','set-cookie':'DO_NOT_RETAIN'}),json:async()=>JSON.parse(raw),body:async()=>Buffer.from(raw)};}

const positionFixture=JSON.parse(await fs.readFile(new URL('../../web/src/__fixtures__/ride-position-without-eta-20261025.json',import.meta.url),'utf8'));
async function positionHarness(corrected=false){
 const first=positionFixture.snapshots[0],ride=positionFixture.ride,raw=verifyFeedResponseRecord(first.response),feed=JSON.parse(raw);
 const trip={kind:'fixed',origin:{label:feed.stop_names[ride.boardStopId],...feed.stop_coords[ride.boardStopId],stopId:ride.boardStopId},
  destination:{display_name:feed.stop_names[ride.alightStopId],...feed.stop_coords[ride.alightStopId],stopId:ride.alightStopId}};
 const text=corrected?first.text.replace('Looking for your bus…','Bus location available · arrival estimate unavailable'):first.text;
 const h=current=await harness(feed,trip,{initialLine:positionFixture.line,text,at:first.sampledAt,
  initialFeedAgeMs:Date.parse(first.sampledAt)-first.response.receivedAt,initialResponse:rawResponse(raw),
  initialRun:{id:positionFixture.runId,phase:'riding',line:positionFixture.line,trip,busName:ride.busName,boardStopId:ride.boardStopId,
   exitStopId:ride.alightStopId,boardedAt:new Date(ride.startedAt).toISOString(),startedAt:new Date(ride.startedAt).toISOString(),
   boardedStorage:positionFixture.boardedStorage}});
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 return h;
}
test('the real rider reports a sustained GPS-present looking-for-bus message once',async()=>{
 const h=await positionHarness();assert.equal((await h.events()).filter(e=>e.kind==='candidate-ride-tracking-status').length,0);
 const s=positionFixture.snapshots[1];vi.setSystemTime(s.response.receivedAt);await h.handlers.response(rawResponse(verifyFeedResponseRecord(s.response)));
 vi.setSystemTime(Date.parse(s.sampledAt));h.text=s.text;await h.watcher.tick();await h.watcher.tick();
 const events=(await h.events()).filter(e=>e.kind==='candidate-ride-tracking-status');assert.equal(events.length,1);
 assert.equal(events[0].detail.bus,'#44');assert.equal(events[0].detail.feedResponse.state,'captured');
 assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.harnessErrors,undefined);
});
test('the rider accepts the corrected position-known status without creating a candidate',async()=>{
 const h=await positionHarness(true),s=positionFixture.snapshots[1];vi.setSystemTime(s.response.receivedAt);
 await h.handlers.response(rawResponse(verifyFeedResponseRecord(s.response)));vi.setSystemTime(Date.parse(s.sampledAt));
 h.text=s.text.replace('Looking for your bus…','Bus location available · arrival estimate unavailable');await h.watcher.tick();
 assert.equal((await h.events()).filter(e=>e.kind==='candidate-ride-tracking-status').length,0);assert.equal(h.watcher.status().run.phase,'riding');
});
test('a feed replaced while reading tracking copy resets the pending contradiction',async()=>{
 const h=await positionHarness(),s=positionFixture.snapshots[1],locator=h.page.locator;
 h.page.locator=()=>({innerText:async()=>{await h.handlers.response(rawResponse(verifyFeedResponseRecord(s.response)));return s.text;}});
 vi.setSystemTime(Date.parse(s.sampledAt));await h.watcher.tick();h.page.locator=locator;
 assert.equal(h.watcher.status().run.rideTrackingConflict,null);
 assert.equal((await h.events()).filter(e=>e.kind==='candidate-ride-tracking-status').length,0);
 assert.equal(h.watcher.status().run.harnessErrors,undefined);
});

test('the recorded Blue Weekend recheck keeps waiting when it confirms an earlier pickup visit',async()=>{
 const recorded=JSON.parse(await fs.readFile(new URL('./__fixtures__/blue-weekend-46-pickup-recheck-20261024.json',import.meta.url),'utf8'));
 const rawBootstrap=verifyFeedResponseRecord(recorded.bootstrap.response),rawA=verifyFeedResponseRecord(recorded.selection.response),rawB=verifyFeedResponseRecord(recorded.recheck.response);
 // Reconstruct a waiting rider at the selected pole; both response bodies
 // and the before/after screen text are original, independently retained data.
 const h=current=await harness(JSON.parse(rawBootstrap),recorded.trip,{initialLine:recorded.line,text:recorded.bootstrap.text,
  at:recorded.sampledAt,initialFeedAgeMs:Date.parse(recorded.sampledAt)-recorded.bootstrap.response.receivedAt,initialResponse:rawResponse(rawBootstrap)});
 vi.setSystemTime(recorded.selection.response.receivedAt);await h.handlers.response(rawResponse(rawA));
 vi.setSystemTime(Date.parse(recorded.selection.sampledAt));h.text=recorded.selection.text;
 let replaced=false;
 h.page.screenshot=async()=>{
  if(!replaced){replaced=true;vi.setSystemTime(recorded.recheck.response.receivedAt);h.text=recorded.recheck.text;await h.handlers.response(rawResponse(rawB));vi.setSystemTime(Date.parse(recorded.recheck.checkedAt));}
  return Buffer.from('jpg');
 };
 h.page.evaluate=async()=>null;
 await h.watcher.tick();
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'waiting');assert.equal(run.boardedAt,undefined);assert.notEqual(run.excludeAccuracy,true);
 assert.equal((await h.journeys()).length,0);assert.deepEqual(h.clicks,[]);
 const observation=run.boardingObservation;
 assert.equal(observation.outcome,'waiting-other-pickup-occurrence');
 const decision=observation.checks.find(c=>c.kind==='card-boards');
 assert.equal(decision.allowed,false);assert.equal(decision.otherOccurrence.pickupStop,53);
 assert.equal(decision.otherOccurrence.standingStop,21);assert.equal(decision.otherOccurrence.stopsAway,2);
 const retained=(await fs.readFile(path.join(h.dir,decision.feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse);
 const byId=new Map(retained.map(r=>[r.id,r]));
 assert.deepEqual(verifyFeedResponseRecord(byId.get(observation.checks[0].feedResponse.id)),rawA);
 assert.deepEqual(verifyFeedResponseRecord(byId.get(decision.feedResponse.id)),rawB);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert(events.some(e=>e.kind==='boarding-deferred-other-occurrence'));
 assert(!events.some(e=>e.kind==='boarding-missed'||e.kind==='journey-finished'||e.kind==='boarded'));
 const checkpoint=JSON.parse(await fs.readFile(path.join(h.dir,'resume.json'),'utf8'));
 assert.equal(checkpoint.run.phase,'waiting');assert.deepEqual(checkpoint.run.boardingObservation,observation);
});

// Constructed response-race controls, not a reconstruction of the missing
// Red #119 boarding recheck body from 2026-10-23.
async function boardingEvidenceHarness({missingBody=false,replaceDuringBody=false,missed=true}={}){
 const h=current=await harness(feedWith([{...near126,observed_at:Date.parse('2026-10-01T11:00:00Z')}]));
 vi.setSystemTime(Date.now()+10000);
 const initial=feedWith([{...at126,observed_at:Date.now()}]);
 const later=feedWith([{...at126,lat:union.lat+0.0013,at_stop_id:null,stationary:false,observed_at:Date.now()}]);
 const replacement=feedWith([{...later.buses[0],lat:union.lat+0.002}]);
 const rawA=Buffer.from('\n'+JSON.stringify(initial,null,2)+'\n'),rawB=Buffer.from(' '+JSON.stringify(later)+'\n'),rawC=Buffer.from(JSON.stringify(replacement));
 const responseB=rawResponse(rawB);
 if(missingBody)responseB.body=async()=>{throw Error('response body unavailable');};
 if(replaceDuringBody)responseB.body=async()=>{await h.handlers.response(rawResponse(rawC));return rawB;};
 let replaced=false;
 h.page.screenshot=async()=>{if(missed&&!replaced){replaced=true;await h.handlers.response(responseB);}return Buffer.from('jpg');};
 h.page.evaluate=async()=>null;
 h.text=dwelling;
 await h.handlers.response(rawResponse(rawA));
 await h.watcher.tick();
 h.evidence={initial,later,replacement,rawA,rawB,rawC};
 return h;
}
test('boarding rechecks retain the newer decision response separately from the pickup screen',async()=>{
 const h=await boardingEvidenceHarness(),[journey]=await h.journeys();
 assert.equal(journey.result,'boarding-missed-excluded');assert.equal(journey.excludeAccuracy,true);assert.equal(journey.boardedAt,undefined);
 const observation=journey.boardingObservation;
 assert.equal(observation.outcome,'boarding-missed-excluded');
 assert.deepEqual(observation.routeIds,[10]);assert.deepEqual(observation.riderCoords,union);
 assert.deepEqual(observation.checks.map(c=>c.kind),['pickup-eligible','observation-ready','card-boards','boarding-missed']);
 assert.deepEqual(observation.checks.map(c=>c.allowed),[true,true,false,false]);
 const rows=(await fs.readFile(path.join(h.dir,observation.checks[0].feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse);
 const byId=new Map(rows.map(r=>[r.id,r]));
 assert.deepEqual(verifyFeedResponseRecord(byId.get(observation.sample.feedResponse.id)),h.evidence.rawA);
 assert.deepEqual(observation.checks[0].bus,h.evidence.initial.buses[0]);
 for(const check of observation.checks.slice(1)){
  assert.deepEqual(check.bus,h.evidence.later.buses[0]);assert.deepEqual(verifyFeedResponseRecord(byId.get(check.feedResponse.id)),h.evidence.rawB);
  assert.equal(check.distanceM,haversineM(check.bus,observation.stopCoords));
 }
 assert.notEqual(observation.sample.feedResponse.id,observation.checks[1].feedResponse.id);
 assert.equal(rows.filter(r=>r.id===observation.checks[1].feedResponse.id).length,1);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const missed=events.find(e=>e.kind==='boarding-missed');assert.deepEqual(missed.detail.boardingObservation,observation);
 assert.equal(missed.detail.distanceNowM,observation.checks.at(-1).distanceM);
});
test('boarding rechecks keep their own response when body capture delivers another poll',async()=>{
 const h=await boardingEvidenceHarness({replaceDuringBody:true}),[journey]=await h.journeys();
 const checks=journey.boardingObservation.checks,first=checks[1];
 const rows=(await fs.readFile(path.join(h.dir,first.feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse),byId=new Map(rows.map(r=>[r.id,r]));
 assert.deepEqual(first.bus,h.evidence.later.buses[0]);assert.deepEqual(verifyFeedResponseRecord(byId.get(first.feedResponse.id)),h.evidence.rawB);
 assert.deepEqual(checks.at(-1).bus,h.evidence.replacement.buses[0]);assert.deepEqual(verifyFeedResponseRecord(byId.get(checks.at(-1).feedResponse.id)),h.evidence.rawC);
});
test('boarding rechecks report an unavailable body without inventing a receipt',async()=>{
 const h=await boardingEvidenceHarness({missingBody:true}),[journey]=await h.journeys();
 assert.equal(journey.result,'boarding-missed-excluded');
 assert.equal(journey.boardingObservation.checks[0].feedResponse.state,'captured');
 for(const check of journey.boardingObservation.checks.slice(1)){assert.equal(check.feedResponse.state,'unavailable');assert.equal(check.feedResponse.reason,'feed-evidence-capture-failed');}
 assert.deepEqual(h.clicks,[]);
});
test('successful boarding rechecks share one retained response and survive checkpointing',async()=>{
 const h=await boardingEvidenceHarness({missed:false}),run=h.watcher.status().run;
 assert.equal(run.phase,'riding');assert.equal(run.boardingObservation.outcome,'boarded');
 assert.equal(run.boardingObservation.checks.length,6);assert(run.boardingObservation.checks.every(c=>c.allowed));
 const refs=run.boardingObservation.checks.map(c=>c.feedResponse);assert.equal(new Set(refs.map(r=>r.id)).size,1);assert(refs.every(r=>r.state==='captured'));
 const rows=(await fs.readFile(path.join(h.dir,refs[0].file),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(r=>r.id===refs[0].id).length,1);assert.deepEqual(verifyFeedResponseRecord(rows.find(r=>r.id===refs[0].id)),h.evidence.rawA);
 const checkpoint=JSON.parse(await fs.readFile(path.join(h.dir,'resume.json'),'utf8'));assert.deepEqual(checkpoint.run.boardingObservation,run.boardingObservation);
});
test('boarding rechecks do not wait for body storage before the confirmation click',async()=>{
 const h=current=await harness(feedWith([{...near126,observed_at:Date.parse('2026-10-01T11:00:00Z')}]));
 vi.setSystemTime(Date.now()+10000);
 const first=feedWith([{...at126,observed_at:Date.now()}]),next=feedWith([{...at126,heading:1,observed_at:Date.now()}]);
 const raw=Buffer.from(JSON.stringify(next)),response=rawResponse(raw);let release;
 response.body=()=>new Promise(resolve=>{release=()=>resolve(raw);});
 let changed=false;h.page.screenshot=async()=>{if(!changed){changed=true;await h.handlers.response(response);}return Buffer.from('jpg');};
 let clicked,timer;const confirmation=new Promise(resolve=>{clicked=resolve;});
 h.page.getByRole=(_,{name})=>({isVisible:async()=>name==="🚌 I'm on it",click:async()=>{h.clicks.push(name);clicked();}});
 h.text=dwelling;await h.handlers.response(rawResponse(Buffer.from(JSON.stringify(first))));
 const tick=h.watcher.tick();
 try{
  await Promise.race([confirmation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('confirmation waited for body retention')),2000);})]);
  assert.deepEqual(h.clicks,["🚌 I'm on it"]);assert.equal(h.watcher.status().busy,true);assert.equal(typeof release,'function');
 }finally{clearTimeout(timer);release?.();await tick;}
 assert.equal(h.watcher.status().run.phase,'riding');
 assert(h.watcher.status().run.boardingObservation.checks.every(c=>c.feedResponse.state==='captured'));
});
test('a saved UI sample is bound to the exact initial response bytes',async()=>{
 const initial=feedWith([near126]),raw=Buffer.from('\n'+JSON.stringify(initial,null,2)+'\n');
 const h=current=await harness(initial,trip,{initialResponse:rawResponse(raw),initialFeedAgeMs:1000});
 await h.watcher.tick();
 const sample=JSON.parse((await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').at(-1));
 assert.equal(sample.feedResponse.state,'captured');assert.equal(sample.feedResponse.receivedAt,Date.now()-1000);
 assert.equal(sample.feedResponse.sourceKind,'bootstrap-request');
 const record=JSON.parse((await fs.readFile(path.join(h.dir,sample.feedResponse.file),'utf8')).trim().split('\n').at(-1));
 assert.equal(record.id,sample.feedResponse.id);assert.deepEqual(verifyFeedResponseRecord(record),raw);
 assert.equal(h.watcher.status().feedEvidence.captured,1);
});
test('a feed change during a text read cannot bind the sample to the replacement response',async()=>{
 const first=feedWith([near126]),rawA=Buffer.from(JSON.stringify(first)),second=feedWith([at126]),rawB=Buffer.from(JSON.stringify(second));
 const h=current=await harness(first,trip,{initialResponse:rawResponse(rawA)});let changed=false;
 h.page.locator=()=>({innerText:async()=>{if(!changed){changed=true;await h.handlers.response(rawResponse(rawB));}return approaching;},evaluateAll:async()=>[]});
 await h.watcher.tick();
 const samples=(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(samples.length,2);const sample=samples.at(-1);
 assert.equal(sample.mapPauseAudit.feedStableDuringRead,false);assert.deepEqual(sample.buses,first.buses);
 const records=(await fs.readFile(path.join(h.dir,sample.feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse);
 const record=records.find(r=>r.id===sample.feedResponse.id);assert.deepEqual(verifyFeedResponseRecord(record),rawA);
 assert.notEqual(record.decodedSHA256,(await import('node:crypto')).createHash('sha256').update(rawB).digest('hex'));
});

test('the real rider loop raises one candidate for a sustained report-142 stop-count contradiction',async()=>{
 const capture=JSON.parse(await fs.readFile(new URL('../../web/src/__fixtures__/red-winchester-report-142.json',import.meta.url),'utf8'));
 const feedOf=buses=>({...capture.feed,buses:buses.map(b=>({...b,observed_at:Date.now()}))});
 const trip={kind:'fixed',origin:{label:'Division / Prospect',...capture.feed.stop_coords[48],stopId:48},destination:{display_name:'130 Prospect Street (S)',...capture.feed.stop_coords[4],stopId:4}};
 const screen='🚌 #317 · 11 stops away\nBOARDDivision/Prospect\nGET OFF130 Prospect Street (S)';
 const h=current=await harness(capture.feed,trip,{initialLine:{label:'Red',busRouteIds:[3]},feedOf,text:screen,at:new Date(capture.receivedAt).toISOString()});
 for(let i=0;i<3;i++)await h.poll(screen,capture.feed.buses);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const alerts=events.filter(e=>e.kind==='candidate-stop-count');
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].detail.expected,3);assert.equal(alerts[0].detail.actual,11);
 assert.equal(h.watcher.status().run.phase,'waiting');
 await h.poll(screen.replace('11 stops','3 stops'),capture.feed.buses);
 assert.equal(h.watcher.status().run.countConflict,null);
});

test.each([true,false])('the rider detects the actual Pink wrong count before GPS arrival (bad screen=%s)',async bad=>{
 const fixture=JSON.parse(await fs.readFile(new URL('../../web/src/__fixtures__/pink-standing-travel-20261023.json',import.meta.url),'utf8'));
 const [first,second]=fixture.snapshots.slice(1,3);
 const feedOf=c=>({buses:[c.bus],routes:c.routeStops,stop_names:c.stopNames,stop_coords:c.stopCoords,server_eta:c.wire});
 const run={id:fixture.runId,phase:'riding',line:{label:'Pink',busRouteIds:[8]},busName:'#324',boardStopId:149,exitStopId:123,
  boardedAt:'2026-10-23T15:18:08.671Z',boardedStorage:fixture.boardedStorage,
  trip:{origin:{label:'York / Cedar',...first.stopCoords[149],stopId:149},destination:{display_name:'VA Entrance Inbound',...first.stopCoords[123],stopId:123}}};
 const text=bad?'Your stop is 10 stops away\nPink #324 → VA Entrance Inbound\n10 stops · holding at VA Entrance Outbound'
  :'Get off at the next stop\nPink #324 → VA Entrance Inbound\nGet off NEXT stop! · holding at VA Entrance Outbound';
 const initial=feedOf(first);
 const h=current=await harness(initial,run.trip,{initialRun:run,initialLine:run.line,at:first.sampleAt,text,initialResponse:rawResponse(Buffer.from(JSON.stringify(initial)))});
 const events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal((await events()).filter(e=>e.kind==='candidate-ride-stop-count').length,0);
 vi.setSystemTime(Date.parse(second.sampleAt));await h.handlers.response(rawResponse(Buffer.from(JSON.stringify(feedOf(second)))));
 await h.watcher.tick();
 const alerts=(await events()).filter(e=>e.kind==='candidate-ride-stop-count');assert.equal(alerts.length,bad?1:0);
 if(bad){assert.equal(alerts[0].detail.expected,1);assert.equal(alerts[0].detail.actual,10);}
 const samples=(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(samples.at(-1).feedResponse.state,'captured');assert.equal(h.watcher.status().feedEvidence.unavailable,0);
 assert.equal(h.watcher.status().run.phase,'arrived');
});

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

test.each(['stale','future','nonfinite','null','string'])('a fresh HTTP receipt cannot board a %s vehicle observation',async mode=>{
 const h=current=await harness(feedWith([near126]));
 const decisionAt=Date.now()+10000;
 const clocks={stale:decisionAt-30001,future:decisionAt+5001,nonfinite:NaN,null:null,string:'not-a-clock'};
 await h.poll(dwelling,[{...at126,observed_at:clocks[mode]}]);
 assert.equal(h.watcher.status().run.phase,'waiting');assert.deepEqual(h.clicks,[]);
 assert.deepEqual(await h.journeys(),[]);
 await h.poll(dwelling,[{...at126,observed_at:Date.now()}]);
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
});
test.each([-30000,5000])('a vehicle clock at the %s ms decision boundary can board',async offset=>{
 const h=current=await harness(feedWith([near126]));
 vi.setSystemTime(Date.now()+10000);h.text=dwelling;
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,
  json:async()=>feedWith([{...at126,observed_at:Date.now()+offset}])});
 await h.watcher.tick();
 assert.equal(h.watcher.status().run.phase,'riding');assert.deepEqual(h.clicks,["🚌 I'm on it"]);
});
test('a clock invalid when received stays unavailable without a replacement observation',async()=>{
 const h=current=await harness(feedWith([near126]));
 await h.poll(dwelling,[{...at126,observed_at:Date.now()+5001}]);
 assert.equal(h.watcher.status().run.phase,'waiting');assert.deepEqual(h.clicks,[]);
 vi.advanceTimersByTime(10000);
 do await new Promise(r=>setImmediate(r));while(h.watcher.status().busy);
 assert.equal(h.watcher.status().run.phase,'waiting');assert.deepEqual(h.clicks,[]);
 await h.poll(dwelling,[{...at126,observed_at:Date.now()}]);
 assert.equal(h.watcher.status().run.phase,'riding');
});
test.each(['pickup-screenshot','confirmation','stored-recovery'])('vehicle evidence lost during %s never becomes accepted boarding',async mode=>{
 const h=current=await harness(feedWith([near126]));
 const stale=async()=>h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,
  json:async()=>feedWith([{...at126,observed_at:Date.now()-30001}])});
 if(mode==='pickup-screenshot')h.page.screenshot=async()=>{await stale();return Buffer.from('jpg');};
 else h.page.waitForFunction=async()=>{await stale();if(mode==='stored-recovery')throw Error('confirmation timeout');};
 if(mode==='stored-recovery')h.page.evaluate=async()=>'#126';
 await h.poll(dwelling,[{...at126,observed_at:Date.now()}]);
 const [journey]=await h.journeys();
 assert.equal(h.watcher.status().run,null);assert.equal(journey.result,'boarding-observation-unavailable-excluded');
 assert.equal(journey.excludeAccuracy,true);assert.equal(journey.boardedAt,undefined);
 assert.equal(h.clicks.length,mode==='pickup-screenshot'?0:1);
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
 // Start a real live trip; the following unavailable poll is the behavior
 // under test. A new selection now waits for an on-route bus.
 const h=current=await harness(feedWith([near126]));
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
test.each(['legacy', 'position-known'])('replay: a boarded bus off its route for 10 min with unavailable route tracking ends the ride (%s)',async(wording)=>{
 const h=await boardPink324();
 assert.equal(h.watcher.status().run.boardedAt,'2026-10-02T22:29:48.333Z');
 for(const [at,...p] of pink324.riding){
  const headline=pink324.headlines[p[4]].replace('Looking for your bus…',wording==='legacy'?'Looking for your bus…':'Bus location available · arrival estimate unavailable');
  await h.ride(at,pink324At(p),headline+"\n🚌 Pink #324 → VA Entrance Inbound");
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
// Run 1792525721613 recorded boarding #127 at 20:33:47.511Z, then
// waiting-timeout 38 ms later. Replay the recorded pickup position and clock
// boundary with the existing constructed route and browser controls. These
// controls do not reconstruct the original HTTP response or physical boarding.
const waitBoundaryStart='2026-10-20T19:48:41.613Z';
const waitBoundaryText='🚌 #127 · 1 stop away\nBOARDDivision/Prospect\nGET OFFLEPH/60 College';
const waitBoundaryBus={bus_name:'#127',route_id:3,lat:41.324824,lon:-72.923697,
 at_stop_id:48,last_stop_id:49,stationary:true,observed_at:1792528418277};
const waitBoundaryFeed=buses=>({...red,buses});
async function waitBoundaryRider(){
 return current=await harness(waitBoundaryFeed([{...red317,bus_name:'#127'}]),fixedTrip,
  {initialLine:{label:'Red',busRouteIds:[3]},feedOf:waitBoundaryFeed,text:waitBoundaryText,at:waitBoundaryStart});
}
test.each([45*60000,45*60000+5762])('boarding at %s ms starts the ride without a waiting timeout',async elapsed=>{
 const h=await waitBoundaryRider();
 vi.setSystemTime(Date.parse(waitBoundaryStart)+elapsed);
 h.text='🚌 14 min\nBOARD🚌Division/Prospect\nGET OFFLEPH/60 College';
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>waitBoundaryFeed([waitBoundaryBus])});
 await h.watcher.tick();
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');assert.equal(run.busName,'#127');
 assert.equal(run.boardedAt,new Date(Date.parse(waitBoundaryStart)+elapsed).toISOString());
 assert.ok(run.lastBoardDistanceM>15&&run.lastBoardDistanceM<16);
 assert.deepEqual(await h.journeys(),[]);assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 await h.poll('Red · Bus #127',[waitBoundaryBus]);
 assert.equal(h.watcher.status().run.phase,'riding');assert.deepEqual(await h.journeys(),[]);
});
test('the same expired waiting cap still closes a run when the bus cannot board',async()=>{
 const h=await waitBoundaryRider();
 vi.setSystemTime(Date.parse(waitBoundaryStart)+45*60000+5762-10000);
 await h.poll(waitBoundaryText,[{...red317,bus_name:'#127'}]);
 const [journey]=await h.journeys();assert.equal(journey.result,'waiting-timeout-needs-review');
 assert.equal(journey.boardedAt,undefined);assert.deepEqual(h.clicks,[]);
 assert.equal(h.watcher.status().run,null);
});
async function fixedRed(initialFeed,initialFeedAgeMs=0,{requestStops=[]}={}){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 vi.setSystemTime(Date.parse('2026-10-01T15:00:00Z'));
 const h={dir:await fs.mkdtemp(path.join(os.tmpdir(),'rider-watch-')),geo:[],opened:[],handlers:{},rowShown:true,requestStops};
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},reload:async()=>{},screenshot:async()=>Buffer.from('jpg'),
  locator:selector=>({innerText:async()=>'BOARDDivision/Prospect\nGET OFFLEPH/60 College',evaluateAll:async()=>selector==='tbody[data-pickup-service="on-demand"]'?h.requestStops??[]:[]}),keyboard:{press:async k=>h.opened.push(k)},waitForFunction:async()=>{},
  evaluate:async()=>({toLL:{lat:ysph.lat,lon:ysph.lon}}),
  getByPlaceholder:()=>({fill:async()=>{},press:async()=>{}}),
  getByRole:(_,{name})=>({isVisible:async()=>h.rowShown&&name==='View Red trip details',click:async()=>{},focus:async()=>h.opened.push(name)})};
 h.watcher=await attach({page,ctx:{setGeolocation:async g=>h.geo.push(g)},initialFeed,initialFeedAt:Date.now()-initialFeedAgeMs,outputDir:h.dir,allowedLabels:['Red'],fixedTrip});
 h.feed=buses=>h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>({...red,buses})});
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.storedStatus=async()=>JSON.parse(await fs.readFile(path.join(h.dir,'status.json'),'utf8'));
 h.journeys=async()=>(await fs.readFile(path.join(h.dir,'journeys.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.page=page;
 return h;
}

test('fresh empty service publishes feed freshness without inventing a journey',async()=>{
 const h=current=await fixedRed({...red,buses:[]});
 const status=await h.storedStatus();
 assert.equal(status.feedReceivedAt,'2026-10-01T15:00:00.000Z');
 assert.equal(status.feedAgeMs,0);assert.equal(status.feedStale,false);assert.equal(status.cachedBuses,0);
 assert.equal(status.running,true);assert.equal(status.phase,'selecting');
 assert.deepEqual(await h.events(),[]);assert.deepEqual(h.geo,[]);
 assert.equal((await fs.readFile(path.join(h.dir,'journeys.jsonl'),'utf8')).trim(),'');
});

test('a selected request-only pickup is skipped without starting a simulated scheduled journey',async()=>{
 const h=current=await fixedRed({...red,buses:[red317]},0,
  {requestStops:[{routeLabel:'Red',stopId:48,text:'Constructed request-only selection control'}]});
 await h.watcher.tick();
 assert.equal(h.watcher.status().run,null);
 const events=await h.events();
 assert.equal(events.filter(event=>event.kind==='selection-on-demand-request-required').length,1);
 assert.equal(events.filter(event=>event.kind==='journey-started').length,0);
});

test('an aged startup feed cannot start a trip and raises only one idle stale diagnostic',async()=>{
 const h=current=await fixedRed({...red,buses:[red317]},31000);
 for(let i=0;i<3;i++)await h.watcher.tick();
 assert.equal(h.watcher.status().run,null);assert.deepEqual(h.geo,[]);assert.deepEqual(h.opened,[]);
 const status=await h.storedStatus();
 assert.equal(status.feedAgeMs,31000);assert.equal(status.feedStale,true);assert.equal(status.cachedBuses,1);
 assert.match(status.note,/fresh shuttle feed/);
 const events=await h.events();assert.equal(events.filter(e=>e.kind==='candidate-stale-feed').length,1);
 assert.equal(events[0].detail.phase,'selecting');assert.equal(events[0].runId,undefined);
 assert.equal(status.retention.imageCount,1);assert.equal(h.watcher.status().running,true);
});

test('failed or unusable responses do not rejuvenate an idle feed; a valid empty feed recovers',async()=>{
 const h=current=await fixedRed({...red,buses:[]});
 vi.setSystemTime(Date.now()+31000);await h.watcher.tick();
 const received=(await h.storedStatus()).feedReceivedAt;
 for(const response of [
  {ok:()=>false,json:async()=>{throw Error('HTTP failure body must not be read');}},
  {ok:()=>true,json:async()=>{throw Error('invalid JSON');}},
  {ok:()=>true,json:async()=>({})},
 ]){
  await h.handlers.response({url:()=>'https://example.test/api/buses',...response});await h.watcher.tick();
  const status=await h.storedStatus();assert.equal(status.feedReceivedAt,received);assert.equal(status.feedStale,true);
 }
 await h.feed([]);await h.watcher.tick();
 const status=await h.storedStatus();assert.equal(status.feedAgeMs,0);assert.equal(status.feedStale,false);
 assert.equal(status.cachedBuses,0);assert.equal(status.running,true);assert.equal(h.watcher.status().run,null);
 const events=await h.events();assert.equal(events.filter(e=>e.kind==='candidate-stale-feed').length,1);
 assert.equal(events.filter(e=>e.kind==='feed-recovered').length,1);
 assert.deepEqual(h.geo,[]);assert.equal((await fs.readFile(path.join(h.dir,'journeys.jsonl'),'utf8')).trim(),'');
});

test('an idle cached bus is ignored after feed loss and can be selected after a fresh response',async()=>{
 const h=current=await fixedRed({...red,buses:[]});await h.feed([red317]);
 vi.setSystemTime(Date.now()+31000);await h.watcher.tick();
 assert.equal(h.watcher.status().run,null);assert.deepEqual(h.opened,[]);
 await h.feed([red317]);await h.watcher.tick();
 assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
 assert.deepEqual(h.opened,['View Red trip details','Enter']);
 assert.equal((await h.events()).filter(e=>e.kind==='journey-started').length,1);
 assert.equal((await h.storedStatus()).feedStale,false);
});

test('idle freshness uses the same strict thirty-second boundary as active journeys',async()=>{
 const h=current=await fixedRed({...red,buses:[]});const started=Date.now();
 vi.setSystemTime(started+30000);await h.watcher.tick();assert.equal((await h.storedStatus()).feedStale,false);
 vi.setSystemTime(started+30001);await h.watcher.tick();assert.equal((await h.storedStatus()).feedStale,true);
});

test('a slow destination lookup cannot open a new trip from a feed that expired during selection',async()=>{
 const h=current=await fixedRed({...red,buses:[]});await h.feed([red317]);
 h.page.reload=async()=>vi.setSystemTime(Date.now()+31000);
 await h.watcher.tick();
 assert.equal(h.watcher.status().run,null);assert.deepEqual(h.opened,[]);
 assert.equal((await h.storedStatus()).feedStale,true);
 assert.equal((await h.events()).filter(e=>e.kind==='candidate-stale-feed').length,1);
});

test('a failed selection reload releases the browser to the launcher instead of idling forever',async()=>{
 const h=current=await fixedRed({...red,buses:[]});await h.feed([red317]);
 let reloads=0;h.page.reload=async()=>{reloads++;throw new Error('page.reload: Timeout 30000ms exceeded.');};
 await h.watcher.tick();
 assert.equal(h.watcher.status().running,false);
 assert.equal(h.watcher.status().restartRequested,'selection-navigation-failed');
 assert.equal(h.watcher.status().run,null);
 const saved=JSON.parse(await fs.readFile(path.join(h.dir,'resume.json'),'utf8'));
 assert.equal(saved.run,null);
 assert.equal((await h.storedStatus()).running,false);
 assert.equal((await h.storedStatus()).restartRequested,'selection-navigation-failed');
 assert.deepEqual((await h.events()).map(e=>e.kind),['harness-error']);
 assert.match((await h.events())[0].detail.message,/page.reload: Timeout/);
 vi.setSystemTime(Date.now()+86400000);await h.watcher.tick();
 assert.equal(reloads,1);assert.deepEqual(await h.journeys(),[]);
});

test('a successful selection reload still starts the normal waiting journey',async()=>{
 const h=current=await fixedRed({...red,buses:[]});await h.feed([red317]);
 await h.watcher.tick();
 assert.equal(h.watcher.status().running,true);
 assert.equal(h.watcher.status().restartRequested,undefined);
 assert.equal(h.watcher.status().run.phase,'waiting');
 assert.deepEqual(await h.journeys(),[]);
});

test('service disappearing during destination lookup leaves the rider idle without a stale alert',async()=>{
 const h=current=await fixedRed({...red,buses:[]});await h.feed([red317]);
 h.page.reload=async()=>h.feed([]);
 await h.watcher.tick();
 assert.equal(h.watcher.status().run,null);assert.deepEqual(h.opened,[]);
 assert.equal((await h.storedStatus()).feedStale,false);assert.equal((await h.storedStatus()).cachedBuses,0);
 assert.deepEqual(await h.events(),[]);
});

test('an active journey still pauses on feed loss and continues on a fresh feed without an outcome',async()=>{
 const h=current=await harness(feedWith([near126]));
 vi.setSystemTime(Date.now()+31000);await h.watcher.tick();
 assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.stale,true);
 let status=JSON.parse(await fs.readFile(path.join(h.dir,'status.json'),'utf8'));assert.equal(status.feedStale,true);
 await h.poll(approaching,[near126]);
 assert.equal(h.watcher.status().run.stale,false);assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
 status=JSON.parse(await fs.readFile(path.join(h.dir,'status.json'),'utf8'));assert.equal(status.feedStale,false);
 assert.deepEqual(await h.journeys(),[]);
});

test('a seeded new trip waits for a fresh initial feed, then starts without a handover exclusion',async()=>{
 const h=current=await harness(feedWith([near126]),trip,{initialFeedAgeMs:31000});
 assert.equal(h.watcher.status().run,null);
 await h.poll(approaching,[near126]);
 assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
 assert.deepEqual(await h.journeys(),[]);
});

test('a seeded trip with empty service waits until its line has a bus',async()=>{
 const h=current=await harness(feedWith([]));
 assert.equal(h.watcher.status().run,null);
 assert.deepEqual(await h.journeys(),[]);
 await h.poll(approaching,[near126]);
 assert.equal(h.watcher.status().run.phase,'waiting');
});
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
 // Keep receiving live data: this case tests the missing-row backoff,
 // independently of the no-response freshness guard.
 for(let i=0;i<11;i++){vi.setSystemTime(Date.now()+10000);await g.feed([red317]);await g.watcher.tick();}
 assert.equal(g.geo.length,1);
 assert.deepEqual((await g.events()).map(e=>e.kind),['selection-unavailable']);
 vi.setSystemTime(Date.now()+10000);await g.feed([red317]);g.rowShown=true;await g.watcher.tick();
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
const busesAt=route_id=>rows=>rows.map(([bus_name,lat,lon,stationary,at_stop_id,last_stop_id,observed_at,last_moved_at])=>({bus_name,route_id,lat,lon,stationary,last_stop_id,...(at_stop_id==null?{}:{at_stop_id}),...(observed_at==null?{}:{observed_at}),...(last_moved_at==null?{}:{last_moved_at})}));
const purpleAt=busesAt(10);
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
  vi.setSystemTime(Date.parse(at)-10000);await h.poll(cards[card],purpleAt(rows),{receiptDelayMs:9999});
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
// Blue Weekend #44, 2026-10-04 (recorded by the rider riding it): it stood 57 m
// short of Broadway / York, then from 15:37:17Z 7 m past the pole with
// last_stop_id already Broadway / York and at_stop_id Elm / York, held that
// fix to 15:37:42Z and left. The app read BOARD🚌 with no bus line there; this
// replay uses the fixture's named cards ("🚌 #44 · 1 stop away"), the next one
// the app's own.
const york44=JSON.parse(await fs.readFile(new URL('./__fixtures__/blue-weekend-44-broadway-york-2026-10-04.json',import.meta.url),'utf8'));
const york44FeedOf=buses=>({buses,routes:{4:york44.route.stops},route_paths:{4:york44.route.path},stop_names:york44.route.stop_names,stop_coords:york44.route.stop_coords});
async function waitAtYork(cardOf){
 const c=york44.route.stop_coords,blueWeekend={label:'Blue Weekend',busRouteIds:[4]};
 const yorkTrip={kind:'random',origin:{label:'Broadway / York',...c[21],stopId:21},destination:{display_name:'Prospect / Edwards',...c[101],stopId:101}};
 const [first,...rest]=york44.polls;
 const h=current=await harness(york44FeedOf(busesAt(4)(first[3])),yorkTrip,{initialLine:blueWeekend,feedOf:york44FeedOf,text:york44.cards[cardOf(first)],at:first[0]});
 for(const poll of rest){
  vi.setSystemTime(Date.parse(poll[0])-10000);await h.poll(york44.cards[cardOf(poll)],busesAt(4)(poll[3]));
  if(h.watcher.status().run?.phase!=='waiting')break;
 }
 return h;
}
test('replay: #44 standing 7 m past Broadway / York with the neighbouring stop is boarded once its fix holds still',async()=>{
 const h=await waitAtYork(([,,named])=>named);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');
 assert.equal(run.busName,'#44');
 // 15:37:22Z: the fix had just changed, so it is skipped as moving past.
 assert.equal(run.pastStopSamples,1);
 assert.equal(run.boardedAt,'2026-10-04T15:37:32.842Z');
 assert.equal(Math.round(run.lastBoardDistanceM),7);
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 assert.equal(run.excludeAccuracy,undefined);
});
// riderneighbourstop20261005: the app's own cards for that wait read
// BOARD🚌Broadway/York with no bus line from 15:37:02Z, while #44 stood 57 m
// short, then 7 m from the pole with at_stop_id still Elm / York. A rider at
// the stop gets on; the runner had no followed bus on any of those polls.
test('replay: the app\'s BOARD🚌 card with no bus line boards #44 standing 7 m from Broadway / York',async()=>{
 const h=await waitAtYork(([,app])=>app);
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'riding');
 assert.equal(run.busName,'#44');
 assert.equal(run.boardedAt,'2026-10-04T15:37:32.842Z');
 assert.equal(Math.round(run.lastBoardDistanceM),7);
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 // 15:37:02Z and 15:37:12Z standing 57 m short, 15:37:22Z just moved there.
 assert.equal(run.unnamedBusSamples,3);
 assert.equal(run.pastStopSamples,undefined);
 assert.equal(run.excludeAccuracy,undefined);
});

// riderwrongcurb20261006: the selected College/Wall (S) occurrence is 15
// route hops from (N), despite poles only 28 m apart. The actual card says
// #47 is 16 stops away when the old proximity arm boards at (N), 39 m from
// (S). Replay every recorded waiting poll, not a replacement gate.
const wrongCurb47=JSON.parse(await fs.readFile(new URL('./__fixtures__/orange-47-opposite-curb-2026-10-06.json',import.meta.url),'utf8'));
const wrongCurbFeed=buses=>({buses,routes:{14:wrongCurb47.route.stops},stop_names:wrongCurb47.route.stop_names,stop_coords:wrongCurb47.route.stop_coords});
test('replay: a named bus standing at the opposite route occurrence is not proximity-boarded',async()=>{
 const [first,...rest]=wrongCurb47.polls;
 const h=current=await harness(wrongCurbFeed(first.buses),wrongCurb47.trip,{initialLine:wrongCurb47.line,feedOf:wrongCurbFeed,text:first.text,at:wrongCurb47.startedAt});
 for(const p of rest){vi.setSystemTime(Date.parse(p.at)-10000);await h.poll(p.text,p.buses);}
 const run=h.watcher.status().run;
 assert.equal(run?.phase,'waiting');
 assert.equal(run.busName,'#47');
 assert.equal(run.boardStopId,42);
 assert.equal(run.boardedAt,undefined);
 assert.deepEqual(h.clicks,[]);
 assert.equal(run.harnessErrors,undefined);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const rejected=events.filter(e=>e.kind==='waiting-bus-opposite-curb');
 assert.equal(rejected.length,1);
 assert.equal(rejected[0].at,'2026-10-06T03:20:05.730Z');
 assert.equal(rejected[0].detail.atStopId,41);
 // Missing the old false boarding is not a newly measured ride/arrival.
 assert.deepEqual(await h.journeys(),[]);
});

// The archived producer crossed within16m between the rider's46m/60m polls.
// The intermediate HTTP delivery is modeled; original response receipts were
// not stored. The regression must use only frames actually delivered here.
const arrivalGap=JSON.parse(await fs.readFile(new URL('./__fixtures__/red-317-arrival-between-ticks-2026-10-16.json',import.meta.url),'utf8'));
const arrivalFeed=buses=>({...red,buses,stop_coords:{...red.stop_coords,72:{lat:arrivalGap.stop.lat,lon:arrivalGap.stop.lon}}});
async function arrivalRider(){
 const from={kind:'fixed',origin:{label:'Division / Prospect',...red.stop_coords[48],stopId:48},destination:{display_name:arrivalGap.stop.name,lat:arrivalGap.stop.lat,lon:arrivalGap.stop.lon,stopId:72}};
 const h=current=await harness(arrivalFeed([red317]),from,{initialLine:{label:'Red',busRouteIds:[3]},feedOf:arrivalFeed,text:'🚌 #317 · 1 stop away\nBOARDDivision/Prospect\nGET OFFLEPH/60 College',at:new Date(Date.parse(arrivalGap.boardedAt)-10000).toISOString()});
 await h.poll('🚌 14 min\nBOARD🚌Division/Prospect⏸ 0:21\nGET OFFLEPH/60 College',[{...red317,...red.stop_coords[48],stationary:true,at_stop_id:48}]);
 assert.equal(h.watcher.status().run.phase,'riding');
 h.receive=async(frame,bus=frame.bus)=>{vi.setSystemTime(frame.receivedAt);await h.handlers.response(rawResponse(Buffer.from(JSON.stringify(arrivalFeed([bus])))));};
 return h;
}
test('a qualifying arrival received between rider ticks survives a later moving feed',async()=>{
 const h=await arrivalRider();await h.receive(arrivalGap.before);vi.setSystemTime(Date.parse(arrivalGap.before.tickAt));await h.watcher.tick();assert.equal(h.watcher.status().run.phase,'riding');
 await h.receive(arrivalGap.middle);await h.receive(arrivalGap.after);vi.setSystemTime(Date.parse(arrivalGap.after.tickAt));await h.watcher.tick();
 const run=h.watcher.status().run;assert.equal(run.phase,'arrived');assert.equal(run.arrivedAt,new Date(arrivalGap.middle.receivedAt).toISOString());
 assert.equal(run.arrivalObservation.bus.observed_at,arrivalGap.middle.bus.observed_at);assert.equal(run.arrivalObservation.bus.bus_id,67807);assert.equal(run.arrivalObservation.stopId,72);assert(run.arrivalObservation.distanceM<16);assert.equal(run.arrivalCriterion,'GPS-within-45m');
 assert.deepEqual(h.geo,{latitude:arrivalGap.middle.bus.lat,longitude:arrivalGap.middle.bus.lon});
 assert.equal(run.arrivalObservation.feedResponse.state,'captured');
 assert.equal(run.arrivalObservation.feedResponse.receivedAt,arrivalGap.middle.receivedAt);
 assert.equal(run.arrivalObservation.feedResponse.sourceKind,'page-response');
 const bodyRows=(await fs.readFile(path.join(h.dir,run.arrivalObservation.feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse);
 const arrivalBody=bodyRows.find(row=>row.id===run.arrivalObservation.feedResponse.id);
 assert.deepEqual(JSON.parse(verifyFeedResponseRecord(arrivalBody)).buses,[arrivalGap.middle.bus]);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);const arrived=events.filter(e=>e.kind==='arrived');assert.equal(arrived.length,1);assert.deepEqual(arrived[0].detail.observation,run.arrivalObservation);
});
test.each(['not-delivered','other-bus','other-route','early','invalid','stale-observation','future-observation','invalid-board-clock'])('the receipt buffer does not infer arrival from %s',async mode=>{
 const h=await arrivalRider();await h.receive(arrivalGap.before);
 if(mode!=='not-delivered'){
  const frame=structuredClone(arrivalGap.middle);
  if(mode==='other-bus')frame.bus.bus_name='#310';if(mode==='other-route')frame.bus.route_id=10;
  if(mode==='early')frame.receivedAt=Date.parse(arrivalGap.boardedAt)+30000;
  if(mode==='invalid-board-clock')h.watcher.status().run.boardedAt='invalid';
  if(mode==='invalid')frame.bus.lat=null;
  if(mode==='stale-observation')frame.bus.observed_at=frame.receivedAt-30001;
  if(mode==='future-observation')frame.bus.observed_at=frame.receivedAt+5001;
  await h.receive(frame);
 }
 await h.receive(arrivalGap.after);vi.setSystemTime(Date.parse(arrivalGap.after.tickAt));await h.watcher.tick();assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.arrivalObservation,undefined);
});

test('the existing stationary-at-target60m rule can retain the first qualifying receipt',async()=>{
 const h=await arrivalRider();const frame=structuredClone(arrivalGap.after);frame.bus.stationary=true;frame.bus.at_stop_id=72;
 await h.receive(frame);await h.receive({...frame,receivedAt:frame.receivedAt+5000,bus:{...frame.bus,lat:arrivalGap.stop.lat,lon:arrivalGap.stop.lon}});
 await h.watcher.tick();const run=h.watcher.status().run;assert.equal(run.phase,'arrived');assert.equal(run.arrivalCriterion,'stationary-at-target-within-60m');assert.equal(run.arrivedAt,new Date(frame.receivedAt).toISOString());assert(run.arrivalObservation.distanceM>59);
});
test('a destination receipt survives a busy UI read and keeps its processing clock causal',async()=>{
 const h=await arrivalRider();await h.receive(arrivalGap.before);vi.setSystemTime(Date.parse(arrivalGap.before.tickAt));
 let release;h.page.locator=()=>({innerText:()=>new Promise(resolve=>{release=resolve;})});const tick=h.watcher.tick();assert.equal(h.watcher.status().busy,true);
 await h.receive(arrivalGap.middle);await h.receive(arrivalGap.after);release('Red #317 has moved on');await tick;
 const run=h.watcher.status().run;assert.equal(run.phase,'arrived');assert.equal(run.arrivedAt,new Date(arrivalGap.middle.receivedAt).toISOString());assert(Date.parse(run.arrivalProcessedAt)>=Date.parse(run.arrivedAt));
 const samples=(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert(samples.at(-1).feedAgeMs>=0);
 assert.equal(run.arrivalTextContext.feedStableDuringTextRead,false);
 assert.equal(run.arrivalTextContext.matchesArrivalResponse,false);
 assert.equal(run.arrivalTextContext.feedResponse.id,samples.at(-1).feedResponse.id);
});

test('Purple308 arrival text keeps its earlier screen response when arrival lands41ms later',async()=>{
 const f=JSON.parse(await fs.readFile(new URL('./__fixtures__/purple-308-arrival-screen-20261023.json',import.meta.url),'utf8'));
 const raw=Buffer.from(JSON.stringify(f.before.feed));
 const h=current=await harness(f.before.feed,f.run.trip,{initialRun:f.run,initialLine:f.run.line,text:f.before.text,
  at:f.before.sampleAt,initialFeedAgeMs:Date.parse(f.before.sampleAt)-f.before.receivedAt,initialResponse:rawResponse(raw)});
 let delivered=false;
 const response={...rawResponse(raw),body:async()=>{
  if(!delivered){delivered=true;vi.setSystemTime(f.arrival.receivedAt);await h.handlers.response(rawResponse(Buffer.from(JSON.stringify(f.arrival.feed))));}
  return raw;
 }};
 vi.setSystemTime(f.before.receivedAt);await h.handlers.response(response);vi.setSystemTime(Date.parse(f.before.sampleAt));
 await h.watcher.tick();const run=h.watcher.status().run;
 assert.equal(run.phase,'arrived');assert.equal(run.arrivedAt,new Date(f.arrival.receivedAt).toISOString());
 assert.equal(run.arrivalText,f.before.text);assert.ok(run.arrivalTextContext);
 assert.equal(run.arrivalTextContext.sampledAt,f.before.sampleAt);
 assert.equal(run.arrivalTextContext.feedReceivedAt,new Date(f.before.receivedAt).toISOString());
 assert.equal(run.arrivalTextContext.feedStableDuringTextRead,true);
 assert.equal(run.arrivalTextContext.matchesArrivalResponse,false);
 const records=(await fs.readFile(path.join(h.dir,run.arrivalTextContext.feedResponse.file),'utf8')).trim().split('\n').map(JSON.parse);
 const screen=records.find(r=>r.id===run.arrivalTextContext.feedResponse.id),arrival=records.find(r=>r.id===run.arrivalObservation.feedResponse.id);
 assert.deepEqual(JSON.parse(verifyFeedResponseRecord(screen)),f.before.feed);
 assert.deepEqual(JSON.parse(verifyFeedResponseRecord(arrival)),f.arrival.feed);
 const samples=(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(run.arrivalTextContext.feedResponse.id,samples.at(-1).feedResponse.id);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.find(e=>e.kind==='arrived').detail.screen,run.arrivalTextContext);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dir,'resume.json'),'utf8')).run.arrivalTextContext,run.arrivalTextContext);
});

test('arrival text identifies a matching receipt only when both captured identities match',async()=>{
 const h=await arrivalRider();await h.receive(arrivalGap.middle);await h.watcher.tick();const run=h.watcher.status().run;
 assert.equal(run.phase,'arrived');assert.equal(run.arrivalTextContext.matchesArrivalResponse,true);
 assert.equal(run.arrivalTextContext.feedResponse.id,run.arrivalObservation.feedResponse.id);
});

test('unavailable screen and arrival bodies keep their match unknown',async()=>{
 const h=await arrivalRider();vi.setSystemTime(arrivalGap.middle.receivedAt);
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>arrivalFeed([arrivalGap.middle.bus])});
 await h.watcher.tick();const run=h.watcher.status().run;assert.equal(run.phase,'arrived');
 assert.equal(run.arrivalObservation.feedResponse.state,'unavailable');
 assert.equal(run.arrivalTextContext.feedResponse.state,'unavailable');
 assert.equal(run.arrivalTextContext.matchesArrivalResponse,null);
});


test('Blue58 waits through the earlier nearby route occurrence, then boards the real pickup',async()=>{
 const capture=JSON.parse(await fs.readFile(new URL('../__fixtures__/blue-weekend-58-pickup-occurrence-2026-10-17.json',import.meta.url),'utf8'));
 let sample=capture.samples[0];
 const feedOf=buses=>({...capture.feedMetadata,buses,server_eta:sample.server_eta});
 const h=current=await harness(feedOf([sample.bus]),capture.trip,{initialLine:capture.line,feedOf,text:sample.text,at:sample.at});
 for(const next of capture.samples.slice(1)){
  sample=next;vi.setSystemTime(Date.parse(sample.at)-10000);await h.poll(sample.text,[sample.bus],{receiptDelayMs:9999});
  assert.equal(h.watcher.status().run.phase,'waiting',sample.at);
 }
 assert.deepEqual(h.clicks,[]);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.kind==='waiting-bus-other-occurrence').length,1);
 assert(h.watcher.status().run.otherOccurrenceSamples>0);
 assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
 // Model a later legitimate return to53. It is a control, not a historical screen receipt.
 const now=Date.parse(sample.at)+15*60000;
 vi.setSystemTime(now-10000);
 sample={...sample,server_eta:{v:2,at:now,servedAt:now,buses:[['58','Blue Weekend',24,{stopId:53,standingSec:15,approach:false}]]}};
 const bus={...sample.bus,...capture.feedMetadata.stop_coords[53],at_stop_id:53,stationary:true,observed_at:now};
 await h.poll('🚌 6 min\nBOARD🚌Elm / York (TYCO)⏸ 0:15\nGET OFFProspect / Edwards',[bus],{receiptDelayMs:9999});
 assert.equal(h.watcher.status().run.phase,'riding');
 assert.deepEqual(h.clicks,["🚌 I'm on it"]);
});


test('manual boarding fallback rechecks a changed pickup occurrence after capture',async()=>{
 const capture=JSON.parse(await fs.readFile(new URL('../__fixtures__/blue-weekend-58-pickup-occurrence-2026-10-17.json',import.meta.url),'utf8'));
 let sample=capture.samples.at(-1);
 const feedOf=buses=>({...capture.feedMetadata,buses,server_eta:sample.server_eta});
 const h=current=await harness(feedOf([sample.bus]),capture.trip,{initialLine:capture.line,feedOf,text:sample.text,at:sample.at});
 h.page.evaluate=async()=>null;
 let changed=false;
 h.page.screenshot=async()=>{
  if(!changed){changed=true;h.text=sample.text;await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf([sample.bus])});}
  return Buffer.from('jpg');
 };
 const at=Date.now();
 const bus={...sample.bus,...capture.feedMetadata.stop_coords[53],at_stop_id:53,stationary:true,observed_at:at};
 await h.poll('🚌 6 min\nBOARD🚌Elm / York (TYCO)⏸ 0:15\nGET OFFProspect / Edwards',[bus]);
 assert.equal(h.watcher.status().run,null);
 assert.deepEqual(h.clicks,[]);
 assert.equal((await h.journeys())[0].result,'boarding-missed-excluded');
});

const blueExitFixture=JSON.parse(await fs.readFile(new URL('./__fixtures__/blue-exit-instruction-20261015.json',import.meta.url),'utf8'));
async function blueExitHarness(){
 const line={label:'Blue Day',busRouteIds:[1]},from={lat:41.323205,lon:-72.917287},to=blueExitFixture.stopCoords[39];
 const feedOf=buses=>({buses:buses.map(b=>({...b,observed_at:Date.now()})),routes:{1:[140,39]},stop_names:{140:'Whitney / Linden',39:'College / George'},stop_coords:{140:from,39:to}});
 const trip={kind:'fixed',origin:{label:'Whitney / Linden',...from,stopId:140},destination:{display_name:'College / George',...to,stopId:39}};
 const at='2026-10-15T16:07:55.558Z',initial=feedOf([{bus_name:'#40',route_id:1,...from,stationary:true,at_stop_id:140}]);initial.buses[0].observed_at=Date.parse(at);
 const h=current=await harness(initial,trip,{initialLine:line,feedOf,text:'BOARD🚌Whitney/Linden\nGET OFFCollege/George',at});
 assert.equal(h.watcher.status().run.phase,'riding');h.watcher.status().run.boardedStorage=structuredClone(blueExitFixture.run.boardedStorage);
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.samples=async()=>(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 h.feedOf=feedOf;h.bad=async(i=0)=>h.poll(blueExitFixture.samples[i].text,blueExitFixture.samples[i].buses);
 return h;
}
test('the real rider reports the sustained Blue exit instruction once and keeps the journey running',async()=>{
 const h=await blueExitHarness();await h.bad(0);assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,0);
 await h.bad(1);await h.bad(2);
 const events=(await h.events()).filter(e=>e.kind==='candidate-exit-instruction');assert.equal(events.length,1);
 assert.equal(events[0].detail.exitStopId,39);assert(events[0].detail.firstWitness.distanceM>135);assert(events[0].detail.distanceM>135);
 assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
 const samples=await h.samples();assert.deepEqual(samples.at(-1).rideContext.exitCoords,blueExitFixture.stopCoords[39]);assert.equal(samples.at(-1).rideContext.feedStableDuringTextRead,true);
});
test('a feed replaced during text sampling resets exit-instruction confirmation',async()=>{
 const h=await blueExitHarness();await h.bad(0);
 const locator=h.page.locator;h.page.locator=()=>({innerText:async()=>{
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>h.feedOf(blueExitFixture.samples[1].buses)});return h.text;
 }});
 await h.bad(1);h.page.locator=locator;assert.equal(h.watcher.status().run.exitInstructionConflict,null);
 assert.equal((await h.samples()).at(-1).rideContext.feedStableDuringTextRead,false);
 assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,0);
 await h.bad(1);assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,0);
 await h.bad(2);assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,1);
 assert.equal(h.watcher.status().run.harnessErrors,undefined);
});
test('a stale feed interrupts exit-instruction confirmation before a fresh recovery',async()=>{
 const h=await blueExitHarness();await h.bad(0);vi.setSystemTime(Date.now()+21000);await h.watcher.tick();
 assert.equal(h.watcher.status().run.exitInstructionConflict,null);
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>h.feedOf(blueExitFixture.samples[1].buses)});
 await h.watcher.tick();assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,0);
 assert.equal(h.watcher.status().run.phase,'riding');assert.equal(h.watcher.status().run.harnessErrors,undefined);
});
test('the real rider accepts the fixed off-pole screen without an arrival-instruction candidate',async()=>{
 const h=await blueExitHarness();for(const s of blueExitFixture.samples)await h.poll(s.text.replaceAll('Get off here','Watch for your stop').replaceAll('Arriving at College/George','Watch for College/George'),s.buses);
 assert.equal((await h.events()).filter(e=>e.kind==='candidate-exit-instruction').length,0);assert.equal(h.watcher.status().run.phase,'riding');
});


test('the real rider loop raises one candidate for a sustained missing map pause',async()=>{
 const coords={10:{lat:41.303254,lon:-72.934247},2:{lat:41.306539,lon:-72.933001},114:{lat:41.315675,lon:-72.920859}};
 const bus={bus_name:'#57',route_id:14,...coords[10],at_stop_id:10,stationary:true};
 const feedOf=buses=>({buses:buses.map(b=>({...b,observed_at:Date.now()})),routes:{14:[10,2,114]},stop_names:{10:'333 Cedar',2:'129 York',114:'Whitney / Sachem'},stop_coords:coords,server_eta:{v:2,at:Date.now(),servedAt:Date.now(),buses:[['57','Orange Night',0,{stopId:10,standingSec:601,approach:false}]],rows:[[0,2,300,120,540,1,0,120,120]]}});
 const trip={kind:'fixed',origin:{label:'129 York',...coords[2],stopId:2},destination:{display_name:'Whitney / Sachem',...coords[114],stopId:114}};
 const text='🚌 #57 · 1 stop away\nBOARD129 York\nGET OFFWhitney / Sachem';
 const h=current=await harness(feedOf([bus]),trip,{initialLine:{label:'Orange Night',busRouteIds:[14]},feedOf,text});
 h.maps=[{markers:[{name:'Orange Night #57'}],labels:[]}];
 for(let i=0;i<3;i++)await h.poll(text,[bus]);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.kind==='candidate-map-pause').length,1);
 assert.equal(h.watcher.status().run.phase,'waiting');
 h.maps=[{markers:[{name:'Orange Night #57. Waiting 10:01.'}],labels:[{text:'Orange Night #57 Stopped 10:01 · departure time unavailable',visible:true}]}];
 await h.poll(text,[bus]);
 assert.deepEqual(h.watcher.status().run.mapPauseConflicts,{});
 // A new response arriving during the actual DOM await must reset the episode.
 h.maps=[{markers:[{name:'Orange Night #57'}],labels:[]}];
 await h.poll(text,[bus]);
 const locator=h.page.locator;
 h.page.locator=()=>({innerText:async()=>h.text,evaluateAll:async()=>{
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf([bus])});
  return h.maps;
 }});
 await h.poll(text,[bus]);h.page.locator=locator;
 assert.deepEqual(h.watcher.status().run.mapPauseConflicts,{});
 assert.equal(h.watcher.status().run.mapPauseAudit.reason,'feed-replaced-during-read');
 const count=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.kind==='candidate-map-pause').length;
 assert.equal(await count(),1);
 await h.poll(text,[bus]);assert.equal(await count(),1);
 await h.poll(text,[bus]);assert.equal(await count(),2);
 assert.equal(h.watcher.status().run.harnessErrors,undefined);
});


test('phase-aligned fresh feeds get a settled map check instead of skipping forever',async()=>{
 const coords={10:{lat:41.303254,lon:-72.934247},2:{lat:41.306539,lon:-72.933001},114:{lat:41.315675,lon:-72.920859}};
 const bus={bus_name:'#57',route_id:14,...coords[10],at_stop_id:10,stationary:true};
 const feedOf=buses=>({buses:buses.map(b=>({...b,observed_at:Date.now()})),routes:{14:[10,2,114]},stop_names:{10:'333 Cedar',2:'129 York',114:'Whitney / Sachem'},stop_coords:coords,server_eta:{v:2,at:Date.now(),servedAt:Date.now(),buses:[['57','Orange Night',0,{stopId:10,standingSec:601,approach:false}]],rows:[[0,2,300,120,540,1,0,120,120]]}});
 const trip={kind:'fixed',origin:{label:'129 York',...coords[2],stopId:2},destination:{display_name:'Whitney / Sachem',...coords[114],stopId:114}};
 const text='🚌 #57 · 1 stop away\nBOARD129 York\nGET OFFWhitney / Sachem';
 const h=current=await harness(feedOf([bus]),trip,{initialLine:{label:'Orange Night',busRouteIds:[14]},feedOf,text,initialFeedAgeMs:2000,fakeTimeouts:true});
 h.maps=[{markers:[{name:'Orange Night #57'}],labels:[]}];
 for(let i=0;i<2;i++){
  vi.setSystemTime(Date.now()+10000);
  await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf([bus])});
  const tick=h.watcher.tick();
  // Let the old immediate sample finish, or the corrected sampler reach its
  // bounded settling wait, before advancing the clock.
  for(let n=0;n<2000&&h.watcher.status().busy&&vi.getTimerCount()<2;n++)await new Promise(r=>setImmediate(r));
  await vi.advanceTimersByTimeAsync(1100);await tick;
  assert.equal(h.watcher.status().run.mapPauseAudit.checked,1,'every aligned tick must eventually inspect its long pause');
 }
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.kind==='candidate-map-pause').length,1);
});


test('a packet received during the settling wait replaces the boarding snapshot',async()=>{
 const coords={10:{lat:41.303254,lon:-72.934247},2:{lat:41.306539,lon:-72.933001},114:{lat:41.315675,lon:-72.920859}};
 const bus={bus_name:'#57',route_id:14,...coords[10],at_stop_id:10,stationary:true};let stop=10;
 const feedOf=buses=>({buses:buses.map(b=>({...b,observed_at:Date.now()})),routes:{14:[10,2,114]},stop_names:{10:'333 Cedar',2:'129 York',114:'Whitney / Sachem'},stop_coords:coords,server_eta:{v:2,at:Date.now(),servedAt:Date.now(),buses:[['57','Orange Night',0,stop===null?null:{stopId:stop,standingSec:601,approach:false}]],rows:[[0,2,300,120,540,1,0,120,120]]}});
 const trip={kind:'fixed',origin:{label:'129 York',...coords[2],stopId:2},destination:{display_name:'Whitney / Sachem',...coords[114],stopId:114}};
 const text='🚌 #57 · 1 stop away\nBOARD129 York\nGET OFFWhitney / Sachem';
 const h=current=await harness(feedOf([bus]),trip,{initialLine:{label:'Orange Night',busRouteIds:[14]},feedOf,text,initialFeedAgeMs:2000,fakeTimeouts:true});
 h.maps=[{markers:[{name:'Orange Night #57'}],labels:[]}];stop=2;
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf([{...bus,...coords[2],at_stop_id:2}])});
 const tick=h.watcher.tick();
 for(let n=0;n<2000&&h.watcher.status().busy&&vi.getTimerCount()<2;n++)await new Promise(r=>setImmediate(r));
 await vi.advanceTimersByTimeAsync(500);stop=null;
 const departed={...bus,lat:coords[2].lat+0.001,lon:coords[2].lon,at_stop_id:undefined,stationary:false,last_stop_id:2,last_moved_at:new Date().toISOString()};
 h.text=text.replace('1 stop','2 stops');
 await h.handlers.response({url:()=>'https://example.test/api/buses',ok:()=>true,json:async()=>feedOf([departed])});
 await vi.advanceTimersByTimeAsync(600);await tick;
 assert.equal(h.watcher.status().run.phase,'waiting');assert.deepEqual(h.clicks,[]);
 const samples=(await fs.readFile(path.join(h.dir,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(samples.at(-1).buses[0].lat,departed.lat);assert(samples.at(-1).mapPauseAudit.renderWaitMs>0);
 assert.equal(h.watcher.status().run.harnessErrors,undefined);
});


test.each(['recorded','contradictory-BOARD-marker'])('Purple329 follows the selected pickup visit instead of an earlier station encounter (%s)',async mode=>{
 const capture=JSON.parse(await fs.readFile(new URL('./__fixtures__/purple-329-pickup-visit-20261018.json',import.meta.url),'utf8'));
 let sample=capture.samples[0];const feedOf=buses=>({...capture.feedMetadata,buses,server_eta:sample.server_eta});
 // The second mode is a modeled contradictory decoration, separate from the
 // unchanged historical text. A pending visit conflict must override it too.
 const textOf=text=>mode==='recorded'?text:text.replace(/(^|\n)BOARD/,'$1BOARD🚌');
 const h=current=await harness(feedOf([sample.bus]),capture.trip,{initialLine:capture.line,feedOf,text:textOf(sample.text),at:sample.at});
 for(const next of capture.samples.slice(1)){
  sample=next;vi.setSystemTime(Date.parse(sample.at)-10000);await h.poll(textOf(sample.text),[sample.bus],{receiptDelayMs:9999});
  assert.equal(h.watcher.status().run.phase,'waiting',sample.at);
 }
 assert.deepEqual(h.clicks,[]);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const conflicts=events.filter(e=>e.kind==='waiting-bus-other-occurrence');assert.equal(conflicts.length,1);assert.equal(conflicts[0].detail.reason,'pickup-still-ahead');
 // Modeled later current-visit control, not a recovered outbound screen:
 // the natural journey had already boarded on the first encounter.
 const now=Date.parse(sample.at)+24*60000;vi.setSystemTime(now-10000);
 sample={...sample,server_eta:{v:2,at:now,servedAt:now,buses:[['329','Purple',4,{stopId:127,standingSec:20,approach:false}]]}};
 const bus={...sample.bus,...capture.feedMetadata.stop_coords[127],observed_at:now,stationary:true,at_stop_id:127};
 await h.poll('BOARD🚌West Haven Train Station⏸ 0:20\nGET OFFBuilding 400',[bus],{receiptDelayMs:9999});
 assert.equal(h.watcher.status().run.phase,'riding');assert.deepEqual(h.clicks,["🚌 I'm on it"]);
 assert.equal(h.watcher.status().run.excludeAccuracy,undefined);
});

const requestRow={routeLabel:'Purple',stopId:122,visible:true,text:'On request. Call Dispatch: 203-281-5470 · option 1',callLinks:['tel:+12032815470'],hasPickupTime:false,hasNextTime:false,hasDestinationTime:false};
const missingRequestRow={...requestRow,text:'About <1 min',callLinks:[],hasPickupTime:true};
const requestClock='2026-10-23T19:20:38.703Z';
async function serviceWatch(rows,text=approaching){
 const feed=feedWith([near126]);
 return current=await harness(feed,trip,{at:requestClock,text,initialResponse:rawResponse(JSON.stringify(feed)),pickupRows:rows});
}
async function freshServicePoll(h,text=approaching){
 vi.advanceTimersByTime(6000);
 const feed=feedWith([{...near126,observed_at:Date.now()}]);
 await h.handlers.response(rawResponse(JSON.stringify(feed)));
 vi.advanceTimersByTime(4000);
 do await new Promise(r=>setImmediate(r));while(h.watcher.status().busy);
}
test('missing request disclosure is detected without trusting product service metadata',async()=>{
 const h=await serviceWatch([missingRequestRow]);assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.excludeAccuracy,true);assert.deepEqual(h.clicks,[]);
 await freshServicePoll(h);
 const [journey]=await h.journeys();assert.equal(journey.result,'on-demand-request-required-excluded');assert.equal(journey.boardedAt,undefined);
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),alerts=events.filter(e=>e.kind==='candidate-pickup-service');assert.equal(alerts.length,1);
 assert.equal(alerts[0].detail.observations.length,2);assert.notEqual(alerts[0].detail.observations[0].feedResponse.id,alerts[0].detail.observations[1].feedResponse.id);
 assert.deepEqual(journey.pickupServiceObservation,alerts[0].detail);assert.deepEqual(h.clicks,[]);
 const bodies=(await fs.readFile(path.join(h.dir,'feed-responses',journey.id+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 for(const o of alerts[0].detail.observations)assert(bodies.some(r=>r.id===o.feedResponse.id&&verifyFeedResponseRecord(r)));
});
test('correct instructions without the product service marker are excluded without an incident',async()=>{
 const h=await serviceWatch([requestRow]);const [journey]=await h.journeys();assert.equal(journey.result,'on-demand-request-required-excluded');
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert(!events.some(e=>e.kind==='candidate-pickup-service'));assert.deepEqual(h.clicks,[]);
});
test('request disclosure recovery before confirmation does not invent an incident',async()=>{
 const h=await serviceWatch([missingRequestRow]);h.pickupRows=[requestRow];await freshServicePoll(h);
 assert.equal((await h.journeys())[0].result,'on-demand-request-required-excluded');
 const events=(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert(!events.some(e=>e.kind==='candidate-pickup-service'));
});
test('an unreadable selected row remains explicitly unassessed and cannot board',async()=>{
 const h=await serviceWatch([{...requestRow,stopId:121}]);const [journey]=await h.journeys();assert.equal(journey.result,'on-demand-request-required-excluded');assert.equal(journey.pickupServiceAudit.state,'unassessed');assert.deepEqual(h.clicks,[]);
});

async function selectPurpleService({text=approaching,rows=[missingRequestRow],markers=[]}={}){
 vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});vi.setSystemTime(Date.parse(requestClock));
 const h={dir:await fs.mkdtemp(path.join(os.tmpdir(),'rider-service-select-')),text,rows,markers,handlers:{},opened:[]};
 const page={on:(k,f)=>{h.handlers[k]=f;},off:()=>{},reload:async()=>{},screenshot:async()=>Buffer.from('jpg'),
  locator:selector=>({innerText:async()=>h.text,evaluateAll:async()=>selector==='tbody[data-route][data-pickup]'?h.rows:selector==='tbody[data-pickup-service="on-demand"]'?h.markers:[]}),
  keyboard:{press:async k=>h.opened.push(k)},waitForFunction:async()=>{},evaluate:async()=>({toLL:{lat:b400.lat,lon:b400.lon}}),
  getByPlaceholder:()=>({fill:async()=>{},press:async()=>{}}),
  getByRole:(_,{name})=>({isVisible:async()=>name==='View Purple trip details',click:async()=>{},focus:async()=>h.opened.push(name)})};
 h.watcher=await attach({page,ctx:{setGeolocation:async()=>{}},initialFeed:feedWith([near126]),initialFeedAt:Date.now(),outputDir:h.dir,autoTick:false,allowedLabels:['Purple'],fixedTrip:trip});
 h.events=async()=>(await fs.readFile(path.join(h.dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);current=h;return h;
}
test('selection keeps a malformed request-only disclosure for confirmation instead of trusting its marker',async()=>{
 const h=await selectPurpleService({markers:[{routeLabel:'Purple',stopId:122,text:'On request'}]});assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.excludeAccuracy,true);assert.equal(h.watcher.status().run.pickupServiceDiagnostic,true);
 assert(!(await h.events()).some(e=>e.kind==='selection-on-demand-request-required'));
});
test('selection skips a correct request disclosure even if the product marker is missing',async()=>{
 const h=await selectPurpleService({rows:[requestRow]});assert.equal(h.watcher.status().run,null);assert.equal((await h.events()).filter(e=>e.kind==='selection-on-demand-request-required').length,1);
});
test('selection binds request service to the displayed BOARD stop rather than another row of the same route',async()=>{
 const h=await selectPurpleService({text:'🚌 #126\nBOARDWest Haven Train Station\nGET OFFBuilding 400',rows:[requestRow],markers:[{routeLabel:'Purple',stopId:122,text:'Other pickup'}]});
 assert.equal(h.watcher.status().run.phase,'waiting');assert.equal(h.watcher.status().run.excludeAccuracy,undefined);assert(!(await h.events()).some(e=>e.kind==='selection-on-demand-request-required'));
});
