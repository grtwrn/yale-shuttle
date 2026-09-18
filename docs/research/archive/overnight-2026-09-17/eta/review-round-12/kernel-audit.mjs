import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const O = '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12';
const ts = await import(process.cwd() + '/node_modules/typescript/lib/typescript.js');
const file = process.cwd() + '/web/src/eta/filter.ts';
const src = fs.readFileSync(file, 'utf8');
const fn = src.match(/export function moveKernel\(meanCells: number\): Float64Array \{[\s\S]*?\n\}/)[0];
assert.equal(src.match(/const KERNEL_SHAPE = (\d+);/)[1], '3');
const original = 'const mean = Math.max(0.5, Math.min(40, meanCells));';
const rounded = 'const mean = Math.round(Math.max(0.5, Math.min(40, meanCells)) * 10) / 10;';
assert.equal(fn.split(original).length, 2);
function fresh(canonical) {
  const body = (canonical ? fn.replace(original, rounded) : fn).replace('export ', '');
  const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext('const kernelCache = new Map(); const KERNEL_SHAPE = 3;' + js + ';moveKernel');
}
function formula(input) {
  const mean = Math.round(Math.max(.5, Math.min(40, input)) * 10) / 10;
  const last = Math.min(60, Math.ceil(mean * 3 + 3));
  const values = Array.from({length: last + 1}, (_, j) => j === 0 ? 0 : j ** 2 * Math.exp(-3 * j / mean));
  const total = values.reduce((a, b) => a + b, 0);
  return values.map(v => v / total);
}
let currentOrderDependent = 0, canonicalChecks = 0;
for (let key = 5; key <= 400; key++) {
  const inputs = [Math.max(.5, key / 10 - .049), key / 10, Math.min(40, key / 10 + .049)];
  const currentLow = fresh(false), currentHigh = fresh(false);
  const low = Array.from(currentLow(inputs[0])), high = Array.from(currentHigh(inputs[2]));
  if (JSON.stringify(low) !== JSON.stringify(high)) currentOrderDependent++;
  const asc = fresh(true), desc = fresh(true);
  for (const input of inputs) asc(input);
  for (const input of inputs.toReversed()) desc(input);
  for (const input of inputs) {
    const a = Array.from(asc(input)), b = Array.from(desc(input));
    assert.deepEqual(a, b);
    const expected = formula(input);
    assert.equal(a.length, expected.length);
    assert.ok(a.every((v, i) => Math.abs(v - expected[i]) < 1e-14));
    assert.ok(Math.abs(a.reduce((x, y) => x + y, 0) - 1) < 1e-12);
    assert.ok(a[0] === 0 && a.every(v => Number.isFinite(v) && v >= 0));
    canonicalChecks++;
  }
}
assert.equal(currentOrderDependent, 396);
const left = fresh(true), right = fresh(true);
for (const x of [-100, .49, .5, .51]) assert.deepEqual(Array.from(left(x)), Array.from(left(.5)));
for (const x of [39.96, 40, 40.01, 100]) assert.deepEqual(Array.from(right(x)), Array.from(right(40)));
const report = {buckets: 396, currentOrderDependent, canonicalChecks, clampedBoundaries: 8,
  scope: 'Exact current source extraction, isolated caches, canonical replacement only; numerical unit check, not route outcomes.'};
fs.writeFileSync(O + '/kernel-audit.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
