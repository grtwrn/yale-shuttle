/** Rebuild Orange visits from raw GPS, independently of stored visit timestamps. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks,reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits} from '../../services/shuttle-v2/src/collector/departure.ts';
const base='research/k-sweep/results/';
const read=(name:string)=>zlib.gunzipSync(fs.readFileSync(base+name+'.jsonl.gz')).toString().trim().split('\n').map(s=>JSON.parse(s));
const names=new Set(read('stop_visits').filter(v=>[2,14].includes(v.route_id)).map(v=>v.bus_name));
const top=JSON.parse(fs.readFileSync('research/k-sweep/data/topology.json','utf8'));
const net=TransitNetwork.build(top.stops,top.routes),raw:any[]=[];
for await(const line of readline.createInterface({input:fs.createReadStream(base+'raw_positions.jsonl.gz').pipe(zlib.createGunzip())})){
 const r=JSON.parse(line);if(names.has(r.bus_name))raw.push(r);
}
raw.sort((a,b)=>a.collected_at-b.collected_at||a.bus_id-b.bus_id);
const states:any=new Map(),visits:any=new Map(),previous=new Map<string,any>(),events:any[]=[],resets:any[]=[];
let cursor=0;
while(cursor<raw.length){
 const at=raw[cursor].collected_at,obs:any[]=[];
 while(cursor<raw.length&&raw[cursor].collected_at===at){const r=raw[cursor++];obs.push({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:at});}
 const plan=planTracks(obs);
 for(const o of obs){
  const p=previous.get(o.busName),reason=p&&(at-p.collectedAt>60000?'gap':p.routeId!==o.routeId?'route':plan.contendedNames.has(o.busName)?'contended':null);
  if(reason){resets.push({bus:o.busName,at,previousAt:p.collectedAt,from:p.routeId,to:o.routeId,reason});for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}}
  previous.set(o.busName,o);
 }
 reconcileTracks(states,plan);reconcileTracks(visits,plan);
 const result=stepManyWithVisits(net,states,visits,obs,plan);
 for(const e of result.visits)if(e.kind==='visit'&&[2,14].includes(e.routeId))events.push({...e,knownAt:at});
}
fs.mkdirSync(base+'orange-audit',{recursive:true});
fs.writeFileSync(base+'orange-audit/rebuilt-visits.jsonl.gz',zlib.gzipSync(events.map(e=>JSON.stringify(e)).join('\n')+'\n'));
fs.writeFileSync(base+'orange-audit/resets.json',JSON.stringify(resets));
console.log(JSON.stringify({raw:raw.length,events:events.length,resets:resets.length}));
