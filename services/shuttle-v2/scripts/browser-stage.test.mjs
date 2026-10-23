import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBrowserCheck } from './browser-stage.mjs';
import { browserPhaseEvidence, recordBrowserPhase } from './browser-stage-diagnostics.mjs';

const diagnosticsURL = new URL('./browser-stage-diagnostics.mjs', import.meta.url).href;

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
        import { recordBrowserPhase } from ${JSON.stringify(diagnosticsURL)};
        import fs from 'node:fs';
        const record = (phase, details) => recordBrowserPhase('phases.jsonl',phase,details);
        const require = createRequire(${JSON.stringify(import.meta.url)});
        const childProcess = require('node:child_process'), spawn = childProcess.spawn;
        // Observe only this fixture's exact Chrome executable. Forward every
        // argument and the original ChildProcess; leave protocol pipes alone.
        // launchServer does not stream DEBUG=pw:browser before readiness.
        childProcess.spawn = function(command, ...args) {
          const child = spawn.call(this, command, ...args);
          if (command === process.env.BOT_CHROMIUM_PATH) {
            record('browser-process-started',{browserPid:child.pid});
            let chunks = 0;
            child.stderr?.on('data',chunk=>{
              if (chunks++ < 8) record('browser-stderr',{text:chunk.toString('utf8').slice(0,512),bytes:chunk.length});
            });
            child.once('error',error=>record('browser-process-error',{errorName:error.name,errorCode:error.code??null}));
            child.once('exit',(code,signal)=>record('browser-process-exited',{code,signal}));
          }
          return child;
        };
        const { chromium } = require('playwright-core');
        record('check-started'); record('browser-launching');
        let browser;
        try { browser = await chromium.launchServer({executablePath:process.env.BOT_CHROMIUM_PATH,headless:true,
          args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']}); }
        catch (error) { record('browser-launch-failed',{errorName:error.name}); throw error; }
        fs.writeFileSync('ready.json',JSON.stringify({parent:process.pid,child:browser.process().pid}));
        record('browser-ready',{browserPid:browser.process().pid});
        process.kill(process.ppid,'SIGTERM');
        setInterval(()=>{},100);`);
      await fs.writeFile(path.join(options.cwd, 'supervisor.mjs'), `
        import { runBrowserCheck } from ${JSON.stringify(new URL('./browser-stage.mjs', import.meta.url).href)};
        import { recordBrowserPhase } from ${JSON.stringify(diagnosticsURL)};
        const record = (phase, details) => recordBrowserPhase('phases.jsonl',phase,details);
        record('supervisor-started');
        process.on('SIGTERM',()=>{record('supervisor-signaled');process.exit(143);});
        process.on('exit',code=>record('supervisor-exit-started',{code}));
        const checking=runBrowserCheck('check.mjs',{timeoutMs:30_000});
        // The production exit listener is installed by runBrowserCheck above.
        process.on('exit',code=>record('supervisor-exit-cleanup-complete',{code}));
        await checking;`);
      // Browser startup gets a separate generous ceiling. The interruption
      // happens only after readiness, without racing CPU load on the CI host.
      const trace = path.join(options.cwd, 'phases.jsonl');
      recordBrowserPhase(trace, 'outer-started');
      try {
        await expect(runBrowserCheck('supervisor.mjs', { ...options, stdio: 'inherit', timeoutMs: 30_000 })).rejects.toThrow(/exit 143/);
        const { parent, child } = JSON.parse(await fs.readFile(path.join(options.cwd, 'ready.json'), 'utf8'));
        await stopped(parent); await stopped(child);
        const evidence = browserPhaseEvidence(trace);
        expect(evidence.rows.find(row => row.phase === 'browser-process-started')?.browserPid).toBe(child);
        expect(evidence.rows.map(row => row.phase)).toEqual(expect.arrayContaining([
          'browser-ready', 'supervisor-signaled', 'supervisor-exit-cleanup-complete',
        ]));
      } catch (error) {
        console.error('[browser-stage supervision evidence]', JSON.stringify(browserPhaseEvidence(trace)));
        throw error;
      }
    }, 35_000);

  it.each([
    ['before-readiness', ['check-started', 'browser-launching']],
    ['after-readiness', ['browser-ready', 'supervisor-signaled', 'supervisor-exit-started']],
  ])('retains the observed phases when a check fails %s', async (_label, phases) => {
    const options = await fixture(`import { recordBrowserPhase } from ${JSON.stringify(diagnosticsURL)};
      for (const phase of ${JSON.stringify(phases)}) recordBrowserPhase('phases.jsonl',phase);
      process.exit(7);`);
    await expect(runBrowserCheck('check.mjs', options)).rejects.toThrow(/exit 7/);
    const evidence = browserPhaseEvidence(path.join(options.cwd, 'phases.jsonl'));
    expect(evidence.rows.map(row => row.phase)).toEqual(phases);
    expect(evidence.truncated).toBe(false);
    expect(evidence.malformedRows).toBe(0);
  });
});
