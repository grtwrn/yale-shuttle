/** Replay actual recorded served observations, preserving the server across watcher sessions. */
import fs from 'node:fs';import {pathToFileURL}from'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const {ServerEta}=await import(pathToFileURL(root+'/src/server/serverEta.ts').href);
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
const base=payload('baseline-patch.json'),candidate=payload(process.env.CANDIDATE_PATCH??'normalized-patch.json');
const files=process.argv.slice(2);if(!files.length)throw Error('Supply JSONL frames');
const frames=files.flatMap(file=>fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
const arms=['baseline','candidate','baseline_unclamped','candidate_unclamped'];
let engines:any={},firstAt=0,last=0,segmentId=0;const perBus=new Map();const output=fs.openSync(dir+'/'+(process.env.REPLAY_NAME??'watcher')+'-pairs.jsonl','w');
let emitted=0,beliefChecks=0,changed=0;const gaps:any[]=[];let n=0;
for(const f of frames){
 const at=Date.parse(f.at);if(at===last)continue;
 if(!last||at-last>60000){engines=Object.fromEntries(arms.map(a=>[a,new ServerEta({routes:['Red']})]));firstAt=at;segmentId++;perBus.clear();gaps.push({at,gapMs:last?at-last:null});}
 const buses=f.buses.filter((b:any)=>b.route_id===3);const rowMap=new Map();
 for(const bus of buses){const old=perBus.get(bus.bus_name);if(!old||at-old.last>60000)perBus.set(bus.bus_name,{first:at,last:at});else old.last=at;}
 for(const arm of arms){
  const engine=engines[arm];if(arm.endsWith('_unclamped'))for(const e of engine.store.values())delete e.floors;
  const wire=engine.contribute({...((arm==='candidate'||arm==='candidate_unclamped')?candidate:base),buses},n,at);
  if(engine.stats().failures)throw Error('Server ETA failure');
  if(!wire)continue;
  for(const row of wire.rows){
   const[bi,target,eta,low,high,stopsAhead]=row;if(![48,4].includes(target)||stopsAhead<1||stopsAhead>=20)continue;
   const name='#'+wire.buses[bi][0],bus=buses.find((b:any)=>b.bus_name===name);if(!bus)throw Error('missing bus');
   const key=anchorKeyFor('Red',name),belief=engine.store.get(key)?.belief;
   const k=name+'|'+target+'|'+stopsAhead;
   if(!rowMap.has(k))rowMap.set(k,{at,bus:name,busId:bus.bus_id,route:3,target,stopsAhead,occurrence:0,segmentId,warmMs:at-perBus.get(name).first,observedAt:bus.observed_at??null,source:bus.at_stop_id??null,rested:belief?.rested,since:belief?.restSince,lead:belief?.lead,runId:f.runId??null});
   rowMap.get(k)[arm]={eta,low,high};
  }
 }
 for(const bus of buses){
  const key=anchorKeyFor('Red',bus.bus_name),a=engines.baseline.store.get(key)?.belief,b=engines.candidate.store.get(key)?.belief;
  if(a&&b){beliefChecks++;if(a.lead!==b.lead||a.restSince!==b.restSince||a.p.some((x:number,i:number)=>x!==b.p[i]))throw Error('Pricing arm changed tracking belief');}
 }
 for(const row of rowMap.values()){
  if(!arms.every(a=>row[a]))throw Error('Unpaired forecast');
  if(row.baseline.eta!==row.candidate.eta||row.baseline.high!==row.candidate.high)changed++;
  fs.writeSync(output,JSON.stringify(row)+'\n');emitted++;
 }
 last=at;n++;if(n%500===0)console.error(JSON.stringify({frames:n,emitted,changed}));
}
fs.closeSync(output);const meta={frames:n,emitted,changed,beliefChecks,gaps,params:params.version,priorCutoff:'2026-09-14T04:00:00Z',candidatePatch:process.env.CANDIDATE_PATCH??'normalized-patch.json',note:'Actual ServerEta output integer seconds; continuous within observed segments; no synthetic observations or watcher-run resets. Distributions/tables priorSep14; parameter version publishedbeforeSep16. Not original five-second production replay when watcher cadence is ten seconds.'};
fs.writeFileSync(dir+'/'+(process.env.REPLAY_NAME??'watcher')+'-meta.json',JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
