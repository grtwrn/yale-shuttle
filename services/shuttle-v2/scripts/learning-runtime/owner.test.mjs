import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DOCKER_CONTEXT, OWNER_FILE, OWNER_LABEL, probeContainerObserver } from './owner.mjs';
import { FORECAST_RUNTIME } from '../learning-loop/runtime-policy.mjs';
const directories = [];
afterEach(async () => { for (const p of directories.splice(0)) await fs.rm(p, {recursive:true,force:true}); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-owner-')); directories.push(root);
  const script = '/fixture/services/shuttle-v2/scripts/learning-loop/start.ts';
  const wrapper = '/fixture/services/shuttle-v2/scripts/learning-runtime/start.mjs';
  const owner = {v:1,kind:'linux-container',id:'01234567-0123-0123-0123-012345678901',wrapper,script,root,
    hostPid:43210,hostLeasePid:43100,context:DOCKER_CONTEXT,containerId:'a'.repeat(64),image:FORECAST_RUNTIME.image,phase:'running'};
  const info = {state:{Running:true,Paused:false,Dead:false,Pid:123},image:FORECAST_RUNTIME.image.split('@')[1],
    labels:{[OWNER_LABEL]:owner.id},entrypoint:['node'],args:['--import','loader.mjs',script]};
  let hostCommand = `node ${wrapper}`, guestCommand = `node\0${script}\0`, containerError = false;
  const kills = [], calls = [];
  const save = () => fs.writeFile(path.join(root,OWNER_FILE),JSON.stringify(owner));
  await save(); await fs.writeFile(path.join(root,'observer.lock'),'1');
  const exec = async (file,args) => {
    calls.push([file,args]);
    if(file==='ps') return {stdout:args.includes(String(owner.hostLeasePid))?`python3 ${path.dirname(wrapper)}/start-host.py`:`${owner.hostLeasePid} ${hostCommand}`};
    if(containerError) throw Error('Docker unavailable');
    return {stdout:args.includes('inspect')?JSON.stringify(info):guestCommand};
  };
  const probe = () => probeContainerObserver(root,script,{exec,kill:(pid,signal)=>kills.push([pid,signal])});
  return {root,owner,info,kills,calls,save,probe,host:value=>hostCommand=value,guest:value=>guestCommand=value,unavailable:()=>containerError=true};
}
it('verifies the host supervisor, actual container identity and guest command in their separate PID namespaces', async () => {
  const f=await fixture(), result=await f.probe();
  expect(result).toMatchObject({pid:43210,guestPid:1,containerPid:123,alive:true,expectedCommand:true});
  expect(f.kills).toEqual([[43210,0],[43100,0]]); // Never process.kill(1) on the Mac.
  expect(f.calls.some(([file,args])=>file==='docker'&&args.includes('/proc/1/cmdline'))).toBe(true);
});
it('rejects a reused host PID before inspecting any container',async()=>{
  const f=await fixture();f.host('node unrelated.mjs');
  expect(await f.probe()).toMatchObject({alive:false,expectedCommand:false});
  expect(f.calls.some(([file])=>file==='docker')).toBe(false);
});
it.each(['stopped','paused','foreign-owner','foreign-image','probe-command'])('refuses %s container ownership',async scenario=>{
  const f=await fixture();
  if(scenario==='stopped')f.info.state.Running=false;
  if(scenario==='paused')f.info.state.Paused=true;
  if(scenario==='foreign-owner')f.info.labels[OWNER_LABEL]='another';
  if(scenario==='foreign-image')f.info.image='sha256:'+'f'.repeat(64);
  if(scenario==='probe-command')f.info.args.push('--once');
  expect(await f.probe()).toMatchObject({alive:false,expectedCommand:false});
});
it('rejects a different live process even when the container startup metadata matches',async()=>{
  const f=await fixture();f.guest('sleep\0'+'600\0');
  expect(await f.probe()).toMatchObject({alive:false,expectedCommand:false});
});
it('reports unavailable instead of trusting a fresh receipt when Docker cannot be checked',async()=>{
  const f=await fixture();f.unavailable();
  expect(await f.probe()).toMatchObject({alive:false,expectedCommand:false});
});
it('allows the existing host-process probe only when no container receipt exists',async()=>{
  const f=await fixture();await fs.unlink(path.join(f.root,OWNER_FILE));
  expect(await f.probe()).toBeNull();
  await fs.writeFile(path.join(f.root,OWNER_FILE),'broken');
  expect(await f.probe()).toMatchObject({alive:false,expectedCommand:false});
});
