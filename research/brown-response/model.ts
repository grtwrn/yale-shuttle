/** Research boundary around the pinned Python fit; no new numerical fitting. */
/** SHA256 of PROSPECTIVE-FOUR-ARM.json, not the prose companion. */
export const PROTOCOL_SHA256 = '4d1e09bd3cb41762a11e19a7de49bcfb8d8c479b44b3354a845df1b6c8f82742';
export const TOPOLOGY_SHA256 = 'eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc';
export const SEQUENCE = [145,147,4,42,98,121,115,172,47] as const;
export const ARMS = ['frozen_K8_original','frozen_K8_directed','rolling_K5_original','rolling_K5_directed'] as const;
export type Arm = typeof ARMS[number];
export type Forecast = {eta:number;low:number;high:number};
export type Fit = Forecast & {effective:number;days:number};
export type Query = readonly [19,5|8,number,number,number];
export interface ModelManifest {
  schema:1; kind:'sealed'|'fixture'; artifactId:string; training:'frozen'|'rolling'; K:5|8;
  trainBefore:number; builtAt:number; validFrom:number; validUntil:number;
  protocolSha256:string; topologySha256:string; pathsSha256:string; rawPrefixSha256:string;
  knownAtPrefixSha256:string; sourceSha256:string; parametersSha256:string;
  parity:{physical:boolean;source:boolean;path:boolean;fit:boolean};
}
export interface ModelHandle {manifest:ModelManifest;fit:(query:Query)=>Fit|null}
export interface Feature {
  at:number;asof:number;bus:string;route:number;target:number;stopsAhead:number;
  targetIndex:number|null;anchorIndex:number|null;occurrenceReason:string;
  ready:boolean;index:number;nearest:number;phase:string;began:number;observedAt:number;
  origins:Record<string,{departed:number;knownAt:number;route:number}>;
  releasedOrigins:Record<string,number>;baseline:Forecast;from?:number;
}
export type Prediction = {forecast:Forecast;changed:boolean;reason:string;wait?:number;source?:number;
  origin?:number;unsupportedTarget?:number;unsupportedTargetIndex?:number};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const sha=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const distance=(a:number,b:number)=>(b-a+SEQUENCE.length)%SEQUENCE.length;
export const targets=(wait:number)=>wait===0?[1,2,3,4,5]:[6,7,8,0];

/** Schema/availability failures are fallback. A failed scientific gate is fatal. */
export function modelUnavailable(model:ModelHandle|undefined,arm:Arm,at:number,allowFixture=false):string|null {
  if(!model)return 'model missing';
  const m=model.manifest;
  if(m?.parity&&Object.values(m.parity).some(v=>v===false))throw Error('HALT: scientific model parity discrepancy');
  if(!m||m.schema!==1||!['sealed','fixture'].includes(m.kind)||typeof m.artifactId!=='string'||!m.artifactId
    ||m.protocolSha256!==PROTOCOL_SHA256||m.topologySha256!==TOPOLOGY_SHA256
    ||![m.pathsSha256,m.rawPrefixSha256,m.knownAtPrefixSha256,m.sourceSha256,m.parametersSha256].every(sha)
    ||!m.parity||!['physical','source','path','fit'].every(k=>m.parity[k as keyof typeof m.parity]===true)
    ||![m.trainBefore,m.builtAt,m.validFrom,m.validUntil].every(finite)
    ||m.trainBefore>m.builtAt||m.validUntil<=m.validFrom||typeof model.fit!=='function')return 'model invalid';
  if(m.kind==='fixture'&&!allowFixture)return 'fixture model prohibited';
  const frozen=arm.startsWith('frozen');
  if(m.K!==(frozen?8:5)||m.training!==(frozen?'frozen':'rolling'))return 'model arm mismatch';
  if(m.kind==='sealed') {
    const start=Date.parse('2026-09-23T04:00:00Z'),end=Date.parse('2026-09-30T04:30:00Z');
    if(frozen) {
      if(m.trainBefore!==Date.parse('2026-09-16T04:00:00Z')||m.validFrom!==start||m.validUntil!==end)return 'model validity not pinned';
    } else if(m.validFrom<start||m.validFrom>=end||(m.validFrom-start)%86400000!==0
      ||m.trainBefore!==m.validFrom-86400000||m.validUntil!==Math.min(m.validFrom+86400000,end))return 'model validity not pinned';
  }
  if(m.builtAt>at)return 'model not built at server clock';
  if(at<m.validFrom)return 'model not yet valid';
  if(at>=m.validUntil)return 'model expired';
  return null;
}

function eligibility(r:Feature,k:5|8):Prediction|{wait:number;source:number;origin:number;queries:Query[]} {
  const base={forecast:r.baseline,changed:false,reason:'not warm/fresh'};
  if(!r.ready)return base;
  const ti=r.targetIndex;
  if(ti===null)return {...base,reason:'ambiguous occurrence: '+r.occurrenceReason};
  if(r.route!==19||SEQUENCE[ti]!==r.target)throw Error('Invalid Brown target occurrence');
  const wait=ti>=1&&ti<=5?0:5,source=(wait-k+SEQUENCE.length)%SEQUENCE.length;
  const origin=r.origins[source];
  if(!origin)return {...base,reason:'source departure unavailable'};
  if(!(origin.departed<=origin.knownAt&&origin.knownAt<=r.asof))throw Error('Future or invalid source knowledge');
  const release=r.origins[wait];
  if(r.releasedOrigins[`${k}/${wait}`]===origin.departed||(release&&release.departed>origin.departed)
    ||distance(source,r.index)>k||(r.index===wait&&r.phase==='drive'))return {...base,reason:'released/live'};
  if(r.index!==wait&&(distance(r.index,ti)||SEQUENCE.length)<=distance(r.index,wait))return {...base,reason:'pickup before wait'};
  if(!(r.stopsAhead>0&&r.stopsAhead<SEQUENCE.length)||r.anchorIndex===null)return {...base,reason:'occurrence disagreement'};
  const progress=distance(source,r.anchorIndex);
  if(progress>k||r.stopsAhead!==k+distance(wait,ti)-progress)return {...base,reason:'occurrence disagreement'};
  return {wait,source,origin:origin.departed,queries:targets(wait).map(t=>[19,k,wait,t,origin.departed] as Query)};
}
export function requiredQueries(r:Feature,k:5|8):Query[] {
  const e=eligibility(r,k);return 'queries'in e?e.queries:[];
}
export function predictCheckpoint(r:Feature,k:5|8,fit:(q:Query)=>Fit|null):Prediction {
  const e=eligibility(r,k);if(!('queries'in e))return e;
  const forecasts=new Map<number,Forecast>(),elapsed=(r.at-e.origin)/1000;
  // Request ALL group targets even if only one of them has a wire row.
  const results=e.queries.map(q=>({q,f:fit(q)}));
  for(const {q,f}of results) {
    if(f===null)return {forecast:r.baseline,changed:false,reason:'group lacks historical support',unsupportedTarget:SEQUENCE[q[3]],unsupportedTargetIndex:q[3]};
    if(![f.eta,f.low,f.high,f.effective,f.days].every(finite)||f.low<0||f.low>f.eta||f.high<f.eta||f.effective<12||f.days<3)
      throw Error('Invalid or unsupported sealed fit result');
    const value={eta:Math.max(0,f.eta-elapsed),low:Math.max(0,f.low-elapsed),high:Math.max(0,f.high-elapsed)};
    if(value.eta<=60)return {forecast:r.baseline,changed:false,reason:'group countdown expired'};
    forecasts.set(q[3],value);
  }
  const f=forecasts.get(r.targetIndex!)!;
  return {forecast:{eta:Math.round(f.eta),low:Math.round(f.low),high:Math.round(f.high)},changed:true,
    reason:'checkpoint',wait:e.wait,source:e.source,origin:e.origin};
}
