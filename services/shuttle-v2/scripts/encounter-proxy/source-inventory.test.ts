import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryRuntime } from './source-inventory.js';

const root = path.dirname(fileURLToPath(import.meta.url));
describe('standalone runtime import custody', () => {
  it('closes the actual finite runner over independent source and excludes tests/model helpers', () => {
    const inventory = inventoryRuntime(root);
    expect(inventory.pins.some(pin => pin.file === 'engine.ts')).toBe(true);
    expect(inventory.pins.some(pin => pin.file === 'namespace-verifier.ts')).toBe(true);
    expect(inventory.pins.some(pin => pin.file === 'protocol.v3.json')).toBe(true);
    expect(inventory.pins.every(pin => !pin.file.includes('.test.') && !pin.file.includes('__fixtures__')
      && pin.file !== 'test-fixtures.ts' && !pin.file.endsWith('.fixture.ts'))).toBe(true);
    expect(inventoryRuntime(root)).toEqual(inventory);
  });
  for (const [name, code] of [
    ['outside estimator', "import { x } from '../estimator.js';\nexport const y=x;"],
    ['process spawning', "import { spawn } from 'node:child_process';\nexport const y=spawn;"],
    ['second same-line process import', "import fs from 'node:fs'; import cp from 'node:child_process'; export const y=cp;"],
    ['comment-separated import', "import/* unsupported */cp from 'node:child_process'; export const y=cp;"],
    ['comment inside named import', "import { foo/* unsupported */ } from '../estimator.js'; export const y=foo;"],
    ['comment after default import', "import cp /* unsupported */ from 'node:child_process'; export const y=cp;"],
    ['dynamic loading', "export const y=import('./opaque.js');"],
    ['fixture shortcut', "import { x } from './__fixtures__/truth.js';\nexport const y=x;"],
  ]) it(`refuses ${name} before that dependency can load`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-inventory-'));
    try {
      fs.copyFileSync(path.join(root, 'protocol.v3.json'), path.join(temporary, 'protocol.v3.json'));
      fs.writeFileSync(path.join(temporary, 'entry.ts'), code!);
      expect(() => inventoryRuntime(temporary, 'entry.ts')).toThrow();
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
