/** Exact deployed checkpoint layer over the recorded live fallback. Hosted only. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {K10Tracker} from '../../services/shuttle-v2/src/collector/k10Tracker.ts';
import {applyK10Trial} from '../../services/shuttle-v2/src/server/k10Trial.ts';
import {applyRouteK10Trial} from '../../services/shuttle-v2/src/server/routeK10Trial.ts';
import type {BusObservation} from '../../services/shuttle-v2/src/collector/detector.ts';
import type {ServerEtaWire} from '../../services/shuttle-v2/web/src/etaSource.ts';
const input='research/k-sweep/results/',out='research/useful-windows/results/';
fs.mkdirSync(out,{recursive:true});
const read=(f:string)=>zlib.gunzipSync(fs.readFileSync(input+f+'.jsonl.gz')).toString().trim().split('\n').map(s=>JSON.parse(s));
const features=read('features').sort((a,b)=>a.asof-b.asof), names=new Set(features.map(f=>f.bus));
const top=JSON.parse(fs.readFileSync('research/k-sweep/data/topology.json','utf8'));
const byId=new Map<number,any>(top.routes.map((r:any)=>[r.id,r]));
const routes=Object.fromEntries(top.routes.map((r:any)=>[r.id,r.stops]));
const raw:BusObservation[]=[];
for await(const line of readline.createInterface({input:fs.createReadStream(input+'raw_positions.jsonl.gz').pipe(zlib.createGunzip())})){
 const r=JSON.parse(line);if(!names.has(r.bus_name)||r.collected_at<features[0].asof-3600000)continue;
 raw.push({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:r.collected_at});
}
raw.sort((a,b)=>a.collectedAt-b.collectedAt||a.busId-b.busId);
const tracker=new K10Tracker(),net=TransitNetwork.build(top.stops,top.routes),generated:any[]=[],changes:Record<string,number>={};let cursor=0;
for(const f of features){
 while(cursor<raw.length&&raw[cursor]!.collectedAt<=f.asof){
  const at=raw[cursor]!.collectedAt,group=[];
  while(cursor<raw.length&&raw[cursor]!.collectedAt===at)group.push(raw[cursor++]!);
  tracker.update(net,group);
 }
 const route=byId.get(f.route)!,name=f.bus.replace(/^#/,''),seq=route.stops,ti=seq.indexOf(f.target),snapshot=tracker.snapshot(f.asof);
 const wire:ServerEtaWire={v:2,at:f.at,servedAt:f.at,buses:[[name,route.name,(ti-f.stopsAhead+seq.length)%seq.length,null]],rows:[[0,f.target,f.baseline.eta,f.baseline.low,f.baseline.high,f.stopsAhead,0,0,0]],distributions:[[]]};
 const applied=applyRouteK10Trial(applyK10Trial(wire,snapshot,routes['3']),snapshot,routes),row=applied.rows[0]!;
 const e=snapshot.get(name);if(e)assert(e.origin.knownAt<=f.asof&&e.observedAt<=f.asof);
 const changed=Boolean(applied.trial?.changedRows);
 if(changed)changes[route.name]=(changes[route.name]??0)+1;
 generated.push({...f,deployed:{eta:row[2],low:row[3],high:row[4]},deployedChanged:changed,deployedEvidence:e??null});
}
assert.equal(tracker.stats().errors,0);
fs.writeFileSync(out+'deployed.jsonl.gz',zlib.gzipSync(generated.map(r=>JSON.stringify(r)).join('\n')+'\n'));
fs.writeFileSync(out+'baseline-audit.json',JSON.stringify({rows:generated.length,changes,tracker:tracker.stats(),base:'86cb499a4e28'},null,2));
console.log(JSON.stringify({rows:generated.length,changes}));
