import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBrowserCheck } from './browser-stage.mjs';

const directories = [];
async function fixture(source) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ys-browser-stage-')); directories.push(cwd);
  await fs.writeFile(path.join(cwd, 'check.mjs'), source);
  return { cwd, stdio: 'ignore' };
}
async function running(pid) {
  try {
    process.kill(pid, 0);
    // A killed orphan may briefly await init's reap on Linux. It cannot run.
    if (process.platform === 'linux' && (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].startsWith('Z')) return false;
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
}
async function stopped(pid) {
  for (let attempt = 0; attempt < 50 && await running(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(await running(pid)).toBe(false);
}
afterEach(async () => {
  for (const cwd of directories.splice(0)) {
    try {
      const { parent, child } = JSON.parse(await fs.readFile(path.join(cwd, 'ready.json'), 'utf8'));
      for (const pid of [child, parent].filter(Number.isInteger)) {
        if (process.platform !== 'win32') try { process.kill(-pid, 'SIGKILL'); } catch { /* no leaked fixture group */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* no leaked fixture process */ }
      }
    } catch { /* fixture did not spawn */ }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

describe('bounded browser stage', () => {
  it('waits for a successful check and retains its output artifact', async () => {
    const options = await fixture("import fs from 'node:fs'; fs.writeFileSync('passed.txt', 'all assertions passed');");
    await runBrowserCheck('check.mjs', options);
    expect(await fs.readFile(path.join(options.cwd, 'passed.txt'), 'utf8')).toBe('all assertions passed');
  });
  it('rejects a failed assertion rather than continuing deployment', async () => {
    const options = await fixture('process.exit(7);');
    await expect(runBrowserCheck('check.mjs', options)).rejects.toThrow(/check.mjs failed \(exit 7\)/);
  });
  it('rejects launch failures and invalid deadlines', async () => {
    const options = await fixture('');
    await expect(runBrowserCheck('check.mjs', { ...options, cwd: path.join(options.cwd, 'missing') })).rejects.toThrow(/Could not start/);
    for (const timeoutMs of [0, -1, NaN, Infinity]) await expect(runBrowserCheck('check.mjs', { ...options, timeoutMs })).rejects.toThrow(/deadline/);
  });
  it('fails a stalled check by its deadline even when it ignores SIGTERM', async () => {
    const options = await fixture(`import fs from 'node:fs';
      fs.writeFileSync('ready.json', JSON.stringify({ parent: process.pid }));
      process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`);
    await expect(runBrowserCheck('check.mjs', { ...options, timeoutMs: 1000 })).rejects.toThrow(/timed out after 1000 ms/);
    const { parent } = JSON.parse(await fs.readFile(path.join(options.cwd, 'ready.json'), 'utf8'));
    await stopped(parent);
  });
  it.skipIf(process.platform === 'win32').each([
    { ending: 'timeout', detached: false }, { ending: 'timeout', detached: true }, { ending: 'success', detached: false },
  ])('stops browser descendants when the check ends with $ending (detached=$detached)', async ({ ending, detached }) => {
      const options = await fixture(`import { spawn } from 'node:child_process'; import fs from 'node:fs';
        const child = spawn(process.execPath, ['-e', ${JSON.stringify("require('node:fs').writeFileSync('ready.json', JSON.stringify({parent:process.ppid,child:process.pid})); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);")}], { stdio: 'ignore', detached: ${detached} });
        child.unref();
        setInterval(() => { if (${JSON.stringify(ending)} === 'success' && fs.existsSync('ready.json')) process.exit(0); }, 20);`);
      const result = runBrowserCheck('check.mjs', { ...options, timeoutMs: ending === 'timeout' ? 1000 : 5000 });
      if (ending === 'timeout') await expect(result).rejects.toThrow(/timed out/);
      else await result;
      const { parent, child } = JSON.parse(await fs.readFile(path.join(options.cwd, 'ready.json'), 'utf8'));
      await stopped(parent); await stopped(child);
    });
  it.skipIf(!process.env.BOT_CHROMIUM_PATH || process.platform === 'win32')(
    'stops a ready Playwright browser when the supervising deploy process exits', async () => {
      const options = await fixture(`import { createRequire } from 'node:module';
        const { chromium } = createRequire(${JSON.stringify(import.meta.url)})('playwright-core');
        import fs from 'node:fs';
        const browser = await chromium.launchServer({executablePath:process.env.BOT_CHROMIUM_PATH,headless:true,
          args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
        fs.writeFileSync('ready.json',JSON.stringify({parent:process.pid,child:browser.process().pid}));
        process.kill(process.ppid,'SIGTERM');
        setInterval(()=>{},100);`);
      await fs.writeFile(path.join(options.cwd, 'supervisor.mjs'), `
        import { runBrowserCheck } from ${JSON.stringify(new URL('./browser-stage.mjs', import.meta.url).href)};
        process.on('SIGTERM',()=>process.exit(143));
        await runBrowserCheck('check.mjs',{timeoutMs:30_000});`);
      // Browser startup gets a separate generous ceiling. The interruption
      // happens only after readiness, without racing CPU load on the CI host.
      await expect(runBrowserCheck('supervisor.mjs', { ...options, stdio: 'inherit', timeoutMs: 30_000 })).rejects.toThrow(/exit 143/);
      const { parent, child } = JSON.parse(await fs.readFile(path.join(options.cwd, 'ready.json'), 'utf8'));
      await stopped(parent); await stopped(child);
    }, 35_000);
});
