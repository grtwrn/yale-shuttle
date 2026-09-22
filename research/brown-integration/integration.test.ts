import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mountSelection} from '../../deps/selection/research/synthetic-selection/adapter';
import {applyPublicResponse} from '../../deps/selection/services/shuttle-v2/web/src/__researchSelection.generated';
import {serverArrivals} from '../../deps/selection/services/shuttle-v2/web/src/etaSource';
import {liveAnchorStore} from '../../deps/selection/services/shuttle-v2/web/src/eta';
import {adaptResponse,type AdapterContext} from '../brown-response/adapter';
import {ARMS,type Arm} from '../brown-response/model';
import {QueryCollector,queryBank,sha,bodyHash} from './sidecar';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),OUT=path.join(ROOT,'research/brown-integration/results');
const read=(name:string)=>JSON.parse(fs.readFileSync(path.join(OUT,name),'utf8'));
const {topology,cases}=read('cases.json'),models=read('models/index.json'),inventory=read('query-inventory.json');
const banks=inventory.map((v:any)=>({meta:v,bank:queryBank(fs.readFileSync(path.join(ROOT,v.request)),fs.readFileSync(path.join(ROOT,v.result)),v.resultSha256,v.runtimeSha256)}));
const records:any[]=[],summary:any={checks:[],fixtureOnly:true,outcomesRead:0,prospectiveBodiesRead:0};
let session:any;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(cases[0].at);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error(`Forbidden request ${url}`);}));});
afterEach(async()=>{if(session)await session.close();session=null;expect(liveAnchorStore.size).toBe(0);
  expect(vi.mocked(fetch).mock.calls.every(([url])=>url==='/api/weather')).toBe(true);vi.useRealTimers();vi.unstubAllGlobals();
  fs.writeFileSync(path.join(OUT,'integration-transcripts.json.gz'),zlib.gzipSync(JSON.stringify(records)));
  fs.writeFileSync(path.join(OUT,'integration-summary.json'),JSON.stringify(summary,null,2)+'\n');});
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
function context(c:any,frame:any,arm:Arm):AdapterContext {
  const name=c.modelNames[arm.startsWith('frozen')?'frozen':'rolling'],manifest=models[name].manifest;
  return {responseId:frame.id,receivedAt:frame.receivedAt,arm,topology,allowFixtureArtifacts:true,
    model:{manifest,fit:()=>{throw Error('Unbound model query');}},snapshot:()=>c.snapshots[arm.endsWith('_directed')?'directed':'original']};
}
function overlay(c:any,frame:any,arm:Arm) {
  const ctx=context(c,frame,arm),bank=banks.find((b:any)=>b.bank.request.binding.artifactId===ctx.model!.manifest.artifactId)!.bank;
  const model=bank.model(frame.body,ctx);return adaptResponse(frame.body,{...ctx,model});
}
async function run(c:any,frames:any[],reference=false,profile:'A'|'B'='A') {
  vi.clearAllTimers();vi.setSystemTime(c.at);
  session=await mountSelection({reference,scenario:c.scenario,payload:frames[0].body,clock,profile});
  const transcript:any[]=[];const capture=(label:string)=>transcript.push({label,at:Date.now(),...session.snapshot()});capture('initial');
  for(const f of frames.slice(1)){await session.advanceTo(f.receivedAt);await session.receive(f.body);capture(f.id);}
  await session.advanceTo(c.at+44000);capture('before-expiry');await session.advanceTo(c.at+45000);capture('expired');
  await session.close();session=null;return transcript;
}
describe('complete response, original Python query and actual frontend integration',()=>{
  it('collects full target groups and binds all original response rows and inputs',()=>{
    let refs=0,queries=0;
    for(const {bank}of banks){const r=bank.request;expect(r.manifest.kind).toBe('fixture');queries+=r.queries.length;
      for(const input of r.inputs)for(const row of input.rows){refs++;for(const q of row.queries)expect(r.queries).toContainEqual(q);
        if(row.queries.length)expect(row.queries.map((q:any)=>q[3])).toEqual(row.queries[0][2]===0?[1,2,3,4,5]:[6,7,8,0]);}}
    expect(queries).toBeGreaterThan(0);expect(refs).toBeGreaterThan(queries);summary.queryCount=queries;summary.queryRowReferences=refs;
    const c=cases[0],f=structuredClone(c.frames[0]);f.id='one-row-group';f.body.server_eta.rows=[f.body.server_eta.rows.find((r:any)=>r[1]===47)];
    f.body.server_eta.distributions=[[]];const ctx=context(c,f,'frozen_K8_original'),collector=new QueryCollector();collector.add(f.body,ctx);
    expect(collector.all()[0].queries.map(q=>q[3])).toEqual([6,7,8,0]);summary.checks.push('all-target query collection including absent group rows');
  });
  it('rejects missing, duplicate, changed, wrong-pool/source or unbound queries; null is explicit support failure',()=>{
    const {meta}=banks.find((b:any)=>b.bank.request.queries.length>0)!;
    const req=fs.readFileSync(path.join(ROOT,meta.request)),bytes=fs.readFileSync(path.join(ROOT,meta.result));
    const result=JSON.parse(bytes.toString());
    const check=(r:any,pattern:RegExp)=>{const b=Buffer.from(JSON.stringify(r));expect(()=>queryBank(req,b,sha(b),meta.runtimeSha256)).toThrow(pattern);};
    check({...result,rows:result.rows.slice(1)},/Missing/);check({...result,rows:[...result.rows,result.rows[0]]},/Duplicate/);
    check({...result,binding:{...result.binding,pathsSha256:'f'.repeat(64)}},/binding/);
    check({...result,binding:{...result.binding,sourceSha256:'f'.repeat(64)}},/binding/);
    check({...result,requestSha256:'f'.repeat(64)},/binding/);
    expect(()=>queryBank(req,Buffer.from(JSON.stringify({...result,rows:[]})),meta.resultSha256,meta.runtimeSha256)).toThrow(/hash/);
    const nulls=Buffer.from(JSON.stringify({...result,rows:result.rows.map((r:any)=>({...r,fit:null}))}));
    const nullBank=queryBank(req,nulls,sha(nulls),meta.runtimeSha256),input=nullBank.request.inputs[0];
    const c=cases.find((c:any)=>c.frames.some((f:any)=>f.id===input.responseId)),f=c.frames.find((f:any)=>f.id===input.responseId),ctx=context(c,f,input.arm);
    const m=nullBank.model(f.body,ctx),r=adaptResponse(f.body,{...ctx,model:m});expect(r.body).toBe(f.body);
    expect(r.audit.rows.some(a=>a.reason==='group lacks historical support')).toBe(true);
    expect(()=>m.fit([19,ctx.model!.manifest.K,0,1,123])).toThrow(/Missing/);
    const altered=structuredClone(f.body);altered.server_eta.rows[0][2]++;expect(()=>nullBank.model(altered,ctx)).toThrow(/bound/);
    expect(()=>nullBank.model(f.body,{...ctx,receivedAt:ctx.receivedAt+1})).toThrow(/bound/);
    const changed={...ctx,snapshot:()=>({...ctx.snapshot('',19,0)!,index:7})};expect(()=>nullBank.model(f.body,changed)).toThrow(/changed/);
    expect(()=>nullBank.model(f.body,{...ctx,snapshot:()=>({...ctx.snapshot('',19,0)!,prefixSha256:'f'.repeat(64)})})).toThrow(/changed/);
    summary.checks.push('missing/null distinction and source/pool/query/input hash binding');
  });
  it('matches no-treatment component state and actual same-array attachment',async()=>{
    for(const profile of ['A','B'] as const){const c=cases[0],reference=await run(c,c.frames,true,profile),adapter=await run(c,c.frames,false,profile);
      expect(adapter).toEqual(reference);records.push({name:'no-treatment',profile,reference,adapter});}
    vi.clearAllTimers();vi.setSystemTime(cases[0].at);let buses:any;
    const setters=new Proxy({}, {get:(_t,key)=>((v:any)=>{if(key==='setBuses')buses=v;})});
    applyPublicResponse(structuredClone(cases[0].frames[0].body),setters);
    expect(serverArrivals(buses,[47],Date.now())).not.toBeNull();expect(serverArrivals(buses.slice(),[47],Date.now())).toBeNull();
    summary.checks.push('no-treatment full reference component and same-array server attachment');
  });
  it('preserves all four original controls while independently executing both frontend profiles',async()=>{
    const outputs:any={};let changed=0;
    for(const c of cases)for(const profile of ['A','B'] as const)for(const arm of ARMS) {
      const frames=c.frames.map((f:any)=>{const r=overlay(c,f,arm);changed+=r.audit.changedRows;
        expect(r.body.server_eta.distributions).toBe(f.body.server_eta.distributions);
        const target=r.body.server_eta.rows.find((a:any)=>a[1]===c.originalTarget&&a[0]===0);
        expect({eta:target[2],low:target[3],high:target[4]}).toEqual(c.originalCandidates[arm]);
        return {...f,body:r.body};});
      const reference=await run(c,frames,true,profile),actual=await run(c,frames,false,profile);expect(actual).toEqual(reference);
      outputs[`${c.name}/${profile}/${arm}`]=actual;records.push({name:c.name,profile,arm,reference,adapter:actual});
    }
    // Fresh mounts in reverse treatment order: no mutable stores, clocks or
    // reminder/ranking state may leak between arms.
    for(const c of [...cases].reverse())for(const profile of ['B','A'] as const)for(const arm of [...ARMS].reverse()) {
      const frames=c.frames.map((f:any)=>({...f,body:overlay(c,f,arm).body}));
      expect(await run(c,frames,false,profile)).toEqual(outputs[`${c.name}/${profile}/${arm}`]);
    }
    expect(changed).toBeGreaterThan(0);summary.changedDevelopmentArmRows=changed;summary.independentArmProfiles=cases.length*2*ARMS.length;
    summary.checks.push('four-arm original controls, full reference parity and reverse-order isolation');
  });
  it('invalid and unsupported full wires retain exact baseline state, aging and expiry',async()=>{
    const c=cases[0];
    for(const kind of ['invalid','missing-model','missing-clock','unsupported-fit']) {
      const frames=c.frames.map((f:any)=>{const b=structuredClone(f.body),ctx=context(c,{...f,body:b},'frozen_K8_original');
        if(kind==='invalid')b.server_eta.rows[0][2]=-1;
        if(kind==='missing-model')delete ctx.model;
        if(kind==='missing-clock')ctx.snapshot=()=>null;
        if(kind==='unsupported-fit')ctx.model!.fit=()=>null;
        if(kind==='invalid')ctx.model!.fit=()=>{throw Error('Invalid wire must never query');};
        const r=adaptResponse(b,ctx);expect(r.body).toBe(b);return {...f,body:b};});
      const ref=await run(c,frames,true,'B'),actual=await run(c,frames,false,'B');expect(actual).toEqual(ref);
      expect(actual.at(-1).etaFresh).toBe(false);records.push({name:kind,reference:ref,adapter:actual});
    }
    summary.checks.push('invalid/unsupported fallback and actual frontend clock expiry');
  });
  it('records ranking and reminder divergence with separate declared mechanism fixtures',async()=>{
    // These values deliberately exercise component branches. They are not the
    // original Python fits, candidate performance or evidence favoring a lead.
    const c=structuredClone(cases[0]),base=c.frames[0].body,at=c.at,seq=topology.sequence;
    base.server_eta.buses[0][2]=0;Object.assign(base.buses[0],base.stop_coords[seq[0]],{last_stop_id:seq[0],observed_at:at});
    for(const row of base.server_eta.rows) {
      if(row[0]===0){const i=seq.indexOf(row[1]),eta=i===1?600:i===5?1000:500+i*100;
        Object.assign(row,{2:eta,3:i===1?500:i===5?900:Math.max(0,eta-100),4:i===1?1000:i===5?1900:eta+900,5:i||9});}
      else Object.assign(row,row[1]===147?{2:650,3:600,4:1000}:{2:1600,3:1500,4:1900});
    }
    for(const segment of Object.values(base.segments['19']) as any[])segment.avg=60;
    base.segments['3']['147-121'].avg=120;
    base.server_eta.distributions=base.server_eta.rows.map((r:any)=>Array.from({length:50},(_,j)=>r[3]+(r[4]-r[3])*j/49));
    const origin=(seconds:number)=>({departed:at-seconds*1000,knownAt:at-seconds*1000+20000,route:19});
    const origins={'0':origin(2600),'1':origin(2500),'4':origin(2200),'6':origin(1900)};
    const results:any={};
    for(const brownOnly of [false,true]) {
      const b=structuredClone(base);
      if(brownOnly){b.buses=b.buses.slice(0,1);b.server_eta.buses=b.server_eta.buses.slice(0,1);
        b.server_eta.rows=b.server_eta.rows.filter((r:any)=>r[0]===0);b.server_eta.distributions=b.server_eta.distributions.slice(0,b.server_eta.rows.length);delete b.routes['3'];}
      for(const arm of ARMS) {
        const k=arm.startsWith('frozen')?8:5,variant=arm.endsWith('_directed')?'directed':'original';
        const ctx=context(c,c.frames[0],arm),syntheticHash=bodyHash({mechanismOnly:true,K:k,parameters:'fixed component branch exercise'});
        ctx.model={manifest:{...ctx.model!.manifest,artifactId:`synthetic-mechanism/K${k}`,pathsSha256:syntheticHash,sourceSha256:syntheticHash},fit:q=>{
          const elapsed=(at-q[4])/1000,t=q[3],eta=t===1?600:t===5?1000:500+t*100;
          const low=t===1?(k===8?100:260):Math.min(900,eta-50),high=t===5?(k===8?1100:1700):eta+500;
          return {eta:elapsed+eta,low:elapsed+low,high:elapsed+high,effective:20,days:4};}};
        ctx.snapshot=()=>({...c.snapshots[variant],asof:at,observedAt:at,index:0,nearest:0,phase:variant==='original'?'drive':'hold',
          began:at-120000,ready:true,origins,releasedOrigins:{},variant});
        const applied=adaptResponse(b,ctx);expect(applied.body.server_eta.distributions).toBe(b.server_eta.distributions);
        const frames=[{id:'mechanism/0',receivedAt:at,body:applied.body},{id:'mechanism/1',receivedAt:at+15000,
          body:{...applied.body,server_eta:{...applied.body.server_eta,servedAt:at+15000}}}];
        const actual=await run(c,frames,false,'B'),reference=await run(c,frames,true,'B');expect(actual).toEqual(reference);
        results[`${brownOnly}/${arm}`]={initialOrder:actual[0].orderedOptions.map((o:any)=>o.routeLabel),
          pings:actual.at(-1).events.filter((e:any)=>e.type==='would_signal').map((e:any)=>({at:e.at,kind:e.kind})),
          movement:actual.at(-1).movement};records.push({name:'mechanism-only',brownOnly,arm,reference,adapter:actual});
      }
    }
    expect(results['false/frozen_K8_original'].initialOrder[0]).toBe('Red');
    expect(results['false/frozen_K8_directed'].initialOrder[0]).toBe('Brown');
    const leave=(arm:string)=>results[`true/${arm}`].pings.find((e:any)=>e.kind==='leave_now')?.at;
    expect(leave('frozen_K8_directed')).toBe(at);expect(leave('rolling_K5_directed')).toBeGreaterThan(at);
    expect(leave('frozen_K8_original')).toBeUndefined();
    summary.mechanismOnly=results;summary.checks.push('declared mechanism-only ranking and reminder divergences');
  });
});
