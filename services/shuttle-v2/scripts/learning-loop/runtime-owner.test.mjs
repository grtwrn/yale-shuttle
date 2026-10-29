import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertManagedForecastOwner, FORECAST_RUNTIME } from './runtime-policy.mjs';
const folders=[];
afterEach(()=>{for(const d of folders.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-forecast-owner-'));folders.push(root);
 const script='/source/scripts/learning-loop/start.ts',id='01234567-0123-0123-0123-012345678901';
 const owner={v:1,kind:'linux-container',root,script,id,containerId:'a'.repeat(64),image:FORECAST_RUNTIME.image,phase:'created',hostPid:43210,
  context:'colima-yale-shuttle-eval',wrapper:'/source/scripts/learning-runtime/start.mjs'};
 const process={pid:1,id,hostname:'a'.repeat(12)};
 const save=()=>fs.writeFileSync(path.join(root,'runtime-owner.json'),JSON.stringify(owner));save();
 return{root,script,owner,process,save,check:()=>assertManagedForecastOwner(root,script,process)};
}
it('requires managed ownership in the installed policy',()=>expect(FORECAST_RUNTIME.managedContainer).toBe(true));
it('accepts only the exact supervisor receipt and actual container namespace',()=>{const f=fixture();expect(f.check).not.toThrow();});
it.each(['wrong-pid','wrong-container','wrong-owner','wrong-script','terminal','missing-id'])('refuses %s before acquiring the observer lock',mode=>{
 const f=fixture();
 if(mode==='wrong-pid')f.process.pid=123;
 if(mode==='wrong-container')f.process.hostname='b'.repeat(12);
 if(mode==='wrong-owner')f.owner.id='another';
 if(mode==='wrong-script')f.owner.script='/other/start.ts';
 if(mode==='terminal')f.owner.phase='terminal';
 if(mode==='missing-id')delete f.process.id;
 f.save();expect(f.check).toThrow('verified Linux container supervisor');
 expect(fs.existsSync(path.join(f.root,'observer.lock'))).toBe(false);
});
