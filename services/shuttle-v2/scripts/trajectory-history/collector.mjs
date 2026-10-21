import fs from 'node:fs';import {createRequire} from 'node:module';import {gunzipSync} from 'node:zlib';
import {witnessJSON,witnessSHA} from '../../src/collector/witnessCodec.ts';
import {decodeWitness,validatePage} from '../collector-witness-watch/protocol.mjs';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),MiB=1024*1024;

/** Copy bounded original buffers inside a short read-only transaction. Decode
 * after COMMIT so a large archive never blocks the live collector recorder. */
export function collectorSnapshot(file,{since=Date.now()-2*3600000,maxBytes=16*MiB}={}){
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid collector database');
 const db=new DatabaseSync(file,{readOnly:true});let chunks,topologies,finished;const started=Date.now();
 try{db.exec('PRAGMA busy_timeout=1000;BEGIN');
  if(db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Unsupported collector store');
  const bounds=db.prepare('SELECT count(*) n,coalesce(sum(length(payload)),0) bytes FROM chunks WHERE end_at>=?').get(since);
  if(bounds.n>512||bounds.bytes>maxBytes)throw Error('Collector snapshot bound exceeded');
  const topologyBounds=db.prepare('SELECT count(*) n,coalesce(sum(length(payload)),0) bytes FROM topologies').get();if(topologyBounds.n>64||topologyBounds.bytes>2*MiB)throw Error('Collector topology bound exceeded');
  const rows=db.prepare('SELECT * FROM chunks WHERE end_at>=? ORDER BY start_at,first,key').all(since);let bytes=0;
  chunks=rows.map(r=>{bytes+=r.payload.length;if(bytes>maxBytes||rows.length>512)throw Error('Collector snapshot bound exceeded');return{...r,payload:Buffer.from(r.payload)};});
  topologies=db.prepare('SELECT * FROM topologies').all().map(r=>({...r,payload:Buffer.from(r.payload)}));
  if(topologies.length>64||topologies.reduce((s,t)=>s+t.payload.length,0)>2*MiB)throw Error('Collector topology bound exceeded');
  db.exec('COMMIT');finished=Date.now();
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
 const dictionary=new Map();for(const t of topologies){const json=gunzipSync(t.payload,{maxOutputLength:2*MiB}).toString();if(witnessSHA(json)!==t.sha||Buffer.byteLength(json)!==t.bytes)throw Error('Collector topology commitment differs');dictionary.set(t.sha,{sha256:t.sha,bytes:t.bytes,json,decoded:decodeWitness(json)});}
 return{chunks,topologies:dictionary,transactionMs:finished-started};
}

export class CollectorProjection{
 constructor(state={},required=new Set()){
  this.state=structuredClone(state);this.state.tracks??={};this.required=new Set(required);this.records=[];this.topologyHashes=new Set();this.counts={frames:0,selected:0,sourceWrites:0,boundaries:0};
 }
 consume(snapshot){
  for(const stored of snapshot.chunks){
   const raw=gunzipSync(stored.payload,{maxOutputLength:20*1024*1024}).toString();if(witnessSHA(raw)!==stored.raw_sha)throw Error('Stored collector page differs');const p=JSON.parse(raw);
   if(witnessSHA(witnessJSON({epoch:p.epoch,build:p.build,frames:p.frames,evaluations:p.evaluations??[]}))!==stored.key)throw Error('Stored collector page identity differs');
   const first=p.frames[0],last=p.frames.at(-1);if(!first||!last)throw Error('Empty collector page');
   const used=[...new Set(p.frames.map(f=>f.topologySha256).filter(Boolean))].map(s=>{const t=snapshot.topologies.get(s);if(!t)throw Error('Collector topology unavailable');return t;});
   const verified=validatePage({...p,v:1,cursor:last.seq,latest:last.seq,hasMore:false,topologies:used},{epoch:p.epoch,build:p.build,after:first.seq-1,at:first.at-1,chain:first.previousChain});
   for(const{frame:f,input,topology}of verified.frames){
    const old=this.state.last;
    if(old?.epoch===p.epoch&&f.seq<=old.seq){
     if(f.seq===old.seq&&f.sha256!==old.sha256)throw Error('Conflicting collector cursor');
     if(this.required.has(p.epoch+':'+f.seq)){
      const safe=f.status==='recorded'&&input.pollResult==='completed'&&input.sourceWriteEvidence==='recorded'&&topology,decoded=safe?decodeWitness(input.stateAfterJSON):null,{json,...header}=f;
      const buses=safe?input.observations.map(obs=>({name:obs.busName,observation:obs,clock:null,clockReason:'late-source-binding-does-not-reconstruct-past-clock',trackJSON:decoded.states?.has(obs.busName)?witnessJSON(decoded.states.get(obs.busName)):null,visitJSON:decoded.visits?.has(obs.busName)?witnessJSON(decoded.visits.get(obs.busName)):null})):[];
      this.records.push({kind:'collector-projection',v:1,at:f.at,epoch:p.epoch,build:p.build,header,pollResult:input.pollResult,sourceWriteEvidence:input.sourceWriteEvidence,stateAfterSHA256:input.stateAfterSHA256,buses,mutations:[],evaluations:verified.evaluations.filter(a=>a.collectorSeq===f.seq),selection:'late-model-reference'});if(f.topologySha256)this.topologyHashes.add(f.topologySha256);this.required.delete(p.epoch+':'+f.seq);this.counts.selected++;
     }continue;
    }
    if(old&&f.at<old.at)continue; // An overlapping older page was already covered.
    const fence=old?.inputAfter,inputBefore=input.inputBefore,adjacent=old?.epoch===p.epoch&&old.seq+1===f.seq&&f.at>old.at&&f.at-old.at<=30000
     &&f.previousChain===old.chain&&fence&&inputBefore&&fence.epoch===inputBefore.epoch&&fence.revision===inputBefore.revision;
    const safe=f.status==='recorded'&&input.pollResult==='completed'&&input.sourceWriteEvidence==='recorded'&&topology;
    if(!adjacent||!safe){this.state.tracks={};this.records.push({kind:'collector-boundary',at:f.at,epoch:p.epoch,seq:f.seq,sha256:f.sha256,reason:!safe?'unavailable-source':old?'source-context-gap':'first-capture'});this.counts.boundaries++;}
    const mutations=[];for(const w of input.sourceWrites??[])for(const m of w.mutations??[]){if(!['legs','stopVisits','stop_visits'].includes(m.table))continue;if(witnessSHA(m.afterJSON)!==m.afterSHA256)throw Error('Original source row differs');mutations.push(m);}
    let changed=false;const buses=[];
    if(safe){const state=decodeWitness(input.stateAfterJSON),groups=new Map();
     for(const obs of input.observations){if(typeof obs.busName!=='string'||!/^#?[A-Za-z0-9-]{1,24}$/.test(obs.busName))continue;const list=groups.get(obs.busName)??[];list.push(obs);groups.set(obs.busName,list);}
     for(const name of Object.keys(this.state.tracks))if(!groups.has(name)){delete this.state.tracks[name];changed=true;}
     for(const[name,group]of groups){if(group.length!==1){delete this.state.tracks[name];continue;}const obs=group[0],visit=state.visits?.get(name),track=state.states?.get(name),route=topology.decoded.routes.get(obs.routeId);let prior=Object.hasOwn(this.state.tracks,name)?this.state.tracks[name]:null,clock=null;
      if(!prior||prior.id!==obs.busId||prior.route!==obs.routeId||prior.topology!==f.topologySha256){prior={id:obs.busId,route:obs.routeId,topology:f.topologySha256,startedAt:f.at,transit:null};changed=true;}
      const t=visit?.transit,valid=visit?.busId===obs.busId&&track?.busId===obs.busId&&visit?.routeId===obs.routeId&&track?.routeId===obs.routeId&&track.lastObservedAt===f.at&&obs.collectedAt===f.at&&route;
      if(valid&&t&&Number.isSafeInteger(t.fromIndex)&&t.fromIndex>=0&&t.fromIndex<route.stops.length&&Number.isSafeInteger(t.departedAt)&&t.departedAt<=f.at){
       const key=t.fromIndex+':'+t.departedAt;if(prior.transit?.key!==key){prior.transit={key,knownAt:f.at};changed=true;}
       clock={fromIndex:t.fromIndex,toIndex:(t.fromIndex+1)%route.stops.length,departedAt:t.departedAt,knownAt:prior.transit.knownAt,leftCensored:t.departedAt<prior.startedAt,contextStartedAt:prior.startedAt};
      }else if(prior.transit){prior.transit=null;changed=true;}
      this.state.tracks[name]=prior;buses.push({name,observation:obs,clock,trackJSON:track?witnessJSON(track):null,visitJSON:visit?witnessJSON(visit):null});
     }
    }
    if(Object.keys(this.state.tracks).length>128)throw Error('Collector context bound exceeded');
    const bucket=Math.floor(f.at/60000),required=this.required.has(p.epoch+':'+f.seq);
    if(required||mutations.length||changed||!adjacent||!safe||bucket!==this.state.bucket){const{json,...header}=f;this.records.push({kind:'collector-projection',v:1,at:f.at,epoch:p.epoch,build:p.build,header,inputBefore:input.inputBefore,inputAfter:input.inputAfter,pollResult:input.pollResult,sourceWriteEvidence:input.sourceWriteEvidence,stateAfterSHA256:input.stateAfterSHA256,buses,mutations,evaluations:verified.evaluations.filter(a=>a.collectorSeq===f.seq),selection:required?'model-reference':mutations.length?'source-writes':changed?'transition':'minute'});if(f.topologySha256)this.topologyHashes.add(f.topologySha256);this.required.delete(p.epoch+':'+f.seq);this.counts.selected++;this.counts.sourceWrites+=mutations.length;}
    this.state.bucket=bucket;this.state.last={epoch:p.epoch,seq:f.seq,at:f.at,sha256:f.sha256,chain:f.chain,inputAfter:input.inputAfter??null};this.counts.frames++;
   }
  }
 }
}
