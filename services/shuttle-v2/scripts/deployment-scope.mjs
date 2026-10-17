import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const service = 'services/shuttle-v2/';
const directories = ['src/', 'web/', 'drizzle/'];
const files = new Set(['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
  'drizzle.config.ts', 'tsconfig.json', 'fly.toml']);
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const names = output => output.split('\0').filter(Boolean);
const validCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Docker context inputs plus Fly runtime configuration. Operator scripts are
 * tested in staging but are not copied into the running application image. */
export function runtimeChanged(paths) {
  return paths.some(name => {
    if (!name.startsWith(service)) return false;
    const relative = name.slice(service.length);
    return files.has(relative) || directories.some(prefix => relative.startsWith(prefix));
  });
}

function dirtyPaths(cwd) {
  const records = names(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd));
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) paths.push(records[++i]);
  }
  return paths;
}

/** The monitor may be newer than production while the entire application
 * image source is byte-identical. Unknown commits or dirty sources refuse. */
export function matchesProduction(build, { cwd = process.cwd(), revision } = {}) {
  if (typeof build !== 'string' || !/^[a-f0-9]{7,40}$/.test(build)) return false;
  try {
    const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
    const head = git(['rev-parse', 'HEAD'], root).trim();
    if (revision && revision !== head) return false; // source changed while the HTTP poll was in flight
    const dirty = dirtyPaths(root);
    if (runtimeChanged(dirty) || dirty.some(name => name.startsWith(service + 'scripts/display-audit/')
      || name === service + 'scripts/deployment-scope.mjs' || name === service + 'scripts/deployment-scope.d.mts')) return false;
    const production = git(['rev-parse', '--verify', `${build}^{commit}`], root).trim();
    return !runtimeChanged(names(git(['diff', '--no-relative', '--no-renames', '--name-only', '-z', production, head, '--'], root)));
  } catch { return false; }
}

/** Unknown history deploys conservatively. A mismatched checkout never deploys. */
export function deploymentScope({ before, after, cwd = process.cwd(), fetchMissing = true } = {}) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const head = git(['rev-parse', 'HEAD'], root).trim();
  if (!validCommit(after) || after !== head) throw Error('Deployment checkout must match the requested commit');
  const unknown = reason => ({ runtimeChanged: true, changedFiles: [], reason });
  if (!validCommit(before) || /^0+$/.test(before)) return unknown('No verifiable previous commit; run the full deployment');
  try {
    try { git(['cat-file', '-e', `${before}^{commit}`], root); }
    catch {
      if (!fetchMissing) return unknown('Previous commit is unavailable; run the full deployment');
      git(['fetch', '--no-tags', '--depth=1', 'origin', before], root);
    }
    const changedFiles = names(git(['diff', '--no-relative', '--no-renames', '--name-only', '-z', before, after, '--'], root));
    const changed = runtimeChanged(changedFiles);
    return { runtimeChanged: changed, changedFiles,
      reason: changed ? 'Application image inputs or Fly configuration changed' : 'Operator-only change; run staging without replacing production' };
  } catch { return unknown('Unable to verify changed inputs; run the full deployment'); }
}

/** A previous runtime deployment may have failed. Skipping Fly also requires
 * verifying that the running application already contains these image inputs. */
export async function verifiedDeploymentScope({ fetchImpl = fetch, ...options } = {}) {
  const result = deploymentScope(options);
  if (result.runtimeChanged) return result;
  const full = reason => ({ ...result, runtimeChanged: true, reason });
  try {
    const response = await fetchImpl('https://yale-shuttle.fly.dev/healthz', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return full('Production health unavailable; run the full deployment');
    const health = await response.json();
    if (!health?.ok || typeof health.build !== 'string' || !/^[a-f0-9]{7,40}$/.test(health.build)) {
      return full('Production build unavailable; run the full deployment');
    }
    const cwd = options.cwd ?? process.cwd();
    try { git(['rev-parse', '--verify', `${health.build}^{commit}`], cwd); }
    catch {
      if (options.fetchMissing === false) return full('Production commit unavailable; run the full deployment');
      git(['fetch', '--no-tags', '--deepen=100', 'origin', 'master'], cwd);
    }
    if (!matchesProduction(health.build, { cwd, revision: options.after })) {
      return full('Production image inputs do not match this checkout; run the full deployment');
    }
    return { ...result, productionBuild: health.build };
  } catch { return full('Unable to verify production; run the full deployment'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' }, output: { type: 'string' } } });
  const result = await verifiedDeploymentScope({ before: values.before, after: values.after });
  if (values.output) fs.appendFileSync(values.output, `runtime_changed=${result.runtimeChanged}\n`);
  console.log(JSON.stringify(result));
}
