import {execFileSync} from 'node:child_process';
import {matchesProduction} from '../deployment-scope.mjs';
import {monitorFetch} from '../monitor-fetch.mjs';

export const HEALTH_MAX_BYTES=16*1024;
export const HEALTH_TIMEOUT_MS=10_000;
const revisionPattern=/^[a-f0-9]{40}$/;
const buildPattern=/^[a-f0-9]{7,40}$/;

function abortable(promise,signal){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},
      error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}

/** Recheck the original pre-GET revision after any awaited cleanup. This is
 * image-source admission only, not an immutable snapshot or ETA qualification. */
export function launchSourceMatches(admission,{cwd}={}){
  return admission?.allowed===true&&revisionPattern.test(admission.localRevision??'')
    &&buildPattern.test(admission.productionBuild??'')
    &&matchesProduction(admission.productionBuild,{cwd,revision:admission.localRevision});
}

/** One public read with bounded headers/body wait. No credentials, Git fetch,
 * estimator execution, owner/lock mutation or model publication occurs here. */
export async function productionLaunchAdmission({cwd,base='https://yale-shuttle.fly.dev',
  fetchImpl=monitorFetch,signal,timeoutMs=HEALTH_TIMEOUT_MS}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>HEALTH_TIMEOUT_MS)throw Error('Invalid launch health deadline');
  const result={allowed:false,localRevision:null,productionBuild:null};
  const defer=reason=>({...result,reason});
  if(signal?.aborted)return defer('controller-stopping');
  try{
    const revision=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
    if(!revisionPattern.test(revision))return defer('local-revision-unavailable');
    result.localRevision=revision;
  }catch{return defer('local-revision-unavailable');}
  let url;
  try{
    const origin=new URL(base);
    if(origin.protocol!=='https:'||origin.username||origin.password)throw Error('Invalid public health origin');
    url=new URL('/healthz',origin);
  }catch{return defer('production-origin-invalid');}
  const controller=new AbortController();let timedOut=false,reader,response,complete=false;
  const cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try{
    response=await abortable(Promise.resolve().then(()=>fetchImpl(url.toString(),{
      method:'GET',headers:{accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,
    })),controller.signal);
    if(response.status!==200)return defer('production-health-http');
    if(response.redirected||!/^application\/json\b/i.test(response.headers.get('content-type')??'')||!response.body)
      return defer('production-health-invalid');
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>HEALTH_MAX_BYTES))return defer('production-health-oversized');
    reader=response.body.getReader();const chunks=[];let bytes=0;
    for(;;){
      const {done,value}=await abortable(reader.read(),controller.signal);if(done)break;
      bytes+=value.byteLength;if(bytes>HEALTH_MAX_BYTES)return defer('production-health-oversized');chunks.push(value);
    }
    complete=true;
    let health;try{health=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
    catch{return defer('production-health-invalid');}
    if(!health||typeof health!=='object'||Array.isArray(health)||health.ok!==true
      ||typeof health.build!=='string'||!buildPattern.test(health.build))return defer('production-health-invalid');
    result.productionBuild=health.build;
    const admitted={...result,allowed:true,reason:'production-image-inputs-match'};
    if(!launchSourceMatches(admitted,{cwd}))return defer('production-image-inputs-differ');
    if(signal?.aborted)return defer('controller-stopping');
    return admitted;
  }catch{return defer(signal?.aborted?'controller-stopping':timedOut?'production-health-timeout':'production-health-unavailable');}
  finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    if(!complete){
      if(reader)void reader.cancel().catch(()=>{});
      else if(response?.body)void response.body.cancel().catch(()=>{});
    }
    reader?.releaseLock();
  }
}
