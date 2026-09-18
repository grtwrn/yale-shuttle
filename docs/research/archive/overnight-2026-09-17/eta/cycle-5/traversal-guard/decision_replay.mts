import fs from 'node:fs';
import {createGunzip} from 'node:zlib';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {reprice} from './shell-live.generated.mts';
const out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {planTrip,topVisibleOptions,keptThirdLabel,slowerThanWalk,commuteSec}=await load('planner.ts');
const {stableTripOrder,optionTier}=await load('tripRanking.ts');
const {attachServerEta,liveEtaAvailable}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const plan=read(out+'/PLAN.json'),payload=read(out+'/calibration-payload.json');
registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const sessions:any[]=[];
for(const w of plan.windows)for(const target of [48,4])for(const offset of [0,150]){
 const from={...payload.stop_coords[w.sourceStop]};
 if(offset)from.lon-=offset/(111320*Math.cos(from.lat*Math.PI/180));
 sessions.push({id:`${w.sourceId}:${target}:${offset}`,w,target,offset,from,to:payload.stop_coords[target],stable:null,order:null,third:null,roster:null,replans:0});
}
let now=0,n=0,rows=0,checks=0;const realNow=Date.now;Date.now=()=>now;
const fd=fs.openSync(out+'/decisions.jsonl','w');
const stream=fs.createReadStream(out+'/fleet-wire.jsonl.gz').pipe(createGunzip());
const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
try{
 for await(const line of lines){
  const frame=JSON.parse(line);now=frame.at;
  const buses=frame.buses.filter((b:any)=>isBusInService(b,now));
  const attached=attachServerEta(buses,frame.server_eta,now);
  const roster=buses.map((b:any)=>`${b.route_id}:${b.bus_name}`).sort().join(',')+`:${liveEtaAvailable(buses,now)}`;
  for(const s of sessions){if(now<s.w.start||now>s.w.end)continue;
   let reset=false;
   if(s.stable===null||(s.roster!==roster&&!s.stable.some((o:any)=>o.mode==='shuttle'))){s.stable=planTrip(s.from,s.to,buses,payload.routes,payload.stop_coords,payload.segments,payload.dwells,null,now);s.order=null;s.third=null;s.replans++;reset=true;}
   s.roster=roster;
   const result=reprice(s.stable,buses,payload,s.from,s.to);
   const ranked=stableTripOrder(result.options,s.order,now);s.order=ranked.state;
   const visible=topVisibleOptions(ranked.options,s.third);s.third=keptThirdLabel(visible);
   for(const o of result.options){
    const original=s.stable.find((x:any)=>x.routeLabel===o.routeLabel);
    if(o.boardStopId!==original.boardStopId||o.alightStopId!==original.alightStopId||o.plannedRideSec!==original.plannedRideSec)throw Error('Stable plan changed');
    if(o.journeyArrival){
     const j=result.trace.find((t:any)=>t.kind==='journey'&&t.available&&t.board?.busName===o.journeyArrival.busName);
     if(!j||j.destination.stopsAhead<=j.board.stopsAhead||j.destination.busName!==j.board.busName)throw Error('Identity/occurrence mismatch');
     if(Math.abs(o.totalSec-(j.destination.eta+o.walkFromSec))>1e-6)throw Error('Destination total mismatch');checks++;
    }
   }
   fs.writeSync(fd,JSON.stringify({session:s.id,sourceId:s.w.sourceId,sourceStop:s.w.sourceStop,target:s.target,offsetM:s.offset,from:s.from,to:s.to,at:now,segment:frame.segment,attached,warmMs:frame.warmMs,reset,replans:s.replans,stable:s.stable,options:result.options.map((o:any)=>({...o,tier:optionTier(o),slowerThanWalk:slowerThanWalk(o),commuteSec:commuteSec(o)})),trace:result.trace,order:s.order,visible:visible.map((o:any)=>o.routeLabel)})+'\n');rows++;
  }
  n++;
 }
}finally{Date.now=realNow;fs.closeSync(fd);lines.close();stream.destroy();}
const meta={frames:n,decisionRows:rows,sessions:sessions.length,journeyChecks:checks,replans:sessions.map(s=>({session:s.id,n:s.replans,stable:s.stable})),limits:'Mechanically extracted numerical live map, not actual-shell browser validation. Selected hypothetical stationary riders, Red-only archive, walking model only.'};
fs.writeFileSync(out+'/decision-meta.json',JSON.stringify(meta,null,2)+'\n');console.log(JSON.stringify({...meta,replans:meta.replans.map(({session,n}:any)=>({session,n}))}));
