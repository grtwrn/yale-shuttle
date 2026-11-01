import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, sha256 } from '../encounter-proxy/canonical.js';
import { analyzeCatalog, assertRuntimeImports, BoundedFD, encode, EXTERNAL_MANIFEST, FINAL_FILE, hashJSON, runtimeFiles, sourceReadBudget } from './custody.js';
import { verifyCatalog } from './verify.js';
import type { AnalysisReceipt, ExternalManifest } from './custody.js';
import type { CatalogInput } from './types.js';

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of folders.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-custody-'))); folders.push(root);
  const sources = path.join(root, 'sources'); fs.mkdirSync(sources);
  const evidence = Buffer.from('Controlled independent source; no arrival/model-selected evidence.\n');
  fs.writeFileSync(path.join(sources, 'evidence.txt'), evidence);
  const input: CatalogInput = { schema: 'independent-catalog-embedding-input/v1', mode: 'fixture', routeId: 100,
    sources: [{ id: '__proto__', file: 'evidence.txt', bytes: evidence.length, sha256: sha256(evidence) }],
    path: [{ lat: 41, lon: -73 }, { lat: 41, lon: -72.99 }, { lat: 41.01, lon: -72.99 }, { lat: 41.01, lon: -73 }, { lat: 41, lon: -73 }],
    curbs: [{ stopId: 100, coord: { lat: 41, lon: -72.99 }, sourceIds: ['__proto__'] }],
    published: [{ id: '__proto__', publishedIndex: 0, stopId: 100 }], spurs: [],
    variants: [{ id: 'constructor', sourceIds: ['__proto__'], tokens: [{ id: 'toString', occurrenceOptions: ['__proto__'] }] }],
    scope: { onePlanCycleOneRawLoop: { status: 'fixture-assumption', sourceIds: ['__proto__'] },
      orientations: ['forward'], orientationExclusions: [{ orientation: 'reverse',
        evidence: { status: 'fixture-assumption', sourceIds: ['__proto__'] } }], qualificationPending: true } };
  const inputFile = path.join(root, 'input.json');
  fs.writeFileSync(inputFile, encode(input));
  const options = { inputFile, sourceRoot: sources, outputDirectory: path.join(root, 'new-analysis'), now: () => 0 };
  return { root, sources, evidence, input, inputFile, options };
}
function verify(receipt: AnalysisReceipt) {
  return verifyCatalog({ directory: receipt.directory, expectedManifestHash: receipt.manifestHash,
    expectedFinalHash: receipt.finalHash, expectedPrefix: receipt.prefix });
}
function fingerprint(directory: string): unknown {
  const files: Record<string, unknown> = {};
  const walk = (folder: string) => {
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name), stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory()) walk(file);
      else Object.defineProperty(files, path.relative(directory, file), { enumerable: true,
        value: { ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
          ctimeNs: String(stat.ctimeNs), sha256: sha256(fs.readFileSync(file)) } });
    }
  };
  walk(directory); return files;
}
function forgeFinalCount(receipt: AnalysisReceipt): { manifestHash: string; finalHash: string } {
  const finalFile = path.join(receipt.directory, FINAL_FILE), external = path.join(receipt.directory, EXTERNAL_MANIFEST);
  const final = JSON.parse(fs.readFileSync(finalFile, 'utf8'));
  final.result.counts.expandedStates++;
  const finalBytes = encode(final); fs.writeFileSync(finalFile, finalBytes);
  const manifest = JSON.parse(fs.readFileSync(external, 'utf8')) as ExternalManifest;
  const pin = { file: FINAL_FILE, bytes: finalBytes.length, sha256: sha256(finalBytes) };
  manifest.final = pin; manifest.files = manifest.files.map(value => value.file === FINAL_FILE ? pin : value);
  manifest.inventoryHash = hashJSON(manifest.files);
  let bytes = encode(manifest);
  for (;;) {
    manifest.externalManifestBytes = bytes.length;
    manifest.totalOutputBytes = manifest.files.reduce((total, value) => total + value.bytes, 0) + bytes.length;
    const next = encode(manifest); if (next.equals(bytes)) break; bytes = next;
  }
  fs.writeFileSync(external, bytes);
  return { manifestHash: sha256(bytes), finalHash: pin.sha256 };
}

describe('finite catalog artifact custody and replay', () => {
  it('retains a nonvacuous own-ID solution and independently replays every artifact without writing', () => {
    const fixture = setup(), receipt = analyzeCatalog(fixture.options);
    expect(receipt.result.complete).toBe(true);
    expect(receipt.result.counts.feasibleAssignments).toBeGreaterThan(0);
    expect(Object.hasOwn(receipt.result.variantSolutions, 'constructor')).toBe(true);
    expect(receipt.result.invariance).toEqual(expect.arrayContaining([expect.objectContaining({ occurrenceId: '__proto__' })]));
    const before = fingerprint(receipt.directory), report = verify(receipt);
    expect(report).toMatchObject({ verified: true, complete: true, searchExhausted: true,
      prospectiveQualified: false, physicalServiceTruth: false, liveQualified: false, publicationCapability: false });
    expect(fingerprint(receipt.directory)).toEqual(before);
    expect(() => analyzeCatalog(fixture.options)).toThrow(/already exists/);
  });

  it('refuses noncanonical/unknown input and source/cap mismatches before creating an output namespace', () => {
    const fixture = setup();
    fs.writeFileSync(fixture.inputFile, JSON.stringify(fixture.input, null, 2));
    expect(() => analyzeCatalog(fixture.options)).toThrow(/Noncanonical/);
    fs.writeFileSync(fixture.inputFile, encode({ ...fixture.input, selectedPass: 1 }));
    expect(() => analyzeCatalog(fixture.options)).toThrow(/Invalid catalog input/);
    fs.writeFileSync(fixture.inputFile, encode(fixture.input));
    expect(() => analyzeCatalog({ ...fixture.options, caps: { maxSourceFiles: 1 } })).toThrow(/file cap/);
    fs.writeFileSync(path.join(fixture.sources, 'evidence.txt'), 'tampered');
    expect(() => analyzeCatalog(fixture.options)).toThrow(/pin differs/);
    expect(fs.existsSync(fixture.options.outputDirectory)).toBe(false);
  });

  it('seals a valid unqualified reference scope refusal before any clock or geometric search', () => {
    const fixture = setup(); fixture.input.mode = 'reference-analysis';
    fixture.input.scope.onePlanCycleOneRawLoop = { status: 'unqualified', sourceIds: [] };
    fixture.input.scope.orientationExclusions[0]!.evidence = { status: 'unqualified', sourceIds: [] };
    fs.writeFileSync(fixture.inputFile, encode(fixture.input));
    const clock = vi.fn(() => { throw new Error('Unqualified scope cannot enter the solver clock'); });
    const receipt = analyzeCatalog({ ...fixture.options, now: clock });
    expect(clock).not.toHaveBeenCalled();
    expect(receipt.result).toMatchObject({ verdict: 'refused-source-scope', complete: false, searchExhausted: false,
      components: [], invariance: [], counts: { expandedStates: 0 } });
    expect(receipt.prefix.seq).toBe(0);
    expect(verify(receipt)).toMatchObject({ verified: true, verdict: 'refused-source-scope', complete: false });
  });

  it('replays retained cap and actual-clock deadline refusals without partial invariance', () => {
    for (const reason of ['state', 'clock'] as const) {
      const fixture = setup(); let calls = 0;
      const receipt = analyzeCatalog({ ...fixture.options,
        caps: reason === 'state' ? { maxExpandedStates: 1 } : { internalMonotonicBudgetMs: 1 },
        now: () => reason === 'state' ? 0 : calls++ * 2 });
      expect(receipt.result).toMatchObject({ verdict: 'refused-incomplete', complete: false, invariance: [] });
      expect(receipt.result.refusals).toContain(reason === 'state' ? 'expanded-state-cap' : 'monotonic-time-cap');
      expect(verify(receipt)).toMatchObject({ verified: true, complete: false, verdict: 'refused-incomplete' });
    }
  });

  it('retains the last called clock in reserve when general output space is exhausted', () => {
    const fixture = setup(), baseline = analyzeCatalog(fixture.options);
    const receipt = analyzeCatalog({ ...fixture.options, outputDirectory: path.join(fixture.root, 'small-output'),
      caps: { maxDiagnosticOutputBytes: baseline.outputBytesBeforeEnumeration + 32768 + 64, reservedRefusalOutputBytes: 32768 } });
    expect(receipt.result).toMatchObject({ verdict: 'refused-incomplete', complete: false, invariance: [] });
    expect(receipt.result.refusals).toContain('output-cap');
    const clocks = fs.readFileSync(path.join(receipt.directory, 'clock-transcript.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect(clocks.at(-1).record.data.blocked).toBe(true);
    expect(receipt.outputBytes).toBeLessThanOrEqual(baseline.outputBytesBeforeEnumeration + 32768 + 64);
    expect(verify(receipt)).toMatchObject({ verified: true, verdict: 'refused-incomplete' });
  });

  it('retains and replays a clock-source exception as an incomplete analysis', () => {
    const fixture = setup(), receipt = analyzeCatalog({ ...fixture.options,
      now: () => { throw new Error('Controlled clock-source interruption'); } });
    expect(receipt.result).toMatchObject({ verdict: 'refused-incomplete', complete: false,
      invariance: [], refusals: ['clock-source-error'] });
    const row = JSON.parse(fs.readFileSync(path.join(receipt.directory, 'clock-transcript.jsonl'), 'utf8'));
    expect(row.record.data).toMatchObject({ value: 'source-threw', error: 'Error: Controlled clock-source interruption' });
    expect(verify(receipt)).toMatchObject({ verified: true, complete: false, verdict: 'refused-incomplete' });
  });

  it('rejects tampered source/artifact bytes, an unlisted file and an unfinished final record', () => {
    for (const mutation of ['source', 'extra', 'partial', 'missing-manifest'] as const) {
      const fixture = setup(), receipt = analyzeCatalog(fixture.options);
      if (mutation === 'source') fs.appendFileSync(path.join(receipt.directory, 'sources/evidence.txt'), 'x');
      else if (mutation === 'extra') fs.writeFileSync(path.join(receipt.directory, 'unlisted.json'), '{}');
      else if (mutation === 'missing-manifest') fs.unlinkSync(path.join(receipt.directory, EXTERNAL_MANIFEST));
      else {
        const file = path.join(receipt.directory, 'clock-transcript.jsonl'), bytes = fs.readFileSync(file);
        fs.writeFileSync(file, bytes.subarray(0, -1));
      }
      expect(() => verify(receipt)).toThrow();
    }
  });

  it('rejects internally rehashed final result forgery by replay, not just by an old external hash', () => {
    const fixture = setup(), receipt = analyzeCatalog(fixture.options), forged = forgeFinalCount(receipt);
    expect(() => verifyCatalog({ directory: receipt.directory, expectedManifestHash: forged.manifestHash,
      expectedFinalHash: forged.finalHash })).toThrow(/replay differs/);
  });

  it('refuses input and custody symlink/hardlink aliases', () => {
    const fixture = setup(), source = path.join(fixture.sources, 'evidence.txt'), bytes = fs.readFileSync(source);
    const alias = path.join(fixture.root, 'source-alias'); fs.renameSync(source, alias); fs.symlinkSync(alias, source);
    expect(() => analyzeCatalog(fixture.options)).toThrow();
    fs.unlinkSync(source); fs.writeFileSync(source, bytes);
    const receipt = analyzeCatalog(fixture.options), directoryAlias = path.join(fixture.root, 'directory-alias');
    fs.symlinkSync(receipt.directory, directoryAlias);
    expect(() => verifyCatalog({ directory: directoryAlias, expectedManifestHash: receipt.manifestHash })).toThrow();
    fs.linkSync(path.join(receipt.directory, 'input-control.json'), path.join(fixture.root, 'input-hardlink'));
    expect(() => verify(receipt)).toThrow();
  });

  it('bounds actual growing-FD reads before consuming the unadmitted tail', () => {
    const fixture = setup(), file = path.join(fixture.root, 'bounded.txt'); fs.writeFileSync(file, 'abc');
    const actual = fs.readSync, budget = sourceReadBudget(3, 1); let grew = false, read = 0;
    const spy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
      const count = Reflect.apply(actual, fs, args) as number; read += count;
      if (!grew) { grew = true; fs.appendFileSync(file, Buffer.alloc(1024 * 1024)); }
      return count;
    }) as typeof fs.readSync);
    const input = new BoundedFD(file, 3, budget);
    try { expect(() => input.all()).toThrow(/grew/); expect(read).toBe(4);
      expect(budget).toMatchObject({ bytes: 4, payloadBytes: 3, eofProbeAttempts: 1, eofProbeBytes: 1 }); }
    finally { input.close(); spy.mockRestore(); }
  });

  it('accepts exact payload equality and separately bounds the sixteen EOF probes', () => {
    const fixture = setup(), budget = sourceReadBudget(), bytes = Buffer.alloc(131072);
    for (let index = 0; index < 16; index++) {
      const file = path.join(fixture.root, 'cohort-' + index); fs.writeFileSync(file, bytes);
      const reader = new BoundedFD(file, 262144, budget);
      try { expect(reader.all()).toEqual(bytes); reader.finish(); } finally { reader.close(); }
    }
    expect(budget).toMatchObject({ bytes: 2097152, payloadBytes: 2097152, eofProbeAttempts: 16, eofProbeBytes: 0 });
    const extra = path.join(fixture.root, 'seventeenth'); fs.writeFileSync(extra, '');
    const refused = new BoundedFD(extra, 0, budget);
    try { expect(() => refused.all()).toThrow(/probe count cap/); } finally { refused.close(); }
    const fullFile = path.join(fixture.root, 'exact-file'); fs.writeFileSync(fullFile, Buffer.alloc(262144));
    const exact = new BoundedFD(fullFile, 262144, sourceReadBudget(262144, 1));
    try { expect(exact.all().length).toBe(262144); exact.finish(); } finally { exact.close(); }
    expect(() => new BoundedFD(fullFile, 262143, sourceReadBudget())).toThrow(/admission/);
  });

  it('refuses source changes during enumeration before writing the final custody manifest', () => {
    const fixture = setup(); let changed = false;
    expect(() => analyzeCatalog({ ...fixture.options, now: () => {
      if (!changed) { changed = true; fs.appendFileSync(path.join(fixture.sources, 'evidence.txt'), 'x'); }
      return 0;
    } })).toThrow(/changed before custody close/);
    expect(fs.existsSync(path.join(fixture.options.outputDirectory, EXTERNAL_MANIFEST))).toBe(false);
  });

  it('requires nested-directory and namespace-parent durability before completed custody', () => {
    for (const failNested of [false, true]) {
      const fixture = setup(), opened = new Map<number, string>(), directorySyncs: string[] = [];
      const actualOpen = fs.openSync, actualClose = fs.closeSync, actualSync = fs.fsyncSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
        const fd = Reflect.apply(actualOpen, fs, args) as number; opened.set(fd, String(args[0])); return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => { actualClose(fd); opened.delete(fd); });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
        const file = opened.get(fd);
        if (file && fs.fstatSync(fd).isDirectory()) {
          directorySyncs.push(file);
          if (failNested && file === path.join(fixture.options.outputDirectory, 'runtime/encounter-proxy'))
            throw new Error('Controlled nested-directory durability failure');
        }
        actualSync(fd);
      });
      try {
        if (failNested) {
          expect(() => analyzeCatalog(fixture.options)).toThrow(/nested-directory durability failure/);
          expect(fs.existsSync(path.join(fixture.options.outputDirectory, EXTERNAL_MANIFEST))).toBe(false);
        } else {
          analyzeCatalog(fixture.options);
          for (const relative of ['', 'sources', 'runtime', 'runtime/encounter-catalog', 'runtime/encounter-proxy'])
            expect(directorySyncs).toContain(path.join(fixture.options.outputDirectory, relative));
          expect(directorySyncs.at(-1)).toBe(path.dirname(fixture.options.outputDirectory));
        }
        expect(opened.size).toBe(0);
      } finally { vi.restoreAllMocks(); }
    }
  });

  it('rejects commented re-exports and same-line outside imports without loading them', () => {
    const file = 'runtime/encounter-catalog/custody.ts', files = new Set([file, 'runtime/encounter-catalog/schema.ts']);
    expect(() => assertRuntimeImports("import fs from 'node:fs'; export { validateInput } from './schema.js';", file, files)).not.toThrow();
    expect(() => assertRuntimeImports("import { readFileSync as α } from 'node:fs';", file, files)).not.toThrow();
    expect(() => assertRuntimeImports("import { readFileSync as \\u0061 } from 'node:fs';", file, files)).not.toThrow();
    for (const code of [
      "export {x/*comment*/} from '../bad.js';",
      "export{x/*comment*/}from'../bad.js';",
      "import fs from 'node:fs'; import {spawn} from 'node:child_process';",
      "import fs from'node:fs';import{spawn}from'node:child_process';",
      "import fs from 'node:fs'; export {x} from '../bad.js';",
      "import fs from'node:fs';export{x}from'../bad.js';",
      "export {'x' as y} from '../bad.js';",
      "export const x=import('./schema.js');",
      "import { α } from 'node:child_process';",
      "export { α } from '../bad.js';",
      "import { \\u0061 } from 'node:child_process';",
      "export { \\u0061 } from '../bad.js';",
    ]) expect(() => assertRuntimeImports(code, file, files)).toThrow();
  });

  it('distinguishes actual code imports from module words in diagnostics, comments, and regex literals', () => {
    const file = 'runtime/encounter-catalog/custody.ts', files = new Set([file, 'runtime/encounter-catalog/schema.ts']);
    const diagnostic = "const message = 'Outside standalone runtime import'; const target = value.replace(/\\.js$/, '.ts');";
    const inert = [diagnostic,
      "// import x from 'node:child_process';\n/* export {x} from '../bad.js'; */",
      "const message = `import x from 'node:child_process'; export {x} from '../bad.js';`;",
      'const pattern = /\\b(?:import|export)\\s*[\'\"]([^\'\"]+)[\'\"]/g;',
      "const quotient = numerator / denominator;",
    ].join('\n');
    expect(() => assertRuntimeImports(inert + "\nimport {validateInput} from './schema.js';", file, files)).not.toThrow();
    for (const dependency of ["import {spawn} from 'node:child_process';", "export {x} from '../bad.js';"]) {
      expect(() => assertRuntimeImports(inert + '\n' + dependency, file, files)).toThrow();
      expect(() => assertRuntimeImports("const message='runtime import';" + dependency, file, files)).toThrow();
      for (const terminator of ['\n', '\r', '\u2028', '\u2029'])
        expect(() => assertRuntimeImports('// inert' + terminator + dependency, file, files)).toThrow();
      for (const separator of ['\u2028', '\u2029', '\u00a0', '\u2003', '\ufeff'])
        expect(() => assertRuntimeImports('someIdentifier' + separator + dependency, file, files)).toThrow();
    }
    for (const whitespace of ['\u00a0', '\u2003', '\ufeff'])
      expect(() => assertRuntimeImports('import' + whitespace + "{spawn} from 'node:child_process';", file, files)).toThrow();
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      expect(() => assertRuntimeImports('const pattern=/unterminated' + terminator + '/;', file, files)).toThrow();
      expect(() => assertRuntimeImports('const pattern=/escaped\\' + terminator + '/;', file, files)).toThrow();
    }
    // This exercises the actual 16-file admitted source, including the guard's
    // own quoted diagnostics and regex text, rather than an extracted import list.
    const runtime = runtimeFiles();
    expect(runtime.size).toBe(16);
    expect(runtime.has(file)).toBe(true);
    expect(runtime.has('runtime/encounter-proxy/protocol.v3.json')).toBe(true);
  });
});
