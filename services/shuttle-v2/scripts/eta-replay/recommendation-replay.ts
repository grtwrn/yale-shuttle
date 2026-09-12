/** Recorded-feed recommendation comparison; no browser or independent arrival truth.
 * Usage: tsx recommendation-replay.ts CAPTURE PAYLOAD BASELINE_SERVICE_ROOT OUTPUT */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {computeUpcomingArrivals} from '../../web/src/arrivals';
import {rideBoardArrivals,boardingVisitAllowed,boardingVisitConflict,pickLiveArrival,planTrip,MAX_RIDE_SEC,dwellBoardWindowSec} from '../../web/src/planner';
import {ROUTE_LISTS,mergedRouteStops,BUS_SPEED_M_S} from '../../web/src/routes';
import {haversineMeters} from '../../web/src/geo';
import {registerRoutePaths} from '../../web/src/anchor';
import {applyModelParams} from '../../web/src/eta/params';
import {beliefFor,ringForBus,type AnchorStore} from '../../web/src/eta';
import {anchorKeyFor} from '../../web/src/liveAnchor';
const [capture,payload,baselineRoot,output]=process.argv.slice(2);
if(!capture||!payload||!baselineRoot||!output)throw new Error('Usage: CAPTURE PAYLOAD BASELINE_SERVICE_ROOT OUTPUT');
fs.mkdirSync(output,{recursive:true});
const hash=(s:string)=>crypto.createHash('sha256').update(fs.readFileSync(s)).digest('hex');
const git=(root:string)=>execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const provenance={baseline:git(baselineRoot),candidate:git(process.cwd()),candidateDirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim().length>0,sourceHashes:Object.fromEntries(['web/src/planner.ts','web/src/TransitMap.tsx','scripts/eta-replay/recommendation-replay.ts'].map(f=>[f,hash(path.resolve(f))]))};
const base:any=JSON.parse(fs.readFileSync(payload,'utf8'));
const load=async(rel:string)=>import(pathToFileURL(path.join(baselineRoot,rel)).href);
const oldPlan=await load('web/src/planner.ts'),oldAnchor=await load('web/src/anchor.ts'),oldParams=await load('web/src/eta/params.ts');
registerRoutePaths(base.route_paths);applyModelParams(base.model_params);
oldAnchor.registerRoutePaths(base.route_paths);oldParams.applyModelParams(base.model_params);
const focus=[3,9,10,16],store:AnchorStore=new Map(),stats:any={};
const pairs=new Map<number,number[][]>(),grid=new Map<number,number[][]>();
for(const rid of focus){
 const cfg=ROUTE_LISTS.find(c=>c.busRouteIds.includes(rid))!,seq=mergedRouteStops(cfg,base.routes),list:number[][]=[],seen=new Set<string>();
 for(let i=0;i<seq.length;i++){let ride=0;for(let h=1;h<seq.length;h++){
  const a=seq[(i+h-1)%seq.length]!,b=seq[(i+h)%seq.length]!,from=seq[i]!;
  const seg=base.segments[cfg.routeIds[0]!]?.[`${a}-${b}`];
  ride+=seg?.n>=1?seg.avg:Math.max(30,haversineMeters(base.stop_coords[a],base.stop_coords[b])/BUS_SPEED_M_S);
  if(ride>MAX_RIDE_SEC)break;const key=`${from}/${b}`;
  if(from!==b&&!seen.has(key)){seen.add(key);list.push([from,b]);}
 }}
 pairs.set(rid,list);const g=list.filter((_,i)=>i%Math.max(1,Math.floor(list.length/8))===0).slice(0,8);
 if(rid===10&&!g.some(p=>p[0]===127&&p[1]===22))g.push([127,22]);
 if(rid===3&&!g.some(p=>p[0]===48&&p[1]===72))g.push([48,72]);grid.set(rid,g);
 const counts=()=>({total:0,changed:0,lost:0,gained:0,busChanged:0,later:0,earlier:0,unexplained:0});
 stats[rid]={label:cfg.label,pairs:list.length,planPairs:g,frames:0,live:counts(),plan:counts(),examples:[]};
}
const changes=fs.openSync(path.join(output,'changes.jsonl'),'w'),planChanges=fs.openSync(path.join(output,'plan-changes.jsonl'),'w');
const norm=(s:string)=>s.replace(/^#/,'');
const pick=(visits:any[],buses:any[],cfg:any,board:number,alight:number,t:number,candidate:boolean)=>{
 const raw=visits.filter(a=>a.stopId===board),live=candidate?rideBoardArrivals(visits,board,alight):raw,pin=raw[0]?.busName??'';
 const here=buses.filter(b=>b.at_stop_id===board&&(!candidate||boardingVisitAllowed(b.bus_name,board,alight,visits)));
 const bus=here.find(b=>norm(b.bus_name)===norm(pin))??here[0];
 if(bus&&0<=dwellBoardWindowSec(bus,cfg.routeIds[0],board,base.dwells,t))return {bus:norm(bus.bus_name),eta:0};
 const p=pickLiveArrival(live,pin,0);return p&&!p.departed?{bus:p.match.busName,eta:p.match.eta}:null;
};
const compare=(a:any,b:any,s:any)=>{
 s.total++;if((!a&&!b)||(a&&b&&a.bus===b.bus&&Math.abs(a.eta-b.eta)<1&&a.board===b.board&&a.alight===b.alight))return false;
 s.changed++;if(a&&!b)s.lost++;else if(!a&&b)s.gained++;else{if(a.bus!==b.bus)s.busChanged++;if(b.eta>a.eta+1)s.later++;if(b.eta<a.eta-1)s.earlier++;}return true;
};
let prev=0,resets=0,processed=0,lastDecision=-1,lastPlan=-1;
const input=fs.readFileSync(capture,'utf8').trim().split('\n'),maxFrames=Number(process.env.MAX_FRAMES??Infinity),decisionMs=Number(process.env.DECISION_SEC??60)*1000;
for(const line of input){
 const f=JSON.parse(line);if(++processed>maxFrames)break;
 if(!Number.isFinite(f.t)||f.t<=prev)throw new Error('Non-monotone capture');
 if(prev&&f.t-prev>60000){store.clear();resets++;}prev=f.t;
 const decision=Math.floor(f.t/decisionMs)!==lastDecision,planning=Math.floor(f.t/900000)!==lastPlan;
 for(const rid of focus){
  const cfg=ROUTE_LISTS.find(c=>c.busRouteIds.includes(rid))!,buses=f.buses.filter((b:any)=>b.route_id===rid);if(!buses.length)continue;
  const seq=mergedRouteStops(cfg,base.routes);
  for(const bus of buses){const ring=ringForBus(bus,seq,base.stop_coords);if(ring)beliefFor(store,anchorKeyFor(cfg.label,bus.bus_name),bus,ring,ring.stops,f.t);}
  if(!decision)continue;stats[rid].frames++;
  const visits=computeUpcomingArrivals([...new Set(seq)],buses,base.routes,base.stop_coords,base.segments,f.t,base.dwells,store).filter(a=>a.routeLabel===cfg.label);
  for(const [board,alight] of pairs.get(rid)!){
   const a=pick(visits,buses,cfg,board!,alight!,f.t,false),b=pick(visits,buses,cfg,board!,alight!,f.t,true);
   if(compare(a,b,stats[rid].live)){
    const first=visits.filter(v=>v.stopId===board&&v.busName===a?.bus).sort((x,y)=>x.stopsAhead-y.stopsAhead)[0];
    const witness=first?boardingVisitConflict(first,visits,alight!):null;if(!witness)stats[rid].live.unexplained++;
    const row={at:f.at,route:rid,board,alight,before:a,after:b,why:witness?`bus ${a!.bus}: pickup hop ${first!.stopsAhead}, return hop ${witness.nextPickup.stopsAhead}, destination hop ${witness.destination.stopsAhead}`:'NO POSITIVE WITNESS',witness,bus:buses.find((x:any)=>norm(x.bus_name)===a?.bus)};
    fs.writeSync(changes,JSON.stringify(row)+'\n');if(stats[rid].examples.length<6)stats[rid].examples.push(row);
   }
  }
  if(planning){
   const routes=Object.fromEntries(cfg.routeIds.map(id=>[id,base.routes[id]]));
   for(const [board,alight] of grid.get(rid)!){
    const args=[base.stop_coords[board!],base.stop_coords[alight!],buses,routes,base.stop_coords,base.segments,base.dwells,null,f.t] as const;
    const before=oldPlan.planTrip(...args).find((p:any)=>p.mode==='shuttle'&&p.routeLabel===cfg.label),after=planTrip(...args).find(p=>p.mode==='shuttle'&&p.routeLabel===cfg.label);
    const compact=(p:any)=>p?{bus:p.busName,eta:p.totalSec,board:p.boardStopId,alight:p.alightStopId}:null;
    const a=compact(before),b=compact(after);if(compare(a,b,stats[rid].plan))fs.writeSync(planChanges,JSON.stringify({at:f.at,route:rid,origin:board,destination:alight,before:a,after:b})+'\n');
   }
  }
 }
 if(decision)lastDecision=Math.floor(f.t/decisionMs);if(planning)lastPlan=Math.floor(f.t/900000);
 if(processed%240===0){fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify({processed,at:f.at,stats}));console.log(processed,f.at);}
}
fs.closeSync(changes);fs.closeSync(planChanges);
const result={input:capture,inputSha256:hash(capture),payload,payloadSha256:hash(payload),...provenance,processed:Math.min(processed,input.length,maxFrames),resets,decisionSec:decisionMs/1000,planEveryMin:15,stats,limitations:['One estimator; paired fixed-trip live selection, not independent arrival truth.','Route-constrained planner grid samples every 15 min; not a cross-route best-trip census.','Fixed earlier calibration snapshot, not exact historical per-poll parameters.','Missing destination/horizon evidence retains baseline.','GPS gaps over 60s reset history; initial frames are cold.']};
for(const s of Object.values(stats) as any[])delete s.plan.unexplained; // no witness test is made for the separate planner grid
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
