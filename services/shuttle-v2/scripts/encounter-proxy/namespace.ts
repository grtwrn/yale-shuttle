import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON, deepFreeze, sha256 } from './canonical.js';
import { readBoundedFile } from './bounded-read.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import type { ForecastOpportunity } from './enrollment.js';
import type { RouteCatalogSpec } from './types.js';

const MiB = 1024 * 1024;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export interface NamespaceLimits {
  maxRawBytes: number; maxJournalBytes: number; maxCheckpointBytes: number; maxTotalBytes: number;
  maxCommands: number; maxRecords: number; maxRecordBytes: number; maxSourceBytes: number;
}
export const DEFAULT_NAMESPACE_LIMITS: Readonly<NamespaceLimits> = Object.freeze({
  maxRawBytes: 16 * MiB, maxJournalBytes: 16 * MiB, maxCheckpointBytes: 4 * MiB,
  maxTotalBytes: 40 * MiB, maxCommands: 10000, maxRecords: 20001, maxRecordBytes: MiB, maxSourceBytes: 4 * MiB,
});
export interface SourcePin { file: string; bytes: number; sha256: string }
export interface CatalogAdmission { spec: RouteCatalogSpec; compiledCatalogHash: string }
export interface NamespaceManifest {
  v: 1;
  kind: 'independent-encounter-fixture';
  namespaceId: string;
  fixtureMode: true;
  prospectiveCutoff: null;
  publicationCapability: false;
  restartPolicy: 'new-namespace-only';
  createdAt: number;
  protocolHash: string;
  sourceRoot: string;
  sourcePins: readonly SourcePin[];
  sourceInventoryHash: string;
  catalogs: readonly CatalogAdmission[];
  limits: NamespaceLimits;
}
export interface CommandRef { seq: number; hash: string }
export interface RawBytesRef { file: 'raw.bin'; offset: number; bytes: number; sha256: string }
/** availableAt belongs to the FIXTURE simulation, never the actual read clock. */
export type NamespaceCommand =
  | { kind: 'ingest'; availableAt: number; originalReceivedAt: number; status: number; origin: 'historical-frame' | 'public-current' }
  | { kind: 'tick'; availableAt: number }
  | { kind: 'enroll'; availableAt: number; opportunity: ForecastOpportunity };
export type PersistedCommand = Exclude<NamespaceCommand, { kind: 'ingest' }>
  | (Extract<NamespaceCommand, { kind: 'ingest' }> & { raw: RawBytesRef });
export interface EffectPrefix { eventCount: number; eventHead: string; outcomeCount: number; outcomeHead: string }
export interface JournalRecord<Body = unknown> {
  v: 1; namespaceId: string; manifestHash: string; seq: number; previousHash: string;
  kind: 'command' | 'derived' | 'close'; actualConsumerReadAt: number; body: Body; hash: string;
}
export interface CommandBody { command: PersistedCommand }
export interface CheckpointRef { file: string; bytes: number; sha256: string }
export interface DerivedBody {
  commandRef: CommandRef; result: unknown; snapshotHash: string;
  checkpoint: CheckpointRef | null; effects: EffectPrefix;
}
export interface CheckpointFile {
  v: 1; namespaceId: string; manifestHash: string; commandRef: CommandRef;
  rawPrefix: { bytes: number; sha256: string }; snapshotHash: string; snapshot: unknown;
}
export interface CloseBody {
  reason: 'completed' | 'refused'; commandCount: number; rawBytes: number; rawHash: string; effects: EffectPrefix;
}
export interface FixtureNamespaceOptions {
  outputRoot: string; namespaceId: string; sourceRoot: string; sourcePins: readonly SourcePin[];
  catalogs: readonly CatalogAdmission[]; limits?: Readonly<NamespaceLimits>;
}

function safeRelative(file: string): boolean {
  return !!file && !path.isAbsolute(file) && path.normalize(file) === file
    && !file.split(/[\\/]/).some(part => part === '..' || part === '.' || !part);
}
function safeOutput(directory: string): string {
  const absolute = path.resolve(directory);
  const forbidden = absolute.split(path.sep).some(part => {
    const name = part.toLowerCase();
    return name.startsWith('.learning-loop') || name === 'bot-artifacts' || name === '.bot-artifacts'
      || name === 'store' || name === 'shuttle-archive' || name === '.git' || /^cycle-\d+$/.test(name);
  });
  if (forbidden || absolute === path.parse(absolute).root) throw new Error('Protected namespace output path');
  const parent = path.dirname(absolute);
  if (fs.realpathSync(parent) !== parent || !fs.statSync(parent).isDirectory())
    throw new Error('Namespace output cannot traverse symlinks');
  if (fs.existsSync(absolute))
    throw new Error('Namespace output must be exclusive and new');
  // existsSync follows dangling symlinks; lstat also rejects that case.
  try { fs.lstatSync(absolute); throw new Error('Namespace output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return absolute;
}
function sourcePins(sourceRoot: string, pins: readonly SourcePin[], limits: Readonly<NamespaceLimits>): SourcePin[] {
  if (fs.realpathSync(sourceRoot) !== sourceRoot || !pins.length) throw new Error('Missing canonical source inventory');
  const result = pins.map(pin => ({ ...pin })).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  let total = 0;
  for (const [index, pin] of result.entries()) {
    if (!safeRelative(pin.file) || !clock(pin.bytes) || !hash(pin.sha256) || result[index - 1]?.file === pin.file)
      throw new Error('Invalid source pin');
    const file = path.join(sourceRoot, pin.file), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.size !== pin.bytes)
      throw new Error('Source pin path or size changed');
    total += stat.size + 1; // Reserve the bounded EOF probe before each source read.
    if (total > limits.maxSourceBytes) throw new Error('Source inventory read cap exceeded');
    const bytes = readBoundedFile(file, pin.bytes);
    if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Source pin bytes changed');
  }
  return result;
}
function validateLimits(limits: Readonly<NamespaceLimits>): void {
  const keys = Object.keys(DEFAULT_NAMESPACE_LIMITS) as (keyof NamespaceLimits)[];
  if (Object.keys(limits).length !== keys.length || keys.some(key => !Number.isSafeInteger(limits[key]) || limits[key] <= 0))
    throw new Error('Invalid fixed namespace admission limits');
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error('Incomplete namespace write');
    offset += written;
  }
}
function durableFile(file: string, bytes: Uint8Array): void {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const encoded = (value: unknown): Buffer => Buffer.from(canonicalJSON(value) + '\n');

export function effectValues(kind: NamespaceCommand['kind'], result: unknown): { events: unknown[]; outcomes: unknown[] } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Missing exact derived result');
  const value = result as Record<string, unknown>;
  if (value.kind !== kind && !(kind === 'ingest' && value.kind === 'ingress-refused'))
    throw new Error('Derived result wrapper does not match command');
  if (value.kind === 'ingress-refused' && !['http-error', 'malformed-packet', 'packet-capacity'].includes(String(value.error)))
    throw new Error('Missing explicit ingress refusal');
  if (!value.update || typeof value.update !== 'object' || Array.isArray(value.update)) throw new Error('Missing derived public method update');
  const update = value.update as Record<string, unknown>;
  if (kind === 'enroll') {
    if (!Array.isArray(update.events)) throw new Error('Enrollment result must retain transitions');
    return { events: [], outcomes: update.events };
  }
  if (!Array.isArray(update.encounterEvents) || !Array.isArray(update.outcomes)) throw new Error('Raw update must retain events and outcomes');
  return { events: update.encounterEvents, outcomes: update.outcomes };
}
export function extendEffects(previous: EffectPrefix, commandHash: string, kind: NamespaceCommand['kind'], result: unknown): EffectPrefix {
  const values = effectValues(kind, result), next = { ...previous };
  for (const [index, value] of values.events.entries()) {
    next.eventHead = sha256(canonicalJSON({ v: 1, kind: 'event', previousHash: next.eventHead, commandHash, index, value }));
    next.eventCount++;
  }
  for (const [index, value] of values.outcomes.entries()) {
    next.outcomeHead = sha256(canonicalJSON({ v: 1, kind: 'outcome', previousHash: next.outcomeHead, commandHash, index, value }));
    next.outcomeCount++;
  }
  return next;
}

/** Fixture-only durable custody. There is deliberately no writable reopen API. */
export class NamespaceWriter {
  readonly manifest: Readonly<NamespaceManifest>;
  readonly manifestHash: string;
  readonly directory: string;
  private readonly directoryFd: number;
  private readonly rawFd: number;
  private readonly journalFd: number;
  private readonly directoryIdentity: { dev: number; ino: number };
  private readonly fixedBytes: number;
  private readonly rawDigest = createHash('sha256');
  private rawBytes = 0;
  private journalBytes = 0;
  private checkpointBytes = 0;
  private sequence = 0;
  private commandCount = 0;
  private head: string;
  private effects: EffectPrefix;
  private lastActualAt: number;
  private lastSimulationAt = 0;
  private pending: { ref: CommandRef; command: PersistedCommand } | null = null;
  private closed = false;
  private failed = false;
  private requiresRefusedClose = false;

  /** Use createFixtureNamespace so filesystem admission precedes any write. */
  constructor(options: FixtureNamespaceOptions) {
    const limits = { ...(options.limits ?? DEFAULT_NAMESPACE_LIMITS) }; validateLimits(limits);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.namespaceId) || /^cycle-/i.test(options.namespaceId))
      throw new Error('Existing trial or malformed namespace ID');
    this.directory = safeOutput(options.outputRoot);
    const root = path.resolve(options.sourceRoot), pins = sourcePins(root, options.sourcePins, limits);
    const catalogs = structuredClone([...options.catalogs]).sort((a, b) => a.spec.routeId - b.spec.routeId);
    if (!catalogs.length || catalogs.some((value, index) => !hash(value.compiledCatalogHash)
      || !Number.isSafeInteger(value.spec.routeId) || catalogs[index - 1]?.spec.routeId === value.spec.routeId))
      throw new Error('Missing independent catalog admissions');
    const createdAt = Date.now(); if (!clock(createdAt)) throw new Error('Invalid actual namespace creation clock');
    const manifest: NamespaceManifest = { v: 1, kind: 'independent-encounter-fixture', namespaceId: options.namespaceId,
      fixtureMode: true, prospectiveCutoff: null, publicationCapability: false, restartPolicy: 'new-namespace-only',
      createdAt, protocolHash: PROTOCOL_SHA256, sourceRoot: root, sourcePins: pins,
      sourceInventoryHash: sha256(canonicalJSON(pins)), catalogs, limits };
    const manifestBytes = encoded(manifest), lockBytes = encoded({ v: 1, namespaceId: options.namespaceId,
      token: randomUUID(), pid: process.pid, createdAt });
    this.fixedBytes = manifestBytes.byteLength + lockBytes.byteLength;
    if (this.fixedBytes > limits.maxTotalBytes) throw new Error('Namespace manifest admission cap exceeded');
    fs.mkdirSync(this.directory, { mode: 0o700 });
    this.directoryFd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const identity = fs.fstatSync(this.directoryFd); this.directoryIdentity = { dev: identity.dev, ino: identity.ino };
    let rawFd: number | null = null, journalFd: number | null = null;
    try {
      durableFile(path.join(this.directory, 'manifest.json'), manifestBytes);
      durableFile(path.join(this.directory, 'writer.lock'), lockBytes);
      rawFd = fs.openSync(path.join(this.directory, 'raw.bin'), fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      journalFd = fs.openSync(path.join(this.directory, 'journal.jsonl'), fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      fs.fsyncSync(rawFd); fs.fsyncSync(journalFd); fs.fsyncSync(this.directoryFd);
    } catch (error) {
      if (rawFd !== null) fs.closeSync(rawFd);
      if (journalFd !== null) fs.closeSync(journalFd);
      fs.closeSync(this.directoryFd); throw error;
    }
    this.rawFd = rawFd; this.journalFd = journalFd;
    this.manifest = deepFreeze(manifest); this.manifestHash = sha256(manifestBytes);
    this.head = this.manifestHash; this.lastActualAt = createdAt;
    this.effects = { eventCount: 0, eventHead: this.manifestHash, outcomeCount: 0, outcomeHead: this.manifestHash };
  }

  private ready(): void {
    if (this.closed || this.failed) throw new Error('Namespace is closed or requires a new namespace');
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.directoryIdentity.dev
      || stat.ino !== this.directoryIdentity.ino || fs.realpathSync(this.directory) !== this.directory)
      throw new Error('Namespace directory identity changed');
    for (const [file, fd, bytes] of [['raw.bin', this.rawFd, this.rawBytes], ['journal.jsonl', this.journalFd, this.journalBytes]] as const) {
      const current = fs.lstatSync(path.join(this.directory, file)), open = fs.fstatSync(fd);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== open.dev
        || current.ino !== open.ino || current.size !== bytes) throw new Error('Namespace append prefix changed');
    }
  }
  private actualClock(): number {
    const at = Date.now();
    if (!clock(at) || at < this.lastActualAt) throw new Error('Actual namespace consumer clock regressed');
    return at;
  }
  private record<Body>(kind: JournalRecord['kind'], body: Body, at: number): { row: JournalRecord<Body>; bytes: Buffer } {
    const value = { v: 1 as const, namespaceId: this.manifest.namespaceId, manifestHash: this.manifestHash,
      seq: this.sequence + 1, previousHash: this.head, kind, actualConsumerReadAt: at, body };
    const row = { ...value, hash: sha256(canonicalJSON(value)) };
    return { row, bytes: encoded(row) };
  }
  private admit(bytes: number, extraRaw = 0, extraCheckpoint = 0): void {
    const l = this.manifest.limits;
    if (bytes > l.maxRecordBytes || this.sequence + 1 > l.maxRecords
      || this.journalBytes + bytes > l.maxJournalBytes || this.rawBytes + extraRaw > l.maxRawBytes
      || this.checkpointBytes + extraCheckpoint > l.maxCheckpointBytes
      || this.fixedBytes + this.rawBytes + extraRaw + this.journalBytes + bytes + this.checkpointBytes + extraCheckpoint > l.maxTotalBytes)
      throw new Error('Fixed namespace admission cap exceeded');
  }
  private append(row: JournalRecord, bytes: Uint8Array): CommandRef {
    writeAll(this.journalFd, bytes); fs.fsyncSync(this.journalFd);
    this.journalBytes += bytes.byteLength; this.sequence = row.seq; this.head = row.hash; this.lastActualAt = row.actualConsumerReadAt;
    return { seq: row.seq, hash: row.hash };
  }

  /** The raw bytes and command prefix are durable before this method returns;
   * projection/engine calls must occur only after this admission receipt. */
  appendCommand(command: NamespaceCommand, rawBytes?: Uint8Array): CommandRef {
    this.ready();
    if (this.requiresRefusedClose) throw new Error('Ingress refusal permits only close refused');
    if (this.pending) throw new Error('Outstanding command needs one derived commit');
    if (!clock(command.availableAt) || command.availableAt < this.lastSimulationAt) throw new Error('Regressing fixture simulation clock');
    if (this.commandCount + 1 > this.manifest.limits.maxCommands) throw new Error('Fixed namespace command cap exceeded');
    let persisted: PersistedCommand;
    if (command.kind === 'ingest') {
      if (!(rawBytes instanceof Uint8Array) || !clock(command.originalReceivedAt) || command.originalReceivedAt > command.availableAt
        || !Number.isSafeInteger(command.status) || command.status < 100 || command.status > 599
        || !['historical-frame', 'public-current'].includes(command.origin)) throw new Error('Invalid raw command admission');
      persisted = { kind: 'ingest', availableAt: command.availableAt, originalReceivedAt: command.originalReceivedAt,
        status: command.status, origin: command.origin,
        raw: { file: 'raw.bin', offset: this.rawBytes, bytes: rawBytes.byteLength, sha256: sha256(rawBytes) } };
    } else {
      if (rawBytes !== undefined || (command.kind !== 'tick' && command.kind !== 'enroll')) throw new Error('Unexpected command raw bytes');
      persisted = command.kind === 'tick' ? { kind: 'tick', availableAt: command.availableAt }
        : { kind: 'enroll', availableAt: command.availableAt, opportunity: structuredClone(command.opportunity) };
    }
    const entry = this.record<CommandBody>('command', { command: persisted }, this.actualClock());
    this.admit(entry.bytes.byteLength, rawBytes?.byteLength ?? 0);
    try {
      if (rawBytes !== undefined) {
        writeAll(this.rawFd, rawBytes); fs.fsyncSync(this.rawFd);
        this.rawDigest.update(rawBytes); this.rawBytes += rawBytes.byteLength;
      }
      const ref = this.append(entry.row, entry.bytes);
      this.commandCount++; this.lastSimulationAt = command.availableAt; this.pending = { ref, command: persisted };
      return { ...ref };
    } catch (error) { this.failed = true; throw error; }
  }

  appendDerived(ref: CommandRef, value: { result: unknown; snapshot: unknown; checkpoint?: boolean }): CommandRef {
    this.ready();
    if (!this.pending || ref.seq !== this.pending.ref.seq || ref.hash !== this.pending.ref.hash)
      throw new Error('Derived result does not own the outstanding command');
    const snapshotHash = sha256(canonicalJSON(value.snapshot));
    const effects = extendEffects(this.effects, ref.hash, this.pending.command.kind, value.result);
    const refused = (value.result as { kind: string }).kind === 'ingress-refused';
    if (this.pending.command.kind === 'ingest' && this.pending.command.status !== 200 && !refused)
      throw new Error('Failed HTTP input requires an explicit ingress refusal');
    let checkpoint: CheckpointRef | null = null, checkpointBytes: Buffer | null = null;
    if (value.checkpoint === true) {
      const contents: CheckpointFile = { v: 1, namespaceId: this.manifest.namespaceId, manifestHash: this.manifestHash,
        commandRef: { ...ref }, rawPrefix: { bytes: this.rawBytes, sha256: this.rawDigest.copy().digest('hex') },
        snapshotHash, snapshot: value.snapshot };
      checkpointBytes = encoded(contents);
      checkpoint = { file: `checkpoint-${ref.seq}.json`, bytes: checkpointBytes.byteLength, sha256: sha256(checkpointBytes) };
    }
    const body: DerivedBody = { commandRef: { ...ref }, result: value.result, snapshotHash, checkpoint, effects };
    const entry = this.record('derived', body, this.actualClock());
    try {
      this.admit(entry.bytes.byteLength, 0, checkpointBytes?.byteLength ?? 0);
      if (checkpoint && checkpointBytes) {
        durableFile(path.join(this.directory, checkpoint.file), checkpointBytes); fs.fsyncSync(this.directoryFd);
        this.checkpointBytes += checkpointBytes.byteLength;
      }
      const derivedRef = this.append(entry.row, entry.bytes);
      this.effects = effects; this.pending = null; this.requiresRefusedClose = refused;
      return derivedRef;
    } catch (error) { this.failed = true; throw error; }
  }

  close(reason: CloseBody['reason'] = 'completed'): CommandRef {
    this.ready();
    if (this.pending) throw new Error('Cannot close an incomplete command prefix');
    if (reason !== 'completed' && reason !== 'refused') throw new Error('Invalid namespace closure');
    if (this.requiresRefusedClose && reason !== 'refused') throw new Error('Ingress refusal requires close refused');
    const body: CloseBody = { reason, commandCount: this.commandCount, rawBytes: this.rawBytes,
      rawHash: this.rawDigest.copy().digest('hex'), effects: { ...this.effects } };
    const entry = this.record('close', body, this.actualClock());
    try { this.admit(entry.bytes.byteLength); const ref = this.append(entry.row, entry.bytes); this.abandon(); return ref; }
    catch (error) { this.failed = true; throw error; }
  }
  /** Preserve an interrupted prefix; never truncate, recover or reopen it. */
  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.rawFd); fs.closeSync(this.journalFd); fs.closeSync(this.directoryFd);
  }
  prefix(): CommandRef { return { seq: this.sequence, hash: this.head }; }
}

export const createFixtureNamespace = (options: FixtureNamespaceOptions): NamespaceWriter => new NamespaceWriter(options);
/** Prospective admission needs independently verified qualification and a real
 * cutoff. This fixture-only stage cannot turn metadata into that capability. */
export function createProspectiveNamespace(_options: unknown): never {
  throw new Error('Prospective namespace admission is unavailable; fixture custody only');
}
export function openNamespace(_directory: string): never {
  throw new Error('Writable resume is unavailable; preserve the prefix and create a new namespace with censored continuity');
}
