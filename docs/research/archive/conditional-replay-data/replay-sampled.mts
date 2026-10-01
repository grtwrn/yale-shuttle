/** Replay actual recorded served observations, preserving the server across watcher sessions. */
import fs from 'node:fs';import {pathToFileURL}from'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const {setConditionalLapScope,setSampledFutureLap}=await import(pathToFileURL(root+'/web/src/eta/arrival.ts').href);
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
const base=payload('baseline-patch.json'),candidate=payload(process.env.CANDIDATE_PATCH??'normalized-patch.json');
const files=process.argv.slice(2);if(!files.length)throw Error('Supply JSONL frames');
const frames=files.flatMap(file=>fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
registerRoutePaths(topology.route_paths);applyModelParams(params);
let parityChecks=0;
class FocusEngine {
 store=new Map();observed=new Map();seen=new Map();
 contribute(payload:any,version:number,at:number){
  const buses=payload.buses.filter((b:any)=>b.observed_at===undefined||at-b.observed_at<ETA_MAX_AGE_MS).map((b:any)=>{const k=b.route_id+'|'+b.bus_name,old=this.observed.get(k);if(old&&b.observed_at!==undefined&&old.observed_at===b.observed_at)return old;this.observed.set(k,b);return b;});
  for(const b of buses)this.seen.set(anchorKeyFor('Red',b.bus_name),at);
  const arrivals=computeUpcomingArrivals([48,4],buses,payload.routes,payload.stop_coords,payload.segments,at,payload.dwells,this.store);
  for(const[k,t]of this.seen)if(at-t>600000){this.seen.delete(k);this.store.delete(k);}
  if(version%250===0){
   const server:any=new ServerEta({routes:['Red']});for(const[k,e]of this.store)server.store.set(k,structuredClone(e));
   const actual=server.contribute({...payload,buses},version,at);
   for(const a of arrivals){const bi=actual?.buses.findIndex((b:any)=>b[0]===a.busName),row=actual?.rows.find((r:any)=>r[0]===bi&&r[1]===a.stopId&&r[5]===a.stopsAhead);if(!row||row[2]!==Math.round(a.eta)||row[3]!==Math.round(a.low)||row[4]!==Math.round(a.high))throw Error('Target-scoped/full-server parity failure');parityChecks++;}
  }
  const names=[...new Set(arrivals.map((a:any)=>a.busName))];return {buses:names.map(n=>[n,'Red']),rows:arrivals.map((a:any)=>[names.indexOf(a.busName),a.stopId,a.eta,a.low,a.high,a.stopsAhead])};
 }
 stats(){return{failures:0};}
}
const arms=['baseline','candidate','sampled_marginal','sampled_conditional'];
let engines:any={},firstAt=0,last=0,segmentId=0;const perBus=new Map();const output=fs.openSync(dir+'/'+(process.env.REPLAY_NAME??'watcher')+'-pairs.jsonl','w');
let emitted=0,beliefChecks=0,changed=0;const gaps:any[]=[];let n=0;
for(const f of frames){
 const at=Date.parse(f.at);if(at===last)continue;
 if(!last||at-last>60000){engines=Object.fromEntries(arms.map(a=>[a,new FocusEngine()]));firstAt=at;segmentId++;perBus.clear();gaps.push({at,gapMs:last?at-last:null});}
 const buses=f.buses.filter((b:any)=>b.route_id===3);const rowMap=new Map();
 for(const bus of buses){const old=perBus.get(bus.bus_name);if(!old||at-old.last>60000)perBus.set(bus.bus_name,{first:at,last:at});else old.last=at;}
 for(const arm of arms){
  setConditionalLapScope('both');setSampledFutureLap(arm.startsWith('sampled_'));
  const engine=engines[arm];
  const wire=engine.contribute({...(['candidate','sampled_conditional'].includes(arm)?candidate:base),buses},n,at);
  if(engine.stats().failures)throw Error('Server ETA failure');
  if(!wire)continue;
  for(const row of wire.rows){
   const[bi,target,eta,low,high,stopsAhead]=row;if(![48,4].includes(target)||stopsAhead<1||stopsAhead>=20)continue;
   const name='#'+wire.buses[bi][0],bus=buses.find((b:any)=>b.bus_name===name);if(!bus)throw Error('missing bus');
   const key=anchorKeyFor('Red',name),belief=engine.store.get(key)?.belief;
   const k=name+'|'+target+'|'+stopsAhead;
   if(!rowMap.has(k))rowMap.set(k,{at,bus:name,busId:bus.bus_id,route:3,target,stopsAhead,occurrence:0,segmentId,warmMs:at-perBus.get(name).first,observedAt:bus.observed_at??null,source:bus.at_stop_id??null,rested:belief?.rested,since:belief?.restSince,lead:belief?.lead,runId:f.runId??null});
   rowMap.get(k)[arm]={eta,low:Math.max(0,low),high};
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
fs.closeSync(output);const meta={parityChecks,frames:n,emitted,changed,beliefChecks,gaps,params:params.version,priorCutoff:'2026-09-14T04:00:00Z',candidatePatch:process.env.CANDIDATE_PATCH??'normalized-patch.json',note:'Unrounded target-scoped estimator output with periodic full ServerEta parity checks; continuous within observed segments; no synthetic observations or watcher-run resets. Distributions/tables priorSep14; parameter version publishedbeforeSep16. Input raw frames are causal reconstructions at the actual recorded cadence, approximately five seconds; collector lacks prior-day seeds.'};
fs.writeFileSync(dir+'/'+(process.env.REPLAY_NAME??'watcher')+'-meta.json',JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
