import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {bindRelease,encode,JsonlSink,readScenarios,runStreamingEpisode,schedule,utcClock,type Timeline} from './streaming';
import {feed,scenario} from './fixtures';
import {ACTIVE_PROOF as proof} from './source';
import {BASELINE_SOURCE,CURRENT_SOURCE,sourceProof} from './source-versions.mjs';
const START=Date.parse('2026-09-23T16:00:00Z'),HORIZON=START+2_700_000;
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
const episode:any={id:'unit-scenario:2026-09-23:24:B',scenario:{...scenario,id:'unit-scenario'},profile:'B',scheduledAt:START,horizon:HORIZON,date:'2026-09-23',slot:24};
const capture='c'.repeat(64);
function frame(sequence:number,utc:string,body=feed(utcClock(utc).ms)){
  const {us}=utcClock(utc),at=us/1000,id=`${capture}:${sequence}:`+'a'.repeat(64),releaseStateId=`${capture}:release:${sequence}`;
  const receipt={id,sequence,captureId:capture,receivedAt:at,receivedAtUtc:utc,atUs:us,status:'ok',complete:true,replayAdmissible:true,bodySha256:'a'.repeat(64),
    releaseStateId,releaseStateSequence:sequence,body};
  const bundle={completedAtMs:at-1,precedingHealthBuild:proof.source,files:proof.files};
  const health={valid:true,build:proof.source,receivedAtMs:at-1};
  const evidence={status:'candidate_under_continuity_assumption',source:proof.source,webTree:proof.webTree,files:proof.files,
    proofKnownAt:Date.parse(proof.proofKnownAt),knownAt:at-1,lastCompleteBundle:bundle,previousHealth:health};
  const state={id:releaseStateId,sequence,captureId:capture,knownAt:at,clockUnsafe:false,strictIdentityKnown:false,assumptionRequired:true,
    status:evidence.status,source:proof.source,webTree:proof.webTree,files:proof.files,releaseEvidence:evidence};
  return {receipt,state};
}
function timeline(frames:any[],coverageUs=HORIZON*1000,unsafe:any=null):Timeline{
  return {metadata:{captureId:capture,prefixSha256:'d'.repeat(64),coverageStart:{atUs:START*1000-1_000_000},coverage:{atUs:coverageUs},clockUnsafeBoundary:unsafe},
    *fleets(a,b){for(const f of frames)if(f.receipt.atUs>=a&&f.receipt.atUs<=b&&f.receipt.sequence<(unsafe?.sequence??Infinity))yield f.receipt;},
    release:id=>frames.find(f=>f.state.id===id)?.state,body:r=>r.body};
}
const sink=()=>({events:[] as any[],event(e:any){this.events.push(structuredClone(e));},async flush(){}});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error('Forbidden network');}));});
afterEach(()=>{expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();vi.unstubAllGlobals();});
describe('streaming baseline schedule, clocks, uncertainty and component parity',()=>{
  it('retains the exact 42 geometries and every 28,224 profile key',()=>{
    const geometries=readScenarios('../../research/synthetic-selection/PROSPECTIVE-SCENARIOS.json'),rows=[...schedule(geometries)];
    expect(rows).toHaveLength(28224);expect(new Set(rows.map(r=>r.id)).size).toBe(28224);
    expect(rows[0].scheduledAt).toBe(Date.parse('2026-09-23T04:00:00Z'));
    expect(rows.at(-1)?.horizon).toBe(Date.parse('2026-09-30T04:15:00Z'));
    expect(new Set(rows.map(r=>r.scenario.generatingRouteId)).size).toBe(14);
  });
  it('truncates original UTC fractions deliberately and rejects malformed time',()=>{
    expect(utcClock('2026-09-23T16:00:00.123999+00:00')).toEqual({ms:START+123,us:START*1000+123999});
    expect(utcClock('2026-09-23T16:00:00.1Z').ms).toBe(START+100);
    expect(()=>utcClock('2026-02-30T00:00:00Z')).toThrow();expect(()=>utcClock('2026-09-23T16:00:00-04:00')).toThrow();
  });
  it('never rounds a late initial receipt into the 30-second window',async()=>{
    const late=frame(0,'2026-09-23T16:00:30.000001Z');
    const result=await runStreamingEpisode(episode,timeline([late]),clock,sink());
    expect(result.initialStatus).toBe('missing_initial_response');expect(result.executionStatus).toBe('not_started');
  });
  it('requires exact linked source evidence and unknown states shadow prior mappings',async()=>{
    const first=frame(0,'2026-09-23T16:00:00Z'),later=frame(1,'2026-09-23T16:00:15Z');
    expect(bindRelease(first.receipt,first.state)?.assumptionRequired).toBe(true);
    expect(bindRelease(first.receipt,{...first.state,captureId:'other'})).toBeNull();
    first.state.status='no_complete_bundle';
    const result=await runStreamingEpisode(episode,timeline([first,later]),clock,sink());
    expect(result.initialReceipt).toBe(first.receipt.id);expect(result.versionStatus).toBe('initial_version_unavailable');
  });
  it('refuses future proof knowledge and a complete other-version initial receipt',()=>{
    const first=frame(0,'2026-09-23T16:00:00Z');
    first.state.releaseEvidence.proofKnownAt=START+1;
    expect(bindRelease(first.receipt,first.state)).toBeNull();
    const another=frame(1,'2026-09-23T16:00:15Z'),other=sourceProof(proof.source===BASELINE_SOURCE?CURRENT_SOURCE:BASELINE_SOURCE);
    Object.assign(another.state,{source:other.source,webTree:other.webTree,files:other.files});
    Object.assign(another.state.releaseEvidence,{source:other.source,webTree:other.webTree,files:other.files,proofKnownAt:Date.parse(other.proofKnownAt)});
    Object.assign(another.state.releaseEvidence.lastCompleteBundle,{files:other.files,precedingHealthBuild:other.source});
    another.state.releaseEvidence.previousHealth.build=other.source;
    expect(bindRelease(another.receipt,another.state)).toBeNull();
  });
  it('keeps an already-bound page after an explicitly known different qualified source appears',async()=>{
    const first=frame(0,'2026-09-23T16:00:00Z'),changed=frame(1,'2026-09-23T16:00:15Z');
    const other=sourceProof(proof.source===BASELINE_SOURCE?CURRENT_SOURCE:BASELINE_SOURCE);
    Object.assign(changed.state,{source:other.source,webTree:other.webTree,files:other.files});
    Object.assign(changed.state.releaseEvidence,{source:other.source,webTree:other.webTree,files:other.files,proofKnownAt:Date.parse(other.proofKnownAt)});
    Object.assign(changed.state.releaseEvidence.lastCompleteBundle,{files:other.files,precedingHealthBuild:other.source});
    changed.state.releaseEvidence.previousHealth.build=other.source;
    const output=sink(),result=await runStreamingEpisode(episode,timeline([first,changed],START*1000+16000000),clock,output);
    expect(result.versionStatus).toBe('assumption_qualified');expect(result.executionStatus).toBe('known_prefix_only');
    expect(result.release.source).toBe(proof.source);expect(output.events.filter(e=>e.type==='receipt')).toHaveLength(1);
  });
  it('does not skip ambiguous initial input to select a later complete response',async()=>{
    const unknown=frame(0,'2026-09-23T16:00:00Z'),later=frame(1,'2026-09-23T16:00:15Z');
    Object.assign(unknown.receipt,{status:'unknown',complete:false,replayAdmissible:false,reason:'duplicate_json_keys'});
    const result=await runStreamingEpisode(episode,timeline([unknown,later]),clock,sink());
    expect(result.initialStatus).toBe('initial_input_unknown');expect(result.initialReceipt).toBeUndefined();
  });
  it('distinguishes uncovered initial windows from observed missing starts',async()=>{
    expect((await runStreamingEpisode(episode,timeline([],START*1000+10_000_000),clock,sink())).initialStatus).toBe('initial_window_uncovered');
    expect((await runStreamingEpisode(episode,timeline([]),clock,sink())).initialStatus).toBe('missing_initial_response');
  });
  it('cannot infer the first initial receipt from a capture that began after the scheduled start',async()=>{
    const input=timeline([frame(0,'2026-09-23T16:00:15Z')]);input.metadata.coverageStart={atUs:START*1000+5_000_000};
    const result=await runStreamingEpisode(episode,input,clock,sink());
    expect(result.initialStatus).toBe('initial_window_uncovered');expect(result.initialReceipt).toBeUndefined();
    expect(result.scheduledHorizon).toBe(HORIZON);expect(result.id).toBe(episode.id);
  });
  it('stops unknown input without failure, continuation or a second arm',async()=>{
    const first=frame(0,'2026-09-23T16:00:00.000777Z'),unknown=frame(1,'2026-09-23T16:00:15.000777Z'),later=frame(2,'2026-09-23T16:00:30Z');
    Object.assign(unknown.receipt,{status:'unknown',complete:false,replayAdmissible:false,reason:'duplicate_json_keys'});
    const output=sink(),result=await runStreamingEpisode(episode,timeline([first,unknown,later]),clock,output);
    expect(result.executionStatus).toBe('input_unknown');expect(clock.now()).toBe(START+15000);
    expect(output.events.filter(e=>e.type==='feed_failed')).toHaveLength(0);
    expect(output.events.filter(e=>e.type==='arm_attempt')).toHaveLength(1);
    expect(result.scheduledHorizon).toBe(HORIZON);
  });
  it('preserves journal order when fractional receipts collapse to one millisecond',async()=>{
    const frames=[frame(0,'2026-09-23T16:00:00.001001Z'),frame(1,'2026-09-23T16:00:15.001001Z'),frame(2,'2026-09-23T16:00:15.001999Z')];
    const output=sink();await runStreamingEpisode(episode,timeline(frames,START*1000+15_002_000),clock,output);
    expect(output.events.filter(e=>e.type==='receipt').map(e=>e.id)).toEqual(frames.slice(1).map(f=>f.receipt.id));
    expect(output.events.filter(e=>e.type==='receipt').map(e=>e.at)).toEqual([START+15001,START+15001]);
  });
  it('compares streamed known-prefix state against the complete original component and ignores later release changes',async()=>{
    const frames=[frame(0,'2026-09-23T16:00:00Z'),frame(1,'2026-09-23T16:00:15Z',feed(START+15000,[{name:'302',pickup:350,low:239,high:700}]))];
    frames[1].state.status='no_complete_bundle';
    const outputs=[];
    for(const reference of [true,false]){
      vi.setSystemTime(START);const output=sink();
      const result=await runStreamingEpisode(episode,timeline(frames,START*1000+35_000_000),clock,output,reference);
      expect(result.versionStatus).toBe('assumption_qualified');expect(result.coverageStatus).toBe('unfinished_horizon');
      expect(result.executionStatus).toBe('known_prefix_only');expect(clock.now()).toBe(START+35000);
      expect(output.events.filter(e=>e.type==='would_signal').map(e=>e.kind)).toEqual(['heads_up','leave_now']);
      outputs.push(output.events);
    }
    expect(outputs[1]).toEqual(outputs[0]);
  });
  it('cuts at the last safe clock boundary without advancing to a regressed timestamp',async()=>{
    const first=frame(0,'2026-09-23T16:00:00Z');
    const result=await runStreamingEpisode(episode,timeline([first],START*1000+5_000_000,{sequence:1,lastSafe:{atUs:START*1000+5_000_000}}),clock,sink());
    expect(result.coverageStatus).toBe('clock_unknown');expect(clock.now()).toBe(START+5000);
  });
  it('keeps missing polls as timer-only gaps and the fixed horizon',async()=>{
    const output=sink(),result=await runStreamingEpisode(episode,timeline([frame(0,'2026-09-23T16:00:00Z')]),clock,output);
    expect(result.executionStatus).toBe('completed');expect(clock.now()).toBe(HORIZON);
    expect(output.events.filter(e=>e.type==='feed_failed')).toHaveLength(0);
    expect(output.events.some(e=>e.type==='disarm'&&e.reason==='invalid_input')).toBe(true);
  });
  it('isolates sequential episode reminder/module state',async()=>{
    const all=[];
    for(let i=0;i<2;i++){
      vi.setSystemTime(START);const output=sink();
      await runStreamingEpisode(episode,timeline([frame(0,'2026-09-23T16:00:00Z')],START*1000+2_000_000),clock,output);
      all.push(output.events);expect(vi.getTimerCount()).toBe(0);
    }
    expect(all[1]).toEqual(all[0]);
  });
});
describe('bounded diagnostic output',()=>{
  it('preserves undefined/nonfinite values and escapes its reserved tag',()=>{
    expect(encode([undefined,NaN,Infinity,-Infinity,-0])).toEqual([
      {$researchType:'undefined'},{$researchType:'number',value:'NaN'},{$researchType:'number',value:'Infinity'},
      {$researchType:'number',value:'-Infinity'},{$researchType:'number',value:'-0'}]);
    expect(encode({$researchType:'undefined'})).toEqual({$researchType:'object',entries:[['$researchType','undefined']]});
  });
  it('streams with backpressure and verifies complete compressed output',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'selection-stream-'));
    try{
      const output=new JsonlSink(join(dir,'rows.gz'),{episodeId:'fixture'});
      for(let i=0;i<100;i++){output.event({type:'fixture',i,value:'x'.repeat(16384)});await output.flush();}
      const result=await output.close();expect(result.rows).toBe(100);expect(result.maxBuffered).toBeLessThan(65536);
      const raw=gunzipSync(readFileSync(join(dir,'rows.gz'))).toString();expect(raw.trim().split('\n')).toHaveLength(100);
      expect(JSON.parse(raw.split('\n')[0]).event.i).toBe(0);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('surfaces failed writes and output caps without a successful terminal hash',async()=>{
    const output=new JsonlSink('/dev/full',{},100);
    expect(()=>output.event({text:'x'.repeat(200)})).toThrow('resource bound');output.abort();await output.done;
    const missing=new JsonlSink('/a/nonexistent/research/path/rows.gz',{});missing.event({type:'fixture'});
    await expect(missing.close()).rejects.toThrow();
  });
});
