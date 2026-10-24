import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { learningExecutionIdentity } from './execution-files.mjs';

const temporary: string[] = [];
afterEach(() => { for (const p of temporary.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-execution-')); temporary.push(root);
  const write = (name: string, text: string) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  for (const name of ['src/server.ts', 'web/src/eta/model.ts', 'scripts/reestimate-lib.mjs',
    'scripts/reestimate-validation.mjs', 'scripts/archive-files.mjs', 'scripts/canary-metrics.mjs']) write(name, 'export const x = 1;');
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'web/package.json', 'web/package-lock.json', 'web/tsconfig.json']) write(name, '{}');
  write('scripts/learning-loop/start.ts', "import '../../web/src/eta/model';");
  write('web/src/PickupReminderControls.tsx', 'export const Reminder = () => null;');
  write('node_modules/fixture/index.js','export const dependency = 1;');
  return { root, write, identity: () => learningExecutionIdentity(root) };
}

describe('native trial execution identity', () => {
  it('survives a UI edit while retaining actual model and backend changes', () => {
    const f = fixture(), original = f.identity();
    f.write('web/src/PickupReminderControls.tsx', 'export const Reminder = () => "fixed";');
    expect(f.identity().sha256).toBe(original.sha256);
    f.write('web/src/eta/model.ts', 'export const x = 2;');
    expect(f.identity().sha256).not.toBe(original.sha256);
    f.write('web/src/eta/model.ts', 'export const x = 1;');
    f.write('src/server.ts', 'export const x = 2;');
    expect(f.identity().sha256).not.toBe(original.sha256);
  });
  it('includes a UI module when it becomes an execution dependency', () => {
    const f = fixture(); f.write('scripts/learning-loop/start.ts', "export { Reminder } from '../../web/src/PickupReminderControls';");
    const before = f.identity(); expect(before.staticImportClosure).toContain('web/src/PickupReminderControls.tsx');
    f.write('web/src/PickupReminderControls.tsx', 'export const Reminder = () => "different";');
    expect(f.identity().sha256).not.toBe(before.sha256);
  });
  it('binds source membership and configuration without binding the checkout path', () => {
    const f = fixture(), g = fixture(); expect(f.identity().sha256).toBe(g.identity().sha256);
    f.write('src/new-rule.ts', 'export const rule = 1;'); expect(f.identity().sha256).not.toBe(g.identity().sha256);
    g.write('web/package-lock.json', '{"lockfileVersion":3}'); expect(g.identity().sha256).not.toBe(fixture().identity().sha256);
  });
  it.each(["import '../../web/src/absent';", 'const moduleName = "./unknown"; import(moduleName);', 'const moduleName = "./unknown"; require(moduleName);'])('refuses an unaccounted import: %s', source => {
    const f = fixture(); f.write('scripts/learning-loop/start.ts', source); expect(f.identity).toThrow();
  });
  it('does not report an execution fingerprint as cross-context qualification', () => {
    const f = fixture(), identity = f.identity(); expect(identity.scope).toContain('not a compatibility or accuracy certificate');
    expect(identity).not.toHaveProperty('compatible');
  });
  it.each(['{"extends":"../outside.json"}', '{"compilerOptions":{"paths":{"@model":["web/src/eta/model.ts"]}}}'])('refuses an unaccounted resolver config: %s', config => {
    const f = fixture(); f.write('tsconfig.json', config); expect(f.identity).toThrow('explicit import resolution');
  });
  it.each(["import '/tmp/unretained-model.ts';", "import '#private-model';", "import 'file:///tmp/model.mjs';", 'import { broken'])('refuses unsupported or invalid source: %s', source => {
    const f = fixture(); f.write('scripts/learning-loop/start.ts', source); expect(f.identity).toThrow();
  });
  it('refuses a source symlink whose module resolution could leave retained bytes', () => {
    const f = fixture(), g = fixture(); fs.unlinkSync(path.join(f.root, 'web/src/eta/model.ts'));
    fs.symlinkSync(path.join(g.root, 'web/src/eta/model.ts'), path.join(f.root, 'web/src/eta/model.ts'));
    expect(f.identity).toThrow('source symlink');
  });
  it('binds actual installed dependency bytes while the lockfiles stay identical',()=>{
    const f=fixture(),before=f.identity();f.write('node_modules/fixture/index.js','export const dependency = 2;');
    expect(f.identity().sha256).not.toBe(before.sha256);
  });
});
