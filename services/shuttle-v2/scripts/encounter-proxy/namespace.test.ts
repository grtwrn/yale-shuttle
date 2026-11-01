import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, sha256 } from './canonical.js';
import { createFixtureNamespace, createProspectiveNamespace, DEFAULT_NAMESPACE_LIMITS, openNamespace } from './namespace.js';
import type { FixtureNamespaceOptions, JournalRecord, NamespaceLimits, NamespaceWriter } from './namespace.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import { squareSpec } from './test-fixtures.js';

const folders: string[] = [], writers: NamespaceWriter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) writer.abandon();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function setup(limits?: NamespaceLimits): FixtureNamespaceOptions {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'independent-custody-'))); folders.push(folder);
  const source = path.join(folder, 'source'); fs.mkdirSync(source);
  const bytes = Buffer.from('export const fixtureOnly = true;\n'); fs.writeFileSync(path.join(source, 'entry.ts'), bytes);
  return { outputRoot: path.join(folder, 'fixture-run'), namespaceId: 'independent-fixture-test', sourceRoot: source,
    sourcePins: [{ file: 'entry.ts', bytes: bytes.byteLength, sha256: sha256(bytes) }],
    catalogs: [{ spec: squareSpec(), compiledCatalogHash: sha256('unit-only catalog pin; no accuracy qualification') }],
    ...(limits ? { limits } : {}) };
}
function writer(options = setup()): NamespaceWriter {
  const result = createFixtureNamespace(options); writers.push(result); return result;
}
const update = { encounterEvents: [], outcomes: [], diagnostics: [], dispositions: [] };
const result = { kind: 'ingest', update };
const command = (availableAt: number) => ({ kind: 'ingest' as const, availableAt, originalReceivedAt: availableAt,
  status: 200, origin: 'public-current' as const });
function rows(store: NamespaceWriter): JournalRecord<Record<string, unknown>>[] {
  return fs.readFileSync(path.join(store.directory, 'journal.jsonl'), 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as JournalRecord<Record<string, unknown>>);
}

describe('exclusive fixture namespace and durable byte custody', () => {
  it('pins actual creation/source clocks separately from historical fixture simulation and cannot admit prospective metadata', () => {
    const before = Date.now(), store = writer(), after = Date.now();
    expect(store.manifest).toMatchObject({ fixtureMode: true, prospectiveCutoff: null, publicationCapability: false,
      restartPolicy: 'new-namespace-only', protocolHash: PROTOCOL_SHA256 });
    expect(store.manifest.createdAt).toBeGreaterThanOrEqual(before);
    expect(store.manifest.createdAt).toBeLessThanOrEqual(after);
    const manifestBytes = fs.readFileSync(path.join(store.directory, 'manifest.json'));
    expect(sha256(manifestBytes)).toBe(store.manifestHash);
    expect(store.manifest.sourceInventoryHash).toBe(sha256(canonicalJSON(store.manifest.sourcePins)));
    const ref = store.appendCommand(command(1000), Buffer.from('{"historicalFixture":true}'));
    store.appendDerived(ref, { result, snapshot: { fixtureMode: true, simulationAt: 1000 } });
    const row = rows(store)[0]!;
    expect(row.actualConsumerReadAt).toBeGreaterThanOrEqual(before);
    expect((row.body.command as { availableAt: number }).availableAt).toBe(1000);
    expect(() => createProspectiveNamespace({ fixtureMode: false, prospectiveCutoff: 1,
      qualification: { completedAt: 0, hash: sha256('forged qualification metadata') } })).toThrow('fixture custody only');
  });

  it('rejects existing roots, native trial IDs, protected stores and symlink escapes before any output write', () => {
    const options = setup(), store = writer(options);
    expect(() => createFixtureNamespace(options)).toThrow('exclusive');
    expect(() => createFixtureNamespace({ ...options, outputRoot: options.outputRoot + '-other', namespaceId: 'cycle-123' }))
      .toThrow('trial');
    const parent = path.dirname(store.directory);
    for (const name of ['.learning-loop', 'bot-artifacts', 'store']) {
      const protectedRoot = path.join(parent, name); fs.mkdirSync(protectedRoot);
      expect(() => createFixtureNamespace({ ...options, outputRoot: path.join(protectedRoot, 'new') })).toThrow('Protected');
      expect(fs.existsSync(path.join(protectedRoot, 'new'))).toBe(false);
    }
    const outside = path.join(parent, 'outside'); fs.mkdirSync(outside);
    const link = path.join(parent, 'escape'); fs.symlinkSync(outside, link);
    expect(() => createFixtureNamespace({ ...options, outputRoot: path.join(link, 'new') })).toThrow('symlinks');
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
    const dangling = path.join(parent, 'dangling'); fs.symlinkSync(path.join(parent, 'absent'), dangling);
    expect(() => createFixtureNamespace({ ...options, outputRoot: dangling })).toThrow('already exists');
  });

  it('retains failed, malformed and duplicate full bytes contiguously before returning projection admission', () => {
    const store = writer();
    const inputs = [Buffer.from('{"model":{"eta":999},"raw":"same"}'),
      Buffer.from('{"model":{"eta":999},"raw":"same"}')];
    let offset = 0;
    for (const [index, bytes] of inputs.entries()) {
      const ref = store.appendCommand(command(1000 + index), bytes);
      // Projection may begin only after appendCommand returned. Even an HTTP
      // failure or duplicate is already recoverable from its exact raw offset.
      expect(fs.readFileSync(path.join(store.directory, 'raw.bin')).subarray(offset, offset + bytes.byteLength)).toEqual(bytes);
      const body = rows(store).at(-1)!.body.command as { raw: { offset: number; bytes: number; sha256: string } };
      expect(body.raw).toMatchObject({ offset, bytes: bytes.byteLength, sha256: sha256(bytes) });
      offset += bytes.byteLength;
      store.appendDerived(ref, { result, snapshot: { fixtureMode: true, inputCount: index + 1 } });
    }
    const prefix = store.close();
    expect(fs.readFileSync(path.join(store.directory, 'raw.bin'))).toEqual(Buffer.concat(inputs));
    expect(prefix.seq).toBe(5);
    expect(rows(store).at(-1)!.body.rawHash).toBe(sha256(Buffer.concat(inputs)));
    for (const [status, error] of [[503, 'http-error'], [200, 'malformed-packet']] as const) {
      const refused = writer(), broken = Buffer.from('{retained error bytes');
      const admission = refused.appendCommand({ ...command(1000), status }, broken);
      refused.appendDerived(admission, { result: { kind: 'ingress-refused', error, update }, snapshot: {} });
      expect(fs.readFileSync(path.join(refused.directory, 'raw.bin'))).toEqual(broken);
      expect(() => refused.appendCommand({ kind: 'tick', availableAt: 1001 })).toThrow('only close refused');
      expect(() => refused.close('completed')).toThrow('close refused');
      refused.close('refused');
    }
  });

  it('chains commands, exact results, effect prefixes and a final immutable checkpoint to the external head', () => {
    const store = writer(), bytes = Buffer.from('{"opaqueModelPacket":true}');
    const ref = store.appendCommand(command(1000), bytes);
    const effects = { kind: 'ingest', update: { encounterEvents: [{ vehicle: 'raw', event: { kind: 'candidate' } }],
      outcomes: [{ id: 'unknown-forecast', status: 'missing' }], diagnostics: [], dispositions: [] } };
    const snapshot = { fixtureMode: true, finalState: { terminal: 'missing' } };
    store.appendDerived(ref, { result: effects, snapshot, checkpoint: true });
    const finalPrefix = store.close(), journal = rows(store);
    let previousHash = store.manifestHash;
    for (const [index, row] of journal.entries()) {
      const { hash, ...body } = row;
      expect(row.seq).toBe(index + 1); expect(row.previousHash).toBe(previousHash);
      expect(hash).toBe(sha256(canonicalJSON(body))); previousHash = hash;
    }
    expect(previousHash).toBe(finalPrefix.hash);
    const derived = journal[1]!.body;
    expect(derived.result).toEqual(effects);
    expect(derived.snapshotHash).toBe(sha256(canonicalJSON(snapshot)));
    expect(derived.effects).toMatchObject({ eventCount: 1, outcomeCount: 1 });
    const checkpoint = derived.checkpoint as { file: string; bytes: number; sha256: string };
    const retained = fs.readFileSync(path.join(store.directory, checkpoint.file));
    expect(retained.byteLength).toBe(checkpoint.bytes); expect(sha256(retained)).toBe(checkpoint.sha256);
    expect(JSON.parse(retained.toString())).toMatchObject({ commandRef: ref,
      rawPrefix: { bytes: bytes.byteLength, sha256: sha256(bytes) }, snapshot });
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 2000 })).toThrow('closed');
  });

  it('enforces alternating command/result commits and refuses writable restarts without removing partial evidence', () => {
    const store = writer(), bytes = Buffer.from('retained before interrupted projection');
    const ref = store.appendCommand(command(1000), bytes);
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 1001 })).toThrow('Outstanding');
    expect(() => store.appendDerived({ ...ref, hash: sha256('wrong command') }, { result, snapshot: {} })).toThrow('outstanding');
    expect(() => store.close()).toThrow('incomplete');
    store.abandon();
    expect(() => openNamespace(store.directory)).toThrow('create a new namespace');
    expect(fs.readFileSync(path.join(store.directory, 'raw.bin'))).toEqual(bytes);
    expect(rows(store).map(value => value.kind)).toEqual(['command']);
  });

  it('preserves raw bytes if journal fsync fails after durable raw admission and refuses further writes', () => {
    const store = writer(), bytes = Buffer.from('durable despite interrupted journal flush');
    const journalIdentity = fs.statSync(path.join(store.directory, 'journal.jsonl')).ino;
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).ino === journalIdentity) throw new Error('injected journal fsync interruption');
      realFsync(fd);
    });
    expect(() => store.appendCommand(command(1000), bytes)).toThrow('journal fsync');
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(store.directory, 'raw.bin'))).toEqual(bytes);
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 1001 })).toThrow('requires a new namespace');
    expect(() => openNamespace(store.directory)).toThrow('resume');
  });

  it('refuses byte/record budgets before raw append and fixes limits in the immutable manifest', () => {
    const limits = { ...DEFAULT_NAMESPACE_LIMITS, maxRawBytes: 3, maxCommands: 1 };
    const store = writer(setup(limits));
    expect(() => store.appendCommand(command(1000), Buffer.from('four'))).toThrow('cap');
    expect(fs.statSync(path.join(store.directory, 'raw.bin')).size).toBe(0);
    const ref = store.appendCommand(command(1000), Buffer.from('yes'));
    store.appendDerived(ref, { result, snapshot: {} });
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 1001 })).toThrow('command cap');
    expect(store.manifest.limits.maxRawBytes).toBe(3);
    store.close('refused');
  });

  it('rejects source drift, caller clock regression and changed append-file identity', () => {
    const options = setup(); fs.appendFileSync(path.join(options.sourceRoot, 'entry.ts'), '// changed');
    expect(() => createFixtureNamespace(options)).toThrow('Source pin');
    const store = writer(), ref = store.appendCommand({ kind: 'tick', availableAt: 2000 });
    store.appendDerived(ref, { result: { kind: 'tick', update }, snapshot: {} });
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 1999 })).toThrow('simulation clock');
    const journal = path.join(store.directory, 'journal.jsonl');
    fs.renameSync(journal, journal + '.original'); fs.writeFileSync(journal, '');
    expect(() => store.appendCommand({ kind: 'tick', availableAt: 2001 })).toThrow('append prefix changed');
  });

  it('reserves source EOF probes and refuses growth during the descriptor-admitted read before creating output', () => {
    const capped = setup();
    expect(() => createFixtureNamespace({ ...capped, limits: { ...DEFAULT_NAMESPACE_LIMITS,
      maxSourceBytes: capped.sourcePins[0]!.bytes } })).toThrow('Source inventory read cap');
    expect(fs.existsSync(capped.outputRoot)).toBe(false);
    const growing = setup(), file = path.join(growing.sourceRoot, 'entry.ts');
    const sourceInode = fs.statSync(file).ino, realRead = fs.readSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(realRead, fs, args) as number;
      if (!injected && count > 0 && fs.fstatSync(args[0]).ino === sourceInode) {
        injected = true; fs.appendFileSync(file, 'growing-after-admitted-payload');
      }
      return count;
    });
    expect(() => createFixtureNamespace(growing)).toThrow(/changed before EOF/);
    expect(injected).toBe(true);
    expect(fs.existsSync(growing.outputRoot)).toBe(false);
  });
});
