import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJSON, sha256 } from './canonical.js';
import { compileCatalog } from './catalog.js';
import { EncounterEngine } from './engine.js';
import type { EngineSnapshot, EngineUpdate } from './engine.js';
import { PROTOCOL_SHA256 } from './protocol.js';
import { stripRawExchange } from './raw-ingress.js';
import type { OpportunityUpdate } from './enrollment.js';
import type { RouteCatalogSpec } from './types.js';
import type {
  CheckpointFile, CloseBody, CommandBody, CommandRef, DerivedBody, EffectPrefix,
  JournalRecord, NamespaceLimits, NamespaceManifest, PersistedCommand,
} from './namespace.js';

const MiB = 1024 * 1024;
const LIMIT_KEYS: readonly (keyof NamespaceLimits)[] = ['maxRawBytes', 'maxJournalBytes', 'maxCheckpointBytes',
  'maxTotalBytes', 'maxCommands', 'maxRecords', 'maxRecordBytes', 'maxSourceBytes'];
export interface VerificationLimits {
  maxReadBytes: number; maxManifestBytes: number; maxRawBytes: number; maxJournalBytes: number;
  maxCheckpointBytes: number; maxNamespaceBytes: number; maxRecordBytes: number;
  maxSourceBytes: number; maxSourceFiles: number; maxCommands: number; maxRecords: number; maxWallMs: number;
}
export const DEFAULT_VERIFICATION_LIMITS: Readonly<VerificationLimits> = Object.freeze({
  maxReadBytes: 64 * MiB, maxManifestBytes: MiB, maxRawBytes: 16 * MiB, maxJournalBytes: 16 * MiB,
  maxCheckpointBytes: 4 * MiB, maxNamespaceBytes: 40 * MiB, maxRecordBytes: MiB,
  maxSourceBytes: 4 * MiB, maxSourceFiles: 512, maxCommands: 10000, maxRecords: 20001, maxWallMs: 30000,
});
export interface VerificationOptions {
  /** Trusted pins retained OUTSIDE the namespace being checked. */
  manifestHash: string;
  expectedPrefix: CommandRef;
  sourceInventoryHash: string;
  sourceRoot?: string;
  limits?: Partial<VerificationLimits>;
}
export interface FixtureNamespaceVerificationOptions {
  directory: string;
  expectedManifestHash: string;
  expectedPrefix: CommandRef;
  expectedSourceInventoryHash: string;
  sourceRoot?: string;
  limits?: Partial<VerificationLimits>;
}
export interface VerifiedFile {
  file: string; bytes: number; sha256: string;
  identity: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
}
export interface VerificationReport {
  v: 1;
  verified: true; completed: boolean; refused: boolean;
  scope: 'fixture-custody-and-deterministic-R3-reproducibility-only';
  namespaceId: string; fixtureMode: true; prospectiveQualified: false; physicalServiceTruth: false;
  manifestHash: string; sourceInventoryHash: string; protocolHash: string; prefix: CommandRef;
  closeReason: CloseBody['reason']; commands: number; rawBytes: number; rawHash: string;
  effects: EffectPrefix; snapshotHash: string; checkpointFiles: number;
  events: number; outcomes: number;
  checkpointStates: { file: string; commandRef: CommandRef; snapshotHash: string; rawPrefix: { bytes: number; sha256: string } }[];
  actualClocks: { createdAt: number; lastConsumerReadAt: number; verifiedAt: number };
  fixtureClocks: { firstAvailableAt: number | null; lastAvailableAt: number | null };
  readBytes: number; sourceBytes: number; elapsedMs: number; files: VerifiedFile[];
}

export class NamespaceVerificationError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'NamespaceVerificationError'; }
}
function need(value: unknown, code: string, detail: string): asserts value {
  if (!value) throw new NamespaceVerificationError(code, detail);
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digestJSON = (value: unknown): string => sha256(canonicalJSON(value));
const equalJSON = (left: unknown, right: unknown): boolean => canonicalJSON(left) === canonicalJSON(right);
function safeRelative(file: unknown): file is string {
  return typeof file === 'string' && !!file && file.length <= 1024 && !file.includes('\\')
    && !path.isAbsolute(file) && path.normalize(file) === file
    && !file.split('/').some(part => !part || part === '.' || part === '..');
}
function protectedPath(file: string): boolean {
  return file.split(path.sep).some(part => /^cycle-/i.test(part) || part.startsWith('.learning-loop')
    || ['.git', 'store', 'shuttle-archive', 'bot-artifacts', '.bot-artifacts'].includes(part));
}
function identity(stat: fs.BigIntStats) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
const sameIdentity = (a: fs.BigIntStats, b: fs.BigIntStats) => equalJSON(identity(a), identity(b))
  && a.mode === b.mode && a.nlink === b.nlink;

class ReadBudget {
  readonly startedAt = process.hrtime.bigint();
  bytes = 0;
  readonly files: TrackedFile[] = [];
  constructor(readonly limits: Readonly<VerificationLimits>) {}
  guard(extra = 0): void {
    need(this.bytes + extra <= this.limits.maxReadBytes, 'read-cap', 'Aggregate read admission exceeded');
    need(Number(process.hrtime.bigint() - this.startedAt) / 1e6 <= this.limits.maxWallMs,
      'time-cap', 'Verification wall deadline exceeded');
  }
  open(file: string, maximum: number): TrackedFile {
    this.guard();
    const opened = new TrackedFile(file, maximum, this); this.files.push(opened); return opened;
  }
  finish(): VerifiedFile[] {
    this.guard();
    return this.files.map(file => file.verify());
  }
  close(): void { for (const file of this.files) file.close(); }
}

/** Every byte is read through a nofollow FD, bounded and hashed to natural EOF.
 * Later path checks also detect writes after a small source/checkpoint FD closes. */
class TrackedFile {
  readonly before: fs.BigIntStats;
  readonly fd: number;
  readonly digest = createHash('sha256');
  position = 0;
  eof = false;
  private closed = false;
  constructor(readonly file: string, maximum: number, readonly budget: ReadBudget) {
    const stat = fs.lstatSync(file, { bigint: true });
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'file-type', 'Ordinary single-link file required: ' + file);
    need(stat.size <= BigInt(maximum), 'file-cap', 'File exceeds fixed admission: ' + file);
    need(fs.realpathSync(file) === file, 'path-alias', 'File path traverses a symlink: ' + file);
    this.fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    this.before = stat;
    try { need(sameIdentity(stat, fs.fstatSync(this.fd, { bigint: true })), 'fd-identity', 'File changed while opening'); }
    catch (error) { fs.closeSync(this.fd); throw error; }
  }
  chunk(maximum: number): Buffer {
    const remaining = Number(this.before.size) - this.position;
    const readLength = Math.min(maximum, Math.max(1, remaining));
    // Reserve the EOF probe too: a file that grows after admission must not
    // consume even one byte beyond the aggregate read cap before refusal.
    this.budget.guard(readLength);
    const buffer = Buffer.alloc(readLength);
    const count = fs.readSync(this.fd, buffer, 0, buffer.length, null);
    this.budget.bytes += count; this.budget.guard();
    if (count === 0) { this.eof = true; return Buffer.alloc(0); }
    need(this.position + count <= Number(this.before.size), 'file-growth', 'File grew during verification');
    const value = buffer.subarray(0, count); this.position += count; this.digest.update(value); return value;
  }
  exact(bytes: number): Buffer {
    need(integer(bytes), 'raw-length', 'Invalid exact byte count');
    const parts: Buffer[] = []; let length = 0;
    while (length < bytes) {
      const part = this.chunk(Math.min(64 * 1024, bytes - length));
      need(part.length > 0, 'early-eof', 'File ended inside a declared byte range');
      parts.push(part); length += part.length;
    }
    return Buffer.concat(parts, bytes);
  }
  all(): Buffer {
    const bytes = this.exact(Number(this.before.size));
    need(this.chunk(1).length === 0, 'file-eof', 'File does not end at declared extent'); return bytes;
  }
  *lines(maximum: number): Generator<Buffer> {
    let parts: Buffer[] = [], length = 0;
    for (;;) {
      const chunk = this.chunk(64 * 1024);
      if (!chunk.length) break;
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        if (end < 0) {
          const part = chunk.subarray(start); length += part.length;
          need(length < maximum, 'record-cap', 'Journal record exceeds fixed admission including LF');
          if (part.length) parts.push(part); break;
        }
        const part = chunk.subarray(start, end); length += part.length;
        need(length > 0 && length + 1 <= maximum, 'record-cap', 'Empty or oversized journal record including LF');
        parts.push(part); yield Buffer.concat(parts, length); parts = []; length = 0; start = end + 1;
      }
    }
    need(length === 0, 'partial-last-record', 'Journal has an incomplete final JSONL record');
  }
  verify(): VerifiedFile {
    need(this.eof && this.position === Number(this.before.size), 'incomplete-read', 'File was not read to natural EOF: ' + this.file);
    if (!this.closed) need(sameIdentity(this.before, fs.fstatSync(this.fd, { bigint: true })), 'fd-identity', 'Open file changed');
    const after = fs.lstatSync(this.file, { bigint: true });
    need(after.isFile() && !after.isSymbolicLink() && fs.realpathSync(this.file) === this.file
      && sameIdentity(this.before, after), 'file-identity', 'File path/bytes changed during verification');
    return { file: this.file, bytes: this.position, sha256: this.digest.copy().digest('hex'), identity: identity(this.before) };
  }
  close(): void { if (!this.closed) { fs.closeSync(this.fd); this.closed = true; } }
}

function canonicalBytes(bytes: Buffer, newline: boolean): unknown {
  let value: unknown, expected: Buffer;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text); expected = Buffer.from(canonicalJSON(value) + (newline ? '\n' : ''));
  } catch { throw new NamespaceVerificationError('canonical-bytes', 'Invalid canonical UTF-8 JSON'); }
  // Compare original bytes as well: a decoder may otherwise consume a BOM.
  need(bytes.equals(expected), 'canonical-bytes', 'Committed JSON bytes are not canonical');
  return value;
}
function declaredLimits(value: unknown): asserts value is NamespaceLimits {
  need(object(value) && Object.keys(value).length === LIMIT_KEYS.length
    && LIMIT_KEYS.every(key => integer(value[key]) && (value[key] as number) > 0), 'manifest-limits', 'Invalid fixed namespace limits');
}

type ReplayResult = { kind: 'ingest' | 'tick' | 'ingress-refused'; update: EngineUpdate; error?: string }
  | { kind: 'enroll'; update: OpportunityUpdate };
function effectsFor(result: ReplayResult): { events: readonly unknown[]; outcomes: readonly unknown[] } {
  return result.kind === 'enroll' ? { events: [], outcomes: result.update.events }
    : { events: result.update.encounterEvents, outcomes: result.update.outcomes };
}
function extendEffects(previous: EffectPrefix, commandHash: string, result: ReplayResult): EffectPrefix {
  const next = { ...previous }, values = effectsFor(result);
  for (const [index, value] of values.events.entries()) {
    next.eventHead = digestJSON({ v: 1, kind: 'event', previousHash: next.eventHead, commandHash, index, value }); next.eventCount++;
  }
  for (const [index, value] of values.outcomes.entries()) {
    next.outcomeHead = digestJSON({ v: 1, kind: 'outcome', previousHash: next.outcomeHead, commandHash, index, value }); next.outcomeCount++;
  }
  return next;
}

/** Additional protocol invariant, independent of the replayed Engine result:
 * a previously terminal enrollment/encounter cannot change or disappear. */
function checkTerminals(snapshot: EngineSnapshot, remembered: Map<string, string>): void {
  const current = new Map<string, string>();
  for (const [id, value] of Object.entries(snapshot.enrollments.records)) if (value.status !== 'open')
    current.set('enrollment:' + id, canonicalJSON(value));
  for (const [vehicle, state] of Object.entries(snapshot.vehicles)) for (const [id, value] of Object.entries(state.encounters.records))
    if (value.kind !== 'candidate') current.set('encounter:' + vehicle + ':' + id, canonicalJSON(value));
  for (const [key, prior] of remembered) need(current.get(key) === prior, 'terminal-reopen', 'Terminal state changed or disappeared: ' + key);
  for (const [key, value] of current) remembered.set(key, value);
}

/** Read-only verifier. The three external pins are mandatory; namespace
 * metadata cannot certify itself as prospective, physically true or qualified. */
export function verifyNamespace(directory: string, options: VerificationOptions): VerificationReport {
  const limits = { ...DEFAULT_VERIFICATION_LIMITS, ...options.limits };
  need(Object.keys(limits).length === Object.keys(DEFAULT_VERIFICATION_LIMITS).length
    && Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0), 'verification-limits', 'Invalid verifier read admission');
  need(hash(options.manifestHash) && hash(options.sourceInventoryHash) && integer(options.expectedPrefix?.seq)
    && options.expectedPrefix.seq > 0 && hash(options.expectedPrefix.hash), 'external-pin', 'Trusted external manifest/source/prefix pins are required');
  const root = path.resolve(directory), verifiedAt = Date.now();
  need(root !== path.parse(root).root && fs.realpathSync(root) === root, 'namespace-path', 'Canonical exclusive namespace path required');
  need(!protectedPath(root), 'namespace-path', 'Protected namespace path');
  const rootBefore = fs.lstatSync(root, { bigint: true });
  need(rootBefore.isDirectory() && !rootBefore.isSymbolicLink(), 'namespace-path', 'Namespace directory required');
  const budget = new ReadBudget(limits);
  let sourceBytes = 0, checkpointBytes = 0, checkpoints = 0;
  try {
    const manifestFile = budget.open(path.join(root, 'manifest.json'), limits.maxManifestBytes);
    const manifestBytes = manifestFile.all();
    need(sha256(manifestBytes) === options.manifestHash, 'manifest-hash', 'Manifest does not match external pin');
    const manifest = canonicalBytes(manifestBytes, true) as NamespaceManifest;
    need(object(manifest) && manifest.v === 1 && manifest.kind === 'independent-encounter-fixture'
      && manifest.fixtureMode === true && manifest.prospectiveCutoff === null && manifest.publicationCapability === false
      && manifest.restartPolicy === 'new-namespace-only', 'fixture-mode', 'Only an explicit fixture-only namespace can be verified');
    need(typeof manifest.namespaceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.namespaceId)
      && !/^cycle-/i.test(manifest.namespaceId), 'namespace-id', 'Invalid or original-trial namespace identity');
    need(integer(manifest.createdAt) && manifest.createdAt <= verifiedAt, 'actual-clock', 'Invalid actual namespace creation time');
    need(manifest.protocolHash === PROTOCOL_SHA256, 'protocol-pin', 'Frozen R3 protocol differs');
    declaredLimits(manifest.limits);
    need(Array.isArray(manifest.sourcePins) && manifest.sourcePins.length > 0 && manifest.sourcePins.length <= limits.maxSourceFiles
      && manifest.sourceInventoryHash === options.sourceInventoryHash
      && digestJSON(manifest.sourcePins) === manifest.sourceInventoryHash, 'source-inventory', 'Source inventory is not externally pinned');
    need(typeof manifest.sourceRoot === 'string' && path.resolve(manifest.sourceRoot) === manifest.sourceRoot
      && !protectedPath(manifest.sourceRoot) && fs.realpathSync(manifest.sourceRoot) === manifest.sourceRoot,
    'source-root', 'Canonical unprotected source root required');
    need(options.sourceRoot === undefined || path.resolve(options.sourceRoot) === manifest.sourceRoot,
      'source-root', 'Manifest source root differs from external source admission');
    let previousSource = '';
    for (const pin of manifest.sourcePins) {
      need(object(pin) && safeRelative(pin.file) && pin.file > previousSource && integer(pin.bytes) && hash(pin.sha256),
        'source-pin', 'Source pins must be unique, ordered safe relative files');
      need(!protectedPath(path.join(manifest.sourceRoot, pin.file)), 'source-pin', 'Protected original source/runtime path');
      previousSource = pin.file; sourceBytes += pin.bytes;
      need(sourceBytes <= Math.min(limits.maxSourceBytes, manifest.limits.maxSourceBytes), 'source-cap', 'Source inventory byte admission exceeded');
      const source = budget.open(path.join(manifest.sourceRoot, pin.file), pin.bytes);
      const raw = source.all();
      need(raw.length === pin.bytes && sha256(raw) === pin.sha256, 'source-pin', 'Source bytes differ: ' + pin.file); source.verify(); source.close();
    }
    need(Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0 && manifest.catalogs.length <= 64,
      'catalog', 'Finite explicit catalog admissions required');
    const routes = new Set<number>();
    const catalogs = manifest.catalogs.map(admission => {
      budget.guard(); need(object(admission) && hash(admission.compiledCatalogHash), 'catalog', 'Invalid catalog hash admission');
      const spec = admission.spec;
      need(object(spec) && spec.v === 1 && integer(spec.routeId) && hash(spec.sourceTopologyHash)
        && typeof spec.pathProvenance === 'string' && Array.isArray(spec.path)
        && Array.isArray(spec.publishedStops) && object(spec.stopCoords) && Array.isArray(spec.calls),
      'catalog', 'Invalid raw catalog shape');
      // The compiler validates every point, original occurrence, call and mask
      // before computing geometry. Parsed JSON remains unknown until this
      // structural boundary; the cast does not replace the compiler's checks.
      const compiled = compileCatalog(spec as unknown as RouteCatalogSpec);
      need(!routes.has(compiled.routeId) && compiled.catalogHash === admission.compiledCatalogHash,
        'catalog-hash', 'Compiled raw catalog differs from immutable admission'); routes.add(compiled.routeId); return compiled;
    });
    const inventory = new Map<string, fs.BigIntStats>(); let namespaceBytes = 0;
    for (const name of fs.readdirSync(root)) {
      need(['manifest.json', 'writer.lock', 'raw.bin', 'journal.jsonl'].includes(name) || /^checkpoint-[1-9]\d*\.json$/.test(name),
        'namespace-files', 'Unknown/uncommitted namespace file: ' + name);
      const stat = fs.lstatSync(path.join(root, name), { bigint: true });
      need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'file-type', 'Unexpected namespace file type');
      inventory.set(name, stat); namespaceBytes += Number(stat.size);
    }
    need(namespaceBytes <= Math.min(limits.maxNamespaceBytes, manifest.limits.maxTotalBytes), 'namespace-cap', 'Namespace total byte admission exceeded');
    const lock = canonicalBytes(budget.open(path.join(root, 'writer.lock'), limits.maxManifestBytes).all(), true) as Record<string, unknown>;
    need(object(lock) && lock.v === 1 && lock.namespaceId === manifest.namespaceId && lock.createdAt === manifest.createdAt
      && integer(lock.pid) && lock.pid > 0 && typeof lock.token === 'string'
      && /^[a-f0-9-]{36}$/.test(lock.token), 'writer-lock', 'Writer identity/actual creation record differs');
    const rawFile = budget.open(path.join(root, 'raw.bin'), Math.min(limits.maxRawBytes, manifest.limits.maxRawBytes));
    const journal = budget.open(path.join(root, 'journal.jsonl'), Math.min(limits.maxJournalBytes, manifest.limits.maxJournalBytes));
    const engine = new EncounterEngine({ namespaceId: manifest.namespaceId, catalogs, fixtureMode: true, prospectiveCutoff: null });
    let prefix: CommandRef = { seq: 0, hash: options.manifestHash };
    let actualAt = manifest.createdAt, replayAt: number | null = null, firstReplayAt: number | null = null;
    let effects: EffectPrefix = { eventCount: 0, eventHead: options.manifestHash, outcomeCount: 0, outcomeHead: options.manifestHash };
    let commandCount = 0, rawConsumed = 0, closed: CloseBody | null = null, refused = false;
    const referencedCheckpoints = new Set<string>(), terminals = new Map<string, string>();
    const checkpointStates: VerificationReport['checkpointStates'] = [];
    let pending: { ref: CommandRef; command: PersistedCommand; result: ReplayResult; snapshot: EngineSnapshot } | null = null;
    for (const line of journal.lines(Math.min(limits.maxRecordBytes, manifest.limits.maxRecordBytes))) {
      budget.guard(); need(!closed, 'closed-prefix', 'Journal extends an already closed namespace');
      const row = canonicalBytes(line, false) as JournalRecord;
      need(object(row) && row.v === 1 && row.namespaceId === manifest.namespaceId && row.manifestHash === options.manifestHash
        && row.seq === prefix.seq + 1 && row.previousHash === prefix.hash && hash(row.hash), 'sequence', 'Journal sequence/previous prefix differs');
      need(row.seq <= Math.min(limits.maxRecords, manifest.limits.maxRecords), 'record-cap', 'Journal record count admission exceeded');
      const { hash: _hash, ...bodyForHash } = row;
      need(digestJSON(bodyForHash) === row.hash, 'journal-hash', 'Journal record bytes/hash differ');
      need(integer(row.actualConsumerReadAt) && row.actualConsumerReadAt >= actualAt && row.actualConsumerReadAt <= verifiedAt,
        'actual-clock', 'Actual consumer clocks regressed, predate creation or lie in the future');
      actualAt = row.actualConsumerReadAt; prefix = { seq: row.seq, hash: row.hash };
      if (row.kind === 'command') {
        need(!pending && !refused, 'command-order', 'Outstanding/refused command cannot accept another command');
        need(object(row.body) && object((row.body as unknown as CommandBody).command), 'command', 'Missing command body');
        const command = (row.body as unknown as CommandBody).command;
        need(integer(command.availableAt) && (replayAt === null || command.availableAt >= replayAt), 'consumer-clock', 'Fixture consumer clock regressed');
        replayAt = command.availableAt; firstReplayAt ??= replayAt;
        need(++commandCount <= Math.min(limits.maxCommands, manifest.limits.maxCommands), 'command-cap', 'Command count admission exceeded');
        let result: ReplayResult;
        if (command.kind === 'ingest') {
          need(object(command.raw) && command.raw.file === 'raw.bin' && command.raw.offset === rawConsumed
            && integer(command.raw.bytes) && command.raw.bytes <= Math.min(limits.maxRawBytes, manifest.limits.maxRawBytes)
            && hash(command.raw.sha256), 'raw-reference', 'Raw offsets must be contiguous and bounded');
          need(integer(command.originalReceivedAt) && command.originalReceivedAt <= command.availableAt
            && Number.isSafeInteger(command.status) && command.status >= 100 && command.status <= 599
            && ['historical-frame', 'public-current'].includes(command.origin), 'raw-command', 'Invalid source clocks/status/origin');
          const bytes = rawFile.exact(command.raw.bytes); rawConsumed += bytes.length;
          need(sha256(bytes) === command.raw.sha256, 'raw-hash', 'Retained raw bytes differ from command pin');
          const stripped = stripRawExchange(bytes, command.status, { originalReceivedAt: command.originalReceivedAt,
            availableAt: command.availableAt, origin: command.origin });
          if (stripped.error !== null || stripped.packet === null) {
            refused = true;
            result = { kind: 'ingress-refused', error: stripped.error ?? 'malformed-packet', update: engine.refuseInput(command.availableAt, 'source-gap') };
          } else result = { kind: 'ingest', update: engine.ingest(stripped.packet) };
        } else if (command.kind === 'enroll') {
          need(object(command.opportunity), 'enrollment-command', 'Missing retained opportunity');
          result = { kind: 'enroll', update: engine.enroll(command.opportunity, command.availableAt) };
        } else {
          need(command.kind === 'tick', 'command-kind', 'Unknown fixture command');
          result = { kind: 'tick', update: engine.tickDetailed(command.availableAt) };
        }
        const snapshot = engine.snapshot(); checkTerminals(snapshot, terminals);
        pending = { ref: { seq: row.seq, hash: row.hash }, command, result, snapshot };
      } else if (row.kind === 'derived') {
        need(pending !== null && object(row.body), 'derived-order', 'Derived record has no outstanding command');
        const derived = row.body as unknown as DerivedBody;
        need(equalJSON(derived.commandRef, pending.ref), 'command-link', 'Derived record links another command');
        need(equalJSON(derived.result, pending.result), 'result-replay', 'Derived result differs from deterministic R3 replay');
        const snapshotHash = digestJSON(pending.snapshot);
        need(derived.snapshotHash === snapshotHash, 'snapshot-replay', 'Derived snapshot hash differs');
        effects = extendEffects(effects, pending.ref.hash, pending.result);
        need(equalJSON(derived.effects, effects), 'effect-chain', 'Event/outcome count or chain differs');
        if (derived.checkpoint !== null) {
          const ref = derived.checkpoint;
          need(object(ref) && ref.file === `checkpoint-${pending.ref.seq}.json` && !referencedCheckpoints.has(ref.file)
            && integer(ref.bytes) && hash(ref.sha256), 'checkpoint-reference', 'Invalid/reused checkpoint reference');
          checkpointBytes += ref.bytes;
          need(checkpointBytes <= Math.min(limits.maxCheckpointBytes, manifest.limits.maxCheckpointBytes), 'checkpoint-cap', 'Aggregate checkpoint admission exceeded');
          const file = budget.open(path.join(root, ref.file), ref.bytes), bytes = file.all();
          need(bytes.length === ref.bytes && sha256(bytes) === ref.sha256, 'checkpoint-hash', 'Checkpoint bytes differ');
          const checkpoint = canonicalBytes(bytes, true) as CheckpointFile;
          need(object(checkpoint) && checkpoint.v === 1 && checkpoint.namespaceId === manifest.namespaceId
            && checkpoint.manifestHash === options.manifestHash && equalJSON(checkpoint.commandRef, pending.ref)
            && equalJSON(checkpoint.rawPrefix, { bytes: rawConsumed, sha256: rawFile.digest.copy().digest('hex') })
            && checkpoint.snapshotHash === snapshotHash && equalJSON(checkpoint.snapshot, pending.snapshot),
          'checkpoint-replay', 'Checkpoint prefix/state differs from replay');
          checkpointStates.push({ file: ref.file, commandRef: checkpoint.commandRef,
            snapshotHash: checkpoint.snapshotHash, rawPrefix: checkpoint.rawPrefix });
          referencedCheckpoints.add(ref.file); checkpoints++; file.verify(); file.close();
        }
        pending = null;
      } else {
        need(row.kind === 'close' && pending === null && object(row.body), 'close-order', 'Unknown record or unfinished command at close');
        const value = row.body as unknown as CloseBody;
        need((value.reason === 'completed' || value.reason === 'refused') && (!refused || value.reason === 'refused')
          && value.commandCount === commandCount && value.rawBytes === rawConsumed
          && value.rawHash === rawFile.digest.copy().digest('hex') && equalJSON(value.effects, effects), 'close-prefix', 'Close does not describe the exact committed prefix');
        closed = value;
      }
    }
    need(pending === null && closed !== null, 'unfinished-prefix', 'Namespace has no complete terminal close');
    need(prefix.seq === options.expectedPrefix.seq && prefix.hash === options.expectedPrefix.hash,
      'external-prefix', 'Journal differs from externally retained final prefix');
    need(rawFile.chunk(1).length === 0 && rawConsumed === Number(rawFile.before.size), 'raw-tail', 'Uncommitted/missing raw bytes after final prefix');
    for (const name of inventory.keys()) if (name.startsWith('checkpoint-'))
      need(referencedCheckpoints.has(name), 'checkpoint-tail', 'Unreferenced checkpoint file');
    need(sameIdentity(rootBefore, fs.lstatSync(root, { bigint: true })), 'directory-identity', 'Namespace changed during verification');
    const files = budget.finish();
    return { v: 1, verified: true, completed: closed.reason === 'completed', refused: closed.reason === 'refused',
      scope: 'fixture-custody-and-deterministic-R3-reproducibility-only', namespaceId: manifest.namespaceId,
      fixtureMode: true, prospectiveQualified: false, physicalServiceTruth: false,
      manifestHash: options.manifestHash, sourceInventoryHash: options.sourceInventoryHash, protocolHash: PROTOCOL_SHA256,
      prefix, closeReason: closed.reason, commands: commandCount, rawBytes: rawConsumed, rawHash: closed.rawHash,
      effects, snapshotHash: digestJSON(engine.snapshot()), checkpointFiles: checkpoints,
      events: effects.eventCount, outcomes: effects.outcomeCount, checkpointStates,
      actualClocks: { createdAt: manifest.createdAt, lastConsumerReadAt: actualAt, verifiedAt },
      fixtureClocks: { firstAvailableAt: firstReplayAt, lastAvailableAt: replayAt }, readBytes: budget.bytes,
      sourceBytes, elapsedMs: Number(process.hrtime.bigint() - budget.startedAt) / 1e6, files };
  } finally { budget.close(); }
}

export function verifyFixtureNamespace(options: FixtureNamespaceVerificationOptions): VerificationReport {
  return verifyNamespace(options.directory, { manifestHash: options.expectedManifestHash,
    expectedPrefix: options.expectedPrefix, sourceInventoryHash: options.expectedSourceInventoryHash,
    ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
    ...(options.limits === undefined ? {} : { limits: options.limits }) });
}
