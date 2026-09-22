import {createHash} from 'node:crypto';
import {ROUTE_LISTS} from '../../services/shuttle-v2/web/src/routes.ts';
import {featureForRow,type ClockSnapshot} from './clock.ts';
import {SEQUENCE,modelUnavailable,predictCheckpoint,type Arm,type ModelHandle} from './model.ts';

type ObjectMap=Record<string,any>;
const object=(v:unknown):v is ObjectMap=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const norm=(s:string)=>s.replace(/^#/,'');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const labels=new Set(ROUTE_LISTS.map(r=>r.label));
export interface TopologyContract {sequence:readonly number[];path:readonly (readonly number[])[];coords:Record<string,{lat:number;lon:number}>}
export interface AdapterContext {
  responseId:string;receivedAt:number;arm:Arm;model?:ModelHandle;topology:TopologyContract;
  snapshot:(bus:string,route:number,asof:number)=>ClockSnapshot|null;
  /** Test fixtures only. Never enable for captured prospective responses. */
  allowFixtureArtifacts?:boolean;
}
export interface RowAudit {
  ordinal:number;key:Record<string,unknown>;reason:string;changedCells:number[];
  featureSha256?:string;prefixSha256?:string;modelId?:string;targetIndex?:number|null;anchorIndex?:number|null;
  wait?:number;source?:number;origin?:number;
}
export function topologyContract(topology:any):TopologyContract {
  const route=topology.routes.find((r:any)=>r.id===19);
  if(!route||!same(route.stops,SEQUENCE))throw Error('Frozen Brown topology mismatch');
  return {sequence:route.stops,path:route.path,coords:Object.fromEntries(route.stops.map((id:number)=>{
    const s=topology.stops.find((s:any)=>s.id===id);if(!s)throw Error('Frozen Brown stop missing');
    return [id,{lat:s.lat,lon:s.lon}];
  }))};
}
function topologyUnavailable(body:ObjectMap,t:TopologyContract):string|null {
  if(!same(t.sequence,SEQUENCE)||!object(body.routes)||!same(body.routes['19'],t.sequence))return 'route topology incompatible';
  if(!object(body.stop_coords)||Object.entries(t.coords).some(([id,p])=>!object(body.stop_coords[id])
    ||body.stop_coords[id].lat!==p.lat||body.stop_coords[id].lon!==p.lon))return 'stop geometry incompatible';
  if(!object(body.route_paths)||!same(body.route_paths['19'],t.path))return 'route geometry incompatible';
  return null;
}
/** Match wire validity before overlay; never turn an invalid snapshot into valid output. */
function wireInvalid(w:unknown):string|null {
  if(!object(w)||w.v!==2||!finite(w.at)||!finite(w.servedAt)||w.at>w.servedAt
    ||!Array.isArray(w.buses)||!Array.isArray(w.rows)||w.buses.length>200||w.rows.length>30000)return 'invalid served wire';
  for(const b of w.buses) {
    if(!Array.isArray(b)||b.length!==4||typeof b[0]!=='string'||typeof b[1]!=='string'
      ||!labels.has(b[1])||!Number.isInteger(b[2])||b[2]<-1)return 'invalid served bus';
    const rest=b[3];
    if(rest!==null&&(!object(rest)||!Number.isInteger(rest.stopId)||!finite(rest.standingSec)
      ||rest.standingSec<0||typeof rest.approach!=='boolean'))return 'invalid served standing';
  }
  for(const r of w.rows)if(!Array.isArray(r)||r.length!==9||!r.every(finite)
    ||!Number.isInteger(r[0])||r[0]<0||r[0]>=w.buses.length||!Number.isInteger(r[1])
    ||!Number.isInteger(r[5])||r[5]<0||(r[6]!==0&&r[6]!==1)||r[2]<0||r[4]<r[3]||r[7]<0)return 'invalid served row';
  return null;
}

/** Pure complete-body overlay: immutable input, no labels, no wall-clock reads. */
export function adaptResponse<T>(original:T,ctx:AdapterContext) {
  const body=object(original)?original:null,w=body?.server_eta;
  const originalRows=object(w)&&Array.isArray(w.rows)?w.rows:[];
  const audits:RowAudit[]=originalRows.map((r:any,i:number)=>({ordinal:i,
    key:{responseId:ctx.responseId,rowOrdinal:i,wireBusIndex:Array.isArray(r)?r[0]:null,
      originalTarget:Array.isArray(r)?r[1]:null,originalStopsAhead:Array.isArray(r)?r[5]:null},
    reason:'not evaluated',changedCells:[]}));
  const audit={responseId:ctx.responseId,arm:ctx.arm,receivedAt:ctx.receivedAt,asof:object(w)&&finite(w.at)?w.at:null,
    diagnosticHybrid:true,fixtureArtifactsAllowed:ctx.allowFixtureArtifacts===true,originalRows:originalRows.length,
    changedRows:0,rows:audits,responseReason:null as string|null};
  const unchanged=(reason:string)=>{audit.responseReason=reason;for(const row of audits)row.reason=reason;return {body:original,audit};};
  const invalid=wireInvalid(w);if(invalid)return unchanged(invalid);
  if(!body||!finite(ctx.receivedAt))return unchanged('invalid response envelope');
  // Browser attachment handles transport age separately. A server forecast may
  // never use a model built by receipt time but unavailable at its own clock.
  const geometry=topologyUnavailable(body,ctx.topology);
  let rows:any[]|null=null;
  for(const [i,row]of (w as ObjectMap).rows.entries()) {
    const a=audits[i]!,bus=w.buses[row[0]];
    if(bus[1]!=='Brown'){a.reason='other route';continue;}
    a.key={...a.key,busName:bus[0],route:19};
    if(geometry){a.reason=geometry;continue;}
    if(w.buses.filter((b:any)=>b[1]==='Brown'&&norm(b[0])===norm(bus[0])).length!==1){a.reason='ambiguous wire bus';continue;}
    if(!Array.isArray(body.buses)){a.reason='raw fleet missing';continue;}
    const matches=body.buses.filter((b:any)=>object(b)&&typeof b.bus_name==='string'&&norm(b.bus_name)===norm(bus[0]));
    if(matches.length!==1){a.reason=matches.length?'ambiguous public bus name':'public bus missing';continue;}
    const raw=matches[0];
    if(raw.route_id!==19||!Number.isInteger(raw.bus_id)||raw.bus_id<=0){a.reason='public provider/route unavailable';continue;}
    a.key={...a.key,provider:raw.bus_id,rawBusName:raw.bus_name};
    const s=ctx.snapshot(raw.bus_name,19,w.at);
    if(!s){a.reason='causal clock missing';continue;}
    a.prefixSha256=s.prefixSha256;
    if(!s.prefixComplete){a.reason='causal raw prefix unavailable';continue;}
    if(s.asof!==w.at||s.bus!==raw.bus_name||s.route!==19){a.reason='causal clock identity/asof mismatch';continue;}
    if(s.provider!==raw.bus_id){a.reason='provider changed since ETA snapshot';continue;}
    if(s.variant!==(ctx.arm.endsWith('_directed')?'directed':'original')){a.reason='phase variant mismatch';continue;}
    // Target/anchor come from this ORIGINAL row, never from the guarded index.
    const feature=featureForRow(s,{at:w.at,asof:w.at,bus:raw.bus_name,route:19,target:row[1],stopsAhead:row[5],
      baseline:{eta:row[2],low:row[3],high:row[4]}},SEQUENCE);
    a.featureSha256=hash(feature);a.targetIndex=feature.targetIndex;a.anchorIndex=feature.anchorIndex;
    a.key={...a.key,targetIndex:feature.targetIndex,anchorIndex:feature.anchorIndex};
    const unavailable=modelUnavailable(ctx.model,ctx.arm,w.at,ctx.allowFixtureArtifacts);
    if(unavailable){a.reason=unavailable;continue;}
    a.modelId=ctx.model!.manifest.artifactId;
    const prediction=predictCheckpoint(feature,ctx.model!.manifest.K,ctx.model!.fit);
    const {forecast,changed,...evidence}=prediction;Object.assign(a,evidence);
    if(!changed)continue;
    const low=Math.min(row[3],forecast.low,row[2]),high=Math.max(row[2],forecast.high);
    if(!finite(low)||!finite(high)||low>row[2]||high<row[2]||low>row[3])throw Error('Hybrid invariant failed');
    if(low===row[3]&&high===row[4])continue;
    if(!rows)rows=w.rows.slice();
    const next=row.slice();next[3]=low;next[4]=high;rows[i]=next;
    a.changedCells=[3,4].filter(j=>next[j]!==row[j]);audit.changedRows++;
  }
  if(!rows)return {body:original,audit};
  return {body:{...body,server_eta:{...w,rows}} as T,audit};
}
