import fs from 'node:fs';
import { deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root=process.cwd(), out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-2';
const load=(p:string)=>import(pathToFileURL(root+p).href);
const observer=await import(pathToFileURL(out+'/arrival-observer.generated.mts').href);
const current=await load('/web/src/eta/arrival.ts');
const {registerRoutePaths}=await load('/web/src/anchor.ts');
const {applyModelParams}=await load('/web/src/eta/params.ts');
const {ringForBus,globalPoolsFor}=await load('/web/src/eta/index.ts');
const {buildTables}=await load('/web/src/eta/tables.ts');
const snapshots=deserialize(fs.readFileSync(out+'/component-snapshots.v8'));
const outcomes=JSON.parse(fs.readFileSync(out+'/trace-outcomes.json','utf8')).cases;
const result:any[]=[];let rowChecks=0, identities=0;
for(const snap of snapshots){
 const {payload,bus,entry,at,sourceId}=snap;
 registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
 const ring=ringForBus(bus,payload.routes['3'],payload.stop_coords);
 assert(ring);
 const tables=buildTables(ring.stops,payload.stop_coords,payload.segments['3'],payload.dwells['3'],ring,globalPoolsFor(payload.dwells).pools,ring.repaired?ring.order:undefined);
 const args=[entry.belief,ring,tables,ring.stops,new Set([11,48,4]),at,0.5];
 const a=current.priceRoute(...args,structuredClone(entry.floors),bus.lap,true,entry.releasePin);
 const b=observer.priceRoute(...args,structuredClone(entry.floors),bus.lap,true,entry.releasePin);
 assert.deepEqual(b,a);
 for(const x of a){
  const served=snap.forecasts.find((r:any)=>r.stopId===x.stopId&&r.stopsAhead===x.stopsAhead);
  assert(served);
  for(const k of ['eta','low','high','departNow'])assert(Math.abs(x[k]-served[k])<1e-7);
  assert.deepEqual(x.distribution,served.distribution);rowChecks++;
 }
 const parts=observer.componentObserver;
 const mass=parts.reduce((n:number,p:any)=>n+p.mass,0);
 const fields=['preWin','wait','postDivision','postRose','totalDivision','totalRose'];
 const means:any={};
 for(const f of fields)means[f]=parts.reduce((n:number,p:any)=>n+p.mass*p[f].reduce((a:number,b:number)=>a+b,0)/p[f].length,0)/mass;
 for(const p of parts)for(let k=0;k<p.preWin.length;k++){
  assert(Math.abs(p.preWin[k]+p.wait[k]+p.postDivision[k]-p.totalDivision[k])<1e-8);
  assert(Math.abs(p.preWin[k]+p.wait[k]+p.postRose[k]-p.totalRose[k])<1e-8);
  assert(p.wait[k]>-1e-8);identities+=2;
 }
 const record=outcomes.find((c:any)=>c.sourceId===sourceId);
 const endpoint=(target:number)=>record.endpoints.find((e:any)=>e.target===target&&e.occurrence===0).outcome;
 const win=endpoint(11),division=endpoint(48),rose=endpoint(4);
 const truth={preWin:(win.arrived_at-at)/1000,wait:(win.departed_at-win.arrived_at)/1000,
  postDivision:(division.arrived_at-win.departed_at)/1000,postRose:(rose.arrived_at-win.departed_at)/1000,
  totalDivision:(division.arrived_at-at)/1000,totalRose:(rose.arrived_at-at)/1000};
 const lead=parts.find((p:any)=>p.isLead);assert(lead);
 assert(lead.rawSecondRoseMedian>current.MAX_ETA_SEC);
 assert(!snap.forecasts.some((r:any)=>r.stopId===4&&r.stopsAhead>29));
 result.push({sourceId,at,leadClusterMass:mass,parts:parts.map((p:any)=>({mass:p.mass,standing:p.standing,leg:p.leg})),
  secondOccurrenceGate:{rawLeadDivisionMedian:lead.rawSecondDivisionMedian,rawLeadRoseMedian:lead.rawSecondRoseMedian,existingMaxSec:current.MAX_ETA_SEC,roseOmitted:true},
  sampledMeansBeforeDisplayCorrections:means,retrospectiveActualSec:truth,
  meanErrorPredictedMinusActual:Object.fromEntries(fields.map(f=>[f,means[f]-truth[f]])),
  displayed:snap.forecasts.map((r:any)=>({target:r.stopId,stopsAhead:r.stopsAhead,eta:r.eta,low:r.low,high:r.high}))});
}
const report={scope:'Internal lead-cluster sample means before display corrections. Means add exactly; these are not served medians, calibrated probabilities or candidate interventions. Actual clocks are separate outcome labels.',rowChecks,sampleIdentities:identities,cases:result};
fs.writeFileSync(out+'/component-probe.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
