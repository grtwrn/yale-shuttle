import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {productionLaunchAdmission,launchSourceMatches,HEALTH_MAX_BYTES} from './launch-admission.mjs';

const dirs=[],prefix='services/shuttle-v2/';
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ys-launch-admission-'));dirs.push(cwd);
  const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-q','--initial-branch=main']);
  const write=(file,text)=>{const target=path.join(cwd,prefix,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
  const commit=()=>{git(['add','--all']);git(['-c','core.hooksPath=/dev/null','-c','user.name=test','-c','user.email=test@test.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']);return git(['rev-parse','HEAD']);};
  write('src/index.ts','export const app=1;');write('web/src/display.ts','export const display=1;');
  const before=commit();return{cwd,write,commit,before};
}
const healthy=f=>Response.json({ok:true,build:f.before.slice(0,12)});

it('admits matching image inputs and operator-only commits/dirty operator state using one public credential-free GET',async()=>{
  const f=fixture();f.write('scripts/learning-runtime/operator.mjs','// operator');const head=f.commit();
  f.write('scripts/learning-runtime/local.mjs','// unrelated operator state');
  const fetchImpl=vi.fn(async(url,options)=>{
    expect(url).toBe('https://yale-shuttle.fly.dev/healthz');
    expect(options.method).toBe('GET');expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');expect(options.cache).toBe('no-store');
    expect(options.headers).toEqual({accept:'application/json'});return healthy(f);
  });
  const result=await productionLaunchAdmission({...f,fetchImpl});
  expect(result).toEqual({allowed:true,localRevision:head,productionBuild:f.before.slice(0,12),reason:'production-image-inputs-match'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each(['src/index.ts','web/src/display.ts'])('defers committed application changes before production catches up: %s',async file=>{
  const f=fixture();f.write(file,'// new image');f.commit();
  expect(await productionLaunchAdmission({...f,fetchImpl:async()=>healthy(f)})).toMatchObject({allowed:false,reason:'production-image-inputs-differ'});
});
it.each(['src/index.ts','web/src/new.ts','package-lock.json'])('defers dirty/untracked image inputs: %s',async file=>{
  const f=fixture();f.write(file,'unpublished');
  expect(await productionLaunchAdmission({...f,fetchImpl:async()=>healthy(f)})).toMatchObject({allowed:false,reason:'production-image-inputs-differ'});
});
it.each(['head','worktree'])('rejects a %s change during the health GET',async change=>{
  const f=fixture();
  const result=await productionLaunchAdmission({...f,fetchImpl:async()=>{
    if(change==='head'){f.write('scripts/operator.mjs','// operator');f.commit();}
    else f.write('src/index.ts','// dirty image');return healthy(f);
  }});
  expect(result).toMatchObject({allowed:false,localRevision:f.before,reason:'production-image-inputs-differ'});
});
it('rechecks the captured revision and current dirty source immediately before create',async()=>{
  const f=fixture(),result=await productionLaunchAdmission({...f,fetchImpl:async()=>healthy(f)});
  expect(launchSourceMatches(result,f)).toBe(true);
  f.write('web/src/display.ts','// changed after health');expect(launchSourceMatches(result,f)).toBe(false);
});
it('refuses unavailable local history without making a request',async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ys-no-git-'));dirs.push(cwd);const fetchImpl=vi.fn();
  expect(await productionLaunchAdmission({cwd,fetchImpl})).toMatchObject({allowed:false,reason:'local-revision-unavailable'});
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(['unknown','unhealthy','truthy','malformed','array','build','http','type','redirect'])('fails closed on production health: %s',async failure=>{
  const f=fixture();
  const result=await productionLaunchAdmission({...f,fetchImpl:async()=>{
    if(failure==='http')return new Response('no',{status:503});
    if(failure==='type')return new Response('{}');
    if(failure==='malformed')return new Response('{',{headers:{'content-type':'application/json'}});
    if(failure==='array')return Response.json([]);
    if(failure==='redirect'){const response=healthy(f);Object.defineProperty(response,'redirected',{value:true});return response;}
    return Response.json({ok:failure==='unhealthy'?false:failure==='truthy'?'yes':true,
      build:failure==='unknown'?'a'.repeat(40):failure==='build'?'HEAD':f.before});
  }});
  expect(result.allowed).toBe(false);expect(result.reason).toBe(failure==='unknown'?'production-image-inputs-differ':failure==='http'?'production-health-http':'production-health-invalid');
});
it.each(['http://example.test','https://user:secret@example.test'])('refuses a non-public/credentialed health origin without fetching: %s',async base=>{
  const f=fixture(),fetchImpl=vi.fn();expect(await productionLaunchAdmission({...f,base,fetchImpl})).toMatchObject({allowed:false,reason:'production-origin-invalid'});
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(['declared','streamed','misleading-length'])('caps health bytes including %s bodies',async kind=>{
  const f=fixture(),cancel=vi.fn();
  const result=await productionLaunchAdmission({...f,fetchImpl:async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array(HEALTH_MAX_BYTES+1));},cancel,
  }),{headers:{'content-type':'application/json',...(kind==='declared'?{'content-length':String(HEALTH_MAX_BYTES+1)}:kind==='misleading-length'?{'content-length':'1'}:{})}})});
  expect(result).toMatchObject({allowed:false,reason:'production-health-oversized'});expect(cancel).toHaveBeenCalledTimes(1);
});
it.each(['headers','body'])('bounds the complete health request when %s stall',async stage=>{
  const f=fixture(),cancel=vi.fn();let requestSignal;
  const result=await productionLaunchAdmission({...f,timeoutMs:20,fetchImpl:async(_url,options)=>{
    requestSignal=options.signal;
    return stage==='headers'?new Promise(()=>{}):new Response(new ReadableStream({cancel}),{headers:{'content-type':'application/json'}});
  }});
  expect(result).toMatchObject({allowed:false,reason:'production-health-timeout'});expect(requestSignal.aborted).toBe(true);
  if(stage==='body')expect(cancel).toHaveBeenCalledTimes(1);
});
it('cancels a pending health read when the controller stops, without exposing error/body content',async()=>{
  const f=fixture(),controller=new AbortController();
  const result=await productionLaunchAdmission({...f,signal:controller.signal,fetchImpl:async()=>{controller.abort();throw Error('secret');}});
  expect(result).toMatchObject({allowed:false,reason:'controller-stopping'});expect(JSON.stringify(result)).not.toContain('secret');
});
