import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, sha256 } from './canonical.js';
import { compileCatalog } from './catalog.js';
import { EncounterEngine } from './engine.js';
import { createFixtureNamespace } from './namespace.js';
import type { JournalRecord, NamespaceCommand, NamespaceWriter } from './namespace.js';
import { verifyFixtureNamespace } from './namespace-verifier.js';
import type { FixtureNamespaceVerificationOptions } from './namespace-verifier.js';
import { stripRawExchange } from './raw-ingress.js';
import { squareSpec } from './test-fixtures.js';

const folders: string[] = [], writers: NamespaceWriter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) writer.abandon();
  for (const directory of folders.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-encounter-fixture-'))); folders.push(parent);
  const sourceRoot = path.join(parent, 'source'); fs.mkdirSync(sourceRoot);
  // A small controlled source-pin specimen. A real runner pins its full
  // externally reviewed runtime closure; this test does not qualify one.
  const source = Buffer.from('export const fixture = 1;\n');
  fs.writeFileSync(path.join(sourceRoot, 'entry.ts'), source);
  const spec = squareSpec(), catalog = compileCatalog(spec);
  const writer = createFixtureNamespace({ outputRoot: path.join(parent, 'namespace'), namespaceId: 'verify-fixture',
    sourceRoot, sourcePins: [{ file: 'entry.ts', bytes: source.byteLength, sha256: sha256(source) }],
    catalogs: [{ spec, compiledCatalogHash: catalog.catalogHash }] }); writers.push(writer);
  const engine = new EncounterEngine({ namespaceId: writer.manifest.namespaceId,
    catalogs: [catalog], fixtureMode: true, prospectiveCutoff: null });
  return { parent, sourceRoot, writer, engine };
}
type Setup = ReturnType<typeof setup>;
function rawPacket(cursor: number, observedAt: number, lon: number, stopId: number | null = null): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, epoch: 'controlled-raw-epoch', build: 'controlled-raw-build',
    cursor, latest: cursor, hasMore: false, frames: [], feed: {
      buses: [{ route_id: 100, bus_id: 7, bus_name: '#raw', observed_at: observedAt,
        lat: 41, lon, stationary: stopId !== null, at_stop_id: stopId }],
      server_eta: { eta: 99999, travel: [999], selectedPass: 'opaque-test-model' },
    } }));
}
function apply(fixture: Setup, command: NamespaceCommand, bytes?: Buffer, checkpoint = false) {
  const ref = fixture.writer.appendCommand(command, bytes); // durable bytes FIRST
  let result: unknown;
  if (command.kind === 'ingest') {
    const stripped = stripRawExchange(bytes!, command.status, { originalReceivedAt: command.originalReceivedAt,
      availableAt: command.availableAt, origin: command.origin });
    result = stripped.error !== null || stripped.packet === null
      ? { kind: 'ingress-refused', error: stripped.error ?? 'malformed-packet', update: fixture.engine.refuseInput(command.availableAt, 'source-gap') }
      : { kind: 'ingest', update: fixture.engine.ingest(stripped.packet) };
  } else if (command.kind === 'enroll') result = { kind: 'enroll', update: fixture.engine.enroll(command.opportunity, command.availableAt) };
  else result = { kind: 'tick', update: fixture.engine.tickDetailed(command.availableAt) };
  fixture.writer.appendDerived(ref, { result, snapshot: fixture.engine.snapshot(), checkpoint });
}
function pins(fixture: Setup, expectedPrefix = fixture.writer.prefix()): FixtureNamespaceVerificationOptions {
  return { directory: fixture.writer.directory, expectedManifestHash: fixture.writer.manifestHash,
    expectedPrefix, expectedSourceInventoryHash: fixture.writer.manifest.sourceInventoryHash, sourceRoot: fixture.sourceRoot };
}
function valid() {
  const fixture = setup(), first = rawPacket(1, 1000, -72.995);
  apply(fixture, { kind: 'ingest', availableAt: 1100, originalReceivedAt: 1100, status: 200, origin: 'public-current' }, first);
  const receipt = stripRawExchange(first, 200, { originalReceivedAt: 1100, availableAt: 1100 }).packet!;
  apply(fixture, { kind: 'enroll', availableAt: 1100, opportunity: { id: 'op', vehicle: { routeId: 100, busId: 7, busName: '#raw' },
    stopId: 100, horizon: '0-2', forecastAt: 1100, availableAt: 1100, receiptHash: receipt.receiptHash } });
  apply(fixture, { kind: 'ingest', availableAt: 21100, originalReceivedAt: 21100, status: 200, origin: 'public-current' }, rawPacket(2, 21000, -72.99, 100));
  apply(fixture, { kind: 'ingest', availableAt: 31100, originalReceivedAt: 31100, status: 200, origin: 'public-current' }, rawPacket(3, 31000, -72.99, 100));
  apply(fixture, { kind: 'tick', availableAt: 32000 }, undefined, true);
  const prefix = fixture.writer.close('completed');
  return { ...fixture, options: pins(fixture, prefix) };
}
type Valid = ReturnType<typeof valid>;
function readRows(fixture: Setup): JournalRecord<Record<string, unknown>>[] {
  return fs.readFileSync(path.join(fixture.writer.directory, 'journal.jsonl'), 'utf8').trimEnd().split('\n')
    .map(line => JSON.parse(line) as JournalRecord<Record<string, unknown>>);
}
/** Forge internally rehashed headers to exercise semantic checks as well as
 * external prefix checks. This deliberately does not grant provenance truth. */
function rechain(fixture: Valid, mutate: (rows: JournalRecord<Record<string, unknown>>[]) => void): FixtureNamespaceVerificationOptions {
  const rows = readRows(fixture); mutate(rows); let previousHash = fixture.writer.manifestHash;
  const commandRefs = new Map<number, { seq: number; hash: string }>();
  for (const row of rows) {
    if (row.kind === 'derived') {
      const old = row.body.commandRef as { seq: number };
      const current = commandRefs.get(old.seq);
      if (current) row.body.commandRef = current;
    }
    row.previousHash = previousHash;
    const { hash: _old, ...body } = row; row.hash = sha256(canonicalJSON(body)); previousHash = row.hash;
    if (row.kind === 'command') commandRefs.set(row.seq, { seq: row.seq, hash: row.hash });
  }
  fs.writeFileSync(path.join(fixture.writer.directory, 'journal.jsonl'), rows.map(row => canonicalJSON(row) + '\n').join(''));
  return { ...fixture.options, expectedPrefix: { seq: rows.at(-1)!.seq, hash: rows.at(-1)!.hash } };
}
function fingerprint(directory: string) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.statSync(file, { bigint: true });
    return [name, { bytes: String(stat.size), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs), sha256: sha256(fs.readFileSync(file)) }];
  }));
}

describe('read-only fixture namespace custody and deterministic R3 verification', () => {
  it('recomputes raw receipts, events, terminal outcomes, source/catalog pins and final checkpoint without writing', () => {
    const fixture = valid(), before = fingerprint(fixture.writer.directory);
    expect(fixture.engine.snapshot().enrollments.records.op).toMatchObject({ status: 'matched', arrivedAt: 21000 });
    const report = verifyFixtureNamespace(fixture.options);
    expect(report).toMatchObject({ verified: true, completed: true, refused: false, fixtureMode: true,
      prospectiveQualified: false, physicalServiceTruth: false, commands: 5, checkpointFiles: 1 });
    expect(report.events).toBeGreaterThanOrEqual(2);
    expect(report.outcomes).toBeGreaterThanOrEqual(2);
    expect(report.prefix).toEqual(fixture.options.expectedPrefix);
    expect(report.snapshotHash).toBe(sha256(canonicalJSON(fixture.engine.snapshot())));
    expect(report.checkpointStates[0]?.snapshotHash).toBe(report.snapshotHash);
    expect(report.actualClocks.createdAt).toBeGreaterThan(report.fixtureClocks.lastAvailableAt!);
    expect(report.actualClocks.lastConsumerReadAt).toBeGreaterThanOrEqual(report.actualClocks.createdAt);
    expect(fingerprint(fixture.writer.directory)).toEqual(before);
  });

  it('verifies a consistent refusal after retained failed HTTP bytes and never manufactures a raw fix', () => {
    for (const status of [503, 200]) {
      const fixture = setup(), bytes = Buffer.from('{"error":"offline","model":{"eta":0}}');
      apply(fixture, { kind: 'ingest', availableAt: 1000, originalReceivedAt: 900, status, origin: 'public-current' }, bytes, true);
      const prefix = fixture.writer.close('refused'), options = pins(fixture, prefix);
      const report = verifyFixtureNamespace(options);
      expect(report).toMatchObject({ verified: true, completed: false, refused: true, commands: 1, rawBytes: bytes.length });
      expect((readRows(fixture)[1]!.body.result as { error: string }).error).toBe(status === 503 ? 'http-error' : 'malformed-packet');
      expect(fixture.engine.snapshot().vehicles).toEqual({});
      expect(fs.readFileSync(path.join(fixture.writer.directory, 'raw.bin'))).toEqual(bytes);
      const forged = { ...fixture, options };
      const completed = rechain(forged, rows => { rows.at(-1)!.body.reason = 'completed'; });
      expect(() => verifyFixtureNamespace(completed)).toThrow('close-prefix');
    }
  });

  it('rejects changed exact raw bytes and uncommitted raw tails', () => {
    const fixture = valid(), file = path.join(fixture.writer.directory, 'raw.bin'), original = fs.readFileSync(file);
    const corrupted = Buffer.from(original); corrupted[0] = corrupted[0]! ^ 1; fs.writeFileSync(file, corrupted);
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('raw-hash');
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('uncommitted')]));
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('raw-tail');
  });

  it('rejects partial final records, missing sequence and externally unpinned prefixes', () => {
    const fixture = valid(), file = path.join(fixture.writer.directory, 'journal.jsonl'), original = fs.readFileSync(file);
    fs.writeFileSync(file, original.subarray(0, -1));
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('partial-last-record');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('canonical-bytes');
    fs.writeFileSync(file, original);
    expect(() => verifyFixtureNamespace({ ...fixture.options,
      expectedPrefix: { ...fixture.options.expectedPrefix, seq: fixture.options.expectedPrefix.seq - 1 } })).toThrow('external-prefix');
    const altered = rechain(fixture, rows => { rows.splice(2, 1); });
    expect(() => verifyFixtureNamespace(altered)).toThrow('sequence');
  });

  it('rejects actual clock forgery and regressing fixture consumer clocks even with rehashed headers', () => {
    const actual = valid();
    const actualPins = rechain(actual, rows => { rows[0]!.actualConsumerReadAt = actual.writer.manifest.createdAt - 1; });
    expect(() => verifyFixtureNamespace(actualPins)).toThrow('actual-clock');
    const simulation = valid();
    const simulationPins = rechain(simulation, rows => {
      const row = rows.find(value => value.kind === 'command' && (value.body.command as { kind: string }).kind === 'enroll')!;
      (row.body.command as { availableAt: number }).availableAt = 0;
    });
    expect(() => verifyFixtureNamespace(simulationPins)).toThrow('consumer-clock');
    const sourceClock = valid();
    const sourcePins = rechain(sourceClock, rows => {
      (rows[0]!.body.command as { originalReceivedAt: number }).originalReceivedAt = 0;
    });
    expect(() => verifyFixtureNamespace(sourcePins)).toThrow('result-replay');
  });

  it('does not turn rewritten fixture metadata or a cutoff into prospective admission', () => {
    const fixture = valid(), file = path.join(fixture.writer.directory, 'manifest.json');
    const manifest = { ...fixture.writer.manifest, kind: 'independent-encounter-prospective', fixtureMode: false,
      prospectiveCutoff: 1, publicationCapability: true, qualification: { completedAt: 0, sha256: 'f'.repeat(64) } };
    const bytes = Buffer.from(canonicalJSON(manifest) + '\n'); fs.writeFileSync(file, bytes);
    expect(() => verifyFixtureNamespace({ ...fixture.options, expectedManifestHash: sha256(bytes) })).toThrow('fixture-mode');
  });

  it('requires the exact frozen protocol, source inventory, source bytes and compiled raw catalog', () => {
    const protocol = valid(), protocolFile = path.join(protocol.writer.directory, 'manifest.json');
    const changedProtocol = Buffer.from(canonicalJSON({ ...protocol.writer.manifest, protocolHash: '0'.repeat(64) }) + '\n');
    fs.writeFileSync(protocolFile, changedProtocol);
    expect(() => verifyFixtureNamespace({ ...protocol.options, expectedManifestHash: sha256(changedProtocol) })).toThrow('protocol-pin');
    const source = valid(); fs.writeFileSync(path.join(source.sourceRoot, 'entry.ts'), 'export const fixture = 2;\n');
    expect(() => verifyFixtureNamespace(source.options)).toThrow('source-pin');
    const inventory = valid();
    expect(() => verifyFixtureNamespace({ ...inventory.options, expectedSourceInventoryHash: '0'.repeat(64) })).toThrow('source-inventory');
    const catalog = valid(), catalogFile = path.join(catalog.writer.directory, 'manifest.json');
    const changedCatalog = structuredClone(catalog.writer.manifest);
    (changedCatalog.catalogs[0] as { compiledCatalogHash: string }).compiledCatalogHash = '0'.repeat(64);
    const bytes = Buffer.from(canonicalJSON(changedCatalog) + '\n'); fs.writeFileSync(catalogFile, bytes);
    expect(() => verifyFixtureNamespace({ ...catalog.options, expectedManifestHash: sha256(bytes) })).toThrow('catalog-hash');
    const malformed = valid(), malformedFile = path.join(malformed.writer.directory, 'manifest.json');
    const malformedManifest = structuredClone(malformed.writer.manifest);
    (malformedManifest.catalogs[0] as unknown as { spec: unknown }).spec = null;
    const malformedBytes = Buffer.from(canonicalJSON(malformedManifest) + '\n');
    fs.writeFileSync(malformedFile, malformedBytes);
    expect(() => verifyFixtureNamespace({ ...malformed.options,
      expectedManifestHash: sha256(malformedBytes) })).toThrow('catalog: Invalid raw catalog shape');
  });

  it('rejects forged results/effect chains and checkpoint bytes after deterministic replay', () => {
    const effects = valid();
    const effectPins = rechain(effects, rows => {
      const derived = rows.find(row => row.kind === 'derived')!;
      (derived.body.effects as { eventHead: string }).eventHead = '0'.repeat(64);
    });
    expect(() => verifyFixtureNamespace(effectPins)).toThrow('effect-chain');
    const result = valid();
    const resultPins = rechain(result, rows => {
      const derived = rows.find(row => row.kind === 'derived')!;
      derived.body.result = { kind: 'ingest', update: { encounterEvents: [], outcomes: [], dispositions: [], diagnostics: [] } };
    });
    expect(() => verifyFixtureNamespace(resultPins)).toThrow('result-replay');
    const checkpoint = valid(), row = readRows(checkpoint).find(value => value.kind === 'derived' && value.body.checkpoint !== null)!;
    const ref = row.body.checkpoint as { file: string }, file = path.join(checkpoint.writer.directory, ref.file);
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; value.snapshotHash = '0'.repeat(64);
    fs.writeFileSync(file, canonicalJSON(value) + '\n');
    expect(() => verifyFixtureNamespace(checkpoint.options)).toThrow('checkpoint-hash');
  });

  it('independently rejects terminal reopening even if a replayed Engine snapshot regressed', () => {
    const fixture = valid(), originalSnapshot = EncounterEngine.prototype.snapshot;
    vi.spyOn(EncounterEngine.prototype, 'snapshot').mockImplementation(function (this: EncounterEngine) {
      const state = originalSnapshot.call(this), record = state.enrollments.records.op;
      if (state.availableAt < 32000 || record?.status !== 'matched') return state;
      return { ...state, enrollments: { ...state.enrollments,
        records: { ...state.enrollments.records, op: { ...record, status: 'open' as const } } } };
    });
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('terminal-reopen');
  });

  it('refuses unfinished command prefixes, symlink/hardlink aliases and strict read budgets', () => {
    const incomplete = setup();
    incomplete.writer.appendCommand({ kind: 'tick', availableAt: 1000 }); incomplete.writer.abandon();
    expect(() => verifyFixtureNamespace(pins(incomplete))).toThrow('unfinished-prefix');
    const fixture = valid(), before = fingerprint(fixture.writer.directory);
    expect(() => verifyFixtureNamespace({ ...fixture.options, limits: { maxReadBytes: 16 } })).toThrow('read-cap');
    expect(fingerprint(fixture.writer.directory)).toEqual(before);
    const alias = path.join(fixture.parent, 'alias'); fs.symlinkSync(fixture.writer.directory, alias);
    expect(() => verifyFixtureNamespace({ ...fixture.options, directory: alias })).toThrow('namespace-path');
    fs.linkSync(path.join(fixture.writer.directory, 'raw.bin'), path.join(fixture.parent, 'raw-alias'));
    expect(() => verifyFixtureNamespace(fixture.options)).toThrow('file-type');
  });

  it('reserves the EOF probe before reading a file that grows at the aggregate cap', () => {
    const fixture = valid(), file = path.join(fixture.writer.directory, 'manifest.json');
    const cap = fs.statSync(file).size, originalRead = fs.readSync;
    let actuallyRead = 0, grew = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
      const count = Reflect.apply(originalRead, fs, args) as number;
      actuallyRead += count;
      if (!grew && actuallyRead === cap) {
        fs.appendFileSync(file, 'x'); grew = true;
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => verifyFixtureNamespace({ ...fixture.options, limits: { maxReadBytes: cap } })).toThrow('read-cap');
    expect(grew).toBe(true);
    expect(actuallyRead).toBe(cap);
  });
});
