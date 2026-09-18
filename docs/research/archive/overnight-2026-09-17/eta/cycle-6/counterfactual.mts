import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {reprice as baseline} from './shell-baseline.generated.mts';
import {reprice as ordered} from './shell-ordered.generated.mts';
import {reprice as fallthrough} from './shell-fallthrough.generated.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6';
const B=O.replace('cycle-6','cycle-5/traversal-guard');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const {stableTripOrder}=await load('tripRanking.ts');
const payload=read(B+'/calibration-payload.json');registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const frames=new Map(gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const records=fs.readFileSync(B+'/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse);
const arms={baseline,ordered,fallthrough},orders=new Map(),fds:any={};
const summary:any={n:0,baselineExact:0,arms:{},scope:'Artifact-only numerical shell counterfactual; stable plans preserved, frozen observed wires, no tracker or forecast-row change. Actual rendered candidate not validated.'};
for(const arm of Object.keys(arms)){fds[arm]=fs.openSync(O+'/'+arm+'-decisions.jsonl','w');summary.arms[arm]={available:0,gained:0,lost:0,changed:0,busChanged:0,orderChanged:0,journeyBusDifferent:0};}
let now=0;const realNow=Date.now;Date.now=()=>now;
try{
 for(const r of records){
  now=r.at;const frame=frames.get(now)!;const buses=frame.buses.filter((b:any)=>isBusInService(b,now));assert.ok(attachServerEta(buses,frame.server_eta,now));
  const saved=r.options.map(({tier,slowerThanWalk,commuteSec,...o}:any)=>o);
  const original=saved.find((o:any)=>o.mode==='shuttle');
  for(const [arm,reprice] of Object.entries(arms)){
   const {options,trace}=reprice(r.stable,buses,payload,r.from,r.to);
   if(arm==='baseline'){assert.deepEqual(JSON.parse(JSON.stringify(options)),saved);assert.deepEqual(JSON.parse(JSON.stringify(trace)),r.trace);summary.baselineExact++;}
   const key=arm+'|'+r.session,ranked=stableTripOrder(options,orders.get(key)??null,now);orders.set(key,ranked.state);
   if(arm==='baseline')assert.deepEqual(JSON.parse(JSON.stringify(ranked.state)),r.order);
   const option=options.find((o:any)=>o.mode==='shuttle');const s=summary.arms[arm];
   const changed=JSON.stringify(option)!==JSON.stringify(original),orderChanged=ranked.state.order.join('|')!==r.order.order.join('|');
   s.available+=!!option.journeyArrival;s.gained+=!original.journeyArrival&&!!option.journeyArrival;s.lost+=!!original.journeyArrival&&!option.journeyArrival;
   s.changed+=changed;s.busChanged+=option.busName!==original.busName;s.orderChanged+=orderChanged;
   s.journeyBusDifferent+=!!option.journeyArrival&&option.busName!==option.journeyArrival.busName;
   assert.equal(option.boardStopId,original.boardStopId);assert.equal(option.alightStopId,original.alightStopId);assert.equal(option.plannedRideSec,original.plannedRideSec);
   fs.writeSync(fds[arm],JSON.stringify({session:r.session,sourceId:r.sourceId,at:now,option,trace,order:ranked.state,changed,orderChanged})+'\n');
  }
  summary.n++;
 }
}finally{Date.now=realNow;for(const fd of Object.values(fds))fs.closeSync(fd as number);}
assert.equal(summary.n,4688);assert.equal(summary.baselineExact,4688);
fs.writeFileSync(O+'/counterfactual-summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
