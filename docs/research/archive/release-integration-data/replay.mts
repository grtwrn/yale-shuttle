/** Replay actual recorded served observations, preserving the server across watcher sessions. */
import fs from 'node:fs';import {pathToFileURL}from'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const {setSampledFutureLap}=await import(pathToFileURL(root+'/web/src/eta/arrival.ts').href);
const {setReleaseFits,setReleaseExperiment}=await import(pathToFileURL(root+'/web/src/eta/release.ts').href);
const fitReport=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-window-data/release-survival-screen.json','utf8'));
const original=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-window-data/operating-pattern-screen.json','utf8'));
setReleaseFits(fitReport.fits.filter((f:any)=>f.arm==='hazard_age_lap_clock15').map((f:any)=>({stopId:f.stop,referenceLap:original.results.find((r:any)=>r.stop===f.stop).referenceLap,coefficients:f.coefficients})));
if(process.env.RELEASE_FITS)setReleaseFits(JSON.parse(fs.readFileSync(process.env.RELEASE_FITS,'utf8')).fits);
const outDir='/home/gwarren/projects/yale-shuttle-watcher/release-integration-data';
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
  if(version%1000===0){
   const server:any=new ServerEta({routes:['Red']});for(const[k,e]of this.store)server.store.set(k,structuredClone(e));
   const actual=server.contribute({...payload,buses},version,at);
   for(const a of arrivals){const bi=actual?.buses.findIndex((b:any)=>b[0]===a.busName),row=actual?.rows.find((r:any)=>r[0]===bi&&r[1]===a.stopId&&r[5]===a.stopsAhead);if(!row||row[2]!==Math.round(a.eta)||row[3]!==Math.round(a.low)||row[4]!==Math.round(a.high))throw Error('Target-scoped/full-server parity failure');parityChecks++;}
  }
  const names=[...new Set(arrivals.map((a:any)=>a.busName))];return {buses:names.map(n=>[n,'Red']),rows:arrivals.map((a:any)=>[names.indexOf(a.busName),a.stopId,a.eta,a.low,a.high,a.stopsAhead])};
 }
 stats(){return{failures:0};}
}
const arms=(process.env.RELEASE_ARMS??'baseline,clamped,current,full').split(',');
const configs:any={baseline:{current:false,future:false,unclamp:false},clamped:{current:true,future:false,unclamp:false},current:{current:true,future:false,unclamp:true},full:{current:true,future:true,unclamp:true},hazard:{current:true,future:false,unclamp:true,transition:true},shuffle:{current:true,future:false,unclamp:true,transition:true,shuffle:true},smoothed:{current:true,future:false,unclamp:true,smoothSec:30,freezeLap:true},smoothedUpper:{current:true,future:false,unclamp:true,smoothSec:30,freezeLap:true,rawBand:'upper'},smoothedRaw:{current:true,future:false,unclamp:true,smoothSec:30,freezeLap:true,rawBand:true},winchester:{current:true,future:false,unclamp:false,winchesterOnly:true}};
let engines:any={},firstAt=0,last=0,segmentId=0;const perBus=new Map();const output=fs.openSync(outDir+'/'+(process.env.REPLAY_NAME??'integrated')+'-pairs.jsonl','w');
let emitted=0,beliefChecks=0,changed=0;const unavailable:any=Object.fromEntries(arms.map(a=>[a,0]));const gaps:any[]=[];let n=0;
for(const f of frames){
 const at=Date.parse(f.at);if(at===last)continue;
 if(!last||at-last>60000){engines=Object.fromEntries(arms.map(a=>[a,new FocusEngine()]));firstAt=at;segmentId++;perBus.clear();gaps.push({at,gapMs:last?at-last:null});}
 const buses=f.buses.filter((b:any)=>b.route_id===3);const rowMap=new Map();
 for(const bus of buses){const old=perBus.get(bus.bus_name);if(!old||at-old.last>60000)perBus.set(bus.bus_name,{first:at,last:at});else old.last=at;}
 for(const arm of arms){
  setSampledFutureLap(true);setReleaseExperiment(configs[arm]);
  const engine=engines[arm];
  const wire=engine.contribute({...(arm!=='baseline'?candidate:base),buses},n,at);
  if(engine.stats().failures)throw Error('Server ETA failure');
  if(!wire)continue;
  for(const row of wire.rows){
   const[bi,target,eta,low,high,stopsAhead]=row;if(![48,4].includes(target)||stopsAhead<1||stopsAhead>=60)continue;
   const name='#'+wire.buses[bi][0],bus=buses.find((b:any)=>b.bus_name===name);if(!bus)throw Error('missing bus');
   const key=anchorKeyFor('Red',name),belief=engine.store.get(key)?.belief;
   const k=name+'|'+target+'|'+stopsAhead;
   if(!rowMap.has(k))rowMap.set(k,{at,bus:name,busId:bus.bus_id,route:3,target,stopsAhead,occurrence:0,segmentId,warmMs:at-perBus.get(name).first,observedAt:bus.observed_at??null,source:bus.at_stop_id??null,rested:belief?.rested,since:belief?.restSince,lead:belief?.lead,runId:f.runId??null});
   rowMap.get(k)[arm]={eta,low:Math.max(0,low),high};
  }
 }
 for(const bus of buses){
  const key=anchorKeyFor('Red',bus.bus_name),a=engines[arms[0]].store.get(key)?.belief,b=engines[arms.at(-1)].store.get(key)?.belief;
  if(a&&b&&!configs[arms.at(-1)].transition){beliefChecks++;if(a.lead!==b.lead||a.restSince!==b.restSince||a.p.some((x:number,i:number)=>x!==b.p[i]))throw Error('Pricing arm changed tracking belief');}
 }
 for(const row of rowMap.values()){
  for(const arm of arms)if(!row[arm]){unavailable[arm]++;row[arm]=null;}
  if(row.baseline&&row[arms.at(-1)]&&(row.baseline.eta!==row[arms.at(-1)].eta||row.baseline.high!==row[arms.at(-1)].high))changed++;
  fs.writeSync(output,JSON.stringify(row)+'\n');emitted++;
 }
 last=at;n++;if(n%500===0)console.error(JSON.stringify({frames:n,emitted,changed}));
}
fs.closeSync(output);const meta={arms,configs,unavailable,parityChecks,frames:n,emitted,changed,beliefChecks,gaps,params:params.version,priorCutoff:'2026-09-14T04:00:00Z',candidatePatch:process.env.CANDIDATE_PATCH??'normalized-patch.json',note:'Unrounded target-scoped estimator output with periodic full ServerEta parity checks; continuous within observed segments; no synthetic observations or watcher-run resets. Distributions/tables priorSep14; parameter version publishedbeforeSep16. Actual approximately five-second raw cadence. Includes both target occurrences; collector lacks prior-day seeds. Marginal tables unchanged; per-chain own-departure bridge fixed.'};
fs.writeFileSync(outDir+'/'+(process.env.REPLAY_NAME??'integrated')+'-meta.json',JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
