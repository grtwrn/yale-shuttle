import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {reprice} from './shell-current.generated.mts';
import {pickupContract} from './pickup-contract.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10';
const B=O.replace('cycle-10','cycle-5/traversal-guard'), C=O.replace('cycle-10','cycle-6');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=(p:string)=>fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const {stableTripOrder}=await load('tripRanking.ts');
const {tripBusIdentity}=await load('tripBusIdentity.ts');
const payload=read(B+'/calibration-payload.json');registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const frames=new Map(gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const records=lines(B+'/decisions.jsonl'),expected=lines(C+'/ordered-decisions.jsonl'),orders=new Map();
const clean=(x:any)=>JSON.parse(JSON.stringify(x));
const summary:any={exactProductionDecisions:0,exactRankings:0,historical:{},missingDestination:{},inputRowsUnchanged:0,examples:{},scope:'4688 reused selected Red decisions; ablation is synthetic missing-target telemetry, not observed missing-data incidence or rider accuracy.'};
const cohorts:any={};
const output=fs.openSync(O+'/pickup-census.jsonl','w');
let now=0;const realNow=Date.now;Date.now=()=>now;
function count(arm:string, contract:any, record:any, option:any, baseline?:any) {
  const s=summary[arm],key=contract.status==='selected'?contract.relation:contract.reason;
  s[key]=(s[key]??0)+1;
  const group=cohorts[arm+'|'+key]??={sessions:new Set(),sources:new Set(),dates:new Set(),n:0};
  group.sessions.add(record.session);group.sources.add(record.sourceId);group.dates.add(new Date(now).toLocaleDateString('en-CA',{timeZone:'America/New_York'}));group.n++;
  const identity=tripBusIdentity(option);
  const wrongBus=contract.status==='selected'&&identity.ride!==contract.boarding.busName;
  if(wrongBus)s.presentedRideDiffersFromSelected=(s.presentedRideDiffersFromSelected??0)+1;
  if(contract.status==='selected'&&!contract.destinationAvailable)s.noDestination=(s.noDestination??0)+1;
  if(contract.relation==='raw-current'&&!contract.forecastLink)s.rawWithoutForecastLink=(s.rawWithoutForecastLink??0)+1;
  const exampleKey=arm+'|'+key+'|'+Boolean(contract.destinationAvailable);
  if(!summary.examples[exampleKey])summary.examples[exampleKey]={session:record.session,sourceId:record.sourceId,at:now,contract,identity,walkToSec:option.walkToSec,waitSec:option.waitSec,totalSec:option.totalSec};
  fs.writeSync(output,JSON.stringify({arm,session:record.session,sourceId:record.sourceId,at:now,contract,identity,wrongBus,walkToSec:option.walkToSec,waitSec:option.waitSec,totalSec:option.totalSec,...(baseline?{selectionSame:JSON.stringify(contract.boarding)===JSON.stringify(baseline.boarding)}:{})})+'\n');
}
try{
 for(let i=0;i<records.length;i++){
  const r=records[i],want=expected[i];now=r.at;const frame=frames.get(now)!;
  const inputBefore=JSON.stringify(frame);
  const buses=frame.buses.filter((b:any)=>isBusInService(b,now));assert.ok(attachServerEta(buses,frame.server_eta,now));
  const {options,trace}=reprice(r.stable,buses,payload,r.from,r.to);
  const option=options.find((o:any)=>o.mode==='shuttle');
  assert.deepEqual(clean(option),want.option);assert.deepEqual(clean(trace),want.trace);summary.exactProductionDecisions++;
  const ranked=stableTripOrder(options,orders.get(r.session)??null,now);orders.set(r.session,ranked.state);assert.deepEqual(clean(ranked.state),want.order);summary.exactRankings++;
  const contract=pickupContract(option,trace);count('historical',contract,r,option);
  // Remove only the already selected option's target rows, retaining aligned
  // distributions and all pickup occurrences. No outcome enters this edit.
  const keep=frame.server_eta.rows.map((_:any,j:number)=>j).filter((j:number)=>frame.server_eta.rows[j][1]!==option.alightStopId);
  const wire={...frame.server_eta,rows:keep.map((j:number)=>frame.server_eta.rows[j]),distributions:keep.map((j:number)=>frame.server_eta.distributions[j])};
  const ablatedBuses=buses.map((b:any)=>({...b}));assert.ok(attachServerEta(ablatedBuses,wire,now));
  const absent=reprice(r.stable,ablatedBuses,payload,r.from,r.to),absentOption=absent.options.find((o:any)=>o.mode==='shuttle');
  const absentContract=pickupContract(absentOption,absent.trace);
  count('missingDestination',absentContract,r,absentOption,contract);
  assert.equal(absentOption.journeyArrival,undefined);
  assert.equal(absentOption.busName,option.busName);assert.equal(absentOption.busEtaSec,option.busEtaSec);assert.equal(absentOption.waitSec,option.waitSec);
  assert.deepEqual(absentContract.boarding,contract.boarding);
  assert.equal(JSON.stringify(frame),inputBefore);summary.inputRowsUnchanged++;
 }
}finally{Date.now=realNow;fs.closeSync(output);}
assert.equal(summary.exactProductionDecisions,4688);
summary.cohorts=Object.fromEntries(Object.entries(cohorts).map(([k,v]:any)=>[k,{n:v.n,sessions:v.sessions.size,sources:v.sources.size,dates:[...v.dates]}]));
fs.writeFileSync(O+'/summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
