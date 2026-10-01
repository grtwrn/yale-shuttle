/** Frozen current-production numerical baseline; outputs never feed forecast state. */
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=process.cwd(), archive='/home/gwarren/projects/yale-shuttle-watcher';
const out=archive+'/overnight-2026-09-17/eta/cycle-4';
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


const {serialize}=await import('node:v8');
const window=plan.windows.find((w:any)=>w.sourceId===58224);
setSampledFutureLap(true);setReleaseModelEnabled(true);
const inputs:any[]=[];let engine:any,last=0,n=0,checkpoint:any=null;
for(const line of fs.readFileSync(archive+'/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n')){
 const f=JSON.parse(line),at=Date.parse(f.at);if(at>window.end)break;if(at===last)continue;
 if(!last||at-last>60000)engine=new ServerEta({routes:['Red']});
 if(at>=window.start&&!checkpoint){checkpoint=serialize({v:1,at:last,store:engine.store,seen:engine.seenAt});fs.writeFileSync(out+'/regression-warm.v8',checkpoint);}
 const wire=engine.contribute({...payload,buses:f.buses},n,at);
 if(engine.stats().failures)throw Error('Replay failed');
 if(at>=window.start)inputs.push({at,buses:f.buses,expected:wire});
 last=at;n++;
}
const restored=new ServerEta({routes:['Red']});restored.useCheckpoint({load:()=>checkpoint,save:()=>{}},inputs[0].at);
let matched=0;
for(const [i,f] of inputs.entries()){
 const got=restored.contribute({...payload,buses:f.buses},i,f.at);
 if(JSON.stringify(got)!==JSON.stringify(f.expected))throw Error('Warm restoration parity mismatch '+f.at);
 matched++;
}
fs.writeFileSync(out+'/regression-frames.json',JSON.stringify(inputs)+'\n');
const result={sourceId:58224,frames:inputs.length,prefixFrames:n,restoredBeliefs:restored.stats().restored,matched,checkpointBytes:checkpoint.length,zeroHopPositiveEtaRows:inputs.reduce((n:number,f:any)=>n+f.expected.rows.filter((r:any)=>r[1]===11&&r[5]===0&&r[2]>0).length,0)};
fs.writeFileSync(out+'/regression-fixture.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
