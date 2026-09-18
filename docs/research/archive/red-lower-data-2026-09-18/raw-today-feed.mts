/** Reconstruct recorded five-second Red polls using production collector reducers.
 * Read-only outcome DB; no future history seeds, no network and no persistence.
 */
import fs from'node:fs';import{pathToFileURL}from'node:url';
const root=process.cwd(),dir='/home/gwarren/projects/yale-shuttle-watcher/red-lower-data-2026-09-18';
const load=async(p:string)=>import(pathToFileURL(root+'/'+p).href);
const{loadNet}=await load('scripts/eta-replay/common.ts');const{Collector}=await load('src/collector/collector.ts');
const{planTracks,reconcileTracks}=await load('src/collector/detector.ts');const{stepManyWithVisits,pruneVisits}=await load('src/collector/departure.ts');
const net=loadNet();const rows=net.db.prepare("SELECT * FROM raw_positions WHERE route_id=3 AND collected_at>=? ORDER BY collected_at,id").all(Date.parse('2026-09-18T04:00:00Z'));
const groups:any[][]=[];for(const r of rows){let g=groups.at(-1);if(!g||g[0].collected_at!==r.collected_at)groups.push(g=[]);g.push(r);}
const fresh=()=>Object.assign(Object.create(Collector.prototype),{ref:{get:()=>net.network},states:new Map(),visitStates:new Map(),livePositions:new Map(),lapClock:new Map(),version:0,observationCounter:0});
let collector=fresh(),prev=0,segment=0,events=0;const fd=fs.openSync(dir+'/raw-today-frames.jsonl','w');const gapEvents:any[]=[];
for(const g of groups){
 const at=g[0].collected_at;if(!prev||at-prev>1800000){collector=fresh();segment++;gapEvents.push({at,gapMs:prev?at-prev:null});}
 const obs=g.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:r.collected_at}));
 const plan=planTracks(obs);reconcileTracks(collector.livePositions,plan);
 for(const[k,b]of collector.livePositions)if(b.collectedAt<at-120000)collector.livePositions.delete(k);
 for(const[k,s]of collector.states)if(s.lastObservedAt<at-1800000)collector.states.delete(k);
 pruneVisits(collector.visitStates,collector.states);
 const result=stepManyWithVisits(net.network,collector.states,collector.visitStates,obs,plan);
 for(const e of result.events)if(e.kind==='dwell'){collector.noteDeparture(e.busName,e.stopId,e.leftAt);events++;}
 collector.updateLivePositions(obs,plan);
 const buses=[...collector.livePositions.values()].map((b:any)=>{
  const naive=(t:number)=>new Date(t).toISOString().replace(/Z$/,'');const ages=collector.lapAges(b.busName,at);const lap:any={};
  for(const stop of [11,121])if(ages?.[String(stop)]!==undefined)lap[stop]=ages[String(stop)];
  return{observed_at:b.collectedAt,bus_id:b.busId,bus_name:b.busName,route_id:b.routeId,lat:b.lat,lon:b.lon,heading:b.heading,last_stop_id:b.lastStopId,stationary:b.atStopId!=null,
   ...(b.atStopId!=null?{at_stop_id:b.atStopId}:{}),...(b.atStopSince!=null?{at_stop_since:naive(b.atStopSince)}:{}),...(b.stationarySince!=null?{stationary_since:naive(b.stationarySince)}:{}),...(b.lastMovedAt!=null?{last_moved_at:naive(b.lastMovedAt)}:{}),...(Object.keys(lap).length?{lap}:{})};
 });
 fs.writeSync(fd,JSON.stringify({at:new Date(at).toISOString(),runId:'raw-'+segment,buses})+'\n');prev=at;
}
fs.closeSync(fd);net.db.close();console.log(JSON.stringify({rows:rows.length,polls:groups.length,legacyDepartureEvents:events,gapEvents,note:'Actual stepManyWithVisits and Collector.updateLivePositions/noteDeparture/lapAges; wire serializer mirrors v1compat; history seeds absent at capture start, score only warmed segments. No future outcome labels used to produce observations.'}));
