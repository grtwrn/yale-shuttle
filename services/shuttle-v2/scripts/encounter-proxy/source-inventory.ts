import fs from 'node:fs';
import path from 'node:path';
import { canonicalJSON, sha256 } from './canonical.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import { readBoundedFile } from './bounded-read.js';
import type { SourcePin } from './namespace.js';

const BUILTINS = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url', 'node:os']);
const MAX_FILES = 64, MAX_FILE_BYTES = 256 * 1024, MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export interface RuntimeInventory { sourceRoot: string; pins: SourcePin[]; hash: string }

/** The controlled actor source uses static imports only. Every dependency is
 * pinned inside this standalone directory or is an explicit Node builtin.
 * Forecast, estimator, network and process-spawning packages cannot enter it. */
export function inventoryRuntime(sourceRoot: string, entry = 'fixture-runner.ts'): RuntimeInventory {
  const root = path.resolve(sourceRoot);
  if (fs.realpathSync(root) !== root) throw new Error('Source inventory cannot traverse symlinks');
  const pending = [entry, 'protocol.v3.json'], pins = new Map<string, SourcePin>();
  let bytesRead = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    if (pins.has(relative)) continue;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '__fixtures__')
      || /(?:^|\/)(?:test-fixtures\.ts|.*\.test(?:-helper)?\.ts|.*\.fixture\.ts)$/.test(relative))
      throw new Error('Runtime import leaves the independent source boundary');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) throw new Error('Runtime import escapes source root');
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error('Invalid runtime source file');
    bytesRead += before.size + 1; // Include each bounded EOF probe in the read admission.
    if (bytesRead > MAX_SOURCE_BYTES || pins.size >= MAX_FILES) throw new Error('Runtime source inventory cap exceeded');
    const data = readBoundedFile(file, before.size), after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw new Error('Runtime source changed during inventory');
    const digest = sha256(data); pins.set(relative, { file: relative, bytes: data.byteLength, sha256: digest });
    if (relative === 'protocol.v3.json') {
      if (digest !== PROTOCOL_SHA256) throw new Error('Runtime protocol pin differs');
      continue;
    }
    if (!relative.endsWith('.ts')) throw new Error('Unsupported runtime source format');
    const code = data.toString('utf8');
    if (/\b(?:import|require)\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/.test(code))
      throw new Error('Dynamic executable loading is forbidden in independent runtime');
    const imports: string[] = [];
    const importPattern = /\bimport\s+(?:type\s+)?(?:[\w*$,\s{}]+?\s+from\s*)?['"]([^'"]+)['"]/g;
    const exportPattern = /\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s*['"]([^'"]+)['"]/g;
    if (/\b(?:import|export|from)\s*\/[*\/]/.test(code)
      || /\bimport\b[^;'"`]*\/[*\/]/.test(code)
      || /\bexport\s+(?:type\s+)?(?:\*|\{)[^;'"`]*\/[*\/]/.test(code))
      throw new Error('Comment-separated runtime import syntax is unsupported');
    for (const match of code.matchAll(importPattern)) imports.push(match[1]!);
    for (const match of code.matchAll(exportPattern)) imports.push(match[1]!);
    for (const dependency of imports) {
      if (dependency.startsWith('node:')) {
        if (!BUILTINS.has(dependency)) throw new Error('Forbidden independent runtime builtin');
        continue;
      }
      if (!dependency.startsWith('./')) throw new Error('Runtime import leaves independent source boundary');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency.replace(/\.js$/, '.ts')));
      if (!target.endsWith('.ts')) throw new Error('Only explicit independent TypeScript dependencies are supported');
      pending.push(target);
    }
  }
  const sorted = [...pins.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { sourceRoot: root, pins: sorted, hash: sha256(canonicalJSON(sorted)) };
}
