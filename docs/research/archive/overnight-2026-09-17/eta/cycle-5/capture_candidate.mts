/** Frozen current-production numerical baseline; outputs never feed forecast state. */
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=process.cwd(), archive='/home/gwarren/projects/yale-shuttle-watcher';
const out=archive+'/overnight-2026-09-17/eta/cycle-5';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(root+p).href);
const plan=read(out+'/PLAN.json');
for(const [p,h] of Object.entries(plan.hashes)) if(createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==h) throw Error('Frozen input mismatch: '+p);
const {ServerEta}=await load('/src/server/serverEta.ts');
const {setSampledFutureLap}=await load('/web/src/eta/arrival.ts');
const {setReleaseModelEnabled}=await load('/web/src/eta/release.ts');
const topology=read(archive+'/red-eta-data/payload.json');
const patch=read(archive+'/conditional-replay-data/baseline-patch.json');
const params=read(archive+'/conditional-replay-data/params.json');
const segments:any={},dwells:any={};
for(const [r,entries] of Object.entries(patch.segments) as any) segments[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{avg:0,n:0,...v}]));
for(const [r,entries] of Object.entries(patch.dwells) as any) dwells[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{med:0,n:0,...v}]));
for(const [r,v] of Object.entries(patch.pace) as any) (segments[r]??={}).__pace={avg:0,n:0,spm:v.spm,spmN:v.n};
dwells['3']['11'].release=read(archive+'/release-integration-data/runtime-fits-pre-sep10.json').fits.find((f:any)=>f.stopId===11);
const payload={routes:topology.routes,route_paths:topology.route_paths,stop_coords:topology.stop_coords,segments,dwells,model_params:params};
fs.writeFileSync(out+'/calibration-payload.json',JSON.stringify(payload)+'\n');
const original=new Map<string,any>();
for(const l of fs.readFileSync(out+'/../cycle-2/current-trace.jsonl','utf8').trim().split('\n')) {const r=JSON.parse(l); if(plan.windows.some((w:any)=>w.start<=r.at&&r.at<=w.end)) original.set(r.at+'|'+r.bus.replace(/^#/,''),r);}
setSampledFutureLap(true);setReleaseModelEnabled(true);
const output=fs.createWriteStream(out+'/fleet-wire.jsonl.gz');
const gzip=createGzip();gzip.pipe(output);
const endAt=Math.max(...plan.windows.map((w:any)=>w.end));
let engine:any, last=0,n=0,emitted=0,parity=0,quantileParity=0,segment=0,rows=0;
let perBus=new Map<string,any>();
const gaps:any[]=[], names=new Set<string>(), omissions:any[]=[];
const started=performance.now();
try {
 for(const line of fs.readFileSync(archive+'/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n')) {
  const frame=JSON.parse(line),at=Date.parse(frame.at);if(at>endAt)break;if(at===last)continue;
  if(!last||at-last>60000){engine=new ServerEta({routes:['Red']});perBus=new Map();segment++;gaps.push({at,gapMs:last?at-last:null});}
  const buses=frame.buses;
  for(const b of buses){if(b.route_id!==3)throw Error('Unexpected route');const prev=perBus.get(b.bus_name);if(!prev||at-prev.last>60000)perBus.set(b.bus_name,{first:at,last:at});else prev.last=at;names.add(b.bus_name);}
  const wire=engine.contribute({...payload,buses},n,at);
  if(engine.stats().failures)throw Error('Server failure');
  const contexts=plan.windows.filter((w:any)=>w.start<=at&&at<=w.end).map((w:any)=>w.sourceId);
  if(contexts.length){
   const record={at,contexts,segment,buses,server_eta:wire,warmMs:Object.fromEntries([...perBus].map(([b,s])=>[b,at-s.first]))};
   if(!gzip.write(JSON.stringify(record)+'\n'))await once(gzip,'drain');emitted++;rows+=wire?.rows.length??0;
  }
  last=at;n++;if(n%1000===0)console.error(JSON.stringify({frames:n,emitted,elapsedSec:(performance.now()-started)/1000}));
 }
}finally{gzip.end();await finished(output);}
if(omissions.length)throw Error('Unexpected old-row omissions '+omissions.length);
const meta={head:plan.head,frames:n,emitted,rows,parity,quantileParity,names:[...names],gaps,endAt,elapsedSec:(performance.now()-started)/1000,provenance:'Actual recorded GPS; reconstructed collector clocks. Current code/historical causal calibration. Candidate unchanged-hop pooling identity guard; paired with preserved current-production wires.'};
fs.writeFileSync(out+'/fleet-meta.json',JSON.stringify(meta,null,2)+'\n');console.log(JSON.stringify(meta));
