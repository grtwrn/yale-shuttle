import fs from 'node:fs';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
// Reviewer-authored check: no generated shell, trace instrumentation or
// pickupContract helper. Read the current selector's actual returned rows.
const root='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta';
const out=root+'/review-round-9';
const load=(name:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+name).href);
const {pickLiveArrival,rideBoardArrivals,boardingVisitAllowed,dwellBoardWindowSec}=await load('planner.ts');
const {attachServerEta,liveBusAvailable}=await load('etaSource.ts');
const {computeUpcomingArrivals}=await load('liveArrivals.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const {ROUTE_LISTS}=await load('routes.ts');
const read=(name:string)=>JSON.parse(fs.readFileSync(name,'utf8'));
const lines=(name:string)=>fs.readFileSync(name,'utf8').trim().split('\n').map(x=>JSON.parse(x));
const payload=read(root+'/cycle-5/traversal-guard/calibration-payload.json');
registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const inputs=lines(root+'/cycle-5/traversal-guard/decisions.jsonl');
const options=lines(root+'/cycle-6/ordered-decisions.jsonl');
const census=lines(out+'/pickup-census.jsonl');
const frames=new Map(gunzipSync(fs.readFileSync(root+'/cycle-5/traversal-guard/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(x=>{const f=JSON.parse(x);return [f.at,f]}));
const key=(r:any)=>r.arm+'|'+r.session+'|'+r.at;
const indexed=new Map(census.map(r=>[key(r),r]));assert.equal(indexed.size,9376);
const norm=(n:string)=>n.replace(/^#/,'');
let current=0;const realNow=Date.now;Date.now=()=>current;
const counts={ordinary:0,raw:0,frames:frames.size,checked:0};
try {
 for(let i=0;i<inputs.length;i++) {
  const input=inputs[i],o=options[i].option;current=input.at;
  assert.equal(input.session,options[i].session);assert.equal(input.at,options[i].at);
  const frame=frames.get(current)!;
  for(const arm of ['historical','missingDestination']) {
   const got=indexed.get(key({...input,arm}))!;assert.ok(got);
   const keep=frame.server_eta.rows.map((_:any,j:number)=>j).filter((j:number)=>arm==='historical'||frame.server_eta.rows[j][1]!==o.alightStopId);
   const wire={...frame.server_eta,rows:keep.map((j:number)=>frame.server_eta.rows[j]),distributions:keep.map((j:number)=>frame.server_eta.distributions[j])};
   const buses=frame.buses.filter((b:any)=>isBusInService(b,current)).map((b:any)=>({...b}));
   assert.ok(attachServerEta(buses,wire,current));
   const visits=computeUpcomingArrivals([o.boardStopId,o.alightStopId],buses,payload.routes,payload.stop_coords,payload.segments,current,payload.dwells,new Map()).filter((a:any)=>a.routeLabel===o.routeLabel);
   const cfg=ROUTE_LISTS.find((c:any)=>c.label===o.routeLabel)!;
   const raws=buses.filter((b:any)=>cfg.busRouteIds.includes(b.route_id)&&b.at_stop_id===o.boardStopId&&liveBusAvailable(b,cfg.label,current)&&boardingVisitAllowed(b.bus_name,o.boardStopId,o.alightStopId,visits));
   const planned=input.stable.find((x:any)=>x.mode==='shuttle');
   const here=raws.find((b:any)=>norm(b.bus_name)===norm(planned.busName))??raws[0];
   if(here&&o.walkToSec<=dwellBoardWindowSec(here,cfg.routeIds[0],o.boardStopId,payload.dwells)) {
    assert.equal(got.contract.relation,'raw-current');assert.equal(got.contract.boarding.source,'raw-at-stop');
    assert.equal(got.contract.boarding.busName,norm(here.bus_name));assert.equal(got.waitSec,0);counts.raw++;
   } else {
    const p=pickLiveArrival(rideBoardArrivals(visits,o.boardStopId,o.alightStopId),planned.busName,o.walkToSec)!;
    assert.ok(p&&!p.departed);
    for(const [name,row] of [['countdown',p.match],['boarding',p.boardable]] as const) {
     const evidence=got.contract[name];assert.equal(evidence.source,'forecast');
     assert.equal(evidence.busName,norm(row.busName));assert.equal(evidence.stopId,row.stopId);
     assert.equal(evidence.stopsAhead,row.stopsAhead);assert.equal(evidence.etaSec,row.eta);
     assert.equal(evidence.lowSec,row.low);assert.equal(evidence.highSec,row.high);
    }
    assert.equal(got.waitSec,Math.max(0,p.boardable.eta-o.walkToSec));counts.ordinary++;
   }
   assert.equal(got.contract.boarding.selectedAtMs,current);counts.checked++;
  }
 }
} finally {Date.now=realNow;}
assert.equal(counts.checked,9376);assert.equal(counts.raw,2912);assert.equal(counts.ordinary,6464);
fs.writeFileSync(out+'/direct-selector-audit.json',JSON.stringify(counts,null,2)+'\n');
console.log(JSON.stringify(counts));
