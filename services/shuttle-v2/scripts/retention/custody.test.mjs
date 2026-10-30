import {afterEach,expect,test,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {maintainLearning} from './learning.mjs';
import {archiveLearningCohort} from './archive-cohort.mjs';

const dirs=[],now=Date.parse('2026-11-05T20:00:00Z'),day=86400000;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
afterEach(async()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true});});
const json=async(file,value)=>fs.writeFile(file,JSON.stringify(value)+'\n');
async function fixture({decision=true,age=9}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'learning-custody-'));dirs.push(root);
 const ids=[`cycle-${now-age*day}`,`cycle-${now-age*day+1000}`],trialDescriptor={v:1,id:ids[0],startedAt:Number(ids[0].slice(6))};
 const trial=sha(JSON.stringify(canonical(trialDescriptor))),links=[];
 const source='feed-2026-11-05-19-1.jsonl.gz';
 await json(path.join(root,'state.json'),{id:`cycle-${now}`,trial:{id:`cycle-${now}`},forecastProtocol:'served-control-v2',champion:{version:'original'}});
 for(const [i,id] of ids.entries()){
  const directory=path.join(root,id);await fs.mkdir(directory);
  const frozen={id,startedAt:Number(id.slice(6)),trialSHA256:trial,trial:trialDescriptor,priorContexts:structuredClone(links),
   sourceKey:sha(id),productionBuild:'fixture'};
  await json(path.join(directory,'frozen-candidate.json'),frozen);
  const original=Buffer.from(`original source ${id}`);await fs.writeFile(path.join(directory,source),original);
  await fs.utimes(path.join(directory,source),(now-120000)/1000,(now-120000)/1000);
  const closed={...frozen,invalidatedAt:now-1000,
   source:{seedSha256:sha('seed'+id),epoch:'epoch-'+id,inputFiles:{[source]:original.length}},...(i===1&&decision?{decision:{promote:false,reasons:['No improvement in pooled weighted interval score.']}}:{})};
  const closedFile=path.join(directory,'closed-state.json');await json(closedFile,closed);
  links.push({id,closedStateSHA256:sha(await fs.readFile(closedFile)),sourceKey:closed.sourceKey,
   productionBuild:closed.productionBuild,seedSha256:closed.source.seedSha256,epoch:closed.source.epoch});
 }
 return{root,trial,ids,source};
}
async function archive(f){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cohort-archive-'));dirs.push(directory);
 const files=[],contexts=[];
 for(const id of f.ids){
  const original=path.join(f.root,id),target=path.join(directory,id);await fs.cp(original,target,{recursive:true});
  const frozen=await fs.readFile(path.join(original,'frozen-candidate.json')),closed=await fs.readFile(path.join(original,'closed-state.json'));
  contexts.push({id,frozenSHA256:sha(frozen),closedSHA256:sha(closed)});
  for(const name of await fs.readdir(original)){
   const bytes=await fs.readFile(path.join(original,name));files.push({path:`${id}/${name}`,bytes:bytes.length,sha256:sha(bytes)});
  }
 }
 const manifest={v:1,kind:'learning-cohort-custody',sealed:true,trialSHA256:f.trial,contexts,files};
 const manifestFile=path.join(directory,'manifest.json');await json(manifestFile,manifest);
 await fs.mkdir(path.join(f.root,'custody-releases'));
 const receipt={v:1,trialSHA256:f.trial,reviewedAt:new Date(now-1).toISOString(),note:'Verified complete original cohort archive.',
  manifestFile,manifestSHA256:sha(await fs.readFile(manifestFile))};
 await json(path.join(f.root,'custody-releases',f.trial+'.json'),receipt);
 return{directory,manifestFile,receipt};
}

test.each([false,true])('a completed quality decision (promote=%s) protects every context without fabricating a source refusal',async promote=>{
 const f=await fixture();
 const last=path.join(f.root,f.ids[1],'closed-state.json'),decision=JSON.parse(await fs.readFile(last));
 decision.decision.promote=promote;await json(last,decision);
 const before=await Promise.all(f.ids.map(id=>fs.readFile(path.join(f.root,id,'closed-state.json'))));
 const result=await maintainLearning(f.root,{now,closedMaxBytes:1});
 expect(result.deletedFiles).toBe(0);expect(result.completedTrialContexts.sort()).toEqual(f.ids);
 for(const [i,id] of f.ids.entries()){
  expect(await fs.readFile(path.join(f.root,id,'closed-state.json'))).toEqual(before[i]);
  expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
 }
});
test('a recent retired journal does not inherit the age of a long-running context',async()=>{
 const f=await fixture({decision:false});
 expect((await maintainLearning(f.root,{now})).deletedFiles).toBe(0);
});
test('neutral pins protect a named trial before any quality decision exists',async()=>{
 const f=await fixture({decision:false}),id=f.ids[0];
 await json(path.join(f.root,'custody-pins.json'),{v:1,trials:[{trialSHA256:f.trial,contextId:id,
  frozenSHA256:sha(await fs.readFile(path.join(f.root,id,'frozen-candidate.json'))),reason:'Original inputs named by a qualification audit.'}]});
 const result=await maintainLearning(f.root,{now,closedMaxBytes:1});expect(result.deletedFiles).toBe(0);expect(result.pinnedTrialContexts.sort()).toEqual(f.ids);
});
test('only a complete verified archive releases completed inputs into ordinary rolling retention',async()=>{
 const f=await fixture(),a=await archive(f);
 const result=await maintainLearning(f.root,{now,closedMaxBytes:1});
 expect(result.deletedFiles).toBe(2);expect(result.archivedTrialContexts.sort()).toEqual(f.ids);
 expect(await fs.readFile(path.join(a.directory,f.ids[0],f.source),'utf8')).toContain('original source');
 // A later cleanup verifies the archived copies even after originals expired.
 expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(0);
});
test.each(['missing','corrupt','incomplete-manifest','path-escape','new-original'])('an invalid %s archive cannot authorize deleting original journals',async kind=>{
 const f=await fixture(),a=await archive(f);const target=path.join(a.directory,f.ids[0],f.source);
 if(kind==='missing')await fs.unlink(target);
 if(kind==='corrupt')await fs.appendFile(target,'changed');
 if(kind==='new-original')await fs.writeFile(path.join(f.root,f.ids[0],'extra-original.json'),'new evidence');
 if(kind==='incomplete-manifest'||kind==='path-escape'){
  const m=JSON.parse(await fs.readFile(a.manifestFile));
  if(kind==='incomplete-manifest')m.files=m.files.filter(file=>!file.path.endsWith(f.source));
  else m.files[0].path='../escape';
  await json(a.manifestFile,m);a.receipt.manifestSHA256=sha(await fs.readFile(a.manifestFile));
  await json(path.join(f.root,'custody-releases',f.trial+'.json'),a.receipt);
 }
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow();
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
});
test('a pin continues to protect originals after a valid archive is available',async()=>{
 const f=await fixture(),id=f.ids[0];await archive(f);
 await json(path.join(f.root,'custody-pins.json'),{v:1,trials:[{trialSHA256:f.trial,contextId:id,
  frozenSHA256:sha(await fs.readFile(path.join(f.root,id,'frozen-candidate.json'))),reason:'Still required by the current source proof.'}]});
 expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(0);
});
test('dry run validates an archive without writing acceptance receipts or deleting originals',async()=>{
 const f=await fixture();await archive(f);const result=await maintainLearning(f.root,{now,closedMaxBytes:1,dryRun:true});
 expect(result.deletedFiles).toBe(2);expect(await fs.readdir(path.join(f.root,'custody-releases'))).toEqual([f.trial+'.json']);
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
});
test('an archive cannot claim initial custody of an already missing original',async()=>{
 const f=await fixture();await archive(f);await fs.unlink(path.join(f.root,f.ids[0],f.source));
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('cannot release missing originals');
 expect(await fs.readFile(path.join(f.root,f.ids[1],f.source),'utf8')).toContain('original source');
});
test.each(['source-root','nested','source-root-alias'])('a release cannot use the %s as its archive',async kind=>{
 const f=await fixture(),a=await archive(f);
 let manifestFile=path.join(f.root,'aliased-archive-manifest.json');
 if(kind==='nested'){
  const nested=path.join(f.root,'archive-copy');await fs.cp(a.directory,nested,{recursive:true});
  manifestFile=path.join(nested,'manifest.json');
 }else{
  await fs.copyFile(a.manifestFile,manifestFile);
  if(kind==='source-root-alias'){
   const alias=path.join(a.directory,'source-alias');await fs.symlink(f.root,alias);
   manifestFile=path.join(alias,path.basename(manifestFile));
  }
 }
 a.receipt.manifestFile=manifestFile;
 await json(path.join(f.root,'custody-releases',f.trial+'.json'),a.receipt);
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('separate trees');
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
 expect((await fs.readdir(path.join(f.root,'custody-releases'))).some(n=>n.startsWith('accepted-'))).toBe(false);
});
test('archived bytes are reverified after earlier rolling removals',async()=>{
 const f=await fixture(),a=await archive(f);await maintainLearning(f.root,{now,closedMaxBytes:1});
 await fs.appendFile(path.join(a.directory,f.ids[0],f.source),'corruption');
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow();
});
test.each(['active','champion','refused'])('a valid archive cannot override %s protection',async kind=>{
 const f=await fixture();
 if(kind==='refused'){
  const file=path.join(f.root,f.ids[1],'closed-state.json'),s=JSON.parse(await fs.readFile(file));
  s.sourceRefusal={reason:'Original failed control remains failed.'};await json(file,s);
 }
 await archive(f);
 const state=JSON.parse(await fs.readFile(path.join(f.root,'state.json')));
 if(kind==='active'){state.id=f.ids[1];state.trial.id=f.ids[0];state.priorContexts=[{id:f.ids[0]}];}
 if(kind==='champion')state.champion.version='prospective-'+f.ids[0].slice(6);
 await json(path.join(f.root,'state.json'),state);
 expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(0);
});
test('an archive member symlink cannot substitute for the original stored bytes',async()=>{
 const f=await fixture(),a=await archive(f),file=path.join(a.directory,f.ids[0],f.source);
 await fs.unlink(file);await fs.symlink(path.join(f.root,f.ids[0],f.source),file);
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow();
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
});
test('bounded whole-cohort export retains all original bytes without automatically releasing them',async()=>{
 const f=await fixture(),parent=await fs.mkdtemp(path.join(os.tmpdir(),'archive-output-'));dirs.push(parent);
 const output=await archiveLearningCohort(f.root,f.trial,path.join(parent,'complete'),{now,minFreeBytes:0});
 expect(output.originalsReleased).toBe(false);expect(output.contexts).toBe(2);expect(output.files).toBe(6);
 expect(output.manifestSHA256).toBe(sha(await fs.readFile(output.manifestFile)));
 const manifest=JSON.parse(await fs.readFile(output.manifestFile));
 for(const m of manifest.files){
  const original=await fs.readFile(path.join(f.root,m.path)),copy=await fs.readFile(path.join(path.dirname(output.manifestFile),m.path));
  expect(copy).toEqual(original);expect(sha(copy)).toBe(m.sha256);
 }
 expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(0);
 await fs.mkdir(path.join(f.root,'custody-releases'));
 await json(path.join(f.root,'custody-releases',f.trial+'.json'),{v:1,trialSHA256:f.trial,reviewedAt:new Date(now).toISOString(),
  note:'Independent fixture review of complete exported cohort.',manifestFile:output.manifestFile,manifestSHA256:output.manifestSHA256});
 expect((await maintainLearning(f.root,{now,closedMaxBytes:1})).deletedFiles).toBe(2);
});
test.each(['byte-cap','missing-input','active-trial','reserve'])('whole-cohort export refuses %s before creating an archive',async kind=>{
 const f=await fixture(),parent=await fs.mkdtemp(path.join(os.tmpdir(),'archive-output-'));dirs.push(parent);
 const destination=path.join(parent,'refused');
 if(kind==='missing-input')await fs.unlink(path.join(f.root,f.ids[0],f.source));
 if(kind==='active-trial'){
  const state=JSON.parse(await fs.readFile(path.join(f.root,'state.json')));state.id=f.ids[0];state.trial.id=f.ids[0];
  await json(path.join(f.root,'state.json'),state);
 }
 await expect(archiveLearningCohort(f.root,f.trial,destination,{now,minFreeBytes:kind==='reserve'?Number.MAX_SAFE_INTEGER:0,
  maxBytes:kind==='byte-cap'?1:1024*1024})).rejects.toThrow();
 expect(await fs.stat(destination).catch(e=>e.code)).toBe('ENOENT');
 expect(await fs.readFile(path.join(f.root,f.ids[1],f.source),'utf8')).toContain('original source');
});
test.each(['missing-context','changed-closed-bytes','omitted-prefix'])('export and manual release refuse %s in the original lineage',async kind=>{
 const f=await fixture();
 if(kind==='missing-context')await fs.rm(path.join(f.root,f.ids[0]),{recursive:true});
 if(kind==='changed-closed-bytes')await fs.appendFile(path.join(f.root,f.ids[0],'closed-state.json'),' ');
 if(kind==='omitted-prefix')for(const name of ['frozen-candidate.json','closed-state.json']){
  const file=path.join(f.root,f.ids[1],name),value=JSON.parse(await fs.readFile(file));value.priorContexts=[];await json(file,value);
 }
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'archive-lineage-'));dirs.push(parent);
 await expect(archiveLearningCohort(f.root,f.trial,path.join(parent,'incomplete'),{now,minFreeBytes:0})).rejects.toThrow('lineage');
 // A hand-written, internally checksummed manifest must not bypass exporter validation.
 if(kind==='missing-context')f.ids=f.ids.slice(1);
 await archive(f);
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('lineage');
 expect(await fs.readFile(path.join(f.root,f.ids.at(-1),f.source),'utf8')).toContain('original source');
});
test('a failed acceptance fsync prevents publishing custody and removing original journals',async()=>{
 const f=await fixture();await archive(f);const open=fs.open.bind(fs);
 vi.spyOn(fs,'open').mockImplementation(async(...args)=>{
  const handle=await open(...args);
  if(String(args[0]).includes('/accepted-')&&String(args[0]).endsWith('.partial'))vi.spyOn(handle,'sync').mockRejectedValueOnce(Error('simulated fsync I/O error'));
  return handle;
 });
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow('simulated fsync');
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
 const receipts=await fs.readdir(path.join(f.root,'custody-releases'));
 expect(receipts.some(n=>n.startsWith('accepted-')&&!n.endsWith('.partial'))).toBe(false);
});
test.each(['runtime','seed','event','frozen-source','changed-runtime'])('export and release refuse missing or changed declared %s evidence',async kind=>{
 const f=await fixture(),directory=path.join(f.root,f.ids[1]),file=path.join(directory,'closed-state.json'),closed=JSON.parse(await fs.readFile(file));
 const reference={file:'declared-original.bin',bytes:27,sha256:'c'.repeat(64)};
 if(kind==='runtime'||kind==='changed-runtime')closed.source.runtime=reference;
 if(kind==='seed')closed.source.seedFile=reference;
 if(kind==='event')closed.source.events={['c'.repeat(64)]:reference};
 if(kind==='frozen-source'){
  const frozenFile=path.join(directory,'frozen-candidate.json'),frozen=JSON.parse(await fs.readFile(frozenFile));
  frozen.sourceInventory=closed.sourceInventory=[{file:'engine.ts',sha256:'c'.repeat(64)}];await json(frozenFile,frozen);
 }
 if(kind==='changed-runtime')await fs.writeFile(path.join(directory,reference.file),'wrong bytes');
 await json(file,closed);
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'archive-declared-'));dirs.push(parent);
 await expect(archiveLearningCohort(f.root,f.trial,path.join(parent,'incomplete'),{now,minFreeBytes:0})).rejects.toThrow('declared original context evidence');
 await archive(f);
 await expect(maintainLearning(f.root,{now,closedMaxBytes:1})).rejects.toThrow();
 for(const id of f.ids)expect(await fs.readFile(path.join(f.root,id,f.source),'utf8')).toContain('original source');
});
