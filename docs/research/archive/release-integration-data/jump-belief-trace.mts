/** Read-only state trace; no model selection or reserved afternoon input. */
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const root=process.cwd(),D='/home/gwarren/projects/yale-shuttle-watcher/release-integration-data',R='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const mod=async(p:string)=>import(pathToFileURL(root+'/'+p).href);
const {ringForBus,beliefFor,globalPoolsFor}=await mod('web/src/eta/index.ts');
const {buildTables}=await mod('web/src/eta/tables.ts');
const {setRingProfile}=await mod('web/src/eta/ring.ts');
const {situations,standingSec,clockOrigin}=await mod('web/src/eta/filter.ts');
const {registerRoutePaths,isBusOnRoute}=await mod('web/src/anchor.ts');
const {anchorKeyFor}=await mod('web/src/liveAnchor.ts');
const {applyModelParams}=await mod('web/src/eta/params.ts');
const {setReleaseFits,setReleaseExperiment,releaseDist}=await mod('web/src/eta/release.ts');
const {priceRoute,setSampledFutureLap}=await mod('web/src/eta/arrival.ts');
const {residual}=await mod('web/src/eta/dist.ts');
const hot=JSON.parse(fs.readFileSync(D+'/jump-hotspots.json','utf8'));
const topo=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/payload.json','utf8'));
const patch=JSON.parse(fs.readFileSync(R+'/baseline-patch.json','utf8'));
const fitReport=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-window-data/release-survival-screen.json','utf8'));
const original=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/red-window-data/operating-pattern-screen.json','utf8'));
const fits=fitReport.fits.filter((f:any)=>f.arm==='hazard_age_lap_clock15').map((f:any)=>({stopId:f.stop,referenceLap:original.results.find((r:any)=>r.stop===f.stop).referenceLap,coefficients:f.coefficients}));
setReleaseFits(fits);setReleaseExperiment({current:true,future:false,unclamp:true,transition:false,shuffle:false});setSampledFutureLap(true);
registerRoutePaths(topo.route_paths);applyModelParams(JSON.parse(fs.readFileSync(R+'/params.json','utf8')));
const segments:any={},dwells:any={};
for(const[r,es]of Object.entries(patch.segments)as any)segments[r]=Object.fromEntries(Object.entries(es).map(([k,v]:any)=>[k,{avg:0,n:0,...v}]));
for(const[r,es]of Object.entries(patch.dwells)as any)dwells[r]=Object.fromEntries(Object.entries(es).map(([k,v]:any)=>[k,{med:0,n:0,...v}]));
for(const[r,v]of Object.entries(patch.pace)as any)(segments[r]??={}).__pace={avg:0,n:0,spm:v.spm,spmN:v.n};
const stops=topo.routes['3'],ring=ringForBus({route_id:3},stops,topo.stop_coords);
const tables=buildTables(ring.stops,topo.stop_coords,segments['3'],dwells['3'],ring,globalPoolsFor(dwells).pools,ring.repaired?ring.order:undefined);
setRingProfile(ring,tables.hops.map((h:any)=>h.speedMps),tables.stops.map((s:any)=>s.pStop),tables.stops.map((s:any)=>s.measured?s.stand:null),tables.stops.map((s:any)=>s.layover));
const wanted=new Map<string,number[]>();for(const h of [...hot.hotspots,...hot.checkpoints]){if(!wanted.has(h.bus))wanted.set(h.bus,[]);wanted.get(h.bus)!.push(h.at);}
const checkpoints=new Set(hot.checkpoints.map((r:any)=>r.bus+'|'+r.at));
let store=new Map(),observed=new Map(),seen=new Map(),last=0,n=0;const out:any[]=[];
const pairs=new Map<string,any>();
for(const line of fs.readFileSync(D+'/integrated-pairs.jsonl','utf8').trim().split('\n')){
 const r=JSON.parse(line);if(r.at>hot.cutoff)throw Error('Reserved holdout in input');
 const k=r.bus+'|'+r.at+'|'+r.target,old=pairs.get(k);if(!old||r.stopsAhead<old.stopsAhead)pairs.set(k,r);
}
let checks=0;
for(const line of fs.readFileSync(R+'/raw-frames.jsonl','utf8').trim().split('\n')){
 const f=JSON.parse(line),at=Date.parse(f.at);if(at>hot.cutoff)throw Error('Reserved holdout in raw input');
 if(!last||at-last>60000){store=new Map();observed=new Map();seen=new Map();}
 for(const raw of f.buses){
  if(raw.route_id!==3||at-raw.observed_at>=45000)continue;
  const k=anchorKeyFor('Red',raw.bus_name),old=observed.get(k),bus=old&&old.observed_at===raw.observed_at?old:raw;
  observed.set(k,bus);seen.set(k,at);
  if(!isBusOnRoute(bus,stops,topo.stop_coords))continue;
  const b=beliefFor(store,k,bus,ring,stops,at),entry=store.get(k);
  if(bus.at_stop_id!=null&&bus.at_stop_since){const since=Date.parse(bus.at_stop_since.endsWith('Z')?bus.at_stop_since:bus.at_stop_since+'Z');if(Number.isFinite(since)&&since<=at)entry.releasePin={stopId:Number(bus.at_stop_id),since};}
  for(const t of [48,4]){const row=pairs.get(bus.bus_name+'|'+at+'|'+t);if(row){checks++;if(row.lead!==b.lead||row.rested!==b.rested||row.since!==b.restSince)throw Error('Belief parity failure '+bus.bus_name+' '+at);}}
  if(!(wanted.get(bus.bus_name)??[]).some(t=>Math.abs(at-t)<=20000))continue;
  const ss=situations(b,ring),restStop=b.rested?b.restStop:-1,pin=entry.releasePin,elapsed=pin?(at-pin.since)/1000:null;
  const age=pin?bus.lap?.[pin.stopId]:undefined,lap=age===undefined||elapsed===null?undefined:age-elapsed;
  const support=pin&&restStop>=0&&ring.stops[restStop]===pin.stopId&&elapsed!>=0?releaseDist(pin.stopId,pin.since,lap):null;
  const standAt=(s:any)=>{
   const repositioning=!s.standing&&restStop>=0&&s.inRest>=.5&&tables.stops[restStop].layover&&(s.leg+1)%ring.N===restStop;
   return ((s.standing&&s.zoneStop>=0&&(!s.approach||tables.stops[s.zoneStop].layover))||repositioning)?(repositioning?restStop:s.zoneStop):-1;
  };
  const lead=ss.find((s:any)=>s.leg===b.lead)??ss[0],clampAt=lead?standAt(lead):-1;
  const q=support?residual(support,elapsed):null;
  const rr:any={at,bus:bus.bus_name,raw:bus,pin,elapsed,lap,modelSupported:!!support,unclampApplied:!!support&&clampAt===restStop,clampAt,
   belief:{lead:b.lead,rested:b.rested,restStop:b.restStop,restStopId:ring.stops[b.restStop],restApproach:b.restApproach,restSince:b.restSince,clockOrigin:clockOrigin(b),standingSec:standingSec(b,at),serverSince:b.serverSince,fresh:b.fresh,leftStop:b.leftStop,leftSince:b.leftSince,leftAt:b.leftAt,restPoint:b.restPoint},
   residual:q?{low:q(.1),eta:q(.5),high:q(.9)}:null,situations:ss.map((s:any)=>({...s,standingAt:standAt(s)}))};
  if(checkpoints.has(bus.bus_name+'|'+at)){
   const prices=(bb:any)=>priceRoute(bb,ring,tables,ring.stops,new Set([48,4]),at,.5,undefined,bus.lap,false,pin).filter((r:any)=>r.stopsAhead>0&&r.stopsAhead<=29);
   rr.rawPrices=prices(b);
   for(const mode of ['standing','moving']){
    const p=new Float64Array(b.p.length);let total=0;
    for(let i=0;i<p.length;i++){const c=i%ring.C,yes=mode==='standing'?i<ring.C&&b.standLeg[c]===b.lead:i>=ring.C&&ring.leg[c]===b.lead;if(yes){p[i]=b.p[i];total+=p[i];}}
    rr[mode+'Mass']=total;
    if(total>1e-9){for(let i=0;i<p.length;i++)p[i]/=total;rr[mode+'OnlyPrices']=prices({...b,p});}
   }
  }
  out.push(rr);
 }
 for(const[k,t]of seen)if(at-t>600000){seen.delete(k);store.delete(k);}
 last=at;n++;
}
fs.writeFileSync(D+'/jump-belief-trace.json',JSON.stringify({frames:n,beliefChecks:checks,cutoff:hot.cutoff,method:'Same ring profile and causal belief stepping as completed integrated replay, with release transition experiment explicitly off; parity checked against every available first-occurrence row lead/restSince/rested. Raw pricing counterfactuals have no display floor. Standing/moving counterfactuals condition within the same lead leg, not different routes or model fits.',rows:out},null,2)+'\n');
console.log(JSON.stringify({frames:n,beliefChecks:checks,traceRows:out.length}));
