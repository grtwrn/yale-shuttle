/** Causal feature replay. Outcome visits and legs are deliberately NOT read. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {TransitNetwork} from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import {planTracks, reconcileTracks} from '../../services/shuttle-v2/src/collector/detector.ts';
import {stepManyWithVisits, pruneVisits} from '../../services/shuttle-v2/src/collector/departure.ts';

const dir = new URL('.', import.meta.url).pathname;
const downstream = process.env.REPLAY_SCOPE==='downstream';
const outputDir=dir+'results'+(downstream?'/multistop':'');
const input = (name:string) => zlib.gunzipSync(fs.readFileSync(dir+'data/'+name+'.jsonl.gz')).toString().trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
const top = JSON.parse(fs.readFileSync(dir+'data/topology.json','utf8'));
const net = TransitNetwork.build(top.stops,[top.route]);
const seq:number[] = top.route.stops;
const targets=downstream?seq.slice(15):[48,4];
const raw = input('raw_positions').sort((a,b)=>a.collected_at-b.collected_at || a.bus_id-b.bus_id);
const predictions = input(downstream?'multistop_predictions':'predictions_log');
const byDay = Map.groupBy(raw.filter(r=>r.day>='2026-09-16'),r=>r.day);
const preds = new Map<string,any>();
let duplicatePredictions=0;
for (const p of predictions) {
  const key = `${p.predicted_at}|${p.bus_name}|${p.to_stop_id}`;
  const old=preds.get(key);
  if(old){duplicatePredictions++; if(old.surface==='trip')continue;}
  preds.set(key,p);
}

function replay(rows:any[], day:string, delay=0, end=Infinity) {
  const states:any=new Map(), visits:any=new Map();
  const history=new Map<string,Map<number,any>>(), warm=new Map<string,any>();
  const releases=new Map<string,any[]>();
  const times=new Set<number>();
  for(let at=Math.ceil(rows[0].collected_at/30000)*30000;at<=Math.min(rows.at(-1).collected_at,end);at+=30000)times.add(at);
  for(const p of predictions)if(p.day===day && p.predicted_at<=end)times.add(p.predicted_at);
  const out:any[]=[];
  let cursor=0, emittedVisits=0;
  for(const at of [...times].sort((a,b)=>a-b)) {
    const asof=at-delay;
    while(cursor<rows.length && rows[cursor].collected_at<=asof) {
      const time=rows[cursor].collected_at, group:any[]=[];
      while(cursor<rows.length && rows[cursor].collected_at===time)group.push(rows[cursor++]);
      const obs=group.map(r=>({busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:r.collected_at}));
      for(const o of obs){
        const w=warm.get(o.busName);
        if(!w || time-w.last>60000){
          warm.set(o.busName,{first:time,last:time});history.delete(o.busName);releases.delete(o.busName);
          for(const[k,s]of states)if(s.busName===o.busName){states.delete(k);visits.delete(k);}
        }else w.last=time;
      }
      const plan=planTracks(obs);
      reconcileTracks(states,plan);reconcileTracks(visits,plan);
      pruneVisits(visits,states);
      const result=stepManyWithVisits(net,states,visits,obs,plan);
      for(const e of result.visits){
        if(e.kind!=='visit' || e.routeId!==3 || e.how==='gap' || e.departedAt===null || e.arrivedAt===null || e.outcome==='unresolved')continue;
        assert(e.departedAt<=time);
        let h=history.get(e.busName);if(!h)history.set(e.busName,h=new Map());
        h.set(e.stopIndex,{stop:e.stopId,index:e.stopIndex,arrived:e.arrivedAt,departed:e.departedAt,anchored:e.anchoredAt,knownAt:time,stand:e.standSec});
        if(e.stopIndex===14 || (e.stopIndex===13 && e.standSec!==null && e.standSec>=300)){
          // Replace the array so later departures cannot mutate earlier features.
          releases.set(e.busName,[...(releases.get(e.busName)??[]).filter(r=>time-r.departed<=2700000),h.get(e.stopIndex)]);
        }
        emittedVisits++;
      }
    }
    for(const [key,s]of states){
      const w=warm.get(s.busName);
      if(!w || asof-s.lastObservedAt>15000 || s.lastObservedAt>asof || asof-w.first<600000)continue;
      const v=visits.get(key), pass=v?.pass;
      let phase='unknown', index=-1, began=0;
      if(pass && pass.arrivedAt!==null){phase='hold';index=pass.stopIndex;began=pass.arrivedAt;}
      else if(v?.transit){phase='drive';index=v.transit.fromIndex;began=v.transit.departedAt;}
      if(index<8 || index>(downstream?27:19) || began>asof)continue;
      const h=history.get(s.busName)??new Map();
      const origins:any={};
      for(const [i,e]of h){
        if(i>=4 && i<=(downstream?27:12) && i<=index && e.departed<=began && e.knownAt<=asof && at-e.departed<=2700000)origins[i]=e;
      }
      const canal=h.get(13);
      for(const target of targets) {
        const ti=seq.indexOf(target);
        if(index>=ti)continue;
        const base=preds.get(`${at}|${s.busName}|${target}`);
        const b=base && base.stops_ahead>0 && base.stops_ahead<seq.length
          ? {eta:base.predicted_sec,low:base.predicted_low_sec,high:base.predicted_high_sec,stopsAhead:base.stops_ahead,build:base.client_build,surface:base.surface} : null;
        const targetDeparture=h.get(ti);
        const currentOrigins=Object.fromEntries(Object.entries(origins).filter(([,e]:any)=>!targetDeparture || targetDeparture.departed<e.departed));
        // Follow-up anchors are separate: preserve the original outcome-matching
        // origins and all existing model inputs. These remain causal observations.
        const checkpointOrigins:any={},checkpointArrivals:any={};
        for(const [i,e]of h){
          if(i<0 || i>(downstream?27:13) || i>index || e.departed>began || e.knownAt>asof || at-e.departed>2700000)continue;
          if(targetDeparture && targetDeparture.departed>=e.arrived)continue;
          checkpointOrigins[i]=e;
          checkpointArrivals[i]={...e,departed:e.arrived};
        }
        if(pass && pass.arrivedAt!==null && pass.stopIndex<=(downstream?27:13) && pass.arrivedAt<=asof && at-pass.arrivedAt<=2700000 && (!targetDeparture || targetDeparture.departed<pass.arrivedAt)){
          checkpointArrivals[pass.stopIndex]={stop:pass.stopId,index:pass.stopIndex,arrived:pass.arrivedAt,departed:pass.arrivedAt,knownAt:s.lastObservedAt,active:true};
        }
        const compact=(entries:any)=>Object.fromEntries(Object.entries(entries).map(([i,e]:any)=>[i,{departed:e.departed,knownAt:e.knownAt}]));
        out.push({at,asof,day,bus:s.busName,busId:s.busId,target,index,nearestIndex:s.nearestIndex,phase,began,age:(at-began)/1000,observedAt:s.lastObservedAt,
          lat:s.lat,lon:s.lon,origins:downstream?compact(currentOrigins):currentOrigins,checkpointOrigins:downstream?compact(checkpointOrigins):checkpointOrigins,checkpointArrivals:downstream?{}:checkpointArrivals,releaseEvents:releases.get(s.busName)??[],canal:canal && canal.knownAt<=asof?canal:null,baseline:b,dense:at%30000===0});
      }
    }
  }
  return {rows:out,emittedVisits};
}
fs.mkdirSync(outputDir,{recursive:true});
const out:any[]=[], delayed:any[]=[], audits:any[]=[];
for(const[day,rows]of byDay){
  const a=replay(rows,day);const b=replay(rows,day,15000);
  const midpoint=rows[Math.floor(rows.length/2)].collected_at;
  const prefix=replay(rows.filter(r=>r.collected_at<=midpoint),day,0,midpoint);
  const expected=a.rows.filter(r=>r.at<=midpoint);
  // Input prefix may end before a scheduled origin; use its last observed clock.
  assert.deepEqual(prefix.rows,expected.filter(r=>r.at<=rows.filter(r=>r.collected_at<=midpoint).at(-1).collected_at));
  for(const r of a.rows)for(const group of [r.origins,r.checkpointOrigins,r.checkpointArrivals])for(const e of Object.values(group) as any[])assert(e.knownAt<=r.asof && e.departed<=r.asof);
  for(const r of a.rows)for(const e of r.releaseEvents)assert((e.index===14 || (e.index===13 && e.stand>=300)) && e.knownAt<=r.asof && e.departed<=r.asof);
  out.push(...a.rows);delayed.push(...b.rows);
  audits.push({day,rawRows:rows.length,features:a.rows.length,delayedFeatures:b.rows.length,emittedVisits:a.emittedVisits,prefixRows:prefix.rows.length,prefixInvariant:true});
}
for(const[name,rows]of [['features',out],['features-delay15',delayed]] as const){
  const path=outputDir+'/'+name+'.jsonl.gz';
  fs.writeFileSync(path,'');
  // Concatenated gzip members are a standard gzip stream, read transparently
  // by Python gzip and Node gunzip. Bound each temporary string's size.
  for(let start=0;start<rows.length;start+=500){
    fs.appendFileSync(path,zlib.gzipSync(rows.slice(start,start+500).map(r=>JSON.stringify(r)).join('\n')+'\n'));
  }
}
const hash=(rows:any[])=>{
  const h=crypto.createHash('sha256');h.update('[');
  for(let i=0;i<rows.length;i++){if(i)h.update(',');h.update(JSON.stringify(rows[i]));}
  h.update(']');return h.digest('hex');
};
fs.writeFileSync(outputDir+'/replay-audit.json',JSON.stringify({audits,duplicatePredictions,featureHash:hash(out),delayedHash:hash(delayed),note:'Current production detector/departure reducers, chronological raw observations only. No outcome table enters features. Red-only replay resets each day and after a per-bus gap over60s; ten-minute warmup required. Logged forecast clocks are15s buckets.'},null,2));
console.log(JSON.stringify(audits));
