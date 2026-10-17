import { execFileSync, spawn } from 'node:child_process';

/** Browser regressions must finish before a deploy can proceed. Keep each
 * check in its own process group. Playwright detaches Chrome into another
 * group, so a timeout also snapshots and stops descendants before their
 * parent exits and they become unidentifiable orphans. */
export async function runBrowserCheck(script, {
  cwd = process.cwd(), env = process.env, timeoutMs = 120_000, stdio = 'inherit',
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Browser check requires a positive finite deadline');
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, [script], { cwd, env, stdio, detached: grouped });
    let timedOut = false, startError;
    const groups = new Set(child.pid ? [child.pid] : []), descendants = new Set();
    const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } };
    const stopKnown = () => {
      if (!child.pid) return;
      if (grouped) for (const pid of [...groups].reverse()) kill(-pid);
      else child.kill('SIGKILL');
      for (const pid of [...descendants].reverse()) kill(pid);
    };
    const stop = () => {
      if (grouped && child.pid) {
        try {
          const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
            encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
          const tree = new Set([child.pid]);
          let expanded = true;
          while (expanded) {
            expanded = false;
            for (const [pid, parent] of rows) if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); expanded = true; }
          }
          for (const [pid, , group] of rows) if (tree.has(pid)) {
            descendants.add(pid);
            if (pid === group) groups.add(pid);
          }
        } catch { console.error('[deploy] Could not inspect browser descendants; stopping the known check process group'); }
      }
      stopKnown();
    };
    const timeoutError = () => new Error(`${script} timed out after ${timeoutMs} ms`);
    const timer = setTimeout(() => { timedOut = true; stop(); reject(timeoutError()); }, timeoutMs);
    process.once('exit', stop); // also clean up when deploy's fail/SIGINT path exits
    child.once('error', error => { startError = error; });
    child.once('exit', stopKnown); // Playwright also closes its detached browser on normal exit
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('exit', stop);
      stopKnown();
      if (startError) reject(new Error(`Could not start ${script}: ${startError.message}`, { cause: startError }));
      else if (timedOut) reject(timeoutError());
      else if (code !== 0) reject(new Error(`${script} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
      else resolve();
    });
  });
}
