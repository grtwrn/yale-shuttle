import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { reprice as current } from './shell-current.generated.mts';
import { reprice as diagnostic } from './shell-diagnostic.generated.mts';
const O=new URL('.',import.meta.url).pathname,P=O+'../',B=P+'cycle-5/traversal-guard/';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=(p:string)=>fs.readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const payload=read(B+'calibration-payload.json');registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const frames=new Map(gunzipSync(fs.readFileSync(B+'fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const wanted=new Set(read(P+'cycle-6/missing-cases.json').filter((c:any)=>c.causal.pickupRows[0].hops===29).map((c:any)=>`${c.session}|${c.at}`));
const key=(r:any)=>`${r.session}|${r.at}`;
const previous=Object.fromEntries(['ordered','fallthrough'].map(name=>[name,new Map(lines(P+`cycle-6/${name}-decisions.jsonl`).map(r=>[key(r),r]))]));
const clean=(a:any)=>JSON.parse(JSON.stringify(a));
const result:any[]=[];
let now=0;const real=Date.now;Date.now=()=>now;
try{
 for(const r of lines(B+'decisions.jsonl').filter(r=>wanted.has(key(r)))){
  now=r.at;const f=frames.get(now)!,before=JSON.stringify(f);
  const buses=f.buses.filter((b:any)=>isBusInService(b,now)).map((b:any)=>({...b}));assert.ok(attachServerEta(buses,f.server_eta,now));
  const paired=[];
  for(const [name,run] of [['ordered',current],['fallthrough',diagnostic]] as const){
   const actual=run(r.stable,buses,payload,r.from,r.to),old=previous[name].get(key(r));
   assert.deepEqual(clean(actual.options.find((o:any)=>o.mode==='shuttle')),old.option);
   assert.deepEqual(clean(actual.trace),old.trace);
   paired.push({arm:name,option:clean(actual.options.find((o:any)=>o.mode==='shuttle'))});
  }
  assert.equal(JSON.stringify(f),before);result.push({session:r.session,at:now,paired});
 }
}finally{Date.now=real;}
assert.equal(result.length,38);
fs.writeFileSync(O+'current-pairs.json',JSON.stringify({pairedDecisions:38,exactOptions:76,exactTraces:76,unchangedFrames:38,results:result},null,2)+'\n');
console.log('38 current-production/diagnostic pairs match saved options and traces exactly; every wire frame unchanged');
