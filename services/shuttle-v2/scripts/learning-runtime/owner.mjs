import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FORECAST_RUNTIME } from '../learning-loop/runtime-policy.mjs';

const execute = promisify(execFile);
export const OWNER_FILE = 'runtime-owner.json';
export const DOCKER_CONTEXT = 'colima-yale-shuttle-eval';
export const OWNER_LABEL = 'io.yale-shuttle.learning-owner';
export const INSPECT_FORMAT = '{"state":{{json .State}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"entrypoint":{{json .Config.Entrypoint}},"args":{{json .Config.Cmd}}}';
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

/** Host and guest PID namespaces are different. Never probe guest PID 1 as
 * if it were the observer on macOS, or trust a receipt without live ownership. */
export async function probeContainerObserver(root, script, { exec = execute, kill = process.kill } = {}) {
  let owner;
  try {
    const raw = await fs.readFile(path.join(root, OWNER_FILE), 'utf8');
    if (Buffer.byteLength(raw) > 8192) throw Error('Oversized runtime owner');
    owner = JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { pid: null, alive: false, expectedCommand: false, runtimeKind: 'linux-container', reason: 'Invalid runtime ownership receipt' };
  }
  const failed = reason => ({ pid: owner.hostPid ?? null, alive: false, expectedCommand: false, runtimeKind: 'linux-container', reason });
  const wrapper = path.resolve(path.dirname(script), '../learning-runtime/start.mjs');
  try {
    if (owner.v !== 1 || owner.kind !== 'linux-container' || owner.wrapper !== wrapper
      || owner.script !== script || owner.root !== path.resolve(root) || owner.context !== DOCKER_CONTEXT
      || !Number.isSafeInteger(owner.hostPid) || owner.hostPid <= 0 || !hash(owner.containerId)
      || !Number.isSafeInteger(owner.hostLeasePid) || owner.hostLeasePid <= 0
      || typeof owner.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner.id)
      || owner.image !== FORECAST_RUNTIME.image || !['created', 'running'].includes(owner.phase)) return failed('Runtime ownership fields differ');
    kill(owner.hostPid, 0);
    const host = await exec('ps', ['-p', String(owner.hostPid), '-o', 'ppid=', '-o', 'args='], { timeout: 5000 });
    const hostArgs=host.stdout.trim().split(/\s+/);
    if (Number(hostArgs[0])!==owner.hostLeasePid || !hostArgs.includes(wrapper)) return failed('Host PID belongs to another command or supervisor');
    kill(owner.hostLeasePid,0);
    const lease=await exec('ps',['-p',String(owner.hostLeasePid),'-o','args='],{timeout:5000});
    if(!lease.stdout.trim().split(/\s+/).includes(path.join(path.dirname(wrapper),'start-host.py')))return failed('Host-kernel lease supervisor is missing');
    const lock = Number(await fs.readFile(path.join(root, 'observer.lock'), 'utf8'));
    if (lock !== 1) return failed('Guest observer PID differs from the container entrypoint');
    const response = await exec('docker', ['--context', DOCKER_CONTEXT, 'inspect', '--type', 'container', '--format', INSPECT_FORMAT, owner.containerId],
      { timeout: 10000, maxBuffer: 32768 });
    const info = JSON.parse(response.stdout);
    if (!info.state?.Running || info.state.Paused || info.state.Dead || !(info.state.Pid > 0)
      || info.image !== owner.image.split('@')[1] || info.labels?.[OWNER_LABEL] !== owner.id
      || JSON.stringify(info.entrypoint) !== JSON.stringify(['node']) || !info.args?.includes(script)
      || info.args.includes('--once')) return failed('The expected observer container is not running');
    const guest = await exec('docker', ['--context', DOCKER_CONTEXT, 'exec', owner.containerId, 'cat', '/proc/1/cmdline'],
      { timeout: 10000, maxBuffer: 16384 });
    const args = guest.stdout.split('\0').filter(Boolean);
    if (!args.includes(script) || args.includes('--once')) return failed('Container PID 1 is not the prospective observer');
    return { pid: owner.hostPid, alive: true, expectedCommand: true, runtimeKind: 'linux-container', guestPid: 1,
      containerPid: info.state.Pid, containerId: owner.containerId, runtimeOwner: owner.id, hostLeasePid:owner.hostLeasePid,
      ownerCreatedAt: owner.createdAt ?? null, containerStartedAt: info.state.StartedAt ?? null,
      containerStatus: info.state.Status ?? null };
  } catch (error) { return failed(String(error.message ?? error).slice(0, 160)); }
}
