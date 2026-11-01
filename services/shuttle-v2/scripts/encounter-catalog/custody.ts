import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { canonicalJSON, sha256 } from '../encounter-proxy/canonical.js';
import { enumerateCatalog } from './enumerate.js';
import { canonicalInputHash, DEFAULT_CAPS, effectiveCaps, IO_LIMITS, PROTOCOL_SHA256, R3_PROTOCOL_SHA256 } from './protocol.js';
import { validateInput } from './schema.js';
import { LimitRefusal, type ArtifactChannel, type AuditRecord, type Caps, type CatalogInput,
  type EnumerationResult } from './types.js';

export const EXTERNAL_MANIFEST = 'external-custody-manifest.json';
export const FINAL_FILE = 'final-exhaustion-or-refusal.json';
export const INPUT_MANIFEST = 'frozen-input-manifest.json';
export const CHANNELS = ['component-universe', 'interpretations', 'search-trace-rejections',
  'feasible-embeddings', 'ambiguous-and-unknown-regions', 'clock-transcript'] as const;
export type Channel = typeof CHANNELS[number];
export interface FilePin { file: string; bytes: number; sha256: string }
export interface Prefix { seq: number; hash: string }
export interface FrozenInputManifest {
  schema: 'independent-catalog-frozen-input/v1'; createdAt: number;
  inputHash: string; protocolHash: string; r3ProtocolHash: string; effectiveCaps: Caps;
  input: FilePin; sources: { id: string; originalFile: string; retained: FilePin }[];
  runtime: { observed: { node: string; platform: string; arch: string };
    externalExecutionIdentity: unknown; files: FilePin[]; inventoryHash: string };
  clockSource: 'monotonic-performance' | 'supplied-finite-control-clock';
  qualificationPending: true; liveQualified: false; publicationCapability: false;
}
export interface ArtifactRow {
  schema: 'independent-catalog-artifact-row/v1'; seq: number; previousHash: string;
  channel: Channel; record: AuditRecord; hash: string;
}
export interface ExternalManifest {
  schema: 'independent-catalog-custody/v1'; frozenInputManifestHash: string;
  protocolHash: string; r3ProtocolHash: string; prefix: Prefix;
  final: FilePin; files: FilePin[]; inventoryHash: string;
  totalOutputBytes: number; externalManifestBytes: number; artifactCompletion: boolean;
  qualificationPending: true; liveQualified: false; publicationCapability: false;
}
export interface AnalyzeOptions {
  inputFile: string; sourceRoot: string; outputDirectory: string;
  caps?: Partial<Caps>; now?: () => number;
  /** Opaque externally retained owner admission; never treated as authority by this analyzer. */
  executionIdentity?: unknown;
}
export interface AnalysisReceipt {
  scope: 'finite-catalog-analysis-custody-only'; directory: string;
  manifestHash: string; finalHash: string; prefix: Prefix; outputBytes: number;
  outputBytesBeforeEnumeration: number; artifactCompletion: boolean; result: EnumerationResult;
  admissionReadBytes: number;
  sourceReadPasses: { inputBefore: ReadBudget; runtimeBefore: ReadBudget; inputAfter: ReadBudget; runtimeAfter: ReadBudget };
  liveQualified: false; publicationCapability: false;
}
export const hashJSON = (value: unknown): string => sha256(canonicalJSON(value));
export const encode = (value: unknown): Buffer => Buffer.from(canonicalJSON(value) + '\n');
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const safeRelative = (value: string): boolean => !!value && !value.includes('\\') && !path.isAbsolute(value)
  && path.posix.normalize(value) === value && !value.split('/').some(part => !part || part === '.' || part === '..');
function protectedPath(value: string): boolean {
  return value.split(path.sep).some(part => /^cycle-/i.test(part) || part.startsWith('.learning-loop')
    || ['.git', '.bot-artifacts', 'shuttle-archive', 'store'].includes(part));
}
export function runtimeRequired(): void {
  requireValue(process.platform === 'linux' && process.versions.node.split('.')[0] === '22',
    'Catalog computation/replay requires an independently admitted Linux Node22 runtime');
}
export function canonicalValue(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
  requireValue(encode(value).equals(bytes), 'Noncanonical JSON bytes (including final LF, BOM or duplicate keys)');
  return value;
}
const identity = (value: fs.BigIntStats) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode, value.nlink].map(String).join(':');
export interface ReadBudget {
  /** Strict actual IO for artifacts; admitted payload extent for explicit source passes. */
  bytes: number; maximum: number;
  payloadBytes?: number; eofProbeAttempts?: number; eofProbeBytes?: number; maxEOFProbes?: number;
}
export function sourceReadBudget(maximum = DEFAULT_CAPS.maxAggregateSourceBytes,
  files = DEFAULT_CAPS.maxSourceFiles): ReadBudget {
  requireValue(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= IO_LIMITS.inputPassMaxPayloadBytes
    && Number.isSafeInteger(files) && files > 0 && files <= IO_LIMITS.inputPassMaxEOFProbeAttempts, 'Source pass bounds cannot increase');
  return { bytes: 0, maximum, payloadBytes: 0, eofProbeAttempts: 0, eofProbeBytes: 0, maxEOFProbes: files };
}

/** Fixed descriptor extent plus a reserved EOF probe, with final FD/path identity. */
export class BoundedFD {
  readonly fd: number; readonly before: fs.BigIntStats;
  readonly digest = createHash('sha256'); position = 0; eof = false; private closed = false;
  private probeAttempted = false;
  constructor(readonly file: string, maximum: number, readonly budget: ReadBudget) {
    requireValue(path.resolve(file) === file && fs.realpathSync(file) === file, 'Noncanonical input path');
    this.before = fs.lstatSync(file, { bigint: true });
    requireValue(this.before.isFile() && this.before.nlink === 1n && !this.before.isSymbolicLink()
      && this.before.size <= BigInt(maximum), 'Input file type/link/byte admission');
    this.fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { requireValue(identity(this.before) === identity(fs.fstatSync(this.fd, { bigint: true })), 'Input changed while opening'); }
    catch (error) { fs.closeSync(this.fd); throw error; }
  }
  chunk(maximum = 65536): Buffer {
    if (this.eof) return Buffer.alloc(0);
    const remaining = Number(this.before.size) - this.position;
    if (remaining === 0) {
      requireValue(!this.probeAttempted, 'EOF probe already attempted');
      if (this.budget.maxEOFProbes !== undefined) {
        requireValue((this.budget.eofProbeAttempts ?? 0) < this.budget.maxEOFProbes, 'Source EOF probe count cap');
      } else requireValue(this.budget.bytes + 1 <= this.budget.maximum, 'Aggregate artifact read cap before EOF probe');
      this.probeAttempted = true; this.budget.eofProbeAttempts = (this.budget.eofProbeAttempts ?? 0) + 1;
      const probe = Buffer.alloc(IO_LIMITS.eofProbeRequestedBytes), count = fs.readSync(this.fd, probe, 0, probe.length, null);
      this.budget.bytes += count; this.budget.eofProbeBytes = (this.budget.eofProbeBytes ?? 0) + count;
      requireValue(count === 0, 'Input grew past admitted extent');
      this.eof = true; return Buffer.alloc(0);
    }
    const length = Math.min(maximum, remaining);
    const consumed = this.budget.maxEOFProbes === undefined ? this.budget.bytes : (this.budget.payloadBytes ?? 0);
    requireValue(consumed + length <= this.budget.maximum, 'Aggregate read cap before read');
    const bytes = Buffer.alloc(length), count = fs.readSync(this.fd, bytes, 0, length, null);
    this.budget.bytes += count; this.budget.payloadBytes = (this.budget.payloadBytes ?? 0) + count;
    if (!count) { this.eof = true; return Buffer.alloc(0); }
    requireValue(this.position + count <= Number(this.before.size), 'Input grew past admitted extent');
    this.position += count; const result = bytes.subarray(0, count); this.digest.update(result); return result;
  }
  all(): Buffer {
    const chunks: Buffer[] = [];
    for (;;) { const chunk = this.chunk(); if (!chunk.length) break; chunks.push(chunk); }
    return Buffer.concat(chunks, this.position);
  }
  finish(): FilePin {
    requireValue(this.eof && this.position === Number(this.before.size), 'Input missing natural EOF');
    const named = fs.lstatSync(this.file, { bigint: true });
    requireValue(identity(this.before) === identity(fs.fstatSync(this.fd, { bigint: true }))
      && identity(this.before) === identity(named) && fs.realpathSync(this.file) === this.file, 'Input FD/path identity changed');
    return { file: this.file, bytes: this.position, sha256: this.digest.copy().digest('hex') };
  }
  close(): void { if (!this.closed) { fs.closeSync(this.fd); this.closed = true; } }
}
function retainedRead(file: string, maximum: number, budget: ReadBudget): { bytes: Buffer; pin: FilePin } {
  const input = new BoundedFD(file, maximum, budget);
  try { const bytes = input.all(); return { bytes, pin: input.finish() }; } finally { input.close(); }
}

/** Locate code keywords without interpreting module-like text in literals as
 * declarations. This lexer supports the standalone source grammar only; an
 * unfinished literal refuses rather than granting a dependency exception. */
function moduleKeywordOffsets(code: string): Set<number> {
  const result = new Set<number>();
  let index = 0, canStartRegex = true;
  const identifierPart = (character: string) => !/\s/.test(character) && /[\w$\u0080-\uFFFF]/.test(character);
  const lineTerminator = (character: string) => ['\n', '\r', '\u2028', '\u2029'].includes(character);
  while (index < code.length) {
    const character = code[index]!;
    if (/\s/.test(character)) { index++; continue; }
    if (character === '/' && code[index + 1] === '/') {
      index += 2;
      while (index < code.length && !lineTerminator(code[index]!)) index++;
      continue;
    }
    if (character === '/' && code[index + 1] === '*') {
      const end = code.indexOf('*/', index + 2);
      requireValue(end >= 0, 'Unfinished runtime source comment'); index = end + 2; continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character; index++; let closed = false;
      for (; index < code.length; index++) {
        if (code[index] === '\\') { index++; continue; }
        if (code[index] === quote) { index++; closed = true; break; }
      }
      requireValue(closed, 'Unfinished runtime source literal'); canStartRegex = false; continue;
    }
    if (character === '/' && canStartRegex) {
      index++; let inClass = false, closed = false;
      for (; index < code.length; index++) {
        const next = code[index]!;
        requireValue(!lineTerminator(next), 'Unsupported runtime regex literal');
        if (next === '\\') {
          requireValue(index + 1 < code.length && !lineTerminator(code[index + 1]!), 'Unsupported runtime regex escape');
          index++; continue;
        }
        if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) { index++; closed = true; break; }
      }
      requireValue(closed, 'Unfinished runtime regex literal');
      while (index < code.length && /[a-z]/i.test(code[index]!)) index++;
      canStartRegex = false; continue;
    }
    if (identifierPart(character)) {
      const start = index++;
      while (index < code.length && identifierPart(code[index]!)) index++;
      const word = code.slice(start, index);
      if (word === 'import' || word === 'export') result.add(start);
      canStartRegex = ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await'].includes(word);
      continue;
    }
    if ((character === '+' || character === '-') && code[index + 1] === character) {
      index += 2; canStartRegex = false; continue;
    }
    canStartRegex = ![')', ']', '}', '.'].includes(character); index++;
  }
  return result;
}

/** Fail closed for supported static module syntax; never load a dependency to inspect it. */
export function assertRuntimeImports(code: string, file: string, files: ReadonlySet<string>): void {
  const builtins = new Set(['node:fs', 'node:path', 'node:crypto', 'node:url', 'node:perf_hooks']);
  requireValue(!/\b(?:import|require)\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/.test(code), 'Dynamic loading outside runtime closure');
  requireValue(!/\b(?:import|export|from)\s*\/[*\/]|\bimport\b[^;'"`]*\/[*\/]|\bexport\s*(?:type\s*)?(?:\*|\{)[^;'"`]*\/[*\/]|\bexport\s+type\s*\/[*\/]/.test(code), 'Unsupported commented import/export clause');
  requireValue(!/\b(?:import|export)\s*(?:type\s+)?\{[^}]*['"`]/.test(code), 'Unsupported quoted module binding');
  // Binding names may be Unicode or contain identifier escapes. Find the
  // module specifier without an ASCII-only binding alphabet. Comments and
  // quoted binding names above are explicitly unsupported rather than skipped.
  const keywords = moduleKeywordOffsets(code);
  const pattern = /\b(?:import|export)\s*(?:[^;'"`]*?\bfrom\s*)?['"]([^'"]+)['"]/y;
  for (const offset of keywords) {
    // Anchor each check to its own code token: a false literal match must not
    // consume and hide a subsequent real declaration from a global iterator.
    pattern.lastIndex = offset;
    const match = pattern.exec(code);
    if (!match) continue;
    const dependency = match[1]!;
    if (dependency.startsWith('node:')) { requireValue(builtins.has(dependency), 'Outside runtime builtin'); continue; }
    requireValue(dependency.startsWith('./') || dependency.startsWith('../encounter-proxy/'), 'Outside standalone runtime import');
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency.replace(/\.js$/, '.ts')));
    requireValue(files.has(target), 'Unpinned runtime dependency');
  }
}

/** Explicit standalone closure. Extra files cannot authorize an outside import. */
export function runtimeFiles(budget = sourceReadBudget()): Map<string, Buffer> {
  const folder = path.dirname(fileURLToPath(import.meta.url)), scripts = path.dirname(folder);
  const own = fs.readdirSync(folder).filter(name => name.endsWith('.ts') && !/\.test(?:-helper)?\.ts$|\.fixture\.ts$|^test-fixtures\.ts$/.test(name));
  const names = [...own.map(name => 'encounter-catalog/' + name), 'encounter-catalog/protocol.v2.json',
    'encounter-catalog/input-schema.v1.json', ...['catalog.ts', 'canonical.ts', 'protocol.ts', 'types.ts', 'protocol.v3.json'].map(name => 'encounter-proxy/' + name)].sort();
  requireValue(names.length <= DEFAULT_CAPS.maxSourceFiles, 'Runtime closure file cap');
  const bytes = new Map<string, Buffer>();
  for (const name of names) {
    const value = retainedRead(path.join(scripts, name), DEFAULT_CAPS.maxSourceFileBytes, budget);
    bytes.set('runtime/' + name, value.bytes);
  }
  for (const [name, raw] of bytes) {
    if (!name.endsWith('.ts')) continue;
    assertRuntimeImports(raw.toString('utf8'), name, new Set(bytes.keys()));
  }
  return bytes;
}

export interface ArtifactSink { write(file: string, bytes: Buffer, append: boolean): void }
export class Recorder {
  readonly files = new Map<string, { bytes: number; digest: ReturnType<typeof createHash> }>();
  bytes = 0; seq = 0; head: string; stopped = false; clockCalls = 0; previousClock = -Infinity;
  constructor(readonly caps: Caps, readonly seed: string, readonly sink: ArtifactSink) { this.head = seed; }
  generalRoom(bytes: number): boolean { return !this.stopped && this.bytes + bytes <= this.caps.maxDiagnosticOutputBytes - this.caps.reservedRefusalOutputBytes; }
  put(file: string, bytes: Buffer, reserved = false, append = false): void {
    requireValue(safeRelative(file), 'Unsafe artifact filename');
    if (reserved) requireValue(this.bytes + bytes.length <= this.caps.maxDiagnosticOutputBytes, 'Refusal reserve exhausted; namespace incomplete');
    else if (!this.generalRoom(bytes.length)) throw new LimitRefusal('output-cap');
    const old = this.files.get(file);
    requireValue(append ? !!old : !old, 'Artifact write order/overwrite');
    this.sink.write(file, bytes, append);
    const value = old ?? { bytes: 0, digest: createHash('sha256') };
    value.bytes += bytes.length; value.digest.update(bytes); this.files.set(file, value); this.bytes += bytes.length;
  }
  row(channel: Channel, record: AuditRecord, reserved = false): ArtifactRow {
    const core = { schema: 'independent-catalog-artifact-row/v1' as const, seq: this.seq + 1,
      previousHash: this.head, channel, record };
    const row = { ...core, hash: hashJSON(core) };
    this.put(channel + '.jsonl', encode(row), reserved, true); this.seq = row.seq; this.head = row.hash; return row;
  }
  clock(value: number): number {
    if (this.stopped) throw new LimitRefusal('output-cap');
    const token = Number.isFinite(value) ? value : String(value);
    const valid = Number.isFinite(value) && value >= this.previousClock;
    const data = { index: this.clockCalls, value: token, blocked: false, valid };
    const core = { schema: 'independent-catalog-artifact-row/v1', seq: this.seq + 1,
      previousHash: this.head, channel: 'clock-transcript', record: { kind: 'clock', data } };
    const blocked = !this.generalRoom(encode({ ...core, hash: hashJSON(core) }).length);
    this.row('clock-transcript', { kind: 'clock', data: { ...data, blocked } }, blocked);
    this.clockCalls++; this.previousClock = value;
    if (blocked) { this.stopped = true; throw new LimitRefusal('output-cap'); }
    if (!valid) throw new LimitRefusal('invalid-monotonic-clock');
    return value;
  }
  clockError(error: unknown): never {
    const data = { index: this.clockCalls, value: 'source-threw', error: String(error), blocked: false, valid: false };
    const core = { schema: 'independent-catalog-artifact-row/v1', seq: this.seq + 1,
      previousHash: this.head, channel: 'clock-transcript', record: { kind: 'clock', data } };
    const blocked = !this.generalRoom(encode({ ...core, hash: hashJSON(core) }).length);
    this.row('clock-transcript', { kind: 'clock', data: { ...data, blocked } }, blocked);
    this.clockCalls++;
    if (blocked) { this.stopped = true; throw new LimitRefusal('output-cap'); }
    throw new LimitRefusal('clock-source-error');
  }
  pins(): FilePin[] {
    return [...this.files].map(([file, value]) => ({ file, bytes: value.bytes, sha256: value.digest.copy().digest('hex') }))
      .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  }
}
export interface RecordedAnalysis {
  manifest: ExternalManifest; manifestBytes: Buffer; finalBytes: Buffer; recorder: Recorder;
  result: EnumerationResult; outputBytesBeforeEnumeration: number;
}
function crosswalkBytes(input: CatalogInput, inputHash: string): Buffer {
  return encode({ schema: 'retained-plan-tokens-crosswalk/v1', inputHash,
    published: input.published, spurs: input.spurs, variants: input.variants,
    scope: input.scope, qualificationPending: true, liveQualified: false, publicationCapability: false });
}

/** The same finite recording pipeline is used by the writer and read-only replay. */
export function recordAnalysis(input: CatalogInput, frozen: FrozenInputManifest, frozenBytes: Buffer,
  initialFiles: ReadonlyMap<string, Buffer>, sink: ArtifactSink, nextClock: () => number): RecordedAnalysis {
  const caps = effectiveCaps(frozen.effectiveCaps), recorder = new Recorder(caps, sha256(frozenBytes), sink);
  for (const [file, bytes] of [...initialFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) recorder.put(file, bytes);
  recorder.put(INPUT_MANIFEST, frozenBytes);
  recorder.put('reviewed-plan-tokens-crosswalk.json', crosswalkBytes(input, frozen.inputHash));
  for (const channel of CHANNELS) recorder.put(channel + '.jsonl', Buffer.alloc(0));
  const outputBytesBeforeEnumeration = recorder.bytes;
  const result = enumerateCatalog(input, { caps, now: () => {
    if (recorder.stopped) throw new LimitRefusal('output-cap');
    let value: number;
    try { value = nextClock(); } catch (error) { return recorder.clockError(error); }
    return recorder.clock(value);
  }, emit: (channel, record) => { recorder.row(channel, record); } });
  const originalResultHash = hashJSON(result);
  const invarianceFile = 'per-occurrence-invariance.json', variantFile = 'variant-solution-counts.json';
  const variantBytes = encode({ schema: 'retained-variant-solution-counts/v1', inputHash: result.inputHash, counts: result.variantSolutions });
  const invariantBytes = (value: EnumerationResult) => encode({ schema: 'per-occurrence-invariance/v1', inputHash: value.inputHash,
    complete: value.complete, invariance: value.invariance, qualificationPending: true, liveQualified: false, publicationCapability: false });
  let effective = result, artifactCompletion = true, invariant = invariantBytes(result);
  if (result.complete && !recorder.generalRoom(invariant.length + variantBytes.length)) {
    artifactCompletion = false;
    effective = { ...result, complete: false, verdict: 'refused-incomplete', invariance: [],
      refusals: [...result.refusals, 'output-cap-final-artifact'] };
    invariant = invariantBytes(effective);
  }
  const reserve = !recorder.generalRoom(invariant.length + variantBytes.length);
  recorder.put(invarianceFile, invariant, reserve); recorder.put(variantFile, variantBytes, reserve);
  const { components: _components, invariance: _invariance, unknownRegions: _unknown, variantSolutions: _variants, ...small } = effective;
  const finalBytes = encode({ schema: 'catalog-final-exhaustion-or-refusal/v1', result: small,
    resultHash: hashJSON(effective), originalEnumerationResultHash: originalResultHash, artifactCompletion,
    prefix: { seq: recorder.seq, hash: recorder.head }, artifacts: recorder.pins(),
    qualificationPending: true, liveQualified: false, publicationCapability: false });
  recorder.put(FINAL_FILE, finalBytes, true);
  const files = recorder.pins(), final = files.find(value => value.file === FINAL_FILE)!;
  const manifest: ExternalManifest = { schema: 'independent-catalog-custody/v1', frozenInputManifestHash: sha256(frozenBytes),
    protocolHash: PROTOCOL_SHA256, r3ProtocolHash: R3_PROTOCOL_SHA256, prefix: { seq: recorder.seq, hash: recorder.head },
    final, files, inventoryHash: hashJSON(files), totalOutputBytes: 0, externalManifestBytes: 0, artifactCompletion,
    qualificationPending: true, liveQualified: false, publicationCapability: false };
  let manifestBytes = encode(manifest);
  for (;;) {
    manifest.externalManifestBytes = manifestBytes.length; manifest.totalOutputBytes = recorder.bytes + manifestBytes.length;
    const next = encode(manifest); if (next.equals(manifestBytes)) break; manifestBytes = next;
  }
  recorder.put(EXTERNAL_MANIFEST, manifestBytes, true);
  return { manifest, manifestBytes, finalBytes, recorder, result: effective, outputBytesBeforeEnumeration };
}

function outputPath(value: string): string {
  const result = path.resolve(value), parent = path.dirname(result);
  requireValue(result !== parent && !protectedPath(result) && fs.realpathSync(parent) === parent, 'Unsafe output namespace');
  try { fs.lstatSync(result); throw new Error('Output namespace already exists; fresh directory required'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return result;
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); requireValue(count > 0, 'Incomplete artifact write'); offset += count; }
}
class DurableDirectories {
  readonly opened = new Map<string, { fd: number; before: fs.BigIntStats }>();
  private key(stat: fs.BigIntStats): string {
    // Our own child creation changes timestamps/link counts. Directory identity
    // remains device/inode/type/mode/ownership, verified on FD and named path.
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String).join(':');
  }
  open(directory: string): void {
    requireValue(fs.realpathSync(directory) === directory, 'Output directory path alias');
    const before = fs.lstatSync(directory, { bigint: true });
    requireValue(before.isDirectory() && !before.isSymbolicLink(), 'Output directory type');
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      requireValue(this.key(before) === this.key(fs.fstatSync(fd, { bigint: true })), 'Output directory changed while opening');
      this.opened.set(directory, { fd, before }); this.check(directory);
    } catch (error) { this.opened.delete(directory); fs.closeSync(fd); throw error; }
  }
  check(directory: string): void {
    const owned = this.opened.get(directory); requireValue(owned, 'Unowned output directory');
    const fd = fs.fstatSync(owned.fd, { bigint: true }), named = fs.lstatSync(directory, { bigint: true });
    requireValue(fd.isDirectory() && named.isDirectory() && !named.isSymbolicLink()
      && fs.realpathSync(directory) === directory && this.key(owned.before) === this.key(fd)
      && this.key(fd) === this.key(named), 'Output directory FD/named identity changed');
  }
  parents(root: string, target: string): void {
    this.check(path.dirname(root)); this.check(root);
    const relative = path.relative(root, path.dirname(target));
    requireValue(!relative || safeRelative(relative), 'Output parent escapes namespace');
    let directory = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      directory = path.join(directory, part);
      if (!this.opened.has(directory)) { fs.mkdirSync(directory, { mode: 0o700 }); this.open(directory); }
      this.check(directory);
    }
  }
  sync(): void {
    const names = [...this.opened.keys()].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length
      || (a < b ? -1 : a > b ? 1 : 0));
    for (const directory of names) { this.check(directory); fs.fsyncSync(this.opened.get(directory)!.fd); this.check(directory); }
  }
}

export function analyzeCatalog(options: AnalyzeOptions): AnalysisReceipt {
  runtimeRequired();
  const caps = effectiveCaps(options.caps), sourceRoot = path.resolve(options.sourceRoot), inputPath = path.resolve(options.inputFile);
  requireValue(!protectedPath(sourceRoot) && !protectedPath(inputPath) && fs.realpathSync(sourceRoot) === sourceRoot, 'Protected/noncanonical input namespace');
  const sourceBudget = sourceReadBudget(caps.maxAggregateSourceBytes, caps.maxSourceFiles),
    raw = retainedRead(inputPath, caps.maxSourceFileBytes, sourceBudget);
  const parsed = canonicalValue(raw.bytes); validateInput(parsed, caps); const input: CatalogInput = parsed;
  requireValue(input.sources.length + 1 <= caps.maxSourceFiles, 'Input-control plus primary source file cap');
  requireValue(raw.bytes.length + input.sources.reduce((total, source) => total + source.bytes, 0)
    <= caps.maxAggregateSourceBytes, 'Input-control plus primary source bytes cap');
  const initial = new Map<string, Buffer>([['input-control.json', raw.bytes]]), sources: FrozenInputManifest['sources'] = [];
  for (const source of input.sources) {
    const value = retainedRead(path.join(sourceRoot, source.file), caps.maxSourceFileBytes, sourceBudget);
    requireValue(value.pin.bytes === source.bytes && value.pin.sha256 === source.sha256, 'Primary source pin differs');
    const file = 'sources/' + source.file; initial.set(file, value.bytes);
    sources.push({ id: source.id, originalFile: source.file,
      retained: { file, bytes: source.bytes, sha256: source.sha256 } });
  }
  const runtimeBefore = sourceReadBudget(), runtime = runtimeFiles(runtimeBefore);
  for (const [file, bytes] of runtime) initial.set(file, bytes);
  const runtimePins = [...runtime].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes) }));
  const external = options.executionIdentity ?? null;
  requireValue(encode(external).length <= 32768, 'External execution identity metadata cap');
  const frozen: FrozenInputManifest = { schema: 'independent-catalog-frozen-input/v1', createdAt: Date.now(),
    inputHash: canonicalInputHash(input), protocolHash: PROTOCOL_SHA256, r3ProtocolHash: R3_PROTOCOL_SHA256,
    effectiveCaps: caps, input: { file: 'input-control.json', bytes: raw.bytes.length, sha256: raw.pin.sha256 }, sources,
    runtime: { observed: { node: process.version, platform: process.platform, arch: process.arch },
      externalExecutionIdentity: external, files: runtimePins, inventoryHash: hashJSON(runtimePins) },
    clockSource: options.now ? 'supplied-finite-control-clock' : 'monotonic-performance',
    qualificationPending: true, liveQualified: false, publicationCapability: false };
  const frozenBytes = encode(frozen), directory = outputPath(options.outputDirectory);
  // Admission precedes any namespace write; an absent final manifest is always incomplete.
  const fixed = [...initial.values()].reduce((total, bytes) => total + bytes.length, 0)
    + frozenBytes.length + crosswalkBytes(input, frozen.inputHash).length;
  requireValue(fixed <= caps.maxDiagnosticOutputBytes - caps.reservedRefusalOutputBytes, 'Input custody exceeds general output admission');
  const handles = new Map<string, number>(), directories = new DurableDirectories();
  const inputAfter = sourceReadBudget(caps.maxAggregateSourceBytes, caps.maxSourceFiles), runtimeAfter = sourceReadBudget();
  const sink: ArtifactSink = { write(file, bytes, append) {
    if (file === EXTERNAL_MANIFEST) {
      const originalInput = retainedRead(inputPath, caps.maxSourceFileBytes, inputAfter);
      requireValue(originalInput.bytes.equals(raw.bytes), 'Input-control changed before custody close');
      for (const source of input.sources) {
        const value = retainedRead(path.join(sourceRoot, source.file), caps.maxSourceFileBytes, inputAfter);
        requireValue(value.pin.bytes === source.bytes && value.pin.sha256 === source.sha256, 'Primary source changed before custody close');
      }
      const after = runtimeFiles(runtimeAfter);
      requireValue(after.size === runtime.size && [...runtime].every(([name, value]) => after.get(name)?.equals(value)), 'Runtime source changed before custody close');
      // All earlier entries must reach their directories before the completed
      // external manifest becomes visible. Include the namespace's parent.
      directories.sync();
    }
    const target = path.join(directory, file);
    if (!append) {
      directories.parents(directory, target);
      const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      handles.set(file, fd);
    }
    const fd = handles.get(file); requireValue(fd !== undefined, 'Missing exclusive artifact FD'); writeAll(fd, bytes); fs.fsyncSync(fd);
  } };
  try {
    directories.open(path.dirname(directory)); fs.mkdirSync(directory, { mode: 0o700 }); directories.open(directory);
    const recorded = recordAnalysis(input, frozen, frozenBytes, initial, sink, options.now ?? (() => performance.now()));
    for (const fd of handles.values()) fs.fsyncSync(fd);
    // The external manifest's own entry is durable only after this final pass.
    directories.sync();
    return { scope: 'finite-catalog-analysis-custody-only', directory, manifestHash: sha256(recorded.manifestBytes),
      finalHash: sha256(recorded.finalBytes), prefix: recorded.manifest.prefix, outputBytes: recorded.recorder.bytes,
      outputBytesBeforeEnumeration: recorded.outputBytesBeforeEnumeration, artifactCompletion: recorded.manifest.artifactCompletion,
      result: recorded.result, admissionReadBytes: sourceBudget.bytes + runtimeBefore.bytes + inputAfter.bytes + runtimeAfter.bytes,
      sourceReadPasses: { inputBefore: sourceBudget, runtimeBefore, inputAfter, runtimeAfter },
      liveQualified: false, publicationCapability: false };
  } finally {
    let failure: unknown;
    for (const fd of [...handles.values(), ...[...directories.opened.values()].reverse().map(value => value.fd)]) {
      try { fs.closeSync(fd); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
