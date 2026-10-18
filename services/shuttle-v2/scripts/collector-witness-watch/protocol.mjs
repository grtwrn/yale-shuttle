import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';

export function decodeWitness(text) {
  const refs=[];
  function read(n) {
    if(!Array.isArray(n)||typeof n[0]!=='string')throw Error('Malformed witness graph');
    const[t,a,b]=n;
    if(t==='null'&&n.length===1)return null;
    if(t==='undefined'&&n.length===1)return undefined;
    if(['string','boolean'].includes(t)&&n.length===2&&typeof a===t)return a;
    if(t==='f64'&&n.length===2&&typeof a==='string'&&/^[a-f0-9]{16}$/.test(a)) {
      const v=Buffer.from(a,'hex').readDoubleBE();if(!Number.isFinite(v))throw Error('Nonfinite witness');return v;
    }
    if(t==='ref'&&n.length===2&&Number.isSafeInteger(a)&&a>=0&&a<refs.length)return refs[a];
    if(n.length!==3||a!==refs.length||!['date','array','map','set','object'].includes(t))throw Error('Invalid witness reference');
    if(t==='date'){const v=new Date(0);refs.push(v);v.setTime(read(b));return v;}
    if(!Array.isArray(b))throw Error('Malformed witness container');
    const v=t==='array'?[]:t==='map'?new Map():t==='set'?new Set():{};refs.push(v);
    for(const item of b) {
      if(t==='array')v.push(read(item));else if(t==='set')v.add(read(item));else {
        if(!Array.isArray(item)||item.length!==2)throw Error('Malformed witness entry');
        if(t==='map')v.set(read(item[0]),read(item[1]));
        else {if(typeof item[0]!=='string'||Object.hasOwn(v,item[0]))throw Error('Duplicate witness key');
          Object.defineProperty(v,item[0],{value:read(item[1]),writable:true,enumerable:true,configurable:true});}
      }
    }
    return v;
  }
  const value=read(JSON.parse(text));
  if(witnessJSON(value)!==text)throw Error('Noncanonical witness bytes');
  return value;
}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
export function validHead(h) {
  return !!h&&h.v===1&&typeof h.epoch==='string'&&h.epoch.length>0&&h.epoch.length<=100
    &&typeof h.build==='string'&&h.build.length>0&&h.build.length<=100&&integer(h.latest)
    &&integer(h.oldest)&&h.oldest>=1&&h.oldest<=h.latest+1&&hash(h.chain)
    &&(h.unavailable===null||typeof h.unavailable==='string')
    &&typeof h.evaluationEpoch==='string'&&h.evaluationEpoch.length>0&&h.evaluationEpoch.length<=100&&integer(h.evaluationCursor);
}
function topology(t) {
  if(!t||!hash(t.sha256)||typeof t.json!=='string'||Buffer.byteLength(t.json)!==t.bytes||t.bytes>2*1024*1024||witnessSHA(t.json)!==t.sha256)throw Error('Topology bytes differ');
  const decoded=decodeWitness(t.json);
  for(const key of ['stops','routes','segmentEdges','walkTransfers','routeStopIndex','routeStopPositions','legMeters'])if(!(decoded?.[key]instanceof Map))throw Error('Incomplete witness topology');
  for(const stop of decoded.stops.values())if(!stop||!Number.isFinite(stop.lat)||Math.abs(stop.lat)>90||!Number.isFinite(stop.lon)||Math.abs(stop.lon)>180)throw Error('Invalid topology coordinates');
  return {...t,decoded};
}
export function validatePage(page,checkpoint,topologies=new Map()) {
  if(!page||page.v!==1||page.epoch!==checkpoint.epoch||page.build!==checkpoint.build
    ||!integer(page.cursor)||!integer(page.latest)||page.latest<page.cursor
    ||page.hasMore!==(page.cursor<page.latest)||!Array.isArray(page.frames)||page.frames.length>16
    ||page.cursor!==checkpoint.after+page.frames.length||!Array.isArray(page.topologies))throw Error('Malformed witness page/cursor');
  const learned=new Map([...topologies].map(([key,t])=>{if(key!==t.sha256)throw Error('Conflicting topology key');return[key,topology(t)];}));
  for(const t of page.topologies) {
    const checked=topology(t),prior=learned.get(t.sha256);if(prior&&prior.json!==t.json)throw Error('Conflicting topology identity');learned.set(t.sha256,checked);
  }
  let after=checkpoint.after,at=checkpoint.at??-1,chain=checkpoint.chain;const frames=[];
  for(const f of page.frames) {
    if(!f||f.seq!==++after||!integer(f.at)||f.at<=at||typeof f.json!=='string'||Buffer.byteLength(f.json)!==f.bytes||f.bytes>512*1024
      ||!hash(f.sha256)||witnessSHA(f.json)!==f.sha256||!hash(f.previousChain)||!hash(f.chain)
      ||!['recorded','unavailable'].includes(f.status)||f.topologySha256!==null&&!hash(f.topologySha256))throw Error('Invalid witness frame');
    if(chain!==null&&f.previousChain!==chain)throw Error('Missing or forked collector witness');
    const expected=witnessSHA(witnessJSON([f.previousChain,f.seq,f.at,f.sha256,f.topologySha256,f.status]));if(f.chain!==expected)throw Error('Collector witness chain differs');
    if(f.topologySha256!==null&&!learned.has(f.topologySha256))throw Error('Referenced topology unavailable');
    const input=decodeWitness(f.json);if(f.status==='recorded'&&(!f.topologySha256||input?.v!==1||input.at!==f.at||input.origin!=='live-collector'||!['completed','failed'].includes(input.pollResult)||!Array.isArray(input.observations)))throw Error('Invalid captured collector input');
    if(f.status==='unavailable'&&input.status!=='unavailable')throw Error('Unmarked collector gap');
    if(f.status==='recorded')for(const side of ['Before','After'])if(typeof input['state'+side+'JSON']!=='string'||witnessSHA(input['state'+side+'JSON'])!==input['state'+side+'SHA256'])throw Error('Collector state witness differs');
    at=f.at;chain=f.chain;frames.push({frame:f,input,topology:f.topologySha256===null?null:learned.get(f.topologySha256)});
  }
  const evaluations=page.evaluations??[];if(!Array.isArray(evaluations)||evaluations.length>120)throw Error('Invalid evaluation associations');
  for(const r of evaluations) {
    const f=frames.find(x=>x.frame.seq===r.collectorSeq)?.frame,e=r.evaluation;
    if(!f||r.collectorEpoch!==page.epoch||r.collectorSHA256!==f.sha256||!e||typeof e.epoch!=='string'||!e.epoch.length||!integer(e.cursor)||e.cursor<1||!integer(e.at)||!hash(e.sha256)||!hash(e.contextSha256))throw Error('Unverified evaluation association');
  }
  return{frames,evaluations,topologies:learned,checkpoint:{...checkpoint,after,at,chain}};
}
export const initialChain=epoch=>witnessSHA(witnessJSON(['collector-witness-v1',epoch]));

/** A review lead, never a correction, exclusion or claim about actual speed. */
export function derivedLegLeads(records) {
  const leads=[];
  for(const{frame,input,topology}of records) {
    if(frame.status!=='recorded'||input.pollResult!=='completed'||input.sourceWriteEvidence!=='recorded'||!topology)continue;
    for(const write of input.sourceWrites??[])for(const mutation of write.mutations??[]) {
      if(mutation.table!=='legs'||typeof mutation.afterJSON!=='string')continue;
      if(witnessSHA(mutation.afterJSON)!==mutation.afterSHA256)throw Error('Source-row witness checksum differs');
      const leg=decodeWitness(mutation.afterJSON),a=topology.decoded.stops.get(leg.from_stop_id),b=topology.decoded.stops.get(leg.to_stop_id);
      if(!a||!b||!Number.isFinite(leg.leg_sec)||leg.leg_sec<=0)continue;
      const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;
      const hav=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
      const metres=6371000*2*Math.atan2(Math.sqrt(hav),Math.sqrt(Math.max(0,1-hav))),lowerBoundMetresPerSec=metres/leg.leg_sec;
      if(lowerBoundMetresPerSec>30)leads.push({kind:'derived-leg-speed-review',seq:frame.seq,at:frame.at,rowId:leg.id,
        rowSHA256:mutation.afterSHA256,fromStopId:leg.from_stop_id,toStopId:leg.to_stop_id,legSec:leg.leg_sec,
        minimumDistanceM:metres,lowerBoundMetresPerSec,scope:'Diagnostic lead only. Review raw GPS, topology, state and committed source rows; do not filter rows or infer physical service.'});
    }
  }
  return leads;
}
