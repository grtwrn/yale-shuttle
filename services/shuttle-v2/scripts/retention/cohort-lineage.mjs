import {createHash} from 'node:crypto';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const identity=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const id=value=>typeof value==='string'&&/^cycle-\d+$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw Error('Learning input custody: incomplete or conflicting original trial lineage');};

/** Metadata-only custody validation. It does not score, refit, or alter the
 * scientific trial. Surviving folders cannot define a convenient new cohort. */
export function assertCohortLineage(contexts,trialSHA256){
 if(!contexts.length)fail();
 const sorted=[...contexts].sort((a,b)=>Number(a.id.slice(6))-Number(b.id.slice(6)));
 const trial=sorted[0].frozen?.trial;
 if(!trial||trial.v!==1||!id(trial.id)||trial.startedAt!==Number(trial.id.slice(6))||identity(trial)!==trialSHA256||sorted[0].id!==trial.id)fail();
 for(const [i,c] of sorted.entries()){
  if(!id(c.id)||c.frozen?.id!==c.id||c.closed?.id!==c.id||c.frozen.trialSHA256!==trialSHA256
   ||c.closed.trialSHA256!==trialSHA256||!equal(c.frozen.trial,trial)||!equal(c.closed.trial,trial)
   ||c.frozen.startedAt!==Number(c.id.slice(6))||c.closed.startedAt!==c.frozen.startedAt
   ||!Array.isArray(c.frozen.priorContexts)||!equal(c.frozen.priorContexts,c.closed.priorContexts)
   ||c.closed.priorContexts.length!==i||!hash(c.frozenSHA256)||!hash(c.closedSHA256))fail();
  if(c.closed.frozenCandidateSha256!=null&&c.closed.frozenCandidateSha256!==c.frozenSHA256)fail();
  if(c.frozen.trialFileSHA256!=null&&(c.trialFileSHA256!==c.frozen.trialFileSHA256
   ||c.closed.trialFileSHA256!==c.frozen.trialFileSHA256))fail();
  for(const [j,link] of c.closed.priorContexts.entries()){
   const prior=sorted[j],value=prior.closed;
   if(link?.id!==prior.id||link.closedStateSHA256!==prior.closedSHA256
    ||!equal(value.priorContexts,c.closed.priorContexts.slice(0,j))
    ||link.sourceKey!==value.sourceKey||link.productionBuild!==value.productionBuild
    ||link.seedSha256!==value.source?.seedSha256||link.epoch!==value.source?.epoch
    ||!hash(link.sourceKey)||!hash(link.seedSha256)||typeof link.productionBuild!=='string'
    ||typeof link.epoch!=='string'||!link.epoch)fail();
  }
 }
 return sorted;
}

const safe=value=>typeof value==='string'&&value&&!value.includes('\\')&&!value.startsWith('/')
 &&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
/** Require every explicitly named native source/checkpoint member, including
 * absent files which would never appear in a directory walk. External training
 * archives retain their separate policy and are not copied by this exporter. */
export function declaredCohortFiles(frozen,closed){
 const required=new Map();
 const add=(file,value)=>{
  if(!safe(file))fail();
  const previous=required.get(file);
  if(previous&&(value.sha256&&previous.sha256&&value.sha256!==previous.sha256
    ||value.bytes!=null&&previous.bytes!=null&&value.bytes!==previous.bytes))fail();
  required.set(file,{...previous,...value});
 };
 const receipt=value=>{
  if(!value||!hash(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<0)fail();
  add(value.file,{bytes:value.bytes,sha256:value.sha256});
 };
 for(const state of [frozen,closed]){
  const source=state.source??{};
  for(const key of ['seedFile','runtime','previousRuntime','seedHTTPReceipt'])if(source[key])receipt(source[key]);
  for(const value of Object.values(source.events??{}))receipt(value);
  for(const [file,minimumBytes] of Object.entries(source.inputFiles??{})){
   if(!Number.isSafeInteger(minimumBytes)||minimumBytes<0)fail();
   add(file,{minimumBytes:Math.max(required.get(file)?.minimumBytes??0,minimumBytes)});
  }
  if(state.trialFileSHA256!=null){if(!hash(state.trialFileSHA256))fail();add('trial-frozen.json',{sha256:state.trialFileSHA256});}
  if(state.calibratedAt){if(!hash(state.calibratedCandidateSha256))fail();add('calibrated-candidate.json',{sha256:state.calibratedCandidateSha256});}
 }
 if(frozen.sourceInventory!=null){
  if(!Array.isArray(frozen.sourceInventory)||!equal(frozen.sourceInventory,closed.sourceInventory))fail();
  const seen=new Set();
  for(const row of frozen.sourceInventory){
   if(!safe(row.file)||!hash(row.sha256)||seen.has(row.file))fail();seen.add(row.file);add('source/'+row.file,{sha256:row.sha256});
  }
 }
 return required;
}
