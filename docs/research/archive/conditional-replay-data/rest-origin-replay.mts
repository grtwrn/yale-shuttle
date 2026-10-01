/** Read-only reproduction of source65237's fresh-fix restart truncation. */
import fs from 'node:fs';import{pathToFileURL}from'node:url';
const root=process.cwd(),D='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';
const load=async(p:string)=>import(pathToFileURL(root+'/'+p).href);
const{loadNet}=await load('scripts/eta-replay/common.ts');const{stepManyWithVisits}=await load('src/collector/departure.ts');const{seedStationaryFromHistory}=await load('src/collector/detector.ts');
const net=loadNet();const v=net.db.prepare('SELECT * FROM stop_visits WHERE id=65237').get();
const raw=net.db.prepare('SELECT * FROM raw_positions WHERE route_id=3 AND bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at,id').all(v.bus_name,v.pinned_at-600000,v.departed_at+120000);
const obs=(r:any)=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id,collectedAt:r.collected_at});
const runs:any={};let inspectedSeed:any;
for(const arm of ['continuous','restart_on_fresh_fix']){
 let states=new Map(),visits=new Map();const events:any[]=[],visitEvents:any[]=[];
 for(const r of raw){
  const isRestart=arm==='restart_on_fresh_fix'&&r.collected_at===v.anchored_at;if(isRestart){states=new Map();visits=new Map();}
  const seed=isRestart?(o:any,stop:any)=>{
   const history=net.db.prepare('SELECT lat,lon,collected_at AS collectedAt FROM raw_positions WHERE bus_id=? AND collected_at>=? AND collected_at<? ORDER BY collected_at DESC').all(o.busId,o.collectedAt-1800000,o.collectedAt);
   const run=seedStationaryFromHistory(history,o,stop);inspectedSeed=run;
   // Production's fresh-fix branch returns the clock without enteredAt.
   if(run?.restSince!==null)throw Error('Expected fresh-fix seed branch');return run;
  }:null;
  const got=stepManyWithVisits(net.network,states,visits,[obs(r)],undefined,seed);events.push(...got.events);visitEvents.push(...got.visits);
 }
 runs[arm]={events:events.filter(e=>e.stopId===11),visitEvents:visitEvents.filter(e=>e.stopId===11||e.toStopId===11)};
}
const out={sourceVisit:v,inspectedSeed,runs};fs.writeFileSync(D+'/rest-origin-replay.json',JSON.stringify(out,null,2)+'\n');net.db.close();console.log(JSON.stringify(out,null,2));
