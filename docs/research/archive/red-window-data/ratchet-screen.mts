import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher';
const mod=async(p:string)=>import(pathToFileURL(root+'/'+p).href);
const {computeUpcomingArrivals}=await mod('web/src/arrivals.ts');
const {registerRoutePaths}=await mod('web/src/anchor.ts');
const {applyModelParams}=await mod('web/src/eta/params.ts');
const {anchorKeyFor}=await mod('web/src/liveAnchor.ts');
const base=JSON.parse(fs.readFileSync(dir+'/red-eta-data/payload.json','utf8'));
registerRoutePaths(base.route_paths);applyModelParams(base.model_params);
const frames=fs.readFileSync(dir+'/red-eta-data/watcher.jsonl','utf8').trim().split('\n').map(JSON.parse);
let stores={baseline:new Map(),unclamped:new Map()},prev=0,run='';
const out:any[]=[];
for(const f of frames){
 const now=Date.parse(f.at);if(f.runId!==run||now-prev>60000)stores={baseline:new Map(),unclamped:new Map()};run=f.runId;prev=now;
 const buses=f.buses.filter((b:any)=>b.route_id===3),rows:any={};
 for(const arm of ['baseline','unclamped']){
  const store=stores[arm as keyof typeof stores];if(arm==='unclamped')for(const x of store.values())delete x.floors;
  const arrivals=computeUpcomingArrivals(base.routes['3'],buses,base.routes,base.stop_coords,base.segments,now,base.dwells,store);
  for(const bus of buses){
   const belief=store.get(anchorKeyFor('Red',bus.bus_name))?.belief;
   for(const a of arrivals.filter((a:any)=>a.busName===bus.bus_name.replace(/^#/,'')&&[48,4].includes(a.stopId)&&a.stopsAhead>0&&a.stopsAhead<12)){
    const key=bus.bus_name+'|'+a.stopId+'|'+a.stopsAhead;
    (rows[key]??={bus:bus.bus_name,target:a.stopId,stopsAhead:a.stopsAhead,source:bus.at_stop_id,at:now,since:belief?.restSince,rested:belief?.rested,lead:belief?.lead})[arm]={eta:a.eta,low:Math.max(0,a.low),high:a.high};
   }
  }
 }
 out.push(...Object.values(rows));
}
fs.writeFileSync(dir+'/red-window-data/ratchet-screen-pairs.json',JSON.stringify(out));console.log(JSON.stringify({frames:frames.length,rows:out.length}));
