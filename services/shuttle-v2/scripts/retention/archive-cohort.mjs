#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {assertCohortLineage,declaredCohortFiles} from './cohort-lineage.mjs';
import {durableJson,syncFile,syncDirectories,parentDirectories} from './durable.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const GiB=1024**3,MAX_FILES=16384;
async function digest(file){
 const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||await fs.realpath(file)!==file)throw Error('Archive source contains a link or non-file');
 const h=createHash('sha256'),handle=await fs.open(file,'r');
 try{for await(const chunk of handle.createReadStream({autoClose:false}))h.update(chunk);}finally{await handle.close();}
 const after=await fs.lstat(file);
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Archive source changed during hashing');
 return{bytes:before.size,sha256:h.digest('hex')};
}
async function inventory(directory,prefix=''){
 const files=[];
 for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
  const name=path.posix.join(prefix,entry.name);
  if(entry.isDirectory())files.push(...await inventory(directory,name));
  else if(entry.isFile())files.push(name);
  else throw Error('Archive source contains a link or non-file');
  if(files.length>MAX_FILES)throw Error('Archive file budget exceeded');
 }
 return files.sort();
}
async function contextList(root,trialSHA256){
 const contexts=[];
 for(const entry of await fs.readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^cycle-\d+$/.test(entry.name))continue;
  const directory=path.join(root,entry.name);
  const frozen=await fs.readFile(path.join(directory,'frozen-candidate.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!frozen||JSON.parse(frozen).trialSHA256!==trialSHA256)continue;
  const closed=await fs.readFile(path.join(directory,'closed-state.json'));
  const value=JSON.parse(closed);
  if(value.trialSHA256!==trialSHA256)throw Error('Archive closed/frozen trial identity differs');
  const frozenValue=JSON.parse(frozen);
  const trialBytes=frozenValue.trialFileSHA256!=null?await fs.readFile(path.join(directory,'trial-frozen.json')):null;
  contexts.push({id:entry.name,directory,frozen:frozenValue,frozenSHA256:sha(frozen),closedSHA256:sha(closed),closed:value,
   trialFileSHA256:trialBytes?sha(trialBytes):null,names:await inventory(directory)});
 }
 return contexts.sort((a,b)=>a.id.localeCompare(b.id));
}
async function assertRetired(root,contexts,trialSHA256){
 const state=JSON.parse(await fs.readFile(path.join(root,'state.json'))),ids=new Set([state.id,...(state.priorContexts??[]).map(c=>c.id)]);
 if(state.trial?.sha256===trialSHA256||contexts.some(c=>ids.has(c.id)))throw Error('Archive requires a fully retired trial');
}

/** Copies every original file without releasing it. An incomplete attempt has
 * no sealed manifest and can never authorize rolling retention. */
export async function archiveLearningCohort(root,trialSHA256,destination,{now=Date.now(),maxBytes=16*GiB,minFreeBytes=20*GiB}={}){
 if(!/^[a-f0-9]{64}$/.test(trialSHA256)||!Number.isSafeInteger(maxBytes)||maxBytes<=0
  ||!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw Error('Invalid archive identity or byte budget');
 root=await fs.realpath(root);
 destination=path.join(await fs.realpath(path.dirname(path.resolve(destination))),path.basename(destination));
 if(destination===root||destination.startsWith(root+path.sep)||root.startsWith(destination+path.sep))throw Error('Archive and learning store must be separate trees');
 const contexts=await contextList(root,trialSHA256);
 if(!contexts.length||!contexts.some(c=>typeof c.closed.decision?.promote==='boolean'))throw Error('Archive requires an original completed quality decision');
 assertCohortLineage(contexts,trialSHA256);
 await assertRetired(root,contexts,trialSHA256);
 const files=[];
 for(const c of contexts){
  for(const [name,bytes] of Object.entries(c.closed.source?.inputFiles??{})){
   if(!/^feed-\d{4}-\d{2}-\d{2}-\d{2}-\d+\.jsonl\.gz$/.test(name)||!Number.isSafeInteger(bytes)||bytes<0||!c.names.includes(name))throw Error('Archive is missing an original declared input');
   if((await fs.lstat(path.join(c.directory,name))).size<bytes)throw Error('Archive original is shorter than its declared prefix');
  }
  const declared=declaredCohortFiles(c.frozen,c.closed);
  for(const name of declared.keys())if(!c.names.includes(name))throw Error('Archive is missing declared original context evidence');
  for(const name of c.names){
   const actual=await digest(path.join(c.directory,name)),expected=declared.get(name);
   if(expected&&(expected.sha256&&expected.sha256!==actual.sha256||expected.bytes!=null&&expected.bytes!==actual.bytes
    ||expected.minimumBytes!=null&&expected.minimumBytes>actual.bytes))throw Error('Archive differs from declared original context evidence');
   files.push({path:path.posix.join(c.id,name),...actual});
  }
 }
 const bytes=files.reduce((n,f)=>n+f.bytes,0);
 if(files.length>MAX_FILES||bytes>maxBytes)throw Error('Archive byte/file budget exceeded');
 const space=await fs.statfs(path.dirname(destination));
 if(space.bavail*space.bsize<bytes+minFreeBytes+16*1024**2)throw Error('Archive would exceed the free-space reserve');
 await fs.mkdir(destination,{mode:0o700});
 for(const f of files){
  const free=await fs.statfs(destination);
  if(free.bavail*free.bsize<f.bytes+minFreeBytes+16*1024**2)throw Error('Archive free-space reserve was reached');
  const target=path.join(destination,f.path);
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await fs.copyFile(path.join(root,f.path),target,constants.COPYFILE_EXCL);
  if(JSON.stringify(await digest(target))!==JSON.stringify({bytes:f.bytes,sha256:f.sha256}))throw Error('Archive copy verification differs');
  await syncFile(target);
 }
 // Re-read membership and all originals after the copy, including their real
 // gzip footer bytes. Never seal a truncated prefix or changing cohort.
 const after=await contextList(root,trialSHA256);
 assertCohortLineage(after,trialSHA256);
 const describe=cs=>cs.map(({id,frozenSHA256,closedSHA256,names})=>({id,frozenSHA256,closedSHA256,names}));
 if(JSON.stringify(describe(after))!==JSON.stringify(describe(contexts)))throw Error('Archive context membership changed');
 await assertRetired(root,contexts,trialSHA256);
 for(const f of files)if(JSON.stringify(await digest(path.join(root,f.path)))!==JSON.stringify({bytes:f.bytes,sha256:f.sha256}))throw Error('Archive originals changed during export');
 const manifest={v:1,kind:'learning-cohort-custody',sealed:true,createdAt:new Date(now).toISOString(),trialSHA256,
  contexts:contexts.map(({id,frozenSHA256,closedSHA256})=>({id,frozenSHA256,closedSHA256})),files};
 const raw=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestFile=path.join(destination,'manifest.json');
 if(raw.length>16*1024**2)throw Error('Archive manifest budget exceeded');
 await durableJson(manifestFile,manifest);
 await syncDirectories(parentDirectories(files.map(f=>path.join(destination,f.path)),destination));
 return{manifestFile,manifestSHA256:sha(raw),trialSHA256,bytes,files:files.length,contexts:contexts.length,
  originalsReleased:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==5)throw Error('Usage: node archive-cohort.mjs LEARNING_ROOT TRIAL_SHA256 NEW_ARCHIVE_DIRECTORY');
 console.log(JSON.stringify(await archiveLearningCohort(...process.argv.slice(2)),null,2));
}
