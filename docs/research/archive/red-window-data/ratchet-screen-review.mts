/** Verify the supplied paired replay and its no-ratchet arm. Analysis only. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher';
const mod=async(p:string)=>import(pathToFileURL(root+'/'+p).href);
const {computeUpcomingArrivals}=await mod('web/src/arrivals.ts');
const {registerRoutePaths}=await mod('web/src/anchor.ts');
const {applyModelParams}=await mod('web/src/eta/params.ts');
const {anchorKeyFor}=await mod('web/src/liveAnchor.ts');
const {ceilingArmsOnStanding}=await mod('web/src/eta/arrival.ts');
assert.equal(ceilingArmsOnStanding(),false,'Fresh floors would re-arm differently if standing-arm switch were enabled');
const base=JSON.parse(fs.readFileSync(dir+'/red-eta-data/payload.json','utf8'));
registerRoutePaths(base.route_paths);applyModelParams(base.model_params);
const frames=fs.readFileSync(dir+'/red-eta-data/watcher.jsonl','utf8').trim().split('\n').map(JSON.parse);
const expected=JSON.parse(fs.readFileSync(dir+'/red-window-data/ratchet-screen-pairs.json','utf8'));
let stores={baseline:new Map(),unclamped:new Map()},prev=0,run='',resets=0;
const out:any[]=[];
for(const f of frames){
 const now=Date.parse(f.at);if(f.runId!==run||now-prev>60000){stores={baseline:new Map(),unclamped:new Map()};resets++;}run=f.runId;prev=now;
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
 assert.deepEqual([...stores.baseline].map(([k,e])=>[k,e.belief]),[...stores.unclamped].map(([k,e])=>[k,e.belief]),`Beliefs diverged at ${f.at}`);
 out.push(...Object.values(rows));
}
assert.deepEqual(JSON.parse(JSON.stringify(out)),expected,'Recomputed pairs do not match supplied artifact');
assert.equal(ceilingArmsOnStanding(),false);
const sha=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={ceilingArmsOnStanding:false,pairsExactlyReproduced:true,beliefsIdenticalAtEveryFrame:true,frames:frames.length,rows:out.length,resets,
 codeHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 modelParamsVersion:base.model_params.version,modelParamsPublishedAt:base.model_params.publishedAt,
 inputHashes:Object.fromEntries(['red-eta-data/payload.json','red-eta-data/watcher.jsonl','red-window-data/ratchet-screen-pairs.json'].map(p=>[p,sha(dir+'/'+p)])),
 codeHashes:Object.fromEntries(['web/src/eta/arrival.ts','web/src/eta/filter.ts','web/src/eta/tables.ts','web/src/eta/params.ts','web/src/eta/index.ts','web/src/arrivals.ts'].map(p=>[p,sha(root+'/'+p)]))};
fs.writeFileSync(dir+'/red-window-data/ratchet-screen-review-provenance.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
