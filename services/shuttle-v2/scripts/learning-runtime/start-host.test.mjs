import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';

it('uses a real kernel lease rather than a reusable PID file to exclude a second supervisor',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'learning-host-lease-'));
 const folder=path.join(root,'service/scripts/learning-runtime');await fs.mkdir(folder,{recursive:true});
 await fs.copyFile(new URL('./start-host.py',import.meta.url),path.join(folder,'start-host.py'));
 await fs.writeFile(path.join(folder,'start.mjs'),`process.stdout.write(JSON.stringify({pid:process.pid,parent:process.ppid,lease:Number(process.env.LEARNING_HOST_LEASE_PID)})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`);
 const workers=[];
 const launch=()=>{
  const child=spawn('python3',[path.join(folder,'start-host.py')],{env:{...process.env,LEARNING_DIR:path.join(root,'state'),LEARNING_HOST_NODE:process.execPath},stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const exit=once(child,'close');const worker={child,exit,stderr:()=>stderr};workers.push(worker);return worker;
 };
 const first=launch();let second;
 try{
  const [data]=await once(first.child.stdout,'data');const ready=JSON.parse(data.toString());
  expect(ready.parent).toBe(first.child.pid);expect(ready.lease).toBe(first.child.pid);
  // Incorrect stale metadata cannot unlock a still-live kernel lease.
  await fs.writeFile(path.join(root,'state/host-runtime.lock'),'stale-pid-number');
  second=launch();expect((await second.exit)[0]).toBe(1);expect(second.stderr()).toContain('already running');
  first.child.stdin.end();expect((await first.exit)[0]).toBe(0);
  const third=launch();
  const [next]=await once(third.child.stdout,'data');expect(JSON.parse(next.toString()).lease).toBe(third.child.pid);
  third.child.stdin.end();expect((await third.exit)[0]).toBe(0);
 }finally{
  for(const worker of workers)if(worker.child.exitCode===null&&worker.child.signalCode===null){worker.child.stdin.end();await worker.exit;}
  await fs.rm(root,{recursive:true,force:true});
 }
});
