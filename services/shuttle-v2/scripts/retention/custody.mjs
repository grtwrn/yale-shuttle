import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertCohortLineage,declaredCohortFiles} from './cohort-lineage.mjs';
import {durableJson,syncFile,syncDirectories,parentDirectories} from './durable.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const validHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const validId=v=>typeof v==='string'&&/^cycle-\d+$/.test(v);
const fail=message=>{throw Error('Learning input custody: '+message);};
async function read(file,maxBytes=256*1024){
 try{
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>maxBytes)fail('invalid control file');
  const raw=await fs.readFile(file);return{raw,value:JSON.parse(raw)};
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function fileHash(file,bytes){
 const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.size!==bytes||await fs.realpath(file)!==path.resolve(file))fail('archive/source file identity differs');
 const h=createHash('sha256'),handle=await fs.open(file,'r');
 try{for await(const block of handle.createReadStream({autoClose:false}))h.update(block);}finally{await handle.close();}
 const after=await fs.lstat(file);
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('file changed during verification');
 return h.digest('hex');
}
async function tree(directory,prefix=''){
 const result=[];
 for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
  const relative=path.posix.join(prefix,entry.name);
  if(entry.isDirectory())result.push(...await tree(directory,relative));
  else if(entry.isFile())result.push(relative);
  else fail('unexpected context entry');
 }
 return result.sort();
}
const relativeFile=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')
 &&!path.posix.isAbsolute(value)&&value.split('/').every(p=>p&&p!=='.'&&p!=='..');

/** Pins and archive releases are operator custody records, never quality or
 * source verdicts. A corrupt/incomplete release fails before any deletion. */
export async function learningCustody(root,cycles,{now,dryRun}){
 // macOS exposes /var through /private/var. Resolve that prefix once; reject
 // links inside the actual source/archive tree when hashing each member.
 root=await fs.realpath(root);
 cycles=cycles.map(c=>({...c,directory:path.join(root,c.entry.name)}));
 const pinnedTrials=new Set(),completedTrials=new Set(),completedContexts=new Set(),archivedTrials=new Set(),acceptedReceipts=new Map();
 const pinFile=await read(path.join(root,'custody-pins.json'));
 if(pinFile){
  const pins=pinFile.value;
  if(pins.v!==1||!Array.isArray(pins.trials)||pins.trials.length>256)fail('invalid pin list');
  for(const pin of pins.trials){
   if(!validHash(pin.trialSHA256)||!validId(pin.contextId)||!validHash(pin.frozenSHA256)
     ||typeof pin.reason!=='string'||!pin.reason.trim())fail('invalid trial pin');
   const anchor=cycles.find(c=>c.entry.name===pin.contextId);
   if(!anchor||anchor.frozen?.trialSHA256!==pin.trialSHA256||hash(await fs.readFile(path.join(anchor.directory,'frozen-candidate.json')))!==pin.frozenSHA256)fail('pin differs from its original frozen trial');
   pinnedTrials.add(pin.trialSHA256);
  }
 }
 for(const c of cycles){
  if(c.previous?.decision==null)continue;
  if(typeof c.previous.decision.promote!=='boolean')fail('invalid completed decision');
  completedContexts.add(c.entry.name);
  if(c.frozen?.trialSHA256!=null||c.previous.trialSHA256!=null){
   if(!validHash(c.frozen?.trialSHA256)||c.previous.trialSHA256!==c.frozen.trialSHA256)fail('completed trial identity differs');
   completedTrials.add(c.frozen.trialSHA256);
  }
 }
 for(const trial of completedTrials){
  const release=await read(path.join(root,'custody-releases',trial+'.json'));
  if(!release)continue;
  const value=release.value;
  if(value.v!==1||value.trialSHA256!==trial||typeof value.note!=='string'||!value.note.trim()
    ||!Number.isFinite(Date.parse(value.reviewedAt))||Date.parse(value.reviewedAt)>now
    ||typeof value.manifestFile!=='string'||!path.isAbsolute(value.manifestFile)||!validHash(value.manifestSHA256))fail('invalid archive release');
  const archive=await fs.realpath(path.dirname(value.manifestFile));
  if(archive===root||archive.startsWith(root+path.sep)||root.startsWith(archive+path.sep))fail('archive and learning store must be separate trees');
  const manifestFile=path.join(archive,path.basename(value.manifestFile));
  const packed=await read(manifestFile,16*1024*1024);
  if(!packed||hash(packed.raw)!==value.manifestSHA256)fail('archive manifest checksum differs');
  const manifest=packed.value;
  if(manifest.v!==1||manifest.kind!=='learning-cohort-custody'||manifest.sealed!==true||manifest.trialSHA256!==trial
    ||!Array.isArray(manifest.contexts)||!Array.isArray(manifest.files)||manifest.files.length>16384)fail('invalid cohort archive manifest');
  const contexts=cycles.filter(c=>c.frozen?.trialSHA256===trial).sort((a,b)=>a.entry.name.localeCompare(b.entry.name));
  const declared=[...manifest.contexts].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  if(contexts.length!==declared.length||new Set(declared.map(c=>c.id)).size!==declared.length)fail('archive context membership differs');
  for(const c of declared)if(!validId(c.id)||!validHash(c.frozenSHA256)||!validHash(c.closedSHA256))fail('invalid archive context');
  const contextIds=new Set(declared.map(c=>c.id));
  const members=new Map();
  for(const f of manifest.files){
   if(!relativeFile(f.path)||!contextIds.has(f.path.split('/')[0])||!f.path.includes('/')
    ||!Number.isSafeInteger(f.bytes)||f.bytes<0||!validHash(f.sha256)||members.has(f.path))fail('invalid archive member');
   members.set(f.path,f);
   if(await fileHash(path.join(archive,f.path),f.bytes)!==f.sha256)fail('archive bytes changed');
  }
  const acceptedFile=path.join(root,'custody-releases',`accepted-${trial}-${value.manifestSHA256}.json`);
  const accepted=await read(acceptedFile,4*1024*1024);
  if(accepted&&(accepted.value.v!==1||accepted.value.trialSHA256!==trial||accepted.value.manifestSHA256!==value.manifestSHA256
    ||JSON.stringify(accepted.value.contexts)!==JSON.stringify(declared)||!Array.isArray(accepted.value.files)
    ||accepted.value.files.length!==members.size))fail('archive acceptance identity differs');
  const acceptedFiles=new Map();
  for(const f of accepted?.value.files??[]){
   if(acceptedFiles.has(f.path)||members.get(f.path)?.sha256!==f.sha256||members.get(f.path)?.bytes!==f.bytes)fail('archive acceptance membership differs');
   acceptedFiles.set(f.path,f);
  }
  const originals=[];
  const lineage=[];
  for(const [i,c] of contexts.entries()){
   const frozen=await fs.readFile(path.join(c.directory,'frozen-candidate.json')),closed=await read(path.join(c.directory,'closed-state.json'),64*1024*1024);
   if(!closed||declared[i].id!==c.entry.name||hash(frozen)!==declared[i].frozenSHA256||hash(closed.raw)!==declared[i].closedSHA256)fail('archive closed/frozen context differs');
   const trialFile=c.frozen.trialFileSHA256!=null?await read(path.join(c.directory,'trial-frozen.json'),4*1024*1024):null;
   lineage.push({id:c.entry.name,frozen:c.frozen,closed:closed.value,frozenSHA256:hash(frozen),closedSHA256:hash(closed.raw),trialFileSHA256:trialFile?hash(trialFile.raw):null});
   const names=await tree(c.directory),required=new Set(names);
   const declaredFiles=declaredCohortFiles(c.frozen,closed.value);
   for(const name of declaredFiles.keys())required.add(name);
   for(const name of members.keys())if(name.startsWith(c.entry.name+'/'))required.add(name.slice(c.entry.name.length+1));
   for(const name of Object.keys(c.previous?.source?.inputFiles??{})){
    if(!relativeFile(name)||name.includes('/')||!Number.isSafeInteger(c.previous.source.inputFiles[name])||c.previous.source.inputFiles[name]<0)fail('invalid declared original journal');
    required.add(name);
   }
   for(const name of required){
    const relative=path.posix.join(c.entry.name,name),f=members.get(relative);
    if(!f)fail('archive omits original context evidence');
    const expected=declaredFiles.get(name);
    if(expected&&(expected.sha256&&expected.sha256!==f.sha256||expected.bytes!=null&&expected.bytes!==f.bytes
      ||expected.minimumBytes!=null&&expected.minimumBytes>f.bytes))fail('archive differs from declared original evidence');
    if(c.previous?.source?.inputFiles?.[name]>f.bytes)fail('archive is shorter than its original declared prefix');
    const actual=path.join(c.directory,name),st=await fs.lstat(actual).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!st){
     if(!/^feed-\d{4}-\d{2}-\d{2}-\d{2}-\d+\.jsonl\.gz$/.test(name)||!accepted
       ||acceptedFiles.get(relative)?.sha256!==f.sha256||acceptedFiles.get(relative)?.bytes!==f.bytes)fail('cannot release missing originals without a verified prior journal copy');
    }else if(await fileHash(actual,f.bytes)!==f.sha256)fail('original differs from its archive');
    originals.push({path:relative,bytes:f.bytes,sha256:f.sha256});
   }
  }
  assertCohortLineage(lineage,trial);
  // The acceptance records an observed byte-for-byte complete copy BEFORE
  // the first rolling removal; a release note alone cannot invent that fact.
  if(!accepted&&!dryRun){
   for(const f of members.values())await syncFile(path.join(archive,f.path));
   await syncFile(manifestFile);
   await syncDirectories(parentDirectories([...members.keys()].map(name=>path.join(archive,name)),archive));
   const raw=await durableJson(acceptedFile,{v:1,trialSHA256:trial,manifestSHA256:value.manifestSHA256,
    at:new Date(now).toISOString(),contexts:declared,files:originals});
   acceptedReceipts.set(acceptedFile,hash(raw));
  }
  archivedTrials.add(trial);
 }
 return{pinnedTrials,completedTrials,completedContexts,archivedTrials,acceptedReceipts};
}
