/** Hosted only. No fit, scoring, finalized visit input or EOF closure. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {replay} from './replay.ts';

const here=new URL('.',import.meta.url).pathname, out=here+'results/';
const rawDir=here+'../k-sweep/results/', canon=here+'../canonical-windows/results/';
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
const expected=read(canon+'features.jsonl.gz');
const audit:any={planSha256:sha(here+'PLAN.md'),inputHashes:pins,capChecks:{},prefixChecks:[],
 providerInterpretation:'Observed provider IDs only; not proven physical vehicle identity',eofClosureCalls:0};
const prefixes=[.25,.5,.75].map(q=>preds[Math.floor(preds.length*q)].predicted_at);
let control:any[]=[];
for(const cap of [45,90]){
 const full=replay(net,top,waits,raw,preds,cap);
 if(cap===45){assert.deepEqual(full.rows,expected);control=full.rows;}
 else for(let i=0;i<full.rows.length;i++){
  const a=control[i],b=full.rows[i];
  if(![9,10].includes(b.route))assert.deepEqual(b,a);
  for(const k of Object.keys(a).filter(k=>!['origins','releasedOrigins'].includes(k)))assert.deepEqual(b[k],a[k]);
  for(const [k,v]of Object.entries(a.origins))assert.deepEqual(b.origins[k],v);
 }
 write('features-cap'+cap,full.rows);write('provenance-cap'+cap,full.diagnostics);
 audit.capChecks[cap]={features:full.rows.length,strictRetainedOrigins:full.diagnostics.reduce((n,r)=>n+Object.keys(r.retainedPhysicalProofs).length,0),
  emissions:full.observer.emissions.length,rawConsumed:full.rawConsumed};
 for(const end of prefixes){
  const pr=raw.filter(r=>r.collected_at<=end),pp=preds.filter(p=>p.predicted_at<=end);
  const prefix=replay(TransitNetwork.build(top.stops,top.routes),top,waits,pr,pp,cap);
  assert.deepEqual(prefix.rows,full.rows.filter(r=>r.at<=end));
  assert.deepEqual(prefix.diagnostics,full.diagnostics.filter(r=>r.at<=end));
  audit.prefixChecks.push({cap,at:end,raw:pr.length,features:prefix.rows.length,exact:true});
 }
}
for(const[p,h]of Object.entries(pins))assert.equal(sha(p),h);
fs.writeFileSync(out+'feature-verification.json',JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
