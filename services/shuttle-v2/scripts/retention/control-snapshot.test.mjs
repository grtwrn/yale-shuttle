import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {maintainLearning} from './learning.mjs';
import {captureLearningControls,assertLearningControlsUnchanged,writeLearningCustodyControl} from './control-snapshot.mjs';
import {identityHash} from '../reestimate-validation.mjs';
import {withStorageLock} from './storage.mjs';

const dirs=[],now=Date.parse('2026-11-05T20:30:00Z'),originalReadFile=fs.readFile;
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value)+'\n');
afterEach(async()=>{fs.readFile=originalReadFile;for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'custody-controls-'));dirs.push(root);
 const old='cycle-100',active='cycle-300',trial={v:1,id:old,startedAt:100},trialSHA256=identityHash(trial);
 const state={id:active,trial:{v:1,id:active,startedAt:300},priorContexts:[],forecastProtocol:'served-control-v2',champion:{version:'baseline'}};
 await json(path.join(root,'state.json'),state);
 await fs.mkdir(path.join(root,old));await fs.mkdir(path.join(root,active));
 const frozen={id:old,startedAt:100,trial,trialSHA256};
 await json(path.join(root,old,'frozen-candidate.json'),frozen);
 await json(path.join(root,active,'frozen-candidate.json'),{id:active,startedAt:300});
 const journal='feed-2026-11-05-20-123.jsonl.gz',bytes=Buffer.from('original required journal bytes');
 await fs.writeFile(path.join(root,old,journal),bytes);
 await json(path.join(root,old,'closed-state.json'),{...frozen,invalidatedAt:now-1000,priorContexts:[],source:{inputFiles:{[journal]:bytes.length}}});
 const pin={v:1,trials:[{trialSHA256,contextId:old,frozenSHA256:sha(await fs.readFile(path.join(root,old,'frozen-candidate.json'))),reason:'Required source audit'}]};
 return{root,old,active,state,journal,bytes,pin};
}
function onFinalStateRead(root,action){
 let reads=0;
 fs.readFile=async function(file,...args){
  if(String(file)===path.join(root,'state.json')&&++reads===2)await action();
  return originalReadFile.call(this,file,...args);
 };
}

test('a valid pin added at the final state reread aborts before deleting its journal',async()=>{
 const f=await fixture();onFinalStateRead(f.root,()=>json(path.join(f.root,'custody-pins.json'),f.pin));
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('custody controls changed');
 expect(await fs.readFile(path.join(f.root,f.old,f.journal))).toEqual(f.bytes);
});
test.each(['champion','trial','priorContexts'])('changed %s scope with the same active id aborts deletion',async kind=>{
 const f=await fixture();onFinalStateRead(f.root,async()=>{
  const state={...f.state};
  if(kind==='champion')state.champion={version:'prospective-100'};
  if(kind==='trial')state.trial={...state.trial,startedAt:301};
  if(kind==='priorContexts')state.priorContexts=[{id:f.old}];
  await json(path.join(f.root,'state.json'),state);
 });
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('custody controls changed');
 expect(await fs.readFile(path.join(f.root,f.old,f.journal))).toEqual(f.bytes);
});
test.each(['frozen-candidate.json','closed-state.json'])('changed immutable %s aborts deletion',async name=>{
 const f=await fixture();onFinalStateRead(f.root,()=>fs.appendFile(path.join(f.root,f.old,name),' '));
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('custody controls changed');
 expect(await fs.readFile(path.join(f.root,f.old,f.journal))).toEqual(f.bytes);
});
test('a newly added cycle directory aborts deletion',async()=>{
 const f=await fixture();onFinalStateRead(f.root,()=>fs.mkdir(path.join(f.root,'cycle-400')));
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('custody controls changed');
 expect(await fs.readFile(path.join(f.root,f.old,f.journal))).toEqual(f.bytes);
});
test('a new release control aborts deletion',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.root,'custody-releases'));
 onFinalStateRead(f.root,()=>json(path.join(f.root,'custody-releases','a'.repeat(64)+'.json'),{new:'control'}));
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('custody controls changed');
 expect(await fs.readFile(path.join(f.root,f.old,f.journal))).toEqual(f.bytes);
});
test('only an exact newly verified acceptance receipt is allowed during the pass',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.root,'custody-releases'));
 const before=await captureLearningControls(f.root,f.state),name=`accepted-${'a'.repeat(64)}-${'b'.repeat(64)}.json`;
 const file=path.join(before.root,'custody-releases',name),body=Buffer.from('{"verified":"copy"}\n');
 await fs.writeFile(file,body);
 await expect(assertLearningControlsUnchanged(f.root,before,{state:f.state,acceptedReceipts:new Map([[file,sha(body)]])})).resolves.toBeUndefined();
 await fs.appendFile(file,'changed');
 await expect(assertLearningControlsUnchanged(f.root,before,{state:f.state,acceptedReceipts:new Map([[file,sha(body)]])})).rejects.toThrow('custody controls changed');
});
test('an existing acceptance cannot use the new-receipt exception to hide a change',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.root,'custody-releases'));
 const name=`accepted-${'a'.repeat(64)}-${'b'.repeat(64)}.json`,file=path.join(await fs.realpath(f.root),'custody-releases',name);
 await fs.writeFile(file,'old');const before=await captureLearningControls(f.root,f.state);
 await fs.writeFile(file,'new');
 await expect(assertLearningControlsUnchanged(f.root,before,{state:f.state,acceptedReceipts:new Map([[file,sha('new')]])})).rejects.toThrow('custody controls changed');
});
test('changing active runtime/input files does not invalidate fixed custody controls',async()=>{
 const f=await fixture(),before=await captureLearningControls(f.root,f.state);
 await fs.writeFile(path.join(f.root,f.active,'runtime-dynamic.v8.gz'),'next runtime');
 await fs.writeFile(path.join(f.root,f.active,'feed-2026-11-05-20-456.jsonl.gz'),'new input');
 await expect(assertLearningControlsUnchanged(f.root,before,{state:{...f.state,source:{runtime:{cursor:2},inputFiles:{dynamic:99}},pending:{live:{at:now}}}})).resolves.toBeUndefined();
});
test('unchanged controls retain ordinary rolling behavior',async()=>{
 const f=await fixture();expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(1);
});

async function writerFixture(){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'custody-writer-'));dirs.push(parent);
 const root=path.join(parent,'learning');await fs.mkdir(root);
 const id='cycle-100',trialSHA256='a'.repeat(64);await fs.mkdir(path.join(root,id));
 const frozen=Buffer.from(JSON.stringify({id,trialSHA256})+'\n');await fs.writeFile(path.join(root,id,'frozen-candidate.json'),frozen);
 const pin={v:1,trials:[{trialSHA256,contextId:id,frozenSHA256:sha(frozen),reason:'Required source audit'}]};
 return{parent,root,id,trialSHA256,pin};
}
test('normal custody writer waits for the same storage lock as maintenance',async()=>{
 const f=await writerFixture();let pending;
 await withStorageLock(path.join(f.parent,'.storage'),async()=>{
  pending=writeLearningCustodyControl(f.root,'custody-pins.json',f.pin);
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(await fs.stat(path.join(f.root,'custody-pins.json')).catch(error=>error.code)).toBe('ENOENT');
 });
 const saved=await pending;expect(saved.sha256).toBe(sha(await fs.readFile(saved.file)));
 expect(JSON.parse(await fs.readFile(saved.file))).toEqual(f.pin);
});
test('custody writer publishes anchored updates atomically and leaves no partial control',async()=>{
 const f=await writerFixture();await writeLearningCustodyControl(f.root,'custody-pins.json',f.pin);
 const updated=structuredClone(f.pin);updated.trials[0].reason='Updated neutral custody reason';
 await writeLearningCustodyControl(f.root,'custody-pins.json',updated);
 expect(JSON.parse(await fs.readFile(path.join(f.root,'custody-pins.json')))).toEqual(updated);
 expect((await fs.readdir(f.root)).some(name=>name.endsWith('.partial'))).toBe(false);
 const bad=structuredClone(updated);bad.trials[0].frozenSHA256='b'.repeat(64);
 await expect(writeLearningCustodyControl(f.root,'custody-pins.json',bad)).rejects.toThrow('frozen bytes');
 expect(JSON.parse(await fs.readFile(path.join(f.root,'custody-pins.json')))).toEqual(updated);
});
test('custody writer only permits pin lists and named trial release records',async()=>{
 const f=await writerFixture();
 for(const name of ['state.json','../custody-pins.json','cycle-100/closed-state.json',`custody-releases/accepted-${'a'.repeat(64)}-${'b'.repeat(64)}.json`])
  await expect(writeLearningCustodyControl(f.root,name,f.pin)).rejects.toThrow('Only learning custody');
 const release={v:1,trialSHA256:f.trialSHA256,reviewedAt:new Date().toISOString(),note:'Fixture release descriptor only',
  manifestFile:path.join(f.parent,'archive','manifest.json'),manifestSHA256:'b'.repeat(64)};
 await writeLearningCustodyControl(f.root,`custody-releases/${f.trialSHA256}.json`,release);
 expect(JSON.parse(await fs.readFile(path.join(f.root,'custody-releases',f.trialSHA256+'.json')))).toEqual(release);
});
test('custody writer rejects a linked control directory',async()=>{
 const f=await writerFixture(),outside=path.join(f.parent,'outside');await fs.mkdir(outside);
 await fs.symlink(outside,path.join(f.root,'custody-releases'));
 const release={v:1,trialSHA256:f.trialSHA256,reviewedAt:new Date().toISOString(),note:'Fixture',
  manifestFile:path.join(f.parent,'manifest.json'),manifestSHA256:'b'.repeat(64)};
 await expect(writeLearningCustodyControl(f.root,`custody-releases/${f.trialSHA256}.json`,release)).rejects.toThrow('custody controls changed');
 expect(await fs.readdir(outside)).toEqual([]);
});
