import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
const identity = (value: unknown) => digest(JSON.stringify(canonical(value)));
const caches = new Set(['.cache', '.vite', '.vite-temp']);

export function executionFileHash(file: string): string {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw Error('Execution input is not a regular file');
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw Error('Execution input changed while hashing');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Hash actual installed bytes, including internal link identities. Tool caches
 * are generated data; package source, native addons and executables stay in. */
export function executionTreeHash(directory: string, source = false): string {
  const root = fs.realpathSync(directory), hash = createHash('sha256');
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (caches.has(entry.name) || source && (entry.name === '__fixtures__' || /\.test\./.test(entry.name))) continue;
      const file = path.join(folder, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) { hash.update(JSON.stringify([relative,'directory'])+'\n');walk(file); }
      else if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file), outside = path.relative(root, target);
        if (outside === '..' || outside.startsWith('..' + path.sep) || path.isAbsolute(outside))
          throw Error('Execution dependency link leaves its retained tree');
        hash.update(JSON.stringify([relative, 'link', fs.readlinkSync(file)]) + '\n');
      } else if (entry.isFile()) hash.update(JSON.stringify([relative, 'file', executionFileHash(file)]) + '\n');
      else throw Error('Unsupported execution tree entry');
    }
  }; walk(root);
  return hash.digest('hex');
}

const binaryCache = new Map<string, { ino: number; size: number; mtimeMs: number; hash: string }>();
export function runtimeBytesIdentity(service: string) {
  const binary = fs.realpathSync(process.execPath), stat = fs.statSync(binary), old = binaryCache.get(binary);
  const nodeBinarySHA256 = old?.ino===stat.ino&&old.size === stat.size && old.mtimeMs === stat.mtimeMs ? old.hash : executionFileHash(binary);
  binaryCache.set(binary, { ino:stat.ino,size: stat.size, mtimeMs: stat.mtimeMs, hash: nodeBinarySHA256 });
  return { nodeBinarySHA256, dependencyTreeSHA256: executionTreeHash(path.join(service, 'node_modules')) };
}

export interface ProductionExecutionIdentity {
  v: 1;
  sha256: string;
  sourceTreeSHA256: string;
  dependencyTreeSHA256: string;
  nodeBinarySHA256: string;
  runtime: { node: string; platform: string; arch: string; versions: Record<string, string>; timezone: string; argumentsSHA256: string };
}

export function executionRuntimeInfo():ProductionExecutionIdentity['runtime']{
 return {node:process.version,platform:process.platform,arch:process.arch,
  versions:Object.fromEntries(Object.entries(process.versions).filter(([,v])=>typeof v==='string')) as Record<string,string>,
  timezone:process.env['TZ']??'',argumentsSHA256:identity([process.execArgv,process.env['NODE_OPTIONS']??''])};
}

export function validProductionExecutionIdentity(value: unknown): value is ProductionExecutionIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as ProductionExecutionIdentity, hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  if (v.v !== 1 || ![v.sha256, v.sourceTreeSHA256, v.dependencyTreeSHA256, v.nodeBinarySHA256].every(hash)
    || !v.runtime || !['node', 'platform', 'arch', 'timezone'].every(k => typeof (v.runtime as unknown as Record<string, unknown>)[k] === 'string')
    || !hash(v.runtime.argumentsSHA256) || !v.runtime.versions || typeof v.runtime.versions!=='object'||Array.isArray(v.runtime.versions)
    || !Object.values(v.runtime.versions).every(s => typeof s === 'string')) return false;
  return identity({ v: 1, sourceTreeSHA256: v.sourceTreeSHA256, dependencyTreeSHA256: v.dependencyTreeSHA256,
    nodeBinarySHA256: v.nodeBinarySHA256, runtime: v.runtime }) === v.sha256;
}

/** The runtime image contains all backend source and only the explicitly
 * copied model/shared web source. Browser assets in web/dist are separate.
 * Compute once before serving, never once per rider request. */
export function productionExecutionIdentity(service: string): ProductionExecutionIdentity {
  const sourceTreeSHA256 = identity({ src: executionTreeHash(path.join(service, 'src'), true),
    web: executionTreeHash(path.join(service, 'web/src'), true),
    migrations:executionTreeHash(path.join(service,'drizzle'),true),
    config: ['package.json', 'package-lock.json', 'tsconfig.json','drizzle.config.ts'].map(name => [name, executionFileHash(path.join(service, name))]) });
  const bytes = runtimeBytesIdentity(service), runtime = executionRuntimeInfo();
  const core = { v: 1 as const, sourceTreeSHA256, ...bytes, runtime };
  return { ...core, sha256: identity(core) };
}

let cached: ProductionExecutionIdentity | undefined;
export function defaultProductionExecutionIdentity(): ProductionExecutionIdentity {
  return cached ??= productionExecutionIdentity(fileURLToPath(new URL('../..', import.meta.url)));
}
