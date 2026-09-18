/** Paired exact HEAD shell/helper and candidate, identical available inputs. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { reprice as before } from './shell-head.generated.mts';
import { reprice as after } from './shell-candidate.generated.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-8';
const B=O.replace('review-round-8','cycle-5/traversal-guard');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {compareDeadline}=await load('arriveBy.ts');
const {deadlineMessage}=await load('arriveByMessage.ts');
const {stableTripOrder}=await load('tripRanking.ts');
const payload=read(B+'/calibration-payload.json');
const original=gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse).find(f=>f.at===1789561481036);
const sample=fs.readFileSync(B+'/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse).find(r=>r.at===original.at&&r.session==='57454:48:0');
const scenarios=[{walk:0,low:150},{walk:100,low:150},{walk:100,low:100},{walk:119,low:150},
  {walk:121,low:150},{walk:150,low:150},{walk:100,low:150,approaching:true},
  {walk:100,low:150,missingDestination:true}];
const realNow=Date.now;Date.now=()=>original.at;
const cases=[];
try{
 for(const scenario of scenarios){
  const frame=structuredClone(original), {walk,low}=scenario;
  for(const [i,row] of frame.server_eta.rows.entries()){
   if(frame.server_eta.buses[row[0]][0]==='309'&&row[1]===121&&row[5]===1){
    row[2]=200;row[3]=low;row[4]=300;row[7]=200;row[8]=low;
    frame.server_eta.distributions[i]=Array.from({length:50},(_,k)=>low+k*(300-low)/49);
   }
  }
  if(scenario.missingDestination){
   const keep=frame.server_eta.rows.map((r:any,i:number)=>i).filter((i:number)=>frame.server_eta.rows[i][1]!==48);
   frame.server_eta.rows=keep.map((i:number)=>frame.server_eta.rows[i]);
   frame.server_eta.distributions=keep.map((i:number)=>frame.server_eta.distributions[i]);
  }
  if(scenario.approaching)for(const bus of frame.buses)if(bus.bus_name.replace(/^#/,'')==='309')delete bus.at_stop_id;
  const wire=JSON.stringify(frame.server_eta);
  const buses=frame.buses.filter((b:any)=>isBusInService(b,frame.at));assert.ok(attachServerEta(buses,frame.server_eta,frame.at));
  const from={...sample.from,lat:sample.from.lat+walk*1.1/6371000*180/Math.PI};
  const stable=sample.stable.map((o:any)=>o.mode==='shuttle'?{...o,walkToSec:walk}:o);
  const baseline=before(stable,buses,payload,from,sample.to),candidate=after(stable,buses,payload,from,sample.to);
  const base=baseline.options.find((o:any)=>o.mode==='shuttle'),head=candidate.options.find((o:any)=>o.mode==='shuttle');
  const rawBranch=!scenario.approaching&&walk<=120;
  if(scenario.missingDestination){assert.equal(base.journeyArrival,undefined);assert.equal(head.journeyArrival,undefined);}
  else{
   assert.equal(base.journeyArrival.catchRisk,false);
   assert.equal(head.journeyArrival.catchRisk,rawBranch&&walk>0);
   assert.deepEqual(head,{...base,journeyArrival:{...base.journeyArrival,catchRisk:rawBranch&&walk>0}});
  }
  assert.deepEqual(candidate.trace,baseline.trace);
  assert.deepEqual(stableTripOrder(candidate.options,null,frame.at).state,stableTripOrder(baseline.options,null,frame.at).state);
  assert.equal(head.busEtaSec,rawBranch?0:200);
  assert.equal(head.busName,base.busName);assert.equal(head.totalSec,base.totalSec);
  const deadline=(option:any)=>compareDeadline([option],frame.at+90*60_000,5,frame.at,frame.at,false);
  const oldAdvice=deadline(base),newAdvice=deadline(head);
  if(scenario.missingDestination)assert.equal(newAdvice.shuttle.status,'unknown');
  else{
   assert.equal(newAdvice.shuttle.status,'fits');
   assert.equal(!!newAdvice.shuttle.caution,rawBranch&&walk>0);
   assert.equal(newAdvice.recommendation?.option.mode,rawBranch&&walk>0?undefined:'shuttle');
   assert.equal(deadlineMessage(newAdvice,{}).kind,rawBranch&&walk>0?'connection':'recommendation');
   assert.equal(oldAdvice.recommendation.option.mode,'shuttle');
  }
  assert.equal(JSON.stringify(frame.server_eta),wire);
  cases.push({scenario,base,head,before:oldAdvice,after:newAdvice});
 }
}finally{Date.now=realNow;}
fs.writeFileSync(O+'/risk-logic.json',JSON.stringify({cases,scope:'Synthetic pickup/walk boundaries over a recorded current state. Exact HEAD shell and journey helper versus candidate. No observed walking-outcome or incidence claim.'},null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,destinationAndPickupValuesUnchanged:true,rankingUnchanged:true,rawWalkingCautionPreserved:true}));
