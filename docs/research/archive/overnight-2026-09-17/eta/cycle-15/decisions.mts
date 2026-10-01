import fs from'node:fs';import{createGunzip}from'node:zlib';import{createInterface}from'node:readline';import{pathToFileURL}from'node:url';import assert from'node:assert/strict';import{reprice}from'./shell-current.generated.mts';
const O=new URL('.',import.meta.url).pathname,A='/home/gwarren/projects/yale-shuttle-watcher',read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8')),load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {planTrip,topVisibleOptions,keptThirdLabel}=await load('planner.ts'),{stableTripOrder}=await load('tripRanking.ts'),{attachServerEta,liveEtaAvailable}=await load('etaSource.ts'),{isBusInService}=await load('schedule.ts'),{registerRoutePaths}=await load('anchor.ts');
const payload=read(O+'../cycle-4/calibration-payload.json'),plan=read(O+'../cycle-4/PLAN.json');registerRoutePaths(payload.route_paths);
const raw=new Map();for await(const l of createInterface({input:fs.createReadStream(O+'../cycle-14/all-route-raw-frames.jsonl'),crlfDelay:Infinity})){const f=JSON.parse(l);const at=Date.parse(f.at);if(plan.windows.some((w:any)=>at>=w.start&&at<=w.end))raw.set(at,f.buses);}
const all:any={};let now=0;const original=Date.now;Date.now=()=>now;
try{for(const arm of ['current','canonical']){
 const sessions:any[]=[];for(const w of plan.windows)for(const target of[48,4])for(const offset of[0,150]){const from={...payload.stop_coords[w.sourceStop]};if(offset)from.lon-=offset/(111320*Math.cos(from.lat*Math.PI/180));sessions.push({id:`${w.sourceId}:${target}:${offset}`,w,target,from,to:payload.stop_coords[target],stable:null,order:null,third:null,roster:null});}
 const output=fs.openSync(O+arm+'-decisions.jsonl','w');const rows:any[]=[];
 for await(const l of createInterface({input:fs.createReadStream(O+arm+'-wire.jsonl.gz').pipe(createGunzip()),crlfDelay:Infinity})){
  const f=JSON.parse(l);now=f.at;if(!raw.has(now))continue;const buses=structuredClone(raw.get(now)).filter((b:any)=>isBusInService(b,now));attachServerEta(buses,f.wire,now);const roster=buses.map((b:any)=>`${b.route_id}:${b.bus_name}`).sort().join(',')+':'+liveEtaAvailable(buses,now);
  for(const s of sessions){if(now<s.w.start||now>s.w.end)continue;
   if(s.stable===null||(s.roster!==roster&&!s.stable.some((o:any)=>o.mode==='shuttle'))){s.stable=planTrip(s.from,s.to,buses,payload.routes,payload.stop_coords,payload.segments,payload.dwells,null,now);s.order=null;s.third=null;}
   s.roster=roster;const result=reprice(s.stable,buses,payload,s.from,s.to),ranked=stableTripOrder(result.options,s.order,now);s.order=ranked.state;const visible=topVisibleOptions(ranked.options,s.third);s.third=keptThirdLabel(visible);
   const record={session:s.id,sourceId:s.w.sourceId,at:now,from:s.from,to:s.to,options:result.options,trace:result.trace,visible:visible.map((o:any)=>o.routeLabel)};rows.push(record);fs.writeSync(output,JSON.stringify(record)+'\n');
  }
 }
 fs.closeSync(output);all[arm]=rows;
}}finally{Date.now=original;}
assert.equal(all.current.length,all.canonical.length);const changes:any[]=[];let choices=0,vehicles=0,ranks=0,caution=0,available=0,deadlines=0;
for(let i=0;i<all.current.length;i++){
 const a=all.current[i],b=all.canonical[i];assert.deepEqual([a.session,a.at],[b.session,b.at]);if(JSON.stringify(a.visible)!==JSON.stringify(b.visible))ranks++;
 const vehicle=(o:any)=>[o.routeLabel,o.livePickupSelection?.boarding?.busName];if(JSON.stringify(a.options.map(vehicle))!==JSON.stringify(b.options.map(vehicle)))vehicles++;
 const identity=(o:any)=>[o.routeLabel,o.boardStopId,o.alightStopId,o.livePickupSelection?.boarding?.busName,o.livePickupSelection?.boarding?.stopsAhead,o.livePickupSelection?.relation];if(JSON.stringify(a.options.map(identity))!==JSON.stringify(b.options.map(identity)))choices++;
 for(const oa of a.options){const ob=b.options.find((x:any)=>x.routeLabel===oa.routeLabel);if(!ob)continue;if(oa.journeyArrival?.catchRisk!==ob.journeyArrival?.catchRisk)caution++;if(!!oa.journeyArrival!==!!ob.journeyArrival)available++;
 // Fixed relative class windows are synthetic scenario decisions, not observed deadlines.
 for(const minutes of[15,30,45]){if((oa.totalSec<=minutes*60)!==(ob.totalSec<=minutes*60))deadlines++;}}
 if(JSON.stringify(a.options)!==JSON.stringify(b.options)||JSON.stringify(a.visible)!==JSON.stringify(b.visible))changes.push({session:a.session,at:a.at,current:a,canonical:b});
}
const summary={pairedDecisions:all.current.length,sessions:new Set(all.current.map((r:any)=>r.session)).size,pickupSelectionMetadataDifferences:choices,boardingVehicleDifferences:vehicles,visibleOrderDifferences:ranks,cautionDifferences:caution,journeyAvailabilityDifferences:available,syntheticPointDeadlineDifferences:deadlines,changedOptionDecisions:changes.length,limits:'Actual current extracted numerical options/planner/ranking on allfleet wire; prior selected Red-origin geometries, hypothetical stationary walkers and synthetic 15/30/45minute point deadlines. Full actual chosen-bus connected rider outcomes remain separate; this is not browser verification or deadline probability validation.'};fs.writeFileSync(O+'decision-summary.json',JSON.stringify(summary,null,2));fs.writeFileSync(O+'decision-changes.json',JSON.stringify(changes,null,2));console.log(JSON.stringify(summary));
