/** Replay actual recorded served observations, preserving the server across watcher sessions. */
import fs from 'node:fs';import {pathToFileURL}from'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const {setSampledFutureLap}=await import(pathToFileURL(root+'/web/src/eta/arrival.ts').href);
const {ServerEta}=await import(pathToFileURL(root+'/src/server/serverEta.ts').href);
const {computeUpcomingArrivals}=await import(pathToFileURL(root+'/web/src/arrivals.ts').href);
const {registerRoutePaths}=await import(pathToFileURL(root+'/web/src/anchor.ts').href);
const {applyModelParams}=await import(pathToFileURL(root+'/web/src/eta/params.ts').href);
const {ETA_MAX_AGE_MS}=await import(pathToFileURL(root+'/web/src/etaSource.ts').href);
const {anchorKeyFor}=await import(pathToFileURL(root+'/web/src/liveAnchor.ts').href);
const topology=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/payload.json','utf8'));
const params=JSON.parse(fs.readFileSync(dir+'/params.json','utf8'));
function payload(file:string){
 const p=JSON.parse(fs.readFileSync(dir+'/'+file,'utf8'));const segments:any={},dwells:any={};
 for(const[r,entries]of Object.entries(p.segments)as any)segments[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{avg:0,n:0,...v}]));
 for(const[r,entries]of Object.entries(p.dwells)as any)dwells[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{med:0,n:0,...v}]));
 for(const[r,v]of Object.entries(p.pace)as any)(segments[r]??={}).__pace={avg:0,n:0,spm:v.spm,spmN:v.n};
 return {routes:topology.routes,route_paths:topology.route_paths,stop_coords:topology.stop_coords,segments,dwells,model_params:params};
}
const base=payload('baseline-patch.json'),candidate=payload('baseline-patch.json');
const frames=fs.readFileSync(dir+'/raw-frames.jsonl','utf8').trim().split('\n').slice(3000,3300).map(JSON.parse);
registerRoutePaths(topology.route_paths);applyModelParams(params);
const summary:any={};
for(const on of [false,true]){
 setSampledFutureLap(on);const engine=new ServerEta({routes:['Red']});const times:number[]=[];let rows=0;
 for(let i=0;i<frames.length;i++){
  const f=frames[i],at=Date.parse(f.at);const started=performance.now();const wire=engine.contribute({...base,buses:f.buses},i,at);const ms=performance.now()-started;
  if(i>=100){times.push(ms);rows+=wire?.rows.length??0;}
 }
 times.sort((a,b)=>a-b);summary[on?'candidate':'baseline']={n:times.length,rows,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1),failures:engine.stats().failures};
}
fs.writeFileSync(dir+'/joint-full-server-benchmark.json',JSON.stringify(summary,null,2));console.log(summary);
