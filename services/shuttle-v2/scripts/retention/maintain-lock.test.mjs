import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {maintain} from './maintain.mjs';
import {writeLearningCustodyControl} from './control-snapshot.mjs';
import {identityHash} from '../reestimate-validation.mjs';

const dirs=[],readFile=fs.readFile,rename=fs.rename;
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value)+'\n');
afterEach(async()=>{fs.readFile=readFile;fs.rename=rename;for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true});});
async function fixture({normal=false}={}){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'maintain-learning-lock-'));dirs.push(parent);
 const service=path.join(parent,'service');await fs.mkdir(path.join(service,'scripts'),{recursive:true});
 const root=normal?path.join(service,'scripts/.learning-loop'):path.join(parent,'custom/.learning-loop');await fs.mkdir(root,{recursive:true});
 const old='cycle-100',active='cycle-300',trial={v:1,id:old,startedAt:100},trialSHA256=identityHash(trial);
 await fs.mkdir(path.join(root,old));await fs.mkdir(path.join(root,active));
 const frozen=Buffer.from(JSON.stringify({id:old,startedAt:100,trial,trialSHA256})+'\n');await fs.writeFile(path.join(root,old,'frozen-candidate.json'),frozen);
 await json(path.join(root,active,'frozen-candidate.json'),{id:active,startedAt:300});
 await json(path.join(root,'state.json'),{id:active,trial:{id:active},priorContexts:[],forecastProtocol:'served-control-v2',champion:{version:'prospective-100'}});
 await fs.writeFile(path.join(root,old,'feed-2026-01-01-00-123.jsonl.gz'),'old champion evidence');
 const pin={v:1,trials:[{trialSHA256,contextId:old,frozenSHA256:sha(frozen),reason:'Source audit'}]};
 return{parent,service,root,pin,old};
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('a custom-root custody writer waits while real maintenance plans that store',async()=>{
 const f=await fixture();let enter,release,blocked=false;
 const entered=new Promise(resolve=>{enter=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 fs.readFile=async function(file,...args){
  if(String(file)===path.join(await fs.realpath(f.root),'state.json')&&!blocked){blocked=true;enter();await resume;}
  return readFile.call(this,file,...args);
 };
 const maintenance=maintain(f.service,{learningRoot:f.root});let writer;
 try{
  await entered;writer=writeLearningCustodyControl(f.root,'custody-pins.json',f.pin);await wait(30);
  expect(await fs.stat(path.join(f.root,'custody-pins.json')).catch(error=>error.code)).toBe('ENOENT');
 }finally{release();}
 await maintenance;await writer;
 expect(JSON.parse(await readFile(path.join(f.root,'custody-pins.json')))).toEqual(f.pin);
});
test('custom-root maintenance waits for a writer to publish before reading its controls',async()=>{
 const f=await fixture();let enter,release,blocked=false,stateReads=0;
 const entered=new Promise(resolve=>{enter=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 fs.rename=async function(from,to){
  if(String(to)===path.join(await fs.realpath(f.root),'custody-pins.json')&&!blocked){blocked=true;enter();await resume;}
  return rename.call(this,from,to);
 };
 fs.readFile=async function(file,...args){if(String(file)===path.join(await fs.realpath(f.root),'state.json'))stateReads++;return readFile.call(this,file,...args);};
 const writer=writeLearningCustodyControl(f.root,'custody-pins.json',f.pin);let maintenance;
 try{await entered;maintenance=maintain(f.service,{learningRoot:f.root});await wait(30);expect(stateReads).toBe(0);}
 finally{release();}
 await writer;const result=await maintenance;
 expect(result.learning.pinnedTrialContexts).toContain(f.old);
});
test('a normal learning-root alias does not reacquire its already-held service lock',async()=>{
 const f=await fixture({normal:true}),alias=path.join(f.parent,'learning-alias');await fs.symlink(f.root,alias);
 const result=await maintain(f.service,{learningRoot:alias});expect(result.learning.activeCycle).toBe('cycle-300');
 expect(await fs.stat(path.join(f.service,'scripts/.storage/storage.lock')).catch(error=>error.code)).toBe('ENOENT');
});
test('an absent custom learning root keeps the existing no-valid-state skip behavior',async()=>{
 const f=await fixture(),absent=path.join(f.parent,'absent/.learning-loop');
 const result=await maintain(f.service,{learningRoot:absent});expect(result.learning.skipped).toContain('No valid current cycle');
 expect(await fs.stat(path.dirname(absent)).catch(error=>error.code)).toBe('ENOENT');
});
