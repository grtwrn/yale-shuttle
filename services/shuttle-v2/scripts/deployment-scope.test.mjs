import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deploymentScope, verifiedDeploymentScope, matchesProduction, runtimeChanged } from './deployment-scope.mjs';

const prefix = 'services/shuttle-v2/';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-deploy-scope-')); dirs.push(cwd);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '--initial-branch=main']);
  const write = (file, text) => { const target = path.join(cwd, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
  const commit = () => {
    git(['add', '--all']);
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=scope-test', '-c', 'user.email=scope@test.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  write(prefix + 'src/index.ts', 'export const app = 1;');
  write(prefix + 'web/src/display.ts', 'export const display = 1;');
  write(prefix + 'scripts/display-audit/poll.ts', 'export const monitor = 1;');
  write(prefix + 'scripts/deployment-scope.mjs', 'export const scope = 1;');
  write(prefix + 'package-lock.json', '{}');
  const before = commit();
  return { cwd, git, write, commit, before };
}

describe('production image scope', () => {
  it('covers every source copied from the actual Docker context', () => {
    const service = fileURLToPath(new URL('..', import.meta.url));
    const text = fs.readFileSync(path.join(service, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
    let checked = 0;
    for (const line of text.split('\n').filter(line => /^COPY\s/.test(line))) {
      const args = line.slice(5).trim().split(/\s+/);
      if (args[0].startsWith('--from=')) continue;
      expect(args[0].startsWith('--')).toBe(false);
      for (const source of args.slice(0, -1)) {
        const concrete = source === 'package*.json' ? ['package.json', 'package-lock.json'] : [source];
        for (const file of concrete) { expect(runtimeChanged([prefix + file])).toBe(true); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(runtimeChanged([prefix + 'fly.toml'])).toBe(true);
    expect(runtimeChanged([prefix + '.dockerignore'])).toBe(true);
  });
  it('runs operator-only changes through staging while retaining the existing app build', () => {
    const f = fixture();
    f.write(prefix + 'scripts/report-watch/poll.mjs', '// monitor');
    f.write('.github/workflows/deploy.yml', 'operator workflow');
    const after = f.commit();
    expect(deploymentScope({ ...f, after }).runtimeChanged).toBe(false);
    expect(matchesProduction(f.before.slice(0, 12), { cwd: f.cwd, revision: after })).toBe(true);
    expect(matchesProduction(f.before, { cwd: path.join(f.cwd, prefix), revision: after })).toBe(true);
  });
  it('skips replacing production only when the running image inputs are already current', async () => {
    const f = fixture(); f.write(prefix + 'scripts/report-watch/poll.mjs', '// monitor');
    const after = f.commit();
    const fetchImpl = async url => {
      expect(url).toBe('https://yale-shuttle.fly.dev/healthz');
      return Response.json({ ok: true, build: f.before.slice(0, 12) });
    };
    const result = await verifiedDeploymentScope({ ...f, after, fetchImpl });
    expect(result.runtimeChanged).toBe(false);
    expect(result.productionBuild).toBe(f.before.slice(0, 12));
  });
  it('deploys when the preceding runtime change has not reached production', async () => {
    const f = fixture(); f.write(prefix + 'src/index.ts', 'export const app = 2;');
    const before = f.commit(); f.write(prefix + 'scripts/report-watch/poll.mjs', '// monitor');
    const after = f.commit();
    expect(deploymentScope({ ...f, before, after }).runtimeChanged).toBe(false);
    const fetchImpl = async () => Response.json({ ok: true, build: f.before.slice(0, 12) });
    expect((await verifiedDeploymentScope({ ...f, before, after, fetchImpl })).runtimeChanged).toBe(true);
  });
  it.each(['offline', 'http', 'unhealthy', 'unknown', 'malformed'])(
    'deploys conservatively when production cannot be verified: %s', async failure => {
      const f = fixture(); f.write(prefix + 'scripts/report-watch/poll.mjs', '// monitor');
      const after = f.commit();
      const fetchImpl = async () => {
        if (failure === 'offline') throw Error('offline');
        if (failure === 'http') return new Response('Unavailable', { status: 503 });
        if (failure === 'malformed') return Response.json(null);
        return Response.json({ ok: failure !== 'unhealthy', build: failure === 'unknown' ? 'a'.repeat(12) : f.before });
      };
      expect((await verifiedDeploymentScope({ ...f, after, fetchImpl, fetchMissing: false })).runtimeChanged).toBe(true);
    });
  it('deploys runtime changes including a file renamed out of the image context', () => {
    const f = fixture();
    fs.renameSync(path.join(f.cwd, prefix, 'src/index.ts'), path.join(f.cwd, prefix, 'scripts/old-index.ts'));
    const after = f.commit();
    expect(deploymentScope({ ...f, after }).runtimeChanged).toBe(true);
    expect(matchesProduction(f.before, { cwd: f.cwd, revision: after })).toBe(false);
  });
  it('treats unavailable history conservatively and refuses the wrong checkout', () => {
    const f = fixture();
    expect(deploymentScope({ cwd: f.cwd, before: '0'.repeat(40), after: f.before }).runtimeChanged).toBe(true);
    expect(deploymentScope({ cwd: f.cwd, before: 'a'.repeat(40), after: f.before, fetchMissing: false }).runtimeChanged).toBe(true);
    expect(() => deploymentScope({ ...f, after: 'a'.repeat(40) })).toThrow(/checkout/);
    expect(matchesProduction('a'.repeat(12), { cwd: f.cwd })).toBe(false);
    expect(matchesProduction('HEAD', { cwd: f.cwd })).toBe(false);
  });
  it.each(['src/index.ts', 'web/src/new.ts', 'package-lock.json', 'scripts/display-audit/poll.ts', 'scripts/deployment-scope.mjs'])(
    'refuses dirty or untracked source at %s', file => {
      const f = fixture(); f.write(prefix + file, 'unpublished');
      expect(matchesProduction(f.before, { cwd: f.cwd, revision: f.before })).toBe(false);
    });
  it('allows unrelated operator state but refuses a revision that changed during the poll', () => {
    const f = fixture(); f.write(prefix + 'scripts/learning-loop/local.mjs', '// local operator source');
    expect(matchesProduction(f.before, { cwd: f.cwd, revision: f.before })).toBe(true);
    const after = f.commit();
    expect(matchesProduction(f.before, { cwd: f.cwd, revision: f.before })).toBe(false);
    expect(matchesProduction(f.before, { cwd: f.cwd, revision: after })).toBe(true);
  });
});
