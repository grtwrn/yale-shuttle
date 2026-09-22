/** Hosted only. No fit, scoring, finalized visit input or EOF closure. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {replay} from './replay.ts';

const here=new URL('.',import.meta.url).pathname, out=here+'results/';
const rawDir=here+'../k-sweep/results/', canon=here+'canonical/canonical-windows/results/';
const sha=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const write=(name:string,rows:any[])=>fs.writeFileSync(out+name+'.jsonl.gz',zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'));
const key=(r:any)=>JSON.stringify([r.at,r.bus,r.route,r.target]);
const pins:any={
  [rawDir+'raw_positions.jsonl.gz']:'3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9',
  [rawDir+'predictions_log.jsonl.gz']:'5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de',
  [canon+'canonical-topology.json']:'eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc',
  [canon+'preparation.json']:'2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d',
  [canon+'features.jsonl.gz']:'b2268eb15fc913a5c5cbf039d2dfbb8d518eefe25e6149776f7a930bd2eb5bb3',
  [canon+'unscored.jsonl.gz']:'4eb4f2d24429d948e282670c213a807a32eb3858f235b2ded48168cd78c31312',
  [canon+'forecasts.jsonl.gz']:'d529819058df9477132a7918aac372bd970f7551a0190aa19b634f4c77d3b6c3',
};
fs.mkdirSync(out,{recursive:true});
for(const[p,h]of Object.entries(pins))assert.equal(sha(p),h,p);
const top=JSON.parse(fs.readFileSync(canon+'canonical-topology.json','utf8'));
const waits=JSON.parse(fs.readFileSync(canon+'preparation.json','utf8')).waits;
const net=TransitNetwork.build(top.stops,top.routes);
for(const r of top.routes)assert.deepEqual(net.routes.get(r.id)!.stops,r.stops);
const cutoff=Date.parse('2026-09-16T04:00:00Z');
const predictions=read(rawDir+'predictions_log.jsonl.gz').filter(p=>p.predicted_at>=cutoff).sort((a,b)=>a.predicted_at-b.predicted_at);
const names=new Set(predictions.map(p=>p.bus_name));
const raw=read(rawDir+'raw_positions.jsonl.gz').filter(r=>r.collected_at>=cutoff-3600000&&names.has(r.bus_name)).sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
const dedup=new Map<string,any>();
for(const p of predictions){const k=[p.predicted_at,p.bus_name,p.route_id,p.to_stop_id].join('|');if(!dedup.has(k)||p.surface==='trip')dedup.set(k,p);}
const preds=[...dedup.values()].sort((a,b)=>a.predicted_at-b.predicted_at);
const full=replay(net,top,waits,raw,preds);
const reference=read(canon+'features.jsonl.gz');
assert.deepEqual(full.rows,reference,'observer changed original features');
const byKey=new Map(full.rows.map(r=>[key(r),r]));assert.equal(byKey.size,full.rows.length);
const audit:any={descriptiveOnly:true,planSha256:sha(here+'PLAN.md'),inputHashes:Object.fromEntries(Object.entries(pins).map(([p,h])=>[p.replace(here,'').replace(rawDir,'k-sweep/'),h])),
  originalFeaturesExact:full.rows.length,originalForecastInputJoins:0,originalLabelledForecastInputJoins:0,
  rawRows:raw.length,rawConsumed:full.rawConsumed,forecastRows:preds.length,prefixChecks:[],
  modelFits:0,newScores:0,newLabels:0,eofClosureCalls:0,
  prefixContract:'Delete all raw and prediction rows after cutoff; preserve original fixed cohort bus-name membership, input ordering and one-hour start.'};
const expectedModelKeys=new Set(full.rows.filter(r=>r.at>=Date.parse('2026-09-17T04:00:00Z')).map(key));
for(const file of ['unscored','forecasts']){
 const seen=new Set<string>();
 for(const r of read(canon+file+'.jsonl.gz')){
  const f=byKey.get(key(r));assert(f);
  assert(expectedModelKeys.has(key(r)));assert(!seen.has(key(r)));seen.add(key(r));
  for(const field of Object.keys(f))assert.deepEqual(r[field],f[field],file+': '+field);
  audit[file==='unscored'?'originalForecastInputJoins':'originalLabelledForecastInputJoins']++;
 }
 if(file==='unscored')assert.deepEqual(seen,expectedModelKeys);
}
assert.equal(audit.originalForecastInputJoins,expectedModelKeys.size);
audit.originalFeatureOnlyWarmupRows=full.rows.length-expectedModelKeys.size;
// Save observer output only after the independent pinned original control passes.
write('features-control',full.rows);write('diagnostics',full.diagnostics);
write('emissions',full.observer.emissions);write('resets',full.observer.resets);
write('identity-transitions',full.observer.transitions);write('track-changes',full.observer.trackChanges);
const prefixValues=[.25,.5,.75].map(q=>preds[Math.floor(preds.length*q)].predicted_at);
for(const end of prefixValues){
  const prefixRaw=raw.filter(r=>r.collected_at<=end),prefixPreds=preds.filter(p=>p.predicted_at<=end);
  const prefix=replay(TransitNetwork.build(top.stops,top.routes),top,waits,prefixRaw,prefixPreds);
  assert.deepEqual(prefix.rows,full.rows.filter(r=>r.at<=end));
  assert.deepEqual(prefix.diagnostics,full.diagnostics.filter(r=>r.at<=end));
  assert.deepEqual(prefix.observer.emissions,full.observer.emissions.filter(e=>e.knownAt<=end));
  assert.deepEqual(prefix.observer.resets,full.observer.resets.filter(e=>e.at<=end));
  assert.deepEqual(prefix.observer.transitions,full.observer.transitions.filter(e=>e.at<=end));
  audit.prefixChecks.push({at:end,rawRows:prefixRaw.length,predictionRows:prefixPreds.length,features:prefix.rows.length,
    diagnosticRows:prefix.diagnostics.length,emissions:prefix.observer.emissions.length,exact:true});
  console.log(JSON.stringify(audit.prefixChecks.at(-1)));
}
for(const[p,h]of Object.entries(pins))assert.equal(sha(p),h,'mutated input '+p);
audit.routes=Object.fromEntries(top.routes.map((route:any)=>[route.id,{name:route.name,features:full.rows.filter(r=>r.route===route.id).length}]));
audit.emissions=full.observer.emissions.length;audit.strictPhysicalEmissions=full.observer.emissions.filter(e=>e.physical).length;
audit.resets=full.observer.resets.length;audit.identityTransitions=full.observer.transitions.length;
fs.writeFileSync(out+'verification.json',JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
