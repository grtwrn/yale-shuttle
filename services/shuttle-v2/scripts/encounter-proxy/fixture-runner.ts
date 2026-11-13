import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJSON, sha256 } from './canonical.js';
import { compileCatalog } from './catalog.js';
import { EncounterEngine } from './engine.js';
import { createFixtureNamespace } from './namespace.js';
import type { NamespaceCommand } from './namespace.js';
import { verifyFixtureNamespace } from './namespace-verifier.js';
import { stripRawExchange } from './raw-ingress.js';
import { inventoryRuntime } from './source-inventory.js';
import { readBoundedFile } from './bounded-read.js';
import type { ForecastOpportunity, Horizon } from './enrollment.js';
import type { RouteCatalogSpec } from './types.js';

const MAX_INPUT_BYTES = 32 * 1024 * 1024, MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024, MAX_COMMANDS = 10000, MAX_WALL_MS = 60000;
type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Regular, no-follow input with an exact descriptor identity and EOF pin. */
function readInput(file: string, maximum: number): { bytes: Buffer; sha256: string } {
  if (maximum < 1) throw new Error('Fixture input read admission exhausted');
  const bytes = readBoundedFile(file, maximum - 1); // Reserve the actual EOF probe before reading.
  return { bytes, sha256: sha256(bytes) };
}

function parseOpportunity(value: unknown): ForecastOpportunity {
  if (!object(value) || !object(value.vehicle) || typeof value.id !== 'string'
    || typeof value.receiptHash !== 'string' || !clock(value.forecastAt) || !clock(value.availableAt)
    || !clock(value.stopId) || !clock(value.vehicle.routeId) || !clock(value.vehicle.busId)
    || typeof value.vehicle.busName !== 'string' || !['0-2', '2-5', '5-10', '10-30'].includes(String(value.horizon)))
    throw new Error('Malformed fixture forecast opportunity');
  // Numerical forecasts/model vintage are never spread into the matcher.
  return { id: value.id, receiptHash: value.receiptHash, forecastAt: value.forecastAt, availableAt: value.availableAt,
    stopId: value.stopId, horizon: value.horizon as Horizon,
    vehicle: { routeId: value.vehicle.routeId, busId: value.vehicle.busId, busName: value.vehicle.busName } };
}
function commandInput(value: unknown): { command: NamespaceCommand; rawBytes?: Buffer } {
  if (!object(value) || !clock(value.availableAt)) throw new Error('Invalid fixture command clock');
  if (value.kind === 'tick') return { command: { kind: 'tick', availableAt: value.availableAt } };
  if (value.kind === 'enroll') return { command: { kind: 'enroll', availableAt: value.availableAt,
    opportunity: parseOpportunity(value.opportunity) } };
  if (value.kind !== 'ingest' || !clock(value.originalReceivedAt) || !clock(value.status)
    || typeof value.rawBase64 !== 'string' || !['historical-frame', 'public-current'].includes(String(value.origin)))
    throw new Error('Malformed fixture ingest command');
  const rawBytes = Buffer.from(value.rawBase64, 'base64');
  if (rawBytes.toString('base64') !== value.rawBase64) throw new Error('Fixture raw bytes require canonical base64');
  return { command: { kind: 'ingest', availableAt: value.availableAt, originalReceivedAt: value.originalReceivedAt,
    status: value.status, origin: value.origin as 'historical-frame' | 'public-current' }, rawBytes };
}

export interface FixtureRunOptions {
  inputFile: string;
  catalogFiles: readonly string[];
  outputRoot: string;
  namespaceId: string;
}
export function runFixture(options: FixtureRunOptions) {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22')
    throw new Error('Fixture computation requires the admitted Linux Node22 runtime');
  const started = performance.now();
  const checkDeadline = () => {
    if (performance.now() - started > MAX_WALL_MS) throw new Error('Finite fixture wall-clock deadline exceeded');
  };
  const input = readInput(options.inputFile, MAX_INPUT_BYTES);
  checkDeadline();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  if (!text.endsWith('\n')) throw new Error('Fixture command input is incomplete: missing final LF');
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.length > MAX_COMMANDS || lines.some(line => !line.length || Buffer.byteLength(line) > MAX_LINE_BYTES))
    throw new Error('Fixture command count/line admission exceeded');
  const parsed = lines.map(line => { checkDeadline(); return commandInput(JSON.parse(line)); });
  if (!options.catalogFiles.length || options.catalogFiles.length > 32) throw new Error('Fixture catalog count admission exceeded');
  let catalogBytes = 0;
  const catalogInputs = options.catalogFiles.map(file => {
    checkDeadline();
    const value = readInput(file, MAX_CATALOG_BYTES - catalogBytes);
    catalogBytes += value.bytes.byteLength + 1;
    if (catalogBytes > MAX_CATALOG_BYTES) throw new Error('Aggregate fixture catalog read admission exceeded');
    return { file, ...value };
  });
  const specs = catalogInputs.map(value => { checkDeadline(); return JSON.parse(value.bytes.toString('utf8')) as RouteCatalogSpec; });
  const catalogs = specs.map(spec => { checkDeadline(); return compileCatalog(spec); });
  checkDeadline();
  const inventory = inventoryRuntime(path.dirname(fileURLToPath(import.meta.url)));
  checkDeadline();
  const receiptFile = path.resolve(options.outputRoot) + '.receipt.json';
  try { fs.lstatSync(receiptFile); throw new Error('External fixture receipt already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const writer = createFixtureNamespace({ outputRoot: options.outputRoot, namespaceId: options.namespaceId,
    sourceRoot: inventory.sourceRoot, sourcePins: inventory.pins,
    catalogs: specs.map((spec, index) => ({ spec, compiledCatalogHash: catalogs[index]!.catalogHash })) });
  const engine = new EncounterEngine({ namespaceId: options.namespaceId, catalogs, fixtureMode: true, prospectiveCutoff: null });
  let refused = false, consumed = 0;
  try {
    checkDeadline();
    for (const [index, value] of parsed.entries()) {
      checkDeadline();
      const ref = writer.appendCommand(value.command, value.rawBytes);
      const command = value.command;
      let result: unknown;
      if (command.kind === 'ingest') {
        const stripped = stripRawExchange(value.rawBytes!, command.status, {
          originalReceivedAt: command.originalReceivedAt, availableAt: command.availableAt, origin: command.origin });
        if (!stripped.packet) {
          refused = true;
          result = { kind: 'ingress-refused', error: stripped.error ?? 'malformed-packet',
            update: engine.refuseInput(command.availableAt, 'source-gap') };
        } else result = { kind: 'ingest', update: engine.ingest(stripped.packet) };
      } else if (command.kind === 'tick') result = { kind: 'tick', update: engine.tickDetailed(command.availableAt) };
      else result = { kind: 'enroll', update: engine.enroll(command.opportunity, command.availableAt) };
      consumed++;
      writer.appendDerived(ref, { result, snapshot: engine.snapshot(), checkpoint: refused || index === parsed.length - 1 });
      checkDeadline();
      if (refused) break;
    }
    const prefix = writer.close(refused ? 'refused' : 'completed');
    checkDeadline();
    const verification = verifyFixtureNamespace({ directory: writer.directory, expectedManifestHash: writer.manifestHash,
      expectedPrefix: prefix, expectedSourceInventoryHash: inventory.hash, sourceRoot: inventory.sourceRoot,
      limits: { maxWallMs: Math.max(1, Math.min(30000, Math.floor(MAX_WALL_MS - (performance.now() - started)))) } });
    checkDeadline();
    const receipt = { v: 1, scope: 'finite-fixture-custody-and-R3-reproducibility-only',
      fixtureMode: true, prospectiveQualified: false, physicalServiceTruth: false, publicationCapability: false,
      namespaceId: options.namespaceId, directory: writer.directory, manifestHash: writer.manifestHash,
      expectedPrefix: prefix, sourceInventoryHash: inventory.hash,
      input: { file: path.resolve(options.inputFile), bytes: input.bytes.byteLength, sha256: input.sha256,
        commandsProvided: parsed.length, commandsConsumed: consumed },
      catalogInputs: catalogInputs.map(value => ({ file: path.resolve(value.file), bytes: value.bytes.byteLength, sha256: value.sha256 })),
      completed: !refused, refused, actualCompletedAt: Date.now(), elapsedMs: performance.now() - started,
      runtime: { node: process.version, platform: process.platform, arch: process.arch }, verification };
    const bytes = Buffer.from(canonicalJSON(receipt) + '\n');
    checkDeadline();
    const fd = fs.openSync(receiptFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(receiptFile), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    checkDeadline();
    return receipt;
  } catch (error) { writer.abandon(); throw error; }
}

function main(args: readonly string[]): void {
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--input', '--catalog', '--out', '--namespace'].includes(key) || value === undefined)
      throw new Error('Usage: --input commands.jsonl --catalog catalog.json [--catalog other.json] --out NEW_DIRECTORY --namespace UNIQUE_ID');
    if (key !== '--catalog' && values.has(key)) throw new Error('Duplicate fixture CLI option');
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  for (const key of ['--input', '--catalog', '--out', '--namespace']) if (!values.has(key)) throw new Error(`Missing ${key}`);
  const receipt = runFixture({ inputFile: values.get('--input')![0]!, catalogFiles: values.get('--catalog')!,
    outputRoot: values.get('--out')![0]!, namespaceId: values.get('--namespace')![0]! });
  process.stdout.write(JSON.stringify(receipt) + '\n');
  if (receipt.refused) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
