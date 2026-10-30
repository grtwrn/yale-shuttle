import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {FORECAST_RUNTIME} from '../learning-loop/runtime-policy.mjs';
import {DOCKER_CONTEXT,OWNER_LABEL} from './owner.mjs';

const state=vi.hoisted(()=>({current:null}));
vi.mock('node:child_process',async()=>{
  const actual=await vi.importActual('node:child_process');
  const execFile=()=>{throw Error('Expected promisified fake command');};
  execFile[Symbol.for('nodejs.util.promisify.custom')]=async(...args)=>state.current.execute(...args);
  return {...actual,execFile,spawn:(...args)=>state.current.spawn(...args)};
});
const dirs=[],wrapper=fileURLToPath(new URL('./start.mjs',import.meta.url));
const service=path.resolve(path.dirname(wrapper),'../..'),oldCid='a'.repeat(64),newCid='b'.repeat(64);
const admitted={allowed:true,reason:'production-image-inputs-match',localRevision:'c'.repeat(40),productionBuild:'d'.repeat(12)};
afterEach(()=>{vi.unstubAllEnvs();process.exitCode=0;for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
async function fixture({previous='terminal',legacy=false,olderImage=false}={}){
  vi.resetModules();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ys-start-admission-'));dirs.push(root);
  vi.stubEnv('LEARNING_DIR',root);vi.stubEnv('LEARNING_HOST_LEASE_PID',String(process.ppid));
  const owner={v:1,kind:'linux-container',id:'01234567-0123-4567-8901-012345678901',wrapper,
    script:path.join(service,'scripts/learning-loop/start.ts'),root,hostPid:process.pid,hostLeasePid:process.ppid,
    context:DOCKER_CONTEXT,image:olderImage?'registry.fly.io/yale-shuttle@sha256:'+'e'.repeat(64):FORECAST_RUNTIME.image,containerId:oldCid,phase:'terminal'};
  const write=(file,value)=>fs.writeFileSync(path.join(root,file),value);
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  write('host-runtime.lock',JSON.stringify({leasePid:process.ppid,launcher:path.join(path.dirname(wrapper),'start-host.py')}));
  if(previous){write('runtime-owner.json',JSON.stringify(owner)+'\n');write('observer.lock','1\n');}
  if(legacy)write('observer.lock','99999999\n');
  const h={root,owner,commands:[],spawned:[],oldRunning:previous==='running',closed:false,createdId:null,onRemove:null,onCreate:null};
  h.info=cid=>{
    const running=cid===oldCid&&!h.spawned.length?h.oldRunning:!!h.spawned.length&&!h.closed;
    return{labels:{[OWNER_LABEL]:cid===oldCid?owner.id:h.createdId},image:(cid===oldCid?owner.image:FORECAST_RUNTIME.image).split('@')[1],
      entrypoint:['node'],args:[owner.script],state:{Running:running,
        Status:running?'running':cid===newCid&&!h.spawned.length?'created':'exited',ExitCode:0,
        StartedAt:'2026-10-30T12:00:00.000Z',FinishedAt:'2026-10-30T12:01:00.000Z'}};
  };
  h.execute=async(command,args)=>{
    h.commands.push([command,...args]);
    if(command==='colima')return{stdout:'',stderr:''};
    if(command!=='docker')throw Error('Unexpected host command');
    const operation=args[2];
    if(operation==='image')return{stdout:'sha256:pinned',stderr:''};
    if(operation==='inspect')return{stdout:JSON.stringify(h.info(args.at(-1))),stderr:''};
    if(operation==='rm'){await h.onRemove?.();return{stdout:args.at(-1),stderr:''};}
    if(operation==='create'){h.createdId=args[args.indexOf('--label')+1].split('=')[1];await h.onCreate?.();return{stdout:newCid,stderr:''};}
    if(operation==='stop')throw Error('Test must never stop an existing guest');
    throw Error('Unexpected Docker operation '+operation);
  };
  h.spawn=(command,args)=>{
    h.spawned.push([command,...args]);const child=new EventEmitter();
    setTimeout(()=>{h.closed=true;child.emit('close',0);},0);return child;
  };
  state.current=h;
  const {start}=await import('./start.mjs');
  return{...h,live:h,read,write,start,status:()=>JSON.parse(read('runtime-launch-status.json')),
    mutations:()=>h.commands.filter(c=>c[0]==='docker'&&['create','rm','stop'].includes(c[3]))};
}

it.each(['terminal',null])('defers new creation (%s predecessor) with an explicit status and untouched original receipts',async previous=>{
  const f=await fixture({previous});const original=previous?f.read('runtime-owner.json'):null,lock=previous?f.read('observer.lock'):null;
  const sourceMatches=vi.fn();await f.start({admission:async()=>({...admitted,allowed:false,reason:'production-image-inputs-differ'}),sourceMatches});
  expect(f.status()).toMatchObject({phase:'deferred',reason:'production-image-inputs-differ'});
  expect(f.mutations()).toEqual([]);expect(f.spawned).toEqual([]);expect(sourceMatches).not.toHaveBeenCalled();
  if(previous){expect(f.read('runtime-owner.json')).toBe(original);expect(f.read('observer.lock')).toBe(lock);}
  else expect(fs.existsSync(path.join(f.root,'runtime-owner.json'))).toBe(false);
});
it('does not retire a dead legacy lock before production admission',async()=>{
  const f=await fixture({previous:null,legacy:true}),lock=f.read('observer.lock');
  await f.start({admission:async()=>({...admitted,allowed:false,reason:'production-health-unavailable'})});
  expect(f.read('observer.lock')).toBe(lock);expect(f.mutations()).toEqual([]);
});
it.each([false,true])('reattaches a verified running owned container without health/source/new-image admission (older image: %s)',async olderImage=>{
  const f=await fixture({previous:'running',olderImage}),admission=vi.fn(),sourceMatches=vi.fn();
  f.write('runtime-launch-status.json',JSON.stringify({phase:'deferred'}));
  await f.start({admission,sourceMatches});
  expect(admission).not.toHaveBeenCalled();expect(sourceMatches).not.toHaveBeenCalled();
  expect(f.spawned).toEqual([['docker','--context',DOCKER_CONTEXT,'attach','--sig-proxy=false',oldCid]]);
  expect(f.commands.some(c=>c.includes('image'))).toBe(false);expect(f.commands.some(c=>c.includes('create'))).toBe(false);
  expect(f.status()).toMatchObject({phase:'reattached',reason:'verified-running-container'});
  const adoption=f.read('runtime-lifecycle.jsonl').trim().split('\n').map(JSON.parse).find(event=>event.kind==='adopted-running-container');
  expect(adoption.owner.phase).toBe(olderImage?'draining':'running');
});
it.each(['owner','lock','running'])('refuses stale predecessor cleanup when %s changes during the health request',async change=>{
  const f=await fixture(),original=f.read('runtime-owner.json');
  await f.start({admission:async()=>{
    if(change==='owner')f.write('runtime-owner.json',original+' ');
    if(change==='lock')f.write('observer.lock','2\n');
    if(change==='running')f.live.oldRunning=true;
    return admitted;
  },sourceMatches:()=>true});
  expect(f.status()).toMatchObject({phase:'deferred',reason:'runtime-ownership-changed'});
  expect(f.mutations()).toEqual([]);expect(f.spawned).toEqual([]);
  expect(f.read('observer.lock')).toBe(change==='lock'?'2\n':'1\n');
});
it('rechecks source before retiring predecessor receipts and immediately after awaited cleanup',async()=>{
  const f=await fixture(),original=f.read('runtime-owner.json'),lock=f.read('observer.lock');let sourceCurrent=true;
  f.live.onRemove=async()=>{sourceCurrent=false;};
  const sourceMatches=vi.fn(()=>sourceCurrent);
  await f.start({admission:async()=>admitted,sourceMatches});
  expect(sourceMatches).toHaveBeenCalledTimes(2);expect(f.mutations().map(c=>c[3])).toEqual(['rm']);
  expect(f.spawned).toEqual([]);expect(f.status()).toMatchObject({phase:'deferred',reason:'production-image-inputs-differ'});
  expect(f.read('runtime-owner.json')).toBe(original);expect(f.read('observer.lock')).toBe(lock);
});
it.each(['owner','lock'])('rechecks replaced %s bytes after awaited terminal container removal',async change=>{
  const f=await fixture(),original=f.read('runtime-owner.json');
  f.live.onRemove=async()=>{f.write(change==='owner'?'runtime-owner.json':'observer.lock',change==='owner'?original+' ':'2\n');};
  await f.start({admission:async()=>admitted,sourceMatches:()=>true});
  expect(f.mutations().map(c=>c[3])).toEqual(['rm']);expect(f.spawned).toEqual([]);
  expect(f.status()).toMatchObject({phase:'deferred',reason:'runtime-ownership-changed'});
  expect(f.read('runtime-owner.json')).toBe(change==='owner'?original+' ':original);
  expect(f.read('observer.lock')).toBe(change==='lock'?'2\n':'1\n');
});
it('preserves a predecessor when source changes after health but before cleanup',async()=>{
  const f=await fixture(),original=f.read('runtime-owner.json');
  await f.start({admission:async()=>admitted,sourceMatches:()=>false});
  expect(f.mutations()).toEqual([]);expect(f.read('runtime-owner.json')).toBe(original);expect(f.read('observer.lock')).toBe('1\n');
});
it('refuses another guest lock namespace before removing even a terminal predecessor',async()=>{
  const f=await fixture();f.write('observer.lock','2\n');
  await expect(f.start({admission:async()=>admitted,sourceMatches:()=>true})).rejects.toThrow('another namespace');
  expect(f.mutations()).toEqual([]);expect(f.read('observer.lock')).toBe('2\n');
});
it('cancels while waiting for health without stopping or mutating the old owned guest',async()=>{
  const f=await fixture(),original=f.read('runtime-owner.json');
  await f.start({admission:async({signal})=>{process.emit('SIGTERM');expect(signal.aborted).toBe(true);return admitted;},sourceMatches:()=>true});
  expect(f.mutations()).toEqual([]);expect(f.read('runtime-owner.json')).toBe(original);expect(f.read('observer.lock')).toBe('1\n');
  expect(f.status()).toMatchObject({phase:'deferred',reason:'controller-stopping'});
});
it('does not create a new container after cancellation during verified terminal cleanup',async()=>{
  const f=await fixture();f.live.onRemove=async()=>process.emit('SIGTERM');
  await f.start({admission:async()=>admitted,sourceMatches:()=>true});
  expect(f.mutations().map(c=>c[3])).toEqual(['rm']);expect(f.spawned).toEqual([]);
  expect(f.status()).toMatchObject({phase:'deferred',reason:'controller-stopping'});
  expect(f.read('observer.lock')).toBe('1\n');
});
it('cancels only its own newly created, verified not-started container if cancellation races create',async()=>{
  const f=await fixture({previous:null});f.live.onCreate=async()=>process.emit('SIGTERM');
  await f.start({admission:async()=>admitted,sourceMatches:()=>true});
  expect(f.mutations().map(c=>c[3])).toEqual(['create','rm']);expect(f.spawned).toEqual([]);
  expect(JSON.parse(f.read('runtime-owner.json'))).toMatchObject({containerId:newCid,phase:'not-started'});
});
it('creates only after admission, replaces an old deferred status, and keeps existing terminal verification',async()=>{
  const f=await fixture({previous:null});f.write('runtime-launch-status.json',JSON.stringify({phase:'deferred'}));
  const sourceMatches=vi.fn(()=>true);await f.start({admission:async()=>admitted,sourceMatches});
  expect(sourceMatches).toHaveBeenCalledTimes(2);expect(f.mutations().map(c=>c[3])).toEqual(['create','rm']);
  expect(f.spawned).toEqual([['docker','--context',DOCKER_CONTEXT,'start','--attach',newCid]]);
  expect(f.status()).toMatchObject({phase:'admitted',localRevision:admitted.localRevision,productionBuild:admitted.productionBuild});
  expect(JSON.parse(f.read('runtime-owner.json'))).toMatchObject({containerId:newCid,phase:'terminal',exitCode:0});
});
