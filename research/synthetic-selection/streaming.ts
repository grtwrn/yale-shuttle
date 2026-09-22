import {createHash} from 'node:crypto';
import {closeSync,createWriteStream,openSync,readFileSync,readSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {once} from 'node:events';
import {createGzip,gunzipSync} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import Database from '../../services/shuttle-v2/node_modules/better-sqlite3/lib/index.js';
import {mountSelection,type EventSink,type Scenario} from './adapter';
import {initialStructure,supportedRelease,SUPPORTED_RELEASE} from './envelope';
import proof from './INITIAL-SOURCE-PROOF.json';

export const POLICY='9ded9d0';
export const SCENARIO_SHA='265ecc5b1bf189f995f8272805b658dc28c63f991e7a724a54e2e8e1b4699af9';
const hash=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
export function hashFile(path:string){const h=createHash('sha256'),fd=openSync(path,'r'),buffer=Buffer.alloc(65536);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,n));}finally{closeSync(fd);}return h.digest('hex');}
export function utcClock(utc:string):{us:number;ms:number} {
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(utc);
  if(!match)throw Error('Unsupported original UTC clock');
  const digits=(match[2]??'').padEnd(6,'0');
  const whole=Date.parse(match[1]+'Z');
  if(!Number.isFinite(whole)||new Date(whole).toISOString().slice(0,19)!==match[1])throw Error('Invalid original UTC clock');
  const us=whole*1000+Number(digits),ms=whole+Number(digits.slice(0,3));
  if(!Number.isSafeInteger(us))throw Error('Unsafe epoch precision');
  return {us,ms};
}
export function readScenarios(path:string):any[] {
  const bytes=readFileSync(path);if(hash(bytes)!==SCENARIO_SHA)throw Error('Changed scenario geometry');
  const rows=JSON.parse(bytes.toString()).scenarios;
  if(rows.length!==42||new Set(rows.map((r:any)=>r.id)).size!==42)throw Error('Invalid scenario set');
  return rows;
}
export function* schedule(scenarios:any[]) {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  for(let day=23;day<=29;day++)for(let slot=0;slot<48;slot++){
    const date=`2026-09-${day}`,hour=Math.floor(slot/2),minute=(slot%2)*30;
    const at=Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00-04:00`);
    const p=Object.fromEntries(formatter.formatToParts(at).map(p=>[p.type,p.value]));
    if(`${p.year}-${p.month}-${p.day}`!==date||Number(p.hour)!==hour||Number(p.minute)!==minute)throw Error('Schedule timezone mismatch');
    for(const scenario of scenarios)for(const profile of ['A','B'] as const)
      yield {id:`${scenario.id}:${date}:${String(slot).padStart(2,'0')}:${profile}`,scenario,profile,scheduledAt:at,horizon:at+2_700_000,date,slot};
  }
}
export type Episode=ReturnType<typeof schedule> extends Generator<infer T>?T:never;
export interface Timeline {
  metadata:any;
  fleets:(startUs:number,endUs:number)=>Iterable<any>;
  release:(id:string)=>any;
  body:(receipt:any)=>any;
  observations?:(startUs:number,endUs:number)=>Iterable<any>;
}
export class DiskTimeline implements Timeline {
  metadata:any;database:any;root:string;
  constructor(root:string,expectedReadySha:string){
    this.root=root;const ready=readFileSync(join(root,'ready.json'));
    if(hash(ready)!==expectedReadySha)throw Error('Spool readiness seal changed');
    this.metadata=JSON.parse(ready.toString());
    if(!this.metadata.syntheticOnly||this.metadata.outcomes!==false||!this.metadata.verification)throw Error('Only completed synthetic spools permitted');
    if(hashFile(join(root,'events.sqlite'))!==this.metadata.databaseSha256||statSync(join(root,'events.sqlite')).size!==this.metadata.databaseBytes)throw Error('Spool index changed');
    this.database=new Database(join(root,'events.sqlite'),{readonly:true,fileMustExist:true});
  }
  *fleets(startUs:number,endUs:number){
    const stop=this.metadata.clockUnsafeBoundary?.sequence??Number.MAX_SAFE_INTEGER;
    for(const row of this.database.prepare("SELECT event_json FROM events WHERE kind='fleet-receipt' AND at_us>=? AND at_us<=? AND sequence<? ORDER BY sequence").iterate(startUs,endUs,stop))yield JSON.parse(row.event_json);
  }
  *observations(startUs:number,endUs:number){
    const stop=this.metadata.clockUnsafeBoundary?.sequence??Number.MAX_SAFE_INTEGER;
    for(const row of this.database.prepare("SELECT event_json FROM events WHERE kind IN ('fleet-receipt','schedule-gap') AND at_us>=? AND at_us<=? AND sequence<? ORDER BY sequence").iterate(startUs,endUs,stop))yield JSON.parse(row.event_json);
  }
  release(id:string){const row=this.database.prepare('SELECT event_json FROM releases WHERE id=?').get(id);return row?JSON.parse(row.event_json):null;}
  body(receipt:any){
    const bytes=gunzipSync(readFileSync(join(this.root,'bodies',receipt.bodySha256+'.gz')),{maxOutputLength:8*1024*1024});
    if(hash(bytes)!==receipt.bodySha256)throw Error('Spool body changed');
    return JSON.parse(bytes.toString('utf8'));
  }
  close(){this.database.close();}
}
export function bindRelease(receipt:any,state:any) {
  if(!state||state.id!==receipt.releaseStateId||state.sequence!==receipt.sequence||state.sequence!==receipt.releaseStateSequence
    ||state.captureId!==receipt.captureId||state.status!=='candidate_under_continuity_assumption'||state.clockUnsafe
    ||state.knownAt!==receipt.receivedAt||state.strictIdentityKnown!==false||state.assumptionRequired!==true)return null;
  const evidence=state.releaseEvidence;
  if(!evidence||evidence.status!==state.status||evidence.knownAt>receipt.receivedAt||evidence.proofKnownAt>receipt.receivedAt)return null;
  const bundle=evidence.lastCompleteBundle,health=evidence.previousHealth;
  if(!bundle||!health?.valid||health.build!==bundle.precedingHealthBuild||health.receivedAtMs>receipt.receivedAt
    ||bundle.completedAtMs>receipt.receivedAt||evidence.proofKnownAt!==Date.parse(proof.proofKnownAt)
    ||evidence.knownAt!==Math.max(bundle.completedAtMs,health.receivedAtMs,evidence.proofKnownAt)
    ||evidence.source!==state.source||evidence.webTree!==state.webTree)return null;
  if(!state.files||Object.keys(state.files).length!==Object.keys(proof.files).length
    ||!Object.entries(proof.files).every(([path,p])=>state.files[path]?.sha256===p.sha256&&state.files[path]?.bytes===p.bytes))return null;
  if(![bundle.files,evidence.files].every(files=>files&&Object.keys(files).length===Object.keys(proof.files).length
    &&Object.entries(proof.files).every(([path,p])=>files[path]?.sha256===p.sha256&&files[path]?.bytes===p.bytes)))return null;
  const files=Object.fromEntries(Object.entries(state.files).map(([path,descriptor]:any)=>[path,descriptor.sha256]));
  const identity={source:state.source,webTree:state.webTree,files};
  if(!supportedRelease(identity))return null;
  return {...identity,policy:POLICY,initialReleaseStateId:state.id,knownAt:state.knownAt,
    strictIdentityKnown:false,assumptionRequired:true,acceptedUnderPinnedSyntheticPolicy:true,evidence};
}

// Explicit tags preserve values that normal JSON silently loses. Plain objects
// using this reserved key are escaped, so encoded inputs are unambiguous.
export function encode(value:any):any {
  if(value===undefined)return {$researchType:'undefined'};
  if(typeof value==='number'&&!Number.isFinite(value))return {$researchType:'number',value:String(value)};
  if(Object.is(value,-0))return {$researchType:'number',value:'-0'};
  if(Array.isArray(value))return value.map(encode);
  if(value&&typeof value==='object'){
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('Unsupported diagnostic object');
    const entries=Object.keys(value).sort().map(k=>[k,encode(value[k])]);
    return '$researchType' in value?{$researchType:'object',entries}:Object.fromEntries(entries);
  }
  if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')throw Error('Unsupported diagnostic value');
  return value;
}
export class JsonlSink implements EventSink {
  rawBytes=0;rows=0;maxBuffered=0;maxRowBytes=0;failed:any=null;
  rawHash=createHash('sha256');gzip=createGzip({level:6,highWaterMark:16384});file:any;done:Promise<void>;path:string;
  constructor(path:string,readonly context:any,readonly maxBytes=512*1024*1024){
    this.path=path;this.file=createWriteStream(path,{flags:'wx',highWaterMark:65536});
    this.done=pipeline(this.gzip,this.file).catch(error=>{this.failed=error;});
  }
  event(event:any){
    if(this.failed)throw this.failed;
    const raw=Buffer.from(JSON.stringify(encode({...this.context,streamSequence:this.rows,event}))+'\n');
    if(raw.length>16*1024*1024||this.rawBytes+raw.length>this.maxBytes)throw Error('Diagnostic output resource bound');
    this.rawHash.update(raw);this.rawBytes+=raw.length;this.rows++;this.maxRowBytes=Math.max(this.maxRowBytes,raw.length);
    this.gzip.write(raw);this.maxBuffered=Math.max(this.maxBuffered,this.gzip.writableLength);
  }
  async flush(){if(this.gzip.writableNeedDrain&&!this.failed)await Promise.race([once(this.gzip,'drain'),this.done]);if(this.failed)throw this.failed;}
  async close(){await this.flush();this.gzip.end();await this.done;if(this.failed)throw this.failed;
    return {rows:this.rows,rawBytes:this.rawBytes,rawSha256:this.rawHash.digest('hex'),compressedBytes:statSync(this.path).size,compressedSha256:hashFile(this.path),
      maxBuffered:this.maxBuffered,maxRowBytes:this.maxRowBytes};}
  abort(){this.gzip.destroy(Error('Aborted incomplete episode'));}
}

export async function runStreamingEpisode(episode:Episode,timeline:Timeline,clock:any,sink:EventSink,reference=false){
  const startUs=episode.scheduledAt*1000,horizonUs=episode.horizon*1000;
  const coverage=timeline.metadata.coverage?.atUs??-Infinity;
  const unsafe=timeline.metadata.clockUnsafeBoundary;
  const unsafeUs=unsafe?.lastSafe?.atUs??(unsafe?-Infinity:Infinity);
  const limitUs=Math.min(horizonUs,coverage,unsafeUs);
  const base:any={...episode,scenarioId:episode.scenario.id,captureId:timeline.metadata.captureId,prefixSha256:timeline.metadata.prefixSha256,
    generatingRouteId:episode.scenario.generatingRouteId,generatingRouteName:episode.scenario.generatingRouteName,
    initialStatus:'unselected',versionStatus:'not_evaluated',executionStatus:'not_started',
    coverageStatus:unsafeUs<=horizonUs?'clock_unknown':coverage<horizonUs?'unfinished_horizon':'complete',
    scheduledHorizon:episode.horizon,knownThrough:null,strictIdentityKnown:false,assumptionRequired:true,
    inputCounts:{applied:0,failed:0,skippedSlots:0,emptyFleet:0,missingServerEta:0,modelParamsMissing:0}};
  delete base.scenario;
  const done=async()=>{sink.event({type:'episode_terminal',...base});await sink.flush();return base;};
  if(!Number.isSafeInteger(timeline.metadata.coverageStart?.atUs)||timeline.metadata.coverageStart.atUs>startUs){
    base.initialStatus='initial_window_uncovered';base.initialCoverageReason='capture_started_after_scheduled_start_or_unknown';return done();
  }
  if(limitUs<startUs){base.initialStatus=unsafeUs<startUs?'initial_input_unknown':'initial_window_uncovered';return done();}
  let initial:any,payload:any;
  for(const receipt of timeline.fleets(startUs,Math.min(startUs+30_000_000,limitUs))){
    if(receipt.status==='unknown'||receipt.replayAdmissible===false){base.initialStatus='initial_input_unknown';base.uncertainty={reason:receipt.reason,receiptId:receipt.id};return done();}
    if(receipt.status==='ok'&&receipt.complete){
      const data=timeline.body(receipt);
      if(initialStructure(data)){initial=receipt;payload=data;break;}
    }
  }
  if(!initial){base.initialStatus=limitUs<startUs+30_000_000?(unsafeUs<=limitUs?'initial_input_unknown':'initial_window_uncovered'):'missing_initial_response';return done();}
  base.initialStatus='selected';base.initialReceipt=initial.id;base.initialOriginalUtc=initial.receivedAtUtc;
  const release=bindRelease(initial,timeline.release(initial.releaseStateId));
  if(!release){base.versionStatus='initial_version_unavailable';return done();}
  base.versionStatus='assumption_qualified';base.release=release;
  if(clock.now()>episode.scheduledAt)throw Error('Worker clock already past start');
  const initialAt=utcClock(initial.receivedAtUtc).ms;
  await clock.advance(initialAt-clock.now());
  const session=await mountSelection({reference,scenario:episode.scenario,payload,clock,profile:episode.profile,sink,retainEvents:false});
  const countBody=(body:any)=>{base.inputCounts.applied++;if(body.buses.length===0)base.inputCounts.emptyFleet++;
    if(!body.server_eta)base.inputCounts.missingServerEta++;if(body.model_params==null)base.inputCounts.modelParamsMissing++;};
  countBody(payload);
  base.executionStatus='running';base.knownThrough={sequence:initial.sequence,originalUtc:initial.receivedAtUtc,at:initialAt};
  sink.event({type:'episode_initial',receipt:initial.id,at:clock.now(),snapshot:session.snapshot()});await sink.flush();
  try{
    const observations=timeline.observations?timeline.observations(initial.atUs,limitUs):timeline.fleets(initial.atUs,limitUs);
    for(const receipt of observations){
      if(receipt.sequence<=initial.sequence)continue;
      if(receipt.event==='schedule-gap'){
        const at=utcClock(receipt.originalAtUtc).ms;await session.advanceTo(at);
        base.inputCounts.skippedSlots+=receipt.record.skippedTicks;
        sink.event({type:'schedule_gap',sequence:receipt.sequence,originalUtc:receipt.originalAtUtc,at,skippedSlots:receipt.record.skippedTicks});await sink.flush();continue;
      }
      const at=utcClock(receipt.receivedAtUtc).ms;
      await session.advanceTo(at);
      if(receipt.status==='unknown'||receipt.replayAdmissible===false){
        base.executionStatus='input_unknown';base.coverageStatus='input_unknown';
        base.uncertainty={reason:receipt.reason,receiptId:receipt.id,at,originalUtc:receipt.receivedAtUtc};
        base.knownThrough={sequence:receipt.sequence-1,at,excludingReceipt:receipt.id};
        sink.event({type:'episode_known_prefix',at:clock.now(),snapshot:session.snapshot()});return await done();
      }
      sink.event({type:'receipt',id:receipt.id,originalUtc:receipt.receivedAtUtc,at,releaseStateId:receipt.releaseStateId,status:receipt.status,bodySha256:receipt.bodySha256});
      if(receipt.status==='failure'||!receipt.complete){base.inputCounts.failed++;await session.fail();}
      else{const body=timeline.body(receipt);countBody(body);await session.receive(body);}
      base.knownThrough={sequence:receipt.sequence,originalUtc:receipt.receivedAtUtc,at};
    }
    const terminalAt=Math.floor(limitUs/1000);
    await session.advanceTo(terminalAt);
    base.knownThrough={...base.knownThrough,at:terminalAt,originalCoverageUs:limitUs};
    base.executionStatus=base.coverageStatus==='complete'?'completed':'known_prefix_only';
    sink.event({type:'episode_known_prefix',at:clock.now(),snapshot:session.snapshot()});return await done();
  }finally{await session.close();}
}
