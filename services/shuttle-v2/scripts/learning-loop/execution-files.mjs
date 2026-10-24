import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { learningSourceFiles } from './source-files.mjs';
import { runtimeBytesIdentity,executionRuntimeInfo } from '../../src/server/executionIdentity.ts';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const configFiles = ['package.json', 'package-lock.json', 'tsconfig.json',
  'web/package.json', 'web/package-lock.json', 'web/tsconfig.json'];

/** Separate scientific execution bytes from the broader source custody list.
 * Keep all backend/observer files, plus the actual literal import closure in
 * web/. A previously unused UI module becomes scientific as soon as the
 * observer imports it. This identity alone cannot certify remote execution:
 * each new producer context still needs its own seed, chain and live parity.
 */
export function learningExecutionIdentity(service) {
  service = fs.realpathSync(service);
  for (const relative of ['tsconfig.json', 'web/tsconfig.json']) {
    const parsed = ts.readConfigFile(path.join(service, relative), file => fs.readFileSync(file, 'utf8'));
    const options = parsed.config?.compilerOptions;
    if (parsed.error || parsed.config?.extends || options?.paths || options?.baseUrl || options?.rootDirs)
      throw Error(`Execution config needs explicit import resolution: ${relative}`);
  }
  const seen = new Set();
  const resolve = (from, specifier) => {
    const base = path.resolve(path.dirname(from), specifier), stem = base.replace(/\.js$/, '');
    const candidates = [base, stem + '.ts', stem + '.tsx', base + '.ts', base + '.tsx',
      base + '.mjs', base + '.js', base + '.json', path.join(base, 'index.ts'), path.join(base, 'index.mjs')];
    const target = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!target || path.relative(service, target).startsWith('..' + path.sep))
      throw Error(`Unresolved or external relative execution import: ${path.relative(service, from)} ${specifier}`);
    return target;
  };
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith('.json')) return;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw Error(`Invalid execution source: ${path.relative(service, file)}`);
    const walk = node => {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw Error('Nonliteral execution module specifier');
        specifier = node.moduleSpecifier.text;
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
          throw Error(`Nonliteral execution import: ${path.relative(service, file)}`);
        specifier = node.arguments[0].text;
      }
      if (specifier?.startsWith('.')) visit(resolve(file, specifier));
      else if (specifier && (specifier.startsWith('/') || specifier.startsWith('#') || specifier.startsWith('file:')))
        throw Error(`Unaccounted execution import: ${path.relative(service, file)} ${specifier}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(path.join(service, 'scripts/learning-loop/start.ts'));
  const files = new Set(learningSourceFiles(service).filter(file => !path.relative(service, file).startsWith('web' + path.sep)));
  for (const file of seen) files.add(file);
  for (const relative of configFiles) files.add(path.join(service, relative));
  const inventory = [...files].map(file => {
    if (fs.realpathSync(file) !== file) throw Error(`Execution source symlink needs explicit provenance: ${path.relative(service, file)}`);
    return [path.relative(service, file), digest(fs.readFileSync(file))];
  })
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const nativeRuntime = executionRuntimeInfo();
  const runtimeBytes=runtimeBytesIdentity(service);
  return { v: 1, sha256: digest(JSON.stringify({ v: 1, nativeRuntime,runtimeBytes, files: inventory })),
    nativeRuntime,runtimeBytes, files: inventory, staticImportClosure: [...seen].map(file => path.relative(service, file)).sort(),
    scope: 'Local source/config/lockfiles, actual installed dependency and Node binary bytes. A separate production execution fingerprint, retained dynamic inputs and live parity are required; this is not a compatibility or accuracy certificate.' };
}
