import fs from 'node:fs';
import assert from 'node:assert/strict';
import {computeUpcomingArrivals} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/arrivals.ts';
import {ServerEta} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/src/server/serverEta.ts';
import {registerRoutePaths} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/anchor.ts';
import {applyModelParams} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/params.ts';
import {setReleaseModelEnabled} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/release.ts';
import {setSampledFutureLap} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/arrival.ts';
import {ETA_MAX_AGE_MS} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/etaSource.ts';
import {anchorKeyFor} from '/home/gwarren/projects/yale-shuttle-watcher/red-lower-bound-2026-09-18/services/shuttle-v2/web/src/liveAnchor.ts';
const O=new URL('.',import.meta.url).pathname,A='/home/gwarren/projects/yale-shuttle-watcher',read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const arm=process.argv[2];assert.ok(['baseline','candidate'].includes(arm));
const topology=read(A+'/red-eta-data/payload.json'),params=read(A+'/conditional-replay-data/params.json'),p=read(A+'/conditional-replay-data/baseline-patch.json');
const earlyFits=read(A+'/release-integration-data/runtime-fits-pre-sep10.json').fits,freshFits=read(A+'/release-integration-data/runtime-fits-development.json').fits,refitAt=1789665240913;
const segments:any={},dwells:any={};
for(const[r,entries]of Object.entries(p.segments)as any)segments[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{avg:0,n:0,...v}]));
for(const[r,entries]of Object.entries(p.dwells)as any)dwells[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{med:0,n:0,...v}]));
for(const[r,v]of Object.entries(p.pace)as any)(segments[r]??={}).__pace={avg:0,n:0,spm:v.spm,spmN:v.n};
const payload={routes:topology.routes,route_paths:topology.route_paths,stop_coords:topology.stop_coords,segments,dwells,model_params:params};
registerRoutePaths(topology.route_paths);applyModelParams(params);setReleaseModelEnabled(true);setSampledFutureLap(true);
let store:any=new Map(),observed=new Map(),seen=new Map(),perBus=new Map(),last=0,n=0,segmentId=0,emitted=0,parityChecks=0;
const gaps:any[]=[],routes:any={},output=fs.openSync(O+arm+'.jsonl','w'),tracking=fs.openSync(O+arm+'-tracking.jsonl','w');
for(const line of fs.readFileSync(A+'/red-lower-data-2026-09-18/raw-today-frames.jsonl','utf8').trim().split('\n')){
 const f=JSON.parse(line),at=Date.parse(f.at);if(at===last)continue;
 for(const b of f.buses)routes[b.route_id]=(routes[b.route_id]??0)+1;
 if(!last||at-last>60000){store=new Map();observed=new Map();seen=new Map();perBus=new Map();segmentId++;gaps.push({at,gapMs:last?at-last:null});}
 const raw=f.buses.filter((b:any)=>b.route_id===3);
 for(const b of raw){const old=perBus.get(b.bus_name);if(!old||at-old.last>60000)perBus.set(b.bus_name,{first:at,last:at});else old.last=at;}
 const buses=raw.filter((b:any)=>b.observed_at===undefined||at-b.observed_at<ETA_MAX_AGE_MS).map((b:any)=>{const k=b.route_id+'|'+b.bus_name,old=observed.get(k);if(old&&b.observed_at!==undefined&&old.observed_at===b.observed_at)return old;observed.set(k,b);return b;});
 for(const b of buses)seen.set(anchorKeyFor('Red',b.bus_name),at);
 dwells['3']['11'].release=(at>refitAt?freshFits:earlyFits).find((f:any)=>f.stopId===11);
 const arrivals=computeUpcomingArrivals([48,4],buses,payload.routes,payload.stop_coords,segments,at,dwells,store);
 for(const[k,t]of seen)if(at-t>600000){seen.delete(k);store.delete(k);}
 if(n%1000===0){const server:any=new ServerEta({routes:['Red']});for(const[k,e]of store)server.store.set(k,structuredClone(e));const actual=server.contribute({...payload,buses},n,at);assert.equal(server.stats().failures,0);for(const a of arrivals){const bi=actual?.buses.findIndex((b:any)=>b[0]===a.busName),r=actual?.rows.find((r:any)=>r[0]===bi&&r[1]===a.stopId&&r[5]===a.stopsAhead);assert.ok(r);assert.deepEqual(r.slice(2,5),[a.eta,a.low,a.high].map(Math.round));parityChecks++;}}
 for(const b of raw){const belief=store.get(anchorKeyFor('Red',b.bus_name))?.belief;if(belief)fs.writeSync(tracking,JSON.stringify({at,bus:b.bus_name,lead:belief.lead,rested:belief.rested,restSince:belief.restSince,restStop:belief.restStop,lap:belief.lap,pSum:Array.from(belief.p as number[]).reduce((a,b)=>a+b,0)})+'\n');}
 for(const a of arrivals){if(![48,4].includes(a.stopId)||a.stopsAhead<1||a.stopsAhead>=60)continue;const name='#'+a.busName,bus=raw.find((b:any)=>b.bus_name===name);assert.ok(bus);const belief=store.get(anchorKeyFor('Red',name))?.belief;const row={at,bus:name,busId:bus.bus_id,route:3,target:a.stopId,stopsAhead:a.stopsAhead,occurrence:0,segmentId,warmMs:at-perBus.get(name).first,observedAt:bus.observed_at??null,source:bus.at_stop_id??null,rested:belief?.rested,since:belief?.restSince,lead:belief?.lead,pinnedSince:bus.at_stop_since??null,lastMovedAt:bus.last_moved_at??null,restStop:belief?.restStop,forecast:{eta:a.eta,low:a.low,high:a.high},departNow:a.departNow,lowFloor:a.lowFloor};fs.writeSync(output,JSON.stringify(row)+'\n');emitted++;}
 last=at;n++;if(n%2000===0)console.error(JSON.stringify({arm,frames:n,emitted}));
}
fs.closeSync(output);fs.closeSync(tracking);const meta={arm,frames:n,emitted,parityChecks,gaps,routes,refitAt};fs.writeFileSync(O+arm+'-meta.json',JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
