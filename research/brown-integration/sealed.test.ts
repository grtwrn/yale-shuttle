import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {mountSelection} from '../../deps/selection/research/synthetic-selection/adapter';
import {applyPublicResponse} from '../../deps/selection/services/shuttle-v2/web/src/__researchSelection.generated';
import {serverArrivals} from '../../deps/selection/services/shuttle-v2/web/src/etaSource';
import {liveAnchorStore} from '../../deps/selection/services/shuttle-v2/web/src/eta';
import {adaptResponse} from '../brown-response/adapter';
import {ARMS,modelUnavailable,type Arm} from '../brown-response/model';
import {QueryCollector,queryBank,sha} from './sidecar';
import {sealedContext,shiftFixture} from './sealed-fixtures';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),OUT=path.join(ROOT,'research/brown-integration/results/sealed');
const read=(name:string)=>JSON.parse(fs.readFileSync(path.join(OUT,name),'utf8'));
const {topology,cases}=read('cases.json'),models=read('models.json'),inventory=read('query-inventory.json');
const banks=inventory.map((meta:any)=>({meta,bank:queryBank(fs.readFileSync(path.join(ROOT,meta.request)),
  fs.readFileSync(path.join(ROOT,meta.result)),meta.resultSha256,meta.runtimeSha256)}));
const records:any[]=[],summary:any={checks:[],actualSealedArtifacts:true,syntheticInputsOnly:true,
  prospectiveBodiesRead:0,outcomesRead:0,productionChanged:false};
let session:any;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(cases[0].at);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{if(url==='/api/weather')return {ok:false};throw Error(`Forbidden request ${url}`);}));});
afterEach(async()=>{
  if(session)await session.close();session=null;expect(liveAnchorStore.size).toBe(0);
  expect(vi.mocked(fetch).mock.calls.every(([url])=>url==='/api/weather')).toBe(true);
  vi.useRealTimers();vi.unstubAllGlobals();
  fs.writeFileSync(path.join(OUT,'transcripts.json.gz'),zlib.gzipSync(JSON.stringify(records)));
  fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2)+'\n');
});
const clock={now:()=>Date.now(),advance:async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);}};
const ctxFor=(c:any,f:any,arm:Arm)=>sealedContext(c,f,arm,topology,models);
function over(c:any,f:any,arm:Arm) {
  const ctx=ctxFor(c,f,arm),bank=banks.find((b:any)=>b.bank.request.binding.artifactId===ctx.model!.manifest.artifactId)!.bank;
  return adaptResponse(f.body,{...ctx,model:bank.model(f.body,ctx)});
}
async function run(c:any,frames:any[],reference=false,profile:'A'|'B'='A') {
  vi.clearAllTimers();vi.setSystemTime(c.at);
  session=await mountSelection({reference,scenario:c.scenario,payload:frames[0].body,clock,profile});
  const rows:any[]=[];const capture=(label:string)=>rows.push({label,at:Date.now(),...session.snapshot()});capture('initial');
  for(const frame of frames.slice(1)){await session.advanceTo(frame.receivedAt);await session.receive(frame.body);capture(frame.id);}
  await session.advanceTo(c.at+44000);capture('before-expiry');await session.advanceTo(c.at+45000);capture('expired');
  await session.close();session=null;return rows;
}

describe('actual sealed K5/K8 with synthetic response clocks only',()=>{
  it('uses exact sealed manifests and every full-group query without fixture availability',()=>{
    const expected={frozen:['d8648c2a87c00a113268e5da49ef6a8fa46c62081f740ac9bf8152fb7f648c76',1790057940242,1789531200000,1790742600000],
      rolling:['97ff8586a3760e4a3696689510008f9a972b94b989cf793b52bcd4ad457fd54f',1790059735660,1790049600000,1790222400000]};
    let queries=0,refs=0;
    for(const [name,entry]of Object.entries(models) as [keyof typeof expected,any][]) {
      const m=entry.manifest,[id,built,cutoff,until]=expected[name];
      expect([m.artifactId,m.builtAt,m.trainBefore,m.validUntil]).toEqual([id,built,cutoff,until]);
      expect(m.kind).toBe('sealed');expect(m.validFrom).toBe(1790136000000);
      expect(JSON.parse(fs.readFileSync(path.join(ROOT,entry.directory,'manifest.json'),'utf8'))).toEqual(m);
      expect(sha(fs.readFileSync(path.join(ROOT,entry.directory,'manifest.json')))).toBe(entry.manifestSha256);
      const bank=banks.find((b:any)=>b.bank.request.binding.artifactId===id)!.bank;
      expect(bank.request.manifest).toEqual(m);queries+=bank.request.queries.length;
      for(const input of bank.request.inputs)for(const row of input.rows) {
        refs++;for(const q of row.queries)expect(bank.request.queries).toContainEqual(q);
        if(row.queries.length)expect(row.queries.map((q:any)=>q[3])).toEqual(row.queries[0][2]===0?[1,2,3,4,5]:[6,7,8,0]);
      }
      // A one-row wire still asks for all absent members of that wait group.
      const c=cases[0],f=structuredClone(c.frames[0]);f.id=`sealed-one-row/${name}`;
      f.body.server_eta.rows=[f.body.server_eta.rows.find((r:any)=>r[1]===47)];f.body.server_eta.distributions=[[]];
      const ctx=ctxFor(c,f,`${name==='frozen'?'frozen_K8':'rolling_K5'}_directed` as Arm);
      expect(ctx.allowFixtureArtifacts).toBeUndefined();const collector=new QueryCollector();collector.add(f.body,ctx);
      expect(collector.all()[0].queries.map(q=>q[3])).toEqual([6,7,8,0]);
    }
    expect(queries).toBeGreaterThan(0);summary.queryCount=queries;summary.queryRowReferences=refs;
    summary.models=Object.fromEntries(Object.entries(models).map(([name,v]:[string,any])=>[name,
      {artifactId:v.manifest.artifactId,builtAt:v.manifest.builtAt,validFrom:v.manifest.validFrom,validUntil:v.manifest.validUntil}]));
    summary.checks.push('exact sealed manifests and whole-target query accounting');
  });
  it('enforces actual build and validity boundaries using server time rather than receipt',()=>{
    const boundaries:any[]=[];
    for(const arm of ARMS) {
      const manifest=models[arm.startsWith('frozen')?'frozen':'rolling'].manifest;
      const points=[['before-build',manifest.builtAt-1,'model not built at server clock'],
        ['at-build',manifest.builtAt,'model not yet valid'],['before-validity',manifest.validFrom-1,'model not yet valid'],
        ['at-validity',manifest.validFrom,null],['last-valid',manifest.validUntil-1,null],['expired',manifest.validUntil,'model expired']] as const;
      for(const [label,at,reason]of points) {
        const c=shiftFixture(cases[0],at),f=c.frames[0],ctx=ctxFor(c,f,arm);let calls=0;
        ctx.model!.fit=()=>{calls++;return null;};expect(modelUnavailable(ctx.model,arm,at)).toBe(reason);
        const result=adaptResponse(f.body,ctx);expect(result.body).toBe(f.body);
        if(reason){expect(calls).toBe(0);expect(result.audit.rows.some(r=>r.reason===reason)).toBe(true);}
        else expect(calls).toBeGreaterThan(0);
        boundaries.push({arm,label,at,reason,queries:calls});
      }
      // Both actual exports predate validity, so a separate declared fixture
      // isolates a hypothetical build occurring during an otherwise valid day.
      const at=manifest.validFrom+1000,c=shiftFixture(cases[0],at),ctx=ctxFor(c,c.frames[0],arm);
      ctx.model!.manifest={...manifest,kind:'fixture',artifactId:`synthetic-late-build/${arm}`,builtAt:at};
      expect(modelUnavailable(ctx.model,arm,at-1,true)).toBe('model not built at server clock');
      expect(modelUnavailable(ctx.model,arm,at,true)).toBeNull();
      expect(modelUnavailable(ctx.model,arm,at)).toBe('fixture model prohibited');
      for(const serverAt of [manifest.builtAt-1,manifest.validFrom-1,manifest.validUntil-1]) {
        const shifted=shiftFixture(cases[0],serverAt),f=shifted.frames[0];
        f.receivedAt=serverAt+10000;f.body.server_eta.servedAt=f.receivedAt;
        const context=ctxFor(shifted,f,arm);let calls=0;context.model!.fit=()=>{calls++;return null;};
        const result=adaptResponse(f.body,context);expect(result.body).toBe(f.body);
        expect(calls>0).toBe(serverAt===manifest.validUntil-1);
      }
    }
    summary.boundaries=boundaries;summary.checks.push('real build, exclusive expiry and independent server/receipt clocks');
  });
  it('rejects incomplete or mismatched sealed query banks while null is explicit fallback',()=>{
    for(const {bank,meta}of banks) {
      const request=fs.readFileSync(path.join(ROOT,meta.request)),result=JSON.parse(fs.readFileSync(path.join(ROOT,meta.result),'utf8'));
      const check=(value:any,pattern:RegExp)=>{const b=Buffer.from(JSON.stringify(value));expect(()=>queryBank(request,b,sha(b),meta.runtimeSha256)).toThrow(pattern);};
      check({...result,rows:result.rows.slice(1)},/Missing/);check({...result,rows:[...result.rows,result.rows[0]]},/Duplicate/);
      for(const key of ['artifactId','pathsSha256','sourceSha256','rawPrefixSha256','knownAtPrefixSha256'])
        check({...result,binding:{...result.binding,[key]:'f'.repeat(64)}},/binding/);
      check({...result,requestSha256:'f'.repeat(64)},/binding/);check({...result,runtimeSha256:'f'.repeat(64)},/binding/);
      const input=bank.request.inputs[0],c=cases.find((x:any)=>x.frames.some((f:any)=>f.id===input.responseId)),
        f=c.frames.find((x:any)=>x.id===input.responseId),ctx=ctxFor(c,f,input.arm);
      const model=bank.model(f.body,ctx);expect(()=>model.fit([19,ctx.model!.manifest.K,0,1,123])).toThrow(/Missing/);
      expect(()=>bank.model(f.body,{...ctx,receivedAt:ctx.receivedAt+1})).toThrow(/bound/);
      const wrongModel={...ctx,model:{...ctx.model!,manifest:models[ctx.model!.manifest.K===8?'rolling':'frozen'].manifest}};
      expect(()=>bank.model(f.body,wrongModel)).toThrow(/bound/);
      // Synthetic null sidecar is separate from actual sealed query evidence.
      const nullBytes=Buffer.from(JSON.stringify({...result,rows:result.rows.map((r:any)=>({...r,fit:null}))}));
      const nullBank=queryBank(request,nullBytes,sha(nullBytes),meta.runtimeSha256);
      const applied=adaptResponse(f.body,{...ctx,model:nullBank.model(f.body,ctx)});
      expect(applied.body).toBe(f.body);expect(applied.audit.rows.some(r=>r.reason==='group lacks historical support')).toBe(true);
    }
    summary.checks.push('missing query is fatal; wrong bindings rejected; explicit null remains fallback');
  });
  it('retains all non-bound cells and matches four independent frontend arm states in both orders',async()=>{
    const outputs:any={};let changed=0;
    for(const c of cases)for(const profile of ['A','B'] as const)for(const arm of ARMS) {
      const frames=c.frames.map((f:any)=>{
        const original=JSON.stringify(f.body),r=over(c,f,arm);changed+=r.audit.changedRows;
        expect(JSON.stringify(f.body)).toBe(original);expect(r.body.server_eta.distributions).toBe(f.body.server_eta.distributions);
        const restored=structuredClone(r.body);
        restored.server_eta.rows.forEach((row:any,i:number)=>{row[3]=f.body.server_eta.rows[i][3];row[4]=f.body.server_eta.rows[i][4];});
        expect(restored).toEqual(f.body);expect(r.audit.originalRows).toBe(f.body.server_eta.rows.length);
        return {...f,body:r.body};});
      const reference=await run(c,frames,true,profile),actual=await run(c,frames,false,profile);
      expect(actual).toEqual(reference);expect(actual.at(-1).etaFresh).toBe(false);
      outputs[`${c.name}/${profile}/${arm}`]=actual;records.push({name:c.name,profile,arm,reference,adapter:actual});
    }
    for(const c of [...cases].reverse())for(const profile of ['B','A'] as const)for(const arm of [...ARMS].reverse()) {
      const frames=c.frames.map((f:any)=>({...f,body:over(c,f,arm).body}));
      expect(await run(c,frames,false,profile)).toEqual(outputs[`${c.name}/${profile}/${arm}`]);
    }
    expect(changed).toBeGreaterThan(0);summary.changedSyntheticArmRows=changed;summary.independentArmProfiles=cases.length*2*ARMS.length;
    summary.checks.push('non-low/high identity, four-arm full component parity and reverse-order isolation');
  });
  it('keeps invalid, missing, unsupported and expired real-model responses at exact baseline frontend state',async()=>{
    for(const arm of ['frozen_K8_original','rolling_K5_original'] as const)for(const kind of ['baseline','invalid','missing-clock','missing-model','null','expired']) {
      const m=models[arm.startsWith('frozen')?'frozen':'rolling'].manifest,c=kind==='expired'?shiftFixture(cases[0],m.validUntil):cases[0];
      const frames=c.frames.map((f:any)=>{
        const b=structuredClone(f.body),ctx=ctxFor(c,f,arm);
        if(kind==='invalid')b.server_eta.rows[0][2]=-1;
        if(kind==='missing-clock')ctx.snapshot=()=>null;
        if(kind==='missing-model')delete ctx.model;
        if(ctx.model)ctx.model.fit=()=>{if(kind==='null'||kind==='baseline')return null;throw Error('Ineligible response must not query');};
        const result=kind==='baseline'?{body:b}:adaptResponse(b,ctx);expect(result.body).toBe(b);return {...f,body:b};
      });
      const actual=await run(c,frames,false,'B'),reference=await run(c,frames,true,'B');expect(actual).toEqual(reference);
      records.push({name:`sealed-fallback/${arm}/${kind}`,adapter:actual,reference});
    }
    vi.clearAllTimers();vi.setSystemTime(cases[0].at);let buses:any;
    const setters=new Proxy({}, {get:(_t,key)=>((value:any)=>{if(key==='setBuses')buses=value;})});
    const body=over(cases[0],cases[0].frames[0],'rolling_K5_directed').body;
    applyPublicResponse(structuredClone(body),setters);expect(serverArrivals(buses,[47],Date.now())).not.toBeNull();
    expect(serverArrivals(buses.slice(),[47],Date.now())).toBeNull();
    summary.checks.push('exact fullwire fallback component states and actual same-array attachment');
  });
});
