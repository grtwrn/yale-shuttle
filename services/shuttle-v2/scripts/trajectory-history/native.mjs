import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGunzip,constants} from 'node:zlib';
import {witnessSHA,witnessJSON} from '../../src/collector/witnessCodec.ts';
const MiB=1024*1024, hash=v=>/^[a-f0-9]{64}$/.test(v??''), integer=Number.isSafeInteger;
export const MINUTE=60000;

/** A fixed, read-only prefix of the recorder's flushed gzip stream. A partial
 * final JSON line waits for the next poll. Append-only bytes are checked against
 * the prior prefix; a shortened or replaced file never supplies continuity. */
export async function* nativeRecords(file,{previous,captureBytes,expectedFile,maxCompressedBytes=256*MiB,maxRawBytes=4*1024*MiB,maxLineBytes=8*MiB}={}){
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>maxCompressedBytes)throw Error('Invalid native input file');
 const length=captureBytes??st.size;if(!integer(length)||length<0||length>st.size||expectedFile&&(expectedFile.dev!==st.dev||expectedFile.ino!==st.ino))throw Error('Native captured prefix changed');
 if(previous&&(previous.bytes>length||previous.dev!==st.dev||previous.ino!==st.ino))throw Error('Native input prefix changed');
 if(length===0){yield{prefix:{file:path.basename(file),bytes:0,sha256:witnessSHA(''),dev:st.dev,ino:st.ino,completeLines:0,partialTail:false}};return;}
 const stream=fs.createReadStream(file,{start:0,end:length-1}),digest=createHash('sha256'),prior=createHash('sha256');let offset=0;
 stream.on('data',b=>{digest.update(b);if(previous&&offset<previous.bytes)prior.update(b.subarray(0,Math.min(b.length,previous.bytes-offset)));offset+=b.length;});
 const unzip=createGunzip({finishFlush:constants.Z_SYNC_FLUSH});stream.on('error',e=>unzip.destroy(e));stream.pipe(unzip);
 const decoder=new TextDecoder('utf-8',{fatal:true});let tail='',rawBytes=0,line=0;
 try{
  for await(const chunk of unzip){rawBytes+=chunk.length;if(rawBytes>maxRawBytes)throw Error('Native decompression bound exceeded');tail+=decoder.decode(chunk,{stream:true});let index;
   while((index=tail.indexOf('\n'))>=0){const raw=tail.slice(0,index);tail=tail.slice(index+1);if(Buffer.byteLength(raw)>maxLineBytes)throw Error('Native record exceeds bound');if(raw){line++;yield{record:JSON.parse(raw),line,rawSHA256:witnessSHA(raw)};}}
   if(Buffer.byteLength(tail)>maxLineBytes)throw Error('Native record exceeds bound');
  }
  if(offset!==length)throw Error('Native prefix read was incomplete');
  if(previous&&prior.digest('hex')!==previous.sha256)throw Error('Native input prefix changed');
  const after=fs.lstatSync(file);if(after.dev!==st.dev||after.ino!==st.ino||after.size<length)throw Error('Native input file changed');
  yield{prefix:{file:path.basename(file),bytes:length,sha256:digest.digest('hex'),dev:st.dev,ino:st.ino,completeLines:line,partialTail:tail.length>0}};
 }finally{stream.destroy();unzip.destroy();}
}

/** These are verified projections of original published frames, not an engine
 * replay. Entry clocks are first observed adjacent model transitions; neither
 * the collector's eventual departure nor a last-rest clock is backfilled. */
export class ModelProjection{
 constructor(state={},topologies=new Map(),onFrame=null){
  this.onFrame=onFrame;
  this.state=structuredClone(state);this.state.tracks??={};this.topologies=topologies;this.records=[];this.required=new Set();this.counts={frames:0,duplicates:0,selected:0,clockEntries:0,unknownContexts:0,idleReceipts:0,unavailableFrames:0,unavailableReceipts:0};
 }
 consume(packet,{cycle,sourceKey,receivedAt,rawSHA256}={}){
  if(!packet?.build){if(packet?.response?.status===409&&packet.response.body?.error==='evaluation_epoch')return;throw Error('Unsupported native record');}
  if(typeof packet.epoch!=='string'||!packet.epoch||typeof packet.build!=='string'||!Array.isArray(packet.frames))throw Error('Invalid native packet');
  for(const f of packet.frames){
   if(!integer(f.seq)||f.seq<1||!integer(f.at)||!hash(f.sha256)||!hash(f.contextSha256)||typeof f.json!=='string'||typeof f.contextJson!=='string'
    ||Buffer.byteLength(f.json)!==f.bytes||witnessSHA(f.json)!==f.sha256||Buffer.byteLength(f.contextJson)!==f.contextBytes||witnessSHA(f.contextJson)!==f.contextSha256)throw Error('Native frame commitment differs');
   const old=this.state.last;
   if(old?.epoch===packet.epoch&&f.seq<=old.cursor){if(f.seq===old.cursor&&(old.sha256!==f.sha256||old.contextSha256!==f.contextSha256))throw Error('Conflicting native cursor');this.counts.duplicates++;continue;}
   const payload=JSON.parse(f.json),context=JSON.parse(f.contextJson),wire=payload.server_eta,available=wire!=null,head=context.collectorWitness;
   if(context.at!==f.at||!Array.isArray(payload.buses)||(available&&(wire?.v!==2||wire.at!==f.at||wire.servedAt!==f.at||!Array.isArray(wire.buses)||!Array.isArray(wire.rows))))throw Error('Unsupported original forecast frame');
   const adjacent=old?.epoch===packet.epoch&&old.build===packet.build&&old.cycle===cycle&&old.cursor+1===f.seq&&f.at>old.at&&f.at-old.at<=30000;
   if(!adjacent){this.state.tracks={};this.records.push({kind:'model-boundary',at:f.at,epoch:packet.epoch,cursor:f.seq,previous:old??null,reason:old?'context-or-history-gap':'first-capture'});}
   const fresh=head?.status==='recorded'&&typeof head.epoch==='string'&&integer(head.seq)&&integer(head.at)&&head.at<=f.at&&f.at-head.at<30000&&hash(head.sha256)&&hash(head.topologySha256);
   const topology=fresh?this.topologies.get(head.topologySha256):null,groups=new Map();
   for(const b of payload.buses){const name=String(b.bus_name??'').replace(/^#/,'');if(!/^[A-Za-z0-9-]{1,24}$/.test(name))continue;const list=groups.get(name)??[];list.push(b);groups.set(name,list);}
   let changed=!!old&&(this.state.forecastAvailable??true)!==available;const buses=[];
   for(const name of Object.keys(this.state.tracks))if(!groups.has(name)){delete this.state.tracks[name];changed=true;}
   for(const[name,group]of groups){
    if(group.length!==1){delete this.state.tracks[name];this.counts.unknownContexts++;continue;}
    const b=group[0],anchors=(wire?.buses??[]).map((a,i)=>({a,i})).filter(x=>x.a[0]===name),route=topology?.decoded.routes.get(b.route_id),prior=Object.hasOwn(this.state.tracks,name)?this.state.tracks[name]:null;
    const valid=integer(b.bus_id)&&integer(b.route_id)&&Number.isFinite(b.lat)&&Math.abs(b.lat)<=90&&Number.isFinite(b.lon)&&Math.abs(b.lon)<=180
     &&integer(b.observed_at)&&Math.abs(b.observed_at-head?.at)<=5000&&anchors.length===1&&route&&integer(anchors[0].a[2])&&anchors[0].a[2]>=0&&anchors[0].a[2]<route.stops.length;
    let entry=null,reason=null;const anchor=anchors.length===1?anchors[0].a:null;
    if(!valid)reason=available?'missing-or-ambiguous-source-topology-observation-or-anchor':'missing-original-forecast';
    else if(!prior||prior.id!==b.bus_id||prior.route!==b.route_id||prior.topology!==head.topologySha256||prior.collectorEpoch!==head.epoch)reason='first-or-changed-vehicle-source-context';
    else if(prior.lead===anchor[2])entry=prior.entry;
    else{
     const delta=(anchor[2]-prior.lead+route.stops.length)%route.stops.length;changed=true;
     if(delta===1){entry={at:f.at,previousAt:prior.at,previousCursor:prior.cursor,previousModelSHA256:prior.sha256,previousAnchor:prior.anchor,modelSHA256:f.sha256,fromIndex:anchor[2],toIndex:(anchor[2]+1)%route.stops.length,scope:'First observed adjacent model transition; not physical departure.'};this.counts.clockEntries++;}
     else reason='non-adjacent-model-transition';
    }
    if(reason){this.counts.unknownContexts++;changed ||= !!valid||!!prior;}
    if(valid)this.state.tracks[name]={id:b.bus_id,route:b.route_id,collectorEpoch:head.epoch,topology:head.topologySha256,lead:anchor[2],entry,at:f.at,cursor:f.seq,sha256:f.sha256,anchor};else delete this.state.tracks[name];
    const forecasts=[];
    if(anchors.length===1)for(let i=0;i<wire.rows.length;i++){const row=wire.rows[i];if(row[0]!==anchors[0].i||row[5]>1)continue;if(!Array.isArray(row)||row.length<9||!row.slice(0,9).every(Number.isFinite)||row[5]<0)throw Error('Invalid original forecast row');
     const q=wire.distributions?.[i];if(q!==undefined&&(!Array.isArray(q)||q.length!==50||q.some((x,j)=>!Number.isFinite(x)||j>0&&x<q[j-1])))throw Error('Invalid original forecast quantiles');forecasts.push({row,quantiles:q??null});}
    buses.push({name,id:b.bus_id,route:b.route_id,observation:b,anchor,entry,clockReason:reason,forecasts});
   }
   if(Object.keys(this.state.tracks).length>128)throw Error('Model context bound exceeded');
   const bucket=Math.floor(f.at/MINUTE),selected=changed||!adjacent||bucket!==this.state.bucket;
   if(selected){this.records.push({kind:'model-projection',v:1,at:f.at,build:packet.build,epoch:packet.epoch,cursor:f.seq,sha256:f.sha256,contextSha256:f.contextSha256,contextJson:f.contextJson,cycle,sourceKey,forecastAvailable:available,buses,collector:head??null,selection:changed?'transition':!adjacent?'boundary':'minute',quantileGrid:'(i+0.5)/50; original rounded public quantiles'});if(fresh)this.required.add(head.epoch+':'+head.seq);this.counts.selected++;}
   this.state.bucket=bucket;this.state.idleService=false;this.state.forecastAvailable=available;this.state.forecastUnavailable=false;this.state.last={epoch:packet.epoch,build:packet.build,cycle,cursor:f.seq,at:f.at,sha256:f.sha256,contextSha256:f.contextSha256};this.counts.frames++;if(!available)this.counts.unavailableFrames++;
   this.onFrame?.({frame:f,buses});
  }
  if(packet.hasMore===false&&Array.isArray(packet.feed?.buses)){
   const empty=packet.feed.buses.length===0&&packet.feed.server_eta==null;
   if(!integer(receivedAt)||!integer(packet.responseAt)||receivedAt-packet.responseAt>120000||packet.responseAt>receivedAt+5000||!hash(rawSHA256)||!integer(packet.cursor)||packet.cursor<1)throw Error(empty?'Invalid empty-feed receipt':'Invalid original feed receipt');
   const old=this.state.feedReceipt??[this.state.idleReceipt,this.state.forecastUnavailableReceipt].filter(r=>r?.epoch===packet.epoch).sort((a,b)=>b.receivedAt-a.receivedAt)[0];
   if(old?.epoch===packet.epoch&&receivedAt<=old.receivedAt){if(receivedAt===old.receivedAt&&old.recordSHA256!==rawSHA256)throw Error('Conflicting original feed receipt');return;}
   if(this.state.last?.epoch===packet.epoch&&receivedAt<this.state.last.at)return;
   if(this.state.last?.epoch===packet.epoch&&this.state.last.cursor!==packet.cursor)throw Error('Original feed cursor differs');
   this.state.feedReceipt={epoch:packet.epoch,cursor:packet.cursor,receivedAt,responseAt:packet.responseAt,recordSHA256:rawSHA256};
  }
  if(packet.hasMore===false&&Array.isArray(packet.feed?.buses)&&packet.feed.buses.length===0&&packet.feed.server_eta==null){
   if(!integer(receivedAt)||!integer(packet.responseAt)||receivedAt-packet.responseAt>120000||packet.responseAt>receivedAt+5000||!hash(rawSHA256)||!integer(packet.cursor)||packet.cursor<1)throw Error('Invalid empty-feed receipt');
   const old=this.state.idleReceipt;
   if(old?.epoch===packet.epoch&&receivedAt<=old.receivedAt){if(receivedAt===old.receivedAt&&old.recordSHA256!==rawSHA256)throw Error('Conflicting empty-feed receipt');return;}
   if(this.state.last?.epoch===packet.epoch&&receivedAt<this.state.last.at)return;
   if(this.state.last?.epoch===packet.epoch&&this.state.last.cursor!==packet.cursor)throw Error('Empty-feed cursor differs');
   const receipt={receivedAt,responseAt:packet.responseAt,recordSHA256:rawSHA256,epoch:packet.epoch,cursor:packet.cursor,emptyFleet:true,hasServerEta:false};
   const bucket=Math.floor(receivedAt/MINUTE);if(!this.state.idleService||this.state.idleBucket!==bucket)this.records.push({kind:'empty-feed-receipt',v:1,at:receivedAt,build:packet.build,cycle,sourceKey,...receipt,scope:'Original fresh empty GPS feed; no physical service/end-of-day verdict.'});
   this.state.tracks={};this.state.idleService=true;this.state.forecastUnavailable=false;this.state.idleBucket=bucket;this.state.idleReceipt=receipt;this.counts.idleReceipts++;
  }else if(packet.hasMore===false&&Array.isArray(packet.feed?.buses)){
   const observations=packet.feed.buses.filter(b=>Number.isSafeInteger(b.bus_id)&&Number.isSafeInteger(b.route_id)&&/^#?[A-Za-z0-9-]{1,24}$/.test(b.bus_name??'')
    &&Number.isFinite(b.lat)&&Math.abs(b.lat)<=90&&Number.isFinite(b.lon)&&Math.abs(b.lon)<=180&&integer(b.observed_at)&&b.observed_at<=packet.responseAt&&packet.responseAt-b.observed_at<45000)
    .map(b=>({busId:b.bus_id,busName:b.bus_name,routeId:b.route_id,observedAt:b.observed_at,lat:b.lat,lon:b.lon}));
   if(packet.feed.server_eta!=null||!observations.length){this.state.forecastUnavailable=false;this.state.idleService=false;return;}
   if(packet.feed.buses.length>200||!integer(receivedAt)||!integer(packet.responseAt)||receivedAt-packet.responseAt>120000||packet.responseAt>receivedAt+5000||!hash(rawSHA256)||!integer(packet.cursor)||packet.cursor<1)throw Error('Invalid forecast-unavailable receipt');
   const old=this.state.forecastUnavailableReceipt;
   if(old?.epoch===packet.epoch&&receivedAt<=old.receivedAt){if(receivedAt===old.receivedAt&&old.recordSHA256!==rawSHA256)throw Error('Conflicting forecast-unavailable receipt');return;}
   if(this.state.last?.epoch===packet.epoch&&receivedAt<this.state.last.at)return;
   if(this.state.last?.epoch===packet.epoch&&this.state.last.cursor!==packet.cursor)throw Error('Forecast-unavailable cursor differs');
   const receipt={receivedAt,responseAt:packet.responseAt,recordSHA256:rawSHA256,epoch:packet.epoch,cursor:packet.cursor,emptyFleet:false,hasServerEta:false,freshGpsBuses:observations.length,observations};
   const bucket=Math.floor(receivedAt/MINUTE);if(!this.state.forecastUnavailable||this.state.unavailableBucket!==bucket)this.records.push({kind:'forecast-unavailable-feed-receipt',v:1,at:receivedAt,build:packet.build,cycle,sourceKey,...receipt,scope:'Original fresh GPS feed without an arrival forecast; not an empty fleet, new model frame or physical service verdict.'});
   this.state.tracks={};this.state.idleService=false;this.state.forecastUnavailable=true;this.state.unavailableBucket=bucket;this.state.forecastUnavailableReceipt=receipt;this.counts.unavailableReceipts++;
  }
 }
}
