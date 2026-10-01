import fs from 'node:fs';import assert from 'node:assert/strict';import {createInterface}from'node:readline';import{createGzip}from'node:zlib';import{once}from'node:events';import{serialize,deserialize}from'node:v8';import{createHash}from'node:crypto';
import {ServerEta} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/src/server/serverEta.ts';
import {ROUTE_LISTS,mergedRouteStops} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/routes.ts';
import {ringForBus} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/index.ts';
import {situations} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/filter.ts';
import {setReleaseModelEnabled} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/release.ts';
import {setSampledFutureLap} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/arrival.ts';
const O=new URL('.',import.meta.url).pathname,A='/home/gwarren/projects/yale-shuttle-watcher',read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const arm=process.argv[2],start=Number(process.argv[3]??0),end=Number(process.argv[4]??6000),tag=start?arm+'-resume'+start:arm;assert.ok(['current','canonical'].includes(arm));
const topology=read(A+'/red-eta-data/payload.json'),params=read(A+'/conditional-replay-data/params.json'),p=read(A+'/conditional-replay-data/baseline-patch.json');
const earlyFits=read(A+'/release-integration-data/runtime-fits-pre-sep10.json').fits,freshFits=read(A+'/release-integration-data/runtime-fits-development.json').fits,refitAt=1789665240913;
const segments:any={},dwells:any={};for(const[r,entries]of Object.entries(p.segments)as any)segments[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{avg:0,n:0,...v}]));for(const[r,entries]of Object.entries(p.dwells)as any)dwells[r]=Object.fromEntries(Object.entries(entries).map(([k,v]:any)=>[k,{med:0,n:0,...v}]));for(const[r,v]of Object.entries(p.pace)as any)(segments[r]??={}).__pace={avg:0,n:0,spm:v.spm,spmN:v.n};
const payload={routes:topology.routes,route_paths:topology.route_paths,stop_coords:topology.stop_coords,segments,dwells,model_params:params};setReleaseModelEnabled(true);setSampledFutureLap(true);
let server:any,last=0,n=0,rows=0,samples=0,segment=0,minute=-1,started=Date.now();const perBus=new Map(),routeMeta:any={},gaps:any[]=[];
if(start){const saved=deserialize(fs.readFileSync(O+arm+'-checkpoint-'+start+'.v8'));server=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});Object.assign(server,saved.server);for(const[k,v]of saved.perBus)perBus.set(k,v);({last,n,minute,segment}=saved);for(const[k,v]of saved.kernelCache)(globalThis as any).__etaResearchKernelCache.set(k,v);Object.assign(routeMeta,saved.routeMeta);}
function checkpoint(){const properties=['store','seenAt','observed','lastVersion','wire','steps','failures','lastStepMs','restored','lastSavedAt','routeStops','currentBuses'];fs.writeFileSync(O+arm+'-checkpoint-'+n+'.v8',serialize({server:Object.fromEntries(properties.map(k=>[k,server[k]])),perBus,last,n,minute,segment,routeMeta,kernelCache:(globalThis as any).__etaResearchKernelCache}));}
let inputIndex=0;
const gz=createGzip({level:1}),out=fs.createWriteStream(O+tag+'-wire.jsonl.gz');gz.pipe(out);
for await(const line of createInterface({input:fs.createReadStream(O+'../cycle-14/all-route-raw-frames.jsonl'),crlfDelay:Infinity})){
 if(inputIndex++<start)continue;if(n>=end)break;
 const f=JSON.parse(line),at=Date.parse(f.at);if(!last||at-last>60000){server=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});perBus.clear();segment++;gaps.push({at,gap:last?at-last:null});}
 for(const b of f.buses){const key=b.route_id+'|'+b.bus_name,old=perBus.get(key);if(!old||at-old.last>60000)perBus.set(key,{first:at,last:at});else old.last=at;}
 dwells['3']['11'].release=(at>refitAt?freshFits:earlyFits).find((f:any)=>f.stopId===11);
 const wire=server.contribute({...payload,buses:f.buses},n,at);assert.equal(server.stats().failures,0);
 const sample=Math.floor(at/60000)!==minute;minute=Math.floor(at/60000);if(sample)samples++;
 const tracking:any={};
 for(const b of f.buses){const cfg=ROUTE_LISTS.find(c=>c.busRouteIds.includes(b.route_id));if(!cfg)continue;const key=cfg.label+'|'+b.bus_name,e=server.store.get(key);if(!e?.belief)continue;const ring=ringForBus(b,mergedRouteStops(cfg,payload.routes),payload.stop_coords);assert.ok(ring);const belief=e.belief,sits=situations(belief,ring),sit=sits.find(s=>s.leg===belief.lead)??sits[0];
  routeMeta[b.route_id]={label:cfg.label,stops:ring.stops,order:ring.order,repaired:ring.repaired,N:ring.N};
  tracking[cfg.label+'|'+b.bus_name.replace(/^#/,'')]=[b.route_id,belief.lead,belief.rested,belief.restStop,belief.restSince,at-perBus.get(b.route_id+'|'+b.bus_name).first,sit?.leg??null,b.observed_at??null,b.at_stop_id??null];
 }
 const record:any={i:n,at,segment,sample,tracking,wire:wire?{...wire,distributions:sample?wire.distributions:undefined}:null};
 if(sample){const frozen=structuredClone({entries:[...server.store],seen:[...server.seenAt]});for(const[,e]of frozen.entries)assert.ok(e.belief.seenAt<=at);record.stateSha256=createHash('sha256').update(serialize(frozen)).digest('hex');}
 const encoded=JSON.stringify(record)+'\n';if(!gz.write(encoded))await once(gz,'drain');rows+=wire?.rows.length??0;n++;last=at;if(n===5900||n===end)checkpoint();
 if(n%250===0)console.error(JSON.stringify({arm,n,rows,seconds:(Date.now()-started)/1000,rssMB:process.memoryUsage().rss/1048576}));
}
gz.end();await once(out,'finish');const meta={arm,start,end,polls:n-start,rows,samples,gaps,routeMeta,seconds:(Date.now()-started)/1000};fs.writeFileSync(O+tag+'-meta.json',JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
