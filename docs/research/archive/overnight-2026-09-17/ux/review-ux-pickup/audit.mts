import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {reprice as baseline} from './baseline.generated.mts';
import {reprice as candidate} from './candidate.generated.mts';
const O=new URL('.',import.meta.url).pathname, A='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=(p:string)=>fs.readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const {stableTripOrder}=await load('tripRanking.ts');
const B=A+'cycle-5/traversal-guard/';
const payload=read(B+'calibration-payload.json');registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const frames=new Map(gunzipSync(fs.readFileSync(B+'fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const records=lines(B+'decisions.jsonl'), expected=lines(A+'cycle-6/ordered-decisions.jsonl'), census=lines(A+'cycle-10/pickup-census.jsonl');
const clean=(x:any)=>JSON.parse(JSON.stringify(x));
const strip=(o:any)=>{const {livePickupSelection,...rest}=o;return rest;};
const summary:any={pairedDecisions:0,pairedRankings:0,pairedTraces:0,oldProductionMatches:0,metadataMatches:0,inputFramesUnchanged:0,historical:{},missingDestination:{}};
const orders=[new Map(),new Map()], output=fs.openSync(O+'paired-metadata.jsonl','w');
let now=0;const realNow=Date.now;Date.now=()=>now;
try {
 for(let i=0;i<records.length;i++){
  const r=records[i];now=r.at;const frame=frames.get(now)!, before=JSON.stringify(frame);
  for(let arm=0;arm<2;arm++){
   const target=expected[i].option.alightStopId;
   const indices=frame.server_eta.rows.map((_:any,j:number)=>j).filter((j:number)=>!arm||frame.server_eta.rows[j][1]!==target);
   const wire=arm?{...frame.server_eta,rows:indices.map((j:number)=>frame.server_eta.rows[j]),distributions:indices.map((j:number)=>frame.server_eta.distributions[j])}:frame.server_eta;
   const buses=frame.buses.filter((b:any)=>isBusInService(b,now)).map((b:any)=>({...b}));assert.ok(attachServerEta(buses,wire,now));
   const base=baseline(r.stable,buses,payload,r.from,r.to), cand=candidate(r.stable,buses,payload,r.from,r.to);
   assert.deepEqual(clean(cand.options.map(strip)),clean(base.options));summary.pairedDecisions++;
   assert.deepEqual(clean(cand.trace),clean(base.trace));summary.pairedTraces++;
   const prior=orders[arm].get(r.session)??null;
   const rankBase=stableTripOrder(base.options,prior,now), rankCand=stableTripOrder(cand.options,prior,now);
   assert.deepEqual(clean(rankCand.state),clean(rankBase.state));orders[arm].set(r.session,rankBase.state);summary.pairedRankings++;
   const o=cand.options.find((v:any)=>v.mode==='shuttle');
   if(!arm){assert.deepEqual(clean(strip(o)),expected[i].option);assert.deepEqual(clean(cand.trace),expected[i].trace);assert.deepEqual(clean(rankCand.state),expected[i].order);summary.oldProductionMatches++;}
   // Independent expected data is the prior reviewed census, not the helper.
   const priorContract=census[i*2+arm].contract;
   const {routeLabel:unused,selectedAtMs:at,...boarding}=priorContract.boarding;
   const {routeLabel:unused2,selectedAtMs:at2,...countdown}=priorContract.countdown;
   const want={selectedAtMs:at,countdown,boarding,relation:priorContract.relation};
   assert.equal(at,at2);assert.deepEqual(o.livePickupSelection,want);summary.metadataMatches++;
   const key=arm?'missingDestination':'historical';summary[key][want.relation]=(summary[key][want.relation]??0)+1;
   fs.writeSync(output,JSON.stringify({arm:key,session:r.session,sourceId:r.sourceId,at:now,livePickupSelection:o.livePickupSelection,destinationAvailable:!!o.journeyArrival,totalSec:o.totalSec,waitSec:o.waitSec})+'\n');
  }
  assert.equal(JSON.stringify(frame),before);summary.inputFramesUnchanged++;
 }
}finally{Date.now=realNow;fs.closeSync(output);}
assert.equal(summary.pairedDecisions,9376);assert.equal(summary.metadataMatches,9376);
fs.writeFileSync(O+'audit-summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
