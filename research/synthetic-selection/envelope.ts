import {mountSelection,type Scenario} from './adapter';

export const SUPPORTED_RELEASE={
  source:'05a988194af3c376e5aa5da16682c29f797db2b2',
  webTree:'39e7e9738975f45dfb5c443cc99961a39e9aa4ef',
  files:{'index.html':'02dd90560d74374a8e826cd56e36e0d31e4325937f8ed6751899224bc75bd008',
    'assets/rider-U6Gl7ugq.js':'de3217094fc8eca240035b8562189c7f28891068e4936b0a80a92ca7ccf4e18d',
    'assets/geo-BjWFh9tz.js':'5d804a22578f34121b98c45d5b614c6e92ebc354d5423109c4d5421ca8203a5f'},
} as const;
export function supportedRelease(r:any):boolean {
  return !!r && r.source===SUPPORTED_RELEASE.source && r.webTree===SUPPORTED_RELEASE.webTree
    && Object.entries(SUPPORTED_RELEASE.files).every(([p,h])=>r.files?.[p]===h)
    && Object.keys(r.files??{}).length===Object.keys(SUPPORTED_RELEASE.files).length;
}
const record=(v:any)=>!!v && typeof v==='object' && !Array.isArray(v);
// Full response structure, not ETA validity. Empty buses and absent/invalid ETA
// are valid initial observations and must not select a more favorable start.
export function initialStructure(body:any):boolean {
  return record(body) && Array.isArray(body.buses)
    && ['routes','stop_names','stop_coords','segments','dwells'].every(k=>record(body[k]));
}
export type Receipt={id:string;receivedAt:number;status:'ok'|'failure';complete:boolean;body?:any;
  bodySha256:string;serverBuild?:string;requestStartedAt?:number;requestDurationMs?:number};
type Release={knownAt:number;source:string;webTree:string;files:Record<string,string>};
// No file/network reader: immutable capture verification/decoding is a separate
// boundary. This API accepts already-verified complete public receipt envelopes.
export async function runEpisode({scenario,scheduledAt,receipts,releases,clock,profile='A',reference=false,captureKnownThrough}:
  {scenario:Scenario;scheduledAt:number;receipts:Receipt[];releases:Release[];
   clock:{now:()=>number;advance:(ms:number)=>Promise<void>};profile?:'A'|'B';reference?:boolean;captureKnownThrough?:number}) {
  const horizon=scheduledAt+45*60_000;
  if(clock.now()>scheduledAt) throw Error('Clock already after scheduled start');
  const ids=new Set<string>();let last=-Infinity;
  for(const r of receipts){
    if(!Number.isFinite(r.receivedAt)||r.receivedAt<last||ids.has(r.id)||!/^[a-f0-9]{64}$/.test(r.bodySha256)) throw Error('Invalid/noncausal receipt envelope');
    last=r.receivedAt;ids.add(r.id);
  }
  const initial=receipts.find(r=>r.receivedAt>=scheduledAt&&r.receivedAt<=scheduledAt+30_000
    &&r.status==='ok'&&r.complete&&initialStructure(r.body));
  const base={scheduledAt,horizon,profile,scenario,captureKnownThrough:captureKnownThrough??null,
    unfinishedCaptureHorizon:!Number.isFinite(captureKnownThrough)||captureKnownThrough!<horizon};
  if(!initial)return {...base,status:'missing_initial_response',rows:[]};
  const available=releases.filter(r=>Number.isFinite(r.knownAt)&&r.knownAt<=initial.receivedAt).sort((a,b)=>b.knownAt-a.knownAt);
  const release=available[0];
  if(release&&available.filter(r=>r.knownAt===release.knownAt).some(r=>JSON.stringify(r)!==JSON.stringify(release)))return {...base,status:'ambiguous_version',initialReceipt:initial.id,rows:[]};
  if(!supportedRelease(release))return {...base,status:'unavailable_version',initialReceipt:initial.id,rows:[]};
  await clock.advance(initial.receivedAt-clock.now());
  const session=await mountSelection({reference,scenario,payload:initial.body,clock,profile});
  const rows:any[]=[];
  const recordRow=(kind:string,r?:Receipt)=>rows.push({at:clock.now(),kind,receipt:r?{
    id:r.id,bodySha256:r.bodySha256,serverBuild:r.serverBuild,requestStartedAt:r.requestStartedAt,
    requestDurationMs:r.requestDurationMs,receivedAt:r.receivedAt,status:r.status,complete:r.complete,
    serverEtaAt:r.body?.server_eta?.at,serverEtaServedAt:r.body?.server_eta?.servedAt}:null,...session.snapshot()});
  recordRow('initial',initial);
  try {
    for(const r of receipts){
      if(r.receivedAt<initial.receivedAt || r.id===initial.id || r.receivedAt>horizon)continue;
      await session.advanceTo(r.receivedAt);
      if(r.status==='failure'||!r.complete)await session.fail();else await session.receive(r.body);
      recordRow('receipt',r);
    }
    await session.advanceTo(horizon);recordRow('fixed_horizon');
    return {...base,status:'decision_diagnostic',initialReceipt:initial.id,release,rows};
  } finally {await session.close();}
}
