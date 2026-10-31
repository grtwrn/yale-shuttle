import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {withStorageLock} from './storage.mjs';
import {syncDirectories} from './durable.mjs';

const MiB=1024*1024,MAX_FILE_BYTES=64*MiB,MAX_TOTAL_BYTES=256*MiB,MAX_FILES=16384;
const fail=()=>{throw Error('Learning custody controls changed; no evaluation evidence deleted');};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(value).digest('hex');
const identity=st=>({dev:st.dev,ino:st.ino,mode:st.mode});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Only fields which change retention protection, not the changing runtime,
 * live input manifest, clocks or pending served-control-v2 samples. */
function scope(state){
 const value={id:state.id,trial:state.trial??null,trialSHA256:state.trialSHA256??null,
  priorContexts:state.priorContexts??[],champion:state.champion??null,
  forecastProtocol:state.forecastProtocol??null,calibrationDays:state.calibrationDays??null};
 if(state.forecastProtocol!=='served-control-v2')value.legacyReferences={
  pending:Object.values(state.pending??{}).filter(p=>!p.closed&&Number.isFinite(p.at)).map(p=>p.at).sort((a,b)=>a-b),
  candidates:Object.values(state.visits??{}).map(v=>v.candidate?.receivedAt).filter(Number.isFinite).sort((a,b)=>a-b),
 };
 return digest(JSON.stringify(canonical(value)));
}

async function optionalStat(file){
 try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function directory(file){
 const st=await optionalStat(file);
 if(!st)return null;
 if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(file)!==file)fail();
 return identity(st);
}
async function control(file,budget){
 const before=await optionalStat(file);
 if(!before)return null;
 if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_FILE_BYTES
  ||budget.bytes+before.size>MAX_TOTAL_BYTES||++budget.files>MAX_FILES||await fs.realpath(file)!==file)fail();
 budget.bytes+=before.size;
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),hash=createHash('sha256');
 try{
  const opened=await handle.stat();
  if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail();
  for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
 }finally{await handle.close();}
 const after=await optionalStat(file);
 if(!after||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
  ||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail();
 return{...identity(after),bytes:after.size,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs,sha256:hash.digest('hex')};
}

/** Fixed controls only: no runtime checkpoints, feed journals or source trees
 * are scanned. Directory mtimes are intentionally excluded because the active
 * observer legitimately rotates those changing files while cleanup plans. */
export async function captureLearningControls(root,state){
 root=await fs.realpath(root);
 const files=new Map(),cycles=[],budget={bytes:0,files:0};
 for(const entry of await fs.readdir(root,{withFileTypes:true})){
  if(!/^cycle-\d+$/.test(entry.name))continue;
  const dir=path.join(root,entry.name),st=await directory(dir);
  if(!st)fail();
  cycles.push({name:entry.name,...st});
  for(const name of ['frozen-candidate.json','closed-state.json']){
   const relative=entry.name+'/'+name;
   files.set(relative,await control(path.join(root,relative),budget));
  }
 }
 cycles.sort((a,b)=>a.name.localeCompare(b.name));
 files.set('custody-pins.json',await control(path.join(root,'custody-pins.json'),budget));
 const releasesDirectory=await directory(path.join(root,'custody-releases'));
 if(releasesDirectory){
  for(const name of (await fs.readdir(path.join(root,'custody-releases'))).sort()){
   const relative='custody-releases/'+name,value=await control(path.join(root,relative),budget);
   if(!value)fail();
   files.set(relative,value);
  }
 }
 return{root,scopeSHA256:scope(state),cycles,releasesDirectory,files};
}

/** A verified acceptance may be durably added by this very cleanup pass.
 * No exception permits changing a control which was present at planning. */
export async function assertLearningControlsUnchanged(root,before,{state,acceptedReceipts=new Map()}={}){
 if(!(acceptedReceipts instanceof Map))fail();
 const after=await captureLearningControls(root,state);
 if(after.root!==before.root||after.scopeSHA256!==before.scopeSHA256||!same(after.cycles,before.cycles))fail();
 const expected=new Map(before.files);
 for(const [file,sha256] of acceptedReceipts){
  if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file
   ||path.dirname(file)!==path.join(before.root,'custody-releases')
   ||!/^accepted-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(path.basename(file))
   ||typeof sha256!=='string'||! /^[a-f0-9]{64}$/.test(sha256))fail();
  const relative=path.relative(before.root,file);
  if(expected.has(relative)||after.files.get(relative)?.sha256!==sha256)fail();
  expected.set(relative,after.files.get(relative));
 }
 if(before.releasesDirectory){if(!same(before.releasesDirectory,after.releasesDirectory))fail();}
 else if(after.releasesDirectory&&acceptedReceipts.size===0)fail();
 if(expected.size!==after.files.size)fail();
 for(const [name,value] of expected)if(!same(value,after.files.get(name)))fail();
}

/** Normal operator writes share the maintenance lock. Direct/manual writes
 * cannot participate in that serialization; the final snapshot additionally
 * refuses them if their changed controls are observed before deletion. */
export async function writeLearningCustodyControl(root,name,value){
 const release=/^custody-releases\/([a-f0-9]{64})\.json$/.exec(name??'');
 if(name!=='custody-pins.json'&&!release)throw Error('Only learning custody pin/release controls may be written');
 const serialized=JSON.stringify(value,null,2);
 if(typeof serialized!=='string')throw Error('Invalid learning custody JSON');
 const raw=Buffer.from(serialized+'\n'),record=JSON.parse(serialized);
 if(raw.length>256*1024||!record||record.v!==1)throw Error('Invalid learning custody control');
 if(name==='custody-pins.json'){
  if(!Array.isArray(record.trials)||record.trials.length>256)throw Error('Invalid learning custody pin list');
  for(const pin of record.trials)if(!/^[a-f0-9]{64}$/.test(pin?.trialSHA256??'')
   ||!/^cycle-\d+$/.test(pin?.contextId??'')||!/^[a-f0-9]{64}$/.test(pin?.frozenSHA256??'')
   ||typeof pin.reason!=='string'||!pin.reason.trim())throw Error('Invalid learning custody pin');
 }else if(record.trialSHA256!==release[1]||typeof record.note!=='string'||!record.note.trim()
  ||!Number.isFinite(Date.parse(record.reviewedAt))||Date.parse(record.reviewedAt)>Date.now()
  ||typeof record.manifestFile!=='string'||!path.isAbsolute(record.manifestFile)
  ||!/^[a-f0-9]{64}$/.test(record.manifestSHA256??''))throw Error('Invalid learning custody release');
 root=await fs.realpath(root);
 return withStorageLock(path.join(path.dirname(root),'.storage'),async()=>{
  if(name==='custody-pins.json')for(const pin of record.trials){
   const file=path.join(root,pin.contextId,'frozen-candidate.json'),proof=await control(file,{bytes:0,files:0});
   if(!proof||proof.sha256!==pin.frozenSHA256)throw Error('Custody pin differs from original frozen bytes');
   const bytes=await fs.readFile(file);
   if(digest(bytes)!==proof.sha256||JSON.parse(bytes).trialSHA256!==pin.trialSHA256)throw Error('Custody pin differs from original trial');
  }
  const file=path.join(root,name),dir=path.dirname(file);
  if(release)await fs.mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  if(!await directory(dir))throw Error('Invalid learning custody directory');
  const prior=await optionalStat(file);
  if(prior&&(!prior.isFile()||prior.isSymbolicLink()||await fs.realpath(file)!==file))throw Error('Invalid learning custody target');
  const temporary=file+'.'+randomUUID()+'.partial';let handle;
  try{
   handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(raw);await handle.sync();await handle.close();handle=null;
   await fs.rename(temporary,file);
   await syncDirectories([dir,root,path.dirname(root)]);
   return{file,bytes:raw.length,sha256:digest(raw)};
  }finally{
   await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
 });
}
