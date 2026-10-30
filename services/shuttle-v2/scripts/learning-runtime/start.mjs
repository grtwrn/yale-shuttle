import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { FORECAST_RUNTIME } from '../learning-loop/runtime-policy.mjs';
import { DOCKER_CONTEXT, INSPECT_FORMAT, OWNER_FILE, OWNER_LABEL } from './owner.mjs';
import { productionLaunchAdmission, launchSourceMatches } from './launch-admission.mjs';

const execute=promisify(execFile);
const wrapper=fileURLToPath(import.meta.url),service=path.resolve(path.dirname(wrapper),'../..');
const root=path.resolve(process.env.LEARNING_DIR??path.join(service,'scripts/.learning-loop'));
const script=path.join(service,'scripts/learning-loop/start.ts');
const archive=path.resolve(process.env.ARCHIVE_DIR??path.join(os.homedir(),'shuttle-archive'));
const token=path.resolve(process.env.SHUTTLE_ADMIN_TOKEN_FILE??path.join(os.homedir(),'.config/yale-shuttle/admin-token'));
const containerName='yale-shuttle-learning';
const hostLock=path.join(root,'host-runtime.lock');
const ownerFile=path.join(root,OWNER_FILE);
const lockFile=path.join(root,'observer.lock');
const historyFile=path.join(root,'runtime-lifecycle.jsonl');
const launchStatusFile=path.join(root,'runtime-launch-status.json');
const read=file=>{try{return fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const atomic=(file,value)=>{fs.writeFileSync(file+'.partial',JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.partial',file);};
const history=value=>{
  const line=JSON.stringify({at:new Date().toISOString(),...value})+'\n';
  // Only operational process metadata rotates. Frozen trials, original
  // journals, scientific source and unresolved model evidence stay untouched.
  if(fs.existsSync(historyFile)&&fs.statSync(historyFile).size+Buffer.byteLength(line)>4*1024*1024)
    fs.renameSync(historyFile,historyFile+'.previous');
  fs.appendFileSync(historyFile,line,{mode:0o600});
};
const docker=async args=>(await execute('docker',['--context',DOCKER_CONTEXT,...args],{timeout:30000,maxBuffer:65536})).stdout.trim();
async function inspect(id){
  try{return JSON.parse(await docker(['inspect','--type','container','--format',INSPECT_FORMAT,id]));}
  catch(error){if(/No such (object|container)/i.test(error.stderr??''))return null;throw error;}
}
async function hostAlive(pid){
  try{process.kill(pid,0);const r=await execute('ps',['-p',String(pid),'-o','args='],{timeout:5000});return r.stdout.trim().split(/\s+/).includes(wrapper);}
  catch(error){if(error.code==='ESRCH'||error.code===1)return false;throw error;}
}
function owned(owner,info){
  if(owner.v!==1||owner.kind!=='linux-container'||owner.root!==root||owner.wrapper!==wrapper||owner.script!==script
    ||owner.context!==DOCKER_CONTEXT||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner.id??'')||!/^[a-f0-9]{64}$/.test(owner.containerId??'')
    ||!/^registry\.fly\.io\/yale-shuttle@sha256:[a-f0-9]{64}$/.test(owner.image??''))throw Error('Previous runtime ownership is unverifiable');
  if(info&&(info.labels?.[OWNER_LABEL]!==owner.id||info.image!==owner.image.split('@')[1]
    ||JSON.stringify(info.entrypoint)!==JSON.stringify(['node'])||!info.args?.includes(script)||info.args.includes('--once')))
    throw Error('Previous container differs from its original owner receipt');
}
function removeGuestLock(owner,info){
  if(info?.state?.Running)throw Error('Cannot retire a running observer lock');
  const raw=read(lockFile);
  if(raw!==null){if(Number(raw)!==1)throw Error('Observer lock belongs to another namespace');history({kind:'retired-guest-lock',owner:owner.id,containerId:owner.containerId,pid:1,terminal:info?.state??null});fs.unlinkSync(lockFile);}
}

export function containerArguments({owner,service,root,archive,token,base,publish}){
  const observerScript=path.join(service,'scripts/learning-loop/start.ts');
  return ['create','--name',containerName,'--entrypoint','node','--cpus','2','--memory','3g',
    '--log-driver','local','--log-opt','max-size=5m','--log-opt','max-file=3',
    '--label',`${OWNER_LABEL}=${owner.id}`,
    '--mount',`type=bind,source=${service},target=${service},readonly`,
    '--mount',`type=volume,source=yale-shuttle-eval-node-modules,target=${service}/node_modules`,
    '--mount',`type=bind,source=${root},target=${root}`,
    '--mount',`type=bind,source=${archive},target=${archive},readonly`,
    '--mount',`type=bind,source=${token},target=${token},readonly`,
    '--env',`TZ=${FORECAST_RUNTIME.timezone}`,'--env',`LEARNING_DIR=${root}`,
    '--env',`ARCHIVE_DIR=${archive}`,'--env',`SHUTTLE_ADMIN_TOKEN_FILE=${token}`,
    '--env',`BOT_BASE_URL=${base}`,'--env',`LEARNING_PUBLISH=${publish}`,
    '--env',`LEARNING_RUNTIME_OWNER_ID=${owner.id}`,'--workdir',service,FORECAST_RUNTIME.image,
    '--max-old-space-size=2048','--import',`${service}/node_modules/tsx/dist/loader.mjs`,observerScript];
}

export async function start({admission=productionLaunchAdmission,sourceMatches=launchSourceMatches}={}){
  fs.mkdirSync(root,{recursive:true});
  const id=randomUUID(),host={v:1,id,pid:process.pid,wrapper,startedAt:new Date().toISOString()};
  const leasePid=Number(process.env.LEARNING_HOST_LEASE_PID),lease=JSON.parse(read(hostLock)??'null');
  if(!Number.isInteger(leasePid)||leasePid<=0||process.ppid!==leasePid||lease?.leasePid!==leasePid
    ||lease.launcher!==path.join(path.dirname(wrapper),'start-host.py'))
    throw Error('Start the runtime with scripts/learning-runtime/start-host.py to hold its host-kernel lease');
  let owner,child,stopping=false;
  const cancellation=new AbortController();
  const stop=()=>{stopping=true;cancellation.abort();if(owner?.containerId)void docker(['stop','--time','30',owner.containerId]).catch(e=>console.error(e.message));};
  const launchStatus=(phase,reason,evidence={})=>{
    const value={v:1,at:new Date().toISOString(),phase,reason,
      localRevision:evidence.localRevision??null,productionBuild:evidence.productionBuild??null};
    atomic(launchStatusFile,value);
    history({kind:`launch-${phase}`,...value});
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const leaseWatch=setInterval(()=>{if(!stopping&&process.ppid!==leasePid){history({kind:'host-lease-lost',host,leasePid});stop();}},10000);
  try{
    await execute('colima',['start','yale-shuttle-eval','--activate=false'],{timeout:240000,maxBuffer:65536});
    if(stopping)return;
    const previousRaw=read(ownerFile),lockRaw=read(lockFile);let attach=false,predecessor,legacyPid;
    if(previousRaw!==null){
      const previous=JSON.parse(previousRaw),info=await inspect(previous.containerId);owned(previous,info);
      if(previous.hostPid!==process.pid&&await hostAlive(previous.hostPid))throw Error('Another host owns the observer container');
      if(info?.state?.Running){
        owner={...previous,hostPid:process.pid,hostLeasePid:leasePid,phase:previous.image===FORECAST_RUNTIME.image?'running':'draining',adoptedAt:new Date().toISOString()};
        attach=true;history({kind:'adopted-running-container',previousHostPid:previous.hostPid,owner});
        launchStatus('reattached','verified-running-container');
      }else{
        predecessor=previous;
      }
    }else if(lockRaw!==null){
      legacyPid=Number(lockRaw);if(!Number.isSafeInteger(legacyPid)||legacyPid<=0)throw Error('Invalid legacy observer lock');
      try{process.kill(legacyPid,0);throw Error('Legacy host observer is still running; wait for its natural source handover');}
      catch(error){if(error.code!=='ESRCH')throw error;}
    }
    if(stopping)return;
    if(!attach){
      await docker(['image','inspect','--format','{{.Id}}',FORECAST_RUNTIME.image]);
      if(stopping)return;
      const evidence=await admission({cwd:service,base:process.env.BOT_BASE_URL??'https://yale-shuttle.fly.dev',signal:cancellation.signal});
      if(stopping){launchStatus('deferred','controller-stopping',evidence);return;}
      if(!evidence.allowed){launchStatus('deferred',evidence.reason,evidence);return;}
      // The GET yielded control: do not reuse an old terminal observation or
      // erase a receipt/lock replaced while production was being checked.
      const info=predecessor?await inspect(predecessor.containerId):null;
      if(stopping){launchStatus('deferred','controller-stopping',evidence);return;}
      if(predecessor)owned(predecessor,info);
      if(read(ownerFile)!==previousRaw||read(lockFile)!==lockRaw||info?.state?.Running){
        launchStatus('deferred','runtime-ownership-changed',evidence);return;
      }
      if(legacyPid){
        try{process.kill(legacyPid,0);launchStatus('deferred','legacy-observer-running',evidence);return;}
        catch(error){if(error.code!=='ESRCH')throw error;}
      }
      if(predecessor&&lockRaw!==null&&Number(lockRaw)!==1)throw Error('Observer lock belongs to another namespace');
      if(!sourceMatches(evidence,{cwd:service})){launchStatus('deferred','production-image-inputs-differ',evidence);return;}
      if(predecessor){
        history({kind:'verified-previous-terminal',owner:predecessor,terminal:info?.state??null});
        if(info)await docker(['rm',predecessor.containerId]);
      }
      if(stopping){launchStatus('deferred','controller-stopping',evidence);return;}
      if(read(ownerFile)!==previousRaw||read(lockFile)!==lockRaw){
        launchStatus('deferred','runtime-ownership-changed',evidence);return;
      }
      // Preserve the original pre-GET HEAD and recheck dirty image inputs
      // after awaited cleanup, immediately before creating the new container.
      if(!sourceMatches(evidence,{cwd:service})){launchStatus('deferred','production-image-inputs-differ',evidence);return;}
      if(predecessor)removeGuestLock(predecessor,info);
      else if(legacyPid){
        history({kind:'verified-dead-legacy-observer',pid:legacyPid});fs.unlinkSync(lockFile);
      }
      launchStatus('admitted','production-image-inputs-match',evidence);
      owner={v:1,kind:'linux-container',id,wrapper,script,root,hostPid:process.pid,hostLeasePid:leasePid,context:DOCKER_CONTEXT,
        image:FORECAST_RUNTIME.image,phase:'created',createdAt:new Date().toISOString()};
      owner.containerId=await docker(containerArguments({owner,service,root,archive,token,
        base:process.env.BOT_BASE_URL??'https://yale-shuttle.fly.dev',publish:process.env.LEARNING_PUBLISH==='1'?'1':'0'}));
      if(!/^[a-f0-9]{64}$/.test(owner.containerId))throw Error('Invalid created container identity');
      atomic(ownerFile,owner);
      history({kind:'created-container',owner});
    }
    atomic(ownerFile,owner);
    if(stopping&&!attach){
      const info=await inspect(owner.containerId);owned(owner,info);
      if(!info||info.state?.Running)throw Error('Canceled container is unexpectedly running');
      owner={...owner,phase:'not-started',canceledAt:new Date().toISOString()};atomic(ownerFile,owner);
      history({kind:'canceled-before-start',owner});await docker(['rm',owner.containerId]);return;
    }
    child=spawn('docker',['--context',DOCKER_CONTEXT,...(attach?['attach','--sig-proxy=false']:['start','--attach']),owner.containerId],{stdio:'inherit'});
    const completion=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',code=>resolve({code}));});
    const running=await inspect(owner.containerId);
    if(running?.state?.Running&&owner.phase==='created'){owner={...owner,phase:'running'};atomic(ownerFile,owner);}
    const completionResult=await completion;
    if(completionResult.error)throw completionResult.error;
    const code=completionResult.code;
    const info=await inspect(owner.containerId);owned(owner,info);
    if(!info||info.state?.Running||!['exited','dead'].includes(info.state?.Status)
      ||!(Date.parse(info.state.StartedAt)>0)||!(Date.parse(info.state.FinishedAt)>=Date.parse(info.state.StartedAt))
      ||!Number.isInteger(info.state?.ExitCode))throw Error('Observer terminal state could not be verified');
    owner={...owner,phase:'terminal',endedAt:new Date().toISOString(),exitCode:info.state.ExitCode,attachExitCode:code,terminal:info.state};
    atomic(ownerFile,owner);history({kind:'verified-terminal',owner});
    removeGuestLock(owner,info);await docker(['rm',owner.containerId]);
    process.exitCode=owner.exitCode;
  }finally{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    clearInterval(leaseWatch);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===wrapper)start().catch(error=>{console.error(error);process.exitCode=1;});
