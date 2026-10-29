import fs from 'node:fs';
import path from 'node:path';

export const FORECAST_RUNTIME = Object.freeze(JSON.parse(fs.readFileSync(new URL('./runtime-policy.json', import.meta.url), 'utf8')));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Exact posterior trajectories can differ across native runtimes before any
 * rounded wire value differs. A successful short replay cannot certify a
 * different runtime. Keep the actual producer and observer fingerprints. */
export function assertForecastRuntime(execution, producer = false, policy = FORECAST_RUNTIME) {
  if (policy.v !== 1 || typeof policy.managedContainer !== 'boolean' || !hash(policy.nodeBinarySHA256)
    || !/^registry\.fly\.io\/yale-shuttle@sha256:[a-f0-9]{64}$/.test(policy.image)) throw Error('Invalid forecast runtime policy');
  const runtime = producer ? execution?.runtime : execution?.nativeRuntime;
  const binary = producer ? execution?.nodeBinarySHA256 : execution?.runtimeBytes?.nodeBinarySHA256;
  const kind = producer ? 'Production' : 'Learning observer';
  if (!runtime || ['node', 'platform', 'arch', 'timezone'].some(key => runtime[key] !== policy[key])
    || binary !== policy.nodeBinarySHA256) {
    throw Error(`${kind} runtime is incompatible with exact forecast replay; require ${policy.node} ${policy.platform}/${policy.arch} and the pinned Node binary`);
  }
}

export function assertManagedForecastOwner(root, script, { pid=process.pid, id=process.env.LEARNING_RUNTIME_OWNER_ID,
  hostname=process.env.HOSTNAME } = {}, policy=FORECAST_RUNTIME) {
  if(!policy.managedContainer)return;
  let owner;
  try{owner=JSON.parse(fs.readFileSync(path.join(root,'runtime-owner.json'),'utf8'));}
  catch(cause){throw Error('Learning observer must run under its verified Linux container supervisor',{cause});}
  if(pid!==1||owner.v!==1||owner.kind!=='linux-container'||typeof id!=='string'
    ||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)||owner.id!==id||owner.root!==path.resolve(root)
    ||owner.script!==script||owner.image!==policy.image||!['created','running'].includes(owner.phase)
    ||!Number.isSafeInteger(owner.hostPid)||owner.hostPid<=0||owner.context!=='colima-yale-shuttle-eval'
    ||owner.wrapper!==path.resolve(path.dirname(script),'../learning-runtime/start.mjs')
    ||!hash(owner.containerId)||typeof hostname!=='string'||!/^[a-f0-9]{12,64}$/.test(hostname)||!owner.containerId.startsWith(hostname))
    throw Error('Learning observer must run under its verified Linux container supervisor');
}
