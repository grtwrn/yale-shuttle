import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalJSON, sha256 } from '../encounter-proxy/canonical.js';
import { canonicalInputHash, DEFAULT_CAPS, effectiveCaps, PROTOCOL_SHA256, R3_PROTOCOL_SHA256 } from './protocol.js';
import { validateInput } from './schema.js';
import { BoundedFD, CHANNELS, EXTERNAL_MANIFEST, FINAL_FILE, INPUT_MANIFEST, canonicalValue, encode,
  hashJSON, isHash, object, recordAnalysis, requireValue, runtimeFiles, runtimeRequired, safeRelative, sourceReadBudget } from './custody.js';
import type { ArtifactRow, ArtifactSink, Channel, ExternalManifest, FilePin, FrozenInputManifest, Prefix, ReadBudget } from './custody.js';
import type { CatalogInput } from './types.js';

export interface VerifyOptions {
  directory: string; expectedManifestHash: string; expectedFinalHash?: string; expectedPrefix?: Prefix;
}
export interface VerificationReport {
  schema: 'independent-catalog-verification/v1'; verified: true;
  scope: 'finite-formal-universe-custody-and-deterministic-replay-only';
  manifestHash: string; finalHash: string; prefix: Prefix; inputHash: string;
  verdict: string; complete: boolean; searchExhausted: boolean; artifactCompletion: boolean;
  counts: unknown; files: number; outputBytes: number; readBytes: number; elapsedMs: number;
  sourceReadPasses: { retainedInput: ReadBudget; retainedRuntime: ReadBudget; currentRuntimeBefore: ReadBudget; currentRuntimeAfter: ReadBudget };
  qualificationPending: true; liveQualified: false; publicationCapability: false;
  physicalServiceTruth: false; prospectiveQualified: false;
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const equal = (left: unknown, right: unknown) => canonicalJSON(left) === canonicalJSON(right);
const identity = (value: fs.BigIntStats) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode, value.nlink].map(String).join(':');
function remember(observed: Map<string, fs.BigIntStats>, input: BoundedFD): void {
  const old = observed.get(input.file);
  requireValue(!old || identity(old) === identity(input.before), 'Artifact changed between verification passes');
  observed.set(input.file, input.before);
}
function pinShape(value: unknown): value is FilePin {
  return object(value) && typeof value.file === 'string' && safeRelative(value.file)
    && value.file.length <= 1024 && integer(value.bytes) && isHash(value.sha256)
    && Object.keys(value).length === 3;
}
function capability(value: unknown): void {
  requireValue(object(value) && value.qualificationPending === true && value.liveQualified === false
    && value.publicationCapability === false, 'Custody cannot create live or publication qualification');
}
function protectedDirectory(value: string): boolean {
  return value.split(path.sep).some(part => /^cycle-/i.test(part) || part.startsWith('.learning-loop')
    || ['.git', '.bot-artifacts', 'shuttle-archive', 'store'].includes(part));
}

class Lines {
  private pending: Buffer = Buffer.alloc(0); private offset = 0; private pieces: Buffer[] = []; private length = 0;
  constructor(readonly reader: BoundedFD, readonly maximum: number) {}
  next(): { bytes: Buffer; row: ArtifactRow } | null {
    for (;;) {
      if (this.offset === this.pending.length) {
        this.pending = this.reader.chunk(); this.offset = 0;
        if (!this.pending.length) {
          requireValue(this.length === 0, 'Partial final artifact record'); this.reader.finish(); return null;
        }
      }
      const end = this.pending.indexOf(10, this.offset);
      const piece = this.pending.subarray(this.offset, end < 0 ? this.pending.length : end);
      this.length += piece.length;
      requireValue(this.length + 1 <= this.maximum, 'Artifact record byte cap');
      if (piece.length) this.pieces.push(piece);
      if (end < 0) { this.offset = this.pending.length; continue; }
      requireValue(this.length > 0, 'Empty artifact record');
      this.offset = end + 1;
      const bytes = Buffer.concat([...this.pieces, Buffer.from('\n')], this.length + 1);
      this.pieces = []; this.length = 0;
      const value = canonicalValue(bytes);
      requireValue(object(value), 'Malformed artifact row');
      return { bytes, row: value as unknown as ArtifactRow };
    }
  }
}
class MergeRows {
  private readonly readers: { channel: Channel; input: BoundedFD; lines: Lines; head: ReturnType<Lines['next']> }[] = [];
  constructor(directory: string, readonly pins: Map<string, FilePin>, budget: ReadBudget, maximum: number,
    observed: Map<string, fs.BigIntStats>) {
    try {
      for (const channel of CHANNELS) {
        const file = channel + '.jsonl', pin = pins.get(file); requireValue(pin, 'Missing artifact channel');
        const input = new BoundedFD(path.join(directory, file), pin.bytes, budget), lines = new Lines(input, maximum);
        this.readers.push({ channel, input, lines, head: null });
        remember(observed, input);
        this.readers[this.readers.length - 1]!.head = lines.next();
      }
    } catch (error) { this.close(); throw error; }
  }
  peek(): { bytes: Buffer; row: ArtifactRow; channel: Channel } | null {
    let best: typeof this.readers[number] | null = null;
    for (const item of this.readers) if (item.head) {
      requireValue(integer(item.head.row.seq) && item.head.row.seq > 0, 'Invalid artifact sequence');
      if (!best || item.head.row.seq < best.head!.row.seq) best = item;
    }
    return best?.head ? { ...best.head, channel: best.channel } : null;
  }
  pop(): ReturnType<MergeRows['peek']> {
    const next = this.peek(); if (!next) return null;
    const source = this.readers.find(item => item.channel === next.channel)!; source.head = source.lines.next(); return next;
  }
  finish(): void {
    requireValue(this.peek() === null, 'Unconsumed/extra artifact records');
    for (const source of this.readers) {
      const actual = source.input.finish(), expected = this.pins.get(source.channel + '.jsonl')!;
      requireValue(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, 'Artifact channel bytes differ from custody');
    }
  }
  close(): void { for (const source of this.readers) source.input.close(); }
}

/** Read-only: externally anchored bytes, complete prefix, then independent solver replay. */
export function verifyCatalog(options: VerifyOptions): VerificationReport {
  runtimeRequired();
  const started = performance.now(), directory = path.resolve(options.directory);
  requireValue(isHash(options.expectedManifestHash) && (!options.expectedFinalHash || isHash(options.expectedFinalHash)), 'Trusted external custody hash required');
  requireValue(!protectedDirectory(directory) && fs.realpathSync(directory) === directory && fs.lstatSync(directory).isDirectory(), 'Unsafe custody namespace');
  const rootBefore = fs.lstatSync(directory, { bigint: true });
  const observedFiles = new Map<string, fs.BigIntStats>();
  const budget: ReadBudget = { bytes: 0, maximum: 2 * DEFAULT_CAPS.maxDiagnosticOutputBytes + 4 * DEFAULT_CAPS.maxAggregateSourceBytes };
  const read = (file: string, maximum: number, pass?: ReadBudget): { bytes: Buffer; pin: FilePin } => {
    if (pass) requireValue(budget.bytes + maximum + 1 <= budget.maximum, 'Aggregate artifact/source read admission');
    const before = pass?.bytes ?? 0, source = new BoundedFD(path.join(directory, file), maximum, pass ?? budget);
    try { remember(observedFiles, source); const bytes = source.all(); return { bytes, pin: { ...source.finish(), file } }; }
    finally { source.close(); if (pass) budget.bytes += pass.bytes - before; }
  };
  const external = read(EXTERNAL_MANIFEST, DEFAULT_CAPS.reservedRefusalOutputBytes);
  requireValue(external.pin.sha256 === options.expectedManifestHash, 'External custody manifest hash differs');
  const value = canonicalValue(external.bytes); capability(value);
  requireValue(object(value) && value.schema === 'independent-catalog-custody/v1' && value.protocolHash === PROTOCOL_SHA256
    && value.r3ProtocolHash === R3_PROTOCOL_SHA256 && isHash(value.frozenInputManifestHash)
    && object(value.prefix) && integer(value.prefix.seq) && isHash(value.prefix.hash)
    && pinShape(value.final) && value.final.file === FINAL_FILE && Array.isArray(value.files)
    && isHash(value.inventoryHash) && integer(value.totalOutputBytes) && integer(value.externalManifestBytes)
    && typeof value.artifactCompletion === 'boolean', 'Malformed/frozen-protocol custody manifest');
  const manifest = value as unknown as ExternalManifest;
  requireValue(manifest.externalManifestBytes === external.bytes.length && manifest.totalOutputBytes <= DEFAULT_CAPS.maxDiagnosticOutputBytes,
    'Custody total output admission differs');
  if (options.expectedPrefix) requireValue(equal(options.expectedPrefix, manifest.prefix), 'Externally retained prefix differs');
  if (options.expectedFinalHash) requireValue(options.expectedFinalHash === manifest.final.sha256, 'Externally retained final hash differs');
  const pins = new Map<string, FilePin>(); let total = external.bytes.length, previous = '';
  for (const pin of manifest.files) {
    requireValue(pinShape(pin) && pin.file > previous && pin.file !== EXTERNAL_MANIFEST, 'Custody inventory unsafe/duplicate/unsorted');
    previous = pin.file; total += pin.bytes; pins.set(pin.file, pin);
  }
  requireValue(total === manifest.totalOutputBytes && hashJSON(manifest.files) === manifest.inventoryHash
    && equal(pins.get(FINAL_FILE), manifest.final), 'Custody inventory total/hash differs');
  const inventory = new Set<string>();
  const walk = (folder: string, relative: string, depth: number) => {
    requireValue(depth <= 3, 'Unexpected custody directory depth');
    const names = fs.readdirSync(folder); requireValue(names.length <= 64, 'Custody directory entry cap');
    for (const name of names) {
      const file = path.join(folder, name), item = relative ? relative + '/' + name : name;
      requireValue(safeRelative(item) && fs.realpathSync(file) === file, 'Custody path alias');
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { requireValue(['sources', 'runtime', 'runtime/encounter-catalog', 'runtime/encounter-proxy'].includes(item), 'Unlisted custody directory'); walk(file, item, depth + 1); }
      else { requireValue(stat.isFile() && stat.nlink === 1 && (item === EXTERNAL_MANIFEST || pins.has(item)), 'Unlisted/type/link custody artifact'); inventory.add(item); }
    }
  };
  walk(directory, '', 0);
  requireValue(inventory.size === pins.size + 1 && [...pins.keys()].every(file => inventory.has(file)), 'Missing/extra custody artifacts');
  const frozenFile = read(INPUT_MANIFEST, DEFAULT_CAPS.reservedRefusalOutputBytes);
  requireValue(frozenFile.pin.sha256 === manifest.frozenInputManifestHash, 'Frozen input manifest hash differs');
  const frozenValue = canonicalValue(frozenFile.bytes); capability(frozenValue);
  requireValue(object(frozenValue) && frozenValue.schema === 'independent-catalog-frozen-input/v1'
    && frozenValue.protocolHash === PROTOCOL_SHA256 && frozenValue.r3ProtocolHash === R3_PROTOCOL_SHA256
    && integer(frozenValue.createdAt) && frozenValue.createdAt <= Date.now() && isHash(frozenValue.inputHash)
    && pinShape(frozenValue.input) && frozenValue.input.file === 'input-control.json'
    && Array.isArray(frozenValue.sources) && object(frozenValue.runtime) && Array.isArray(frozenValue.runtime.files)
    && object(frozenValue.runtime.observed) && frozenValue.runtime.observed.platform === 'linux'
    && /^v22\./.test(String(frozenValue.runtime.observed.node))
    && ['monotonic-performance', 'supplied-finite-control-clock'].includes(String(frozenValue.clockSource)), 'Malformed frozen input custody');
  const frozen = frozenValue as unknown as FrozenInputManifest, caps = effectiveCaps(frozen.effectiveCaps);
  requireValue(equal(caps, frozen.effectiveCaps) && manifest.totalOutputBytes <= caps.maxDiagnosticOutputBytes, 'Raised/changed engineering bounds');
  requireValue(equal(frozen.runtime.observed, { node: process.version, platform: process.platform, arch: process.arch }),
    'Observed replay runtime differs; version metadata alone is not external execution qualification');
  const initial = new Map<string, Buffer>();
  const retainedInput = sourceReadBudget(caps.maxAggregateSourceBytes, caps.maxSourceFiles),
    retainedRuntime = sourceReadBudget(), currentRuntimeBefore = sourceReadBudget(), currentRuntimeAfter = sourceReadBudget();
  const inputFile = read(frozen.input.file, caps.maxSourceFileBytes, retainedInput);
  requireValue(equal(inputFile.pin, frozen.input), 'Raw input-control pin differs');
  const parsed = canonicalValue(inputFile.bytes); validateInput(parsed, caps); const input: CatalogInput = parsed;
  requireValue(canonicalInputHash(input) === frozen.inputHash && input.sources.length + 1 <= caps.maxSourceFiles
    && inputFile.bytes.length + input.sources.reduce((sum, source) => sum + source.bytes, 0) <= caps.maxAggregateSourceBytes
    && frozen.sources.length === input.sources.length, 'Input-control/source admission differs');
  initial.set(frozen.input.file, inputFile.bytes);
  for (const [index, source] of input.sources.entries()) {
    const retained = frozen.sources[index];
    requireValue(object(retained) && retained.id === source.id && retained.originalFile === source.file && pinShape(retained.retained)
      && equal(retained.retained, { file: 'sources/' + source.file, bytes: source.bytes, sha256: source.sha256 }), 'Retained source identity/crosswalk differs');
    const actual = read(retained.retained.file, caps.maxSourceFileBytes, retainedInput);
    requireValue(equal(actual.pin, retained.retained), 'Retained primary source bytes differ'); initial.set(actual.pin.file, actual.bytes);
  }
  requireValue(budget.bytes + DEFAULT_CAPS.maxAggregateSourceBytes + DEFAULT_CAPS.maxSourceFiles <= budget.maximum, 'Runtime read admission');
  const currentRuntime = runtimeFiles(currentRuntimeBefore), currentPins = [...currentRuntime].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes) }));
  budget.bytes += currentRuntimeBefore.bytes;
  requireValue(budget.bytes <= budget.maximum, 'Aggregate verification/runtime read cap');
  requireValue(equal(currentPins, frozen.runtime.files) && hashJSON(currentPins) === frozen.runtime.inventoryHash, 'Executing runtime source inventory differs');
  for (const pin of frozen.runtime.files) {
    requireValue(pinShape(pin) && currentRuntime.has(pin.file), 'Runtime pin outside allowed static closure');
    const actual = read(pin.file, DEFAULT_CAPS.maxSourceFileBytes, retainedRuntime); requireValue(equal(actual.pin, pin), 'Retained runtime source bytes differ');
    initial.set(pin.file, actual.bytes);
  }
  // First pass independently checks canonical chained coverage and every byte pin.
  const rowFiles = new Set(CHANNELS.map(channel => channel + '.jsonl'));
  for (const pin of pins.values()) if (!rowFiles.has(pin.file)) {
    // Initial source files above are already checked; other small/array artifacts
    // are streamed here without retaining their possibly large parsed arrays.
    if (pin.file === INPUT_MANIFEST) requireValue(equal(frozenFile.pin, pin), 'Frozen manifest inventory pin differs');
    else if (!initial.has(pin.file)) {
      const reader = new BoundedFD(path.join(directory, pin.file), pin.bytes, budget);
      try { remember(observedFiles, reader); while (reader.chunk().length) { /* bounded hash through EOF */ }
        const actual = reader.finish(); requireValue(actual.bytes === pin.bytes && actual.sha256 === pin.sha256, 'Artifact inventory hash differs');
      } finally { reader.close(); }
    } else requireValue(initial.get(pin.file)!.length === pin.bytes && sha256(initial.get(pin.file)!) === pin.sha256, 'Initial artifact inventory pin differs');
  }
  let prefix: Prefix = { seq: 0, hash: manifest.frozenInputManifestHash }, clockIndex = 0;
  const checked = new MergeRows(directory, pins, budget, caps.maxDiagnosticOutputBytes, observedFiles);
  try {
    for (;;) {
      const next = checked.pop(); if (!next) break;
      const row = next.row;
      requireValue(row.schema === 'independent-catalog-artifact-row/v1' && row.seq === prefix.seq + 1
        && row.previousHash === prefix.hash && row.channel === next.channel && isHash(row.hash)
        && object(row.record) && typeof row.record.kind === 'string', 'Artifact sequence/prefix/channel differs');
      const { hash: _hash, ...core } = row; requireValue(hashJSON(core) === row.hash, 'Artifact chained hash differs');
      if (row.channel === 'clock-transcript') {
        requireValue(row.record.kind === 'clock' && object(row.record.data) && row.record.data.index === clockIndex++
          && (typeof row.record.data.value === 'number' || ['NaN', 'Infinity', '-Infinity'].includes(String(row.record.data.value))
            || (row.record.data.value === 'source-threw' && typeof row.record.data.error === 'string'))
          && typeof row.record.data.blocked === 'boolean' && typeof row.record.data.valid === 'boolean', 'Clock transcript differs');
      }
      prefix = { seq: row.seq, hash: row.hash };
      requireValue(performance.now() - started <= caps.externalOwnerWallMs, 'Verification wall deadline');
    }
    checked.finish();
  } finally { checked.close(); }
  requireValue(equal(prefix, manifest.prefix), 'Final prefix is missing or rewritten');
  // Second pass regenerates all artifacts using only the retained raw input and
  // exact clock transcript. This sink never opens a writable descriptor.
  const replay = new MergeRows(directory, pins, budget, caps.maxDiagnosticOutputBytes, observedFiles);
  const sink: ArtifactSink = { write(file, bytes, append) {
    if (append) {
      const expected = replay.pop(); requireValue(expected && expected.channel + '.jsonl' === file && expected.bytes.equals(bytes), 'Deterministic artifact replay differs');
    } else if (!rowFiles.has(file)) {
      const pin = file === EXTERNAL_MANIFEST ? external.pin : pins.get(file);
      requireValue(pin && bytes.length === pin.bytes && sha256(bytes) === pin.sha256, 'Deterministic final/inventory replay differs');
    } else requireValue(bytes.length === 0, 'Nonempty channel creation');
  } };
  let recorded: ReturnType<typeof recordAnalysis>;
  try {
    recorded = recordAnalysis(input, frozen, frozenFile.bytes, initial, sink, () => {
      const next = replay.peek(); requireValue(next?.channel === 'clock-transcript' && object(next.row.record.data), 'Missing exact replay clock');
      const value = next.row.record.data.value;
      if (value === 'source-threw') { requireValue(typeof next.row.record.data.error === 'string', 'Missing clock exception receipt'); throw next.row.record.data.error; }
      if (typeof value === 'number') return value;
      requireValue(['NaN', 'Infinity', '-Infinity'].includes(String(value)), 'Unsupported replay clock token'); return Number(value);
    });
    replay.finish();
  } finally { replay.close(); }
  requireValue(equal(recorded.manifest, manifest) && sha256(recorded.manifestBytes) === options.expectedManifestHash,
    'Replayed custody manifest differs');
  requireValue(budget.bytes + DEFAULT_CAPS.maxAggregateSourceBytes + DEFAULT_CAPS.maxSourceFiles <= budget.maximum, 'Final runtime read admission');
  const runtimeAfter = runtimeFiles(currentRuntimeAfter); budget.bytes += currentRuntimeAfter.bytes;
  requireValue(runtimeAfter.size === currentRuntime.size && [...currentRuntime].every(([file, bytes]) => runtimeAfter.get(file)?.equals(bytes)), 'Executing runtime source changed during verification');
  requireValue(performance.now() - started <= caps.externalOwnerWallMs, 'Verification wall deadline');
  const rootAfter = fs.lstatSync(directory, { bigint: true });
  requireValue(rootBefore.dev === rootAfter.dev && rootBefore.ino === rootAfter.ino
    && rootBefore.mtimeNs === rootAfter.mtimeNs && rootBefore.ctimeNs === rootAfter.ctimeNs, 'Namespace changed during verification');
  inventory.clear(); walk(directory, '', 0);
  requireValue(inventory.size === pins.size + 1 && [...pins.keys()].every(file => inventory.has(file)), 'Custody inventory changed during replay');
  for (const [file, before] of observedFiles) requireValue(identity(before) === identity(fs.lstatSync(file, { bigint: true }))
    && fs.realpathSync(file) === file, 'Artifact changed after its verified read');
  return { schema: 'independent-catalog-verification/v1', verified: true,
    scope: 'finite-formal-universe-custody-and-deterministic-replay-only', manifestHash: options.expectedManifestHash,
    finalHash: sha256(recorded.finalBytes), prefix, inputHash: frozen.inputHash,
    verdict: recorded.result.verdict, complete: recorded.result.complete, searchExhausted: recorded.result.searchExhausted,
    artifactCompletion: manifest.artifactCompletion, counts: recorded.result.counts, files: inventory.size,
    outputBytes: manifest.totalOutputBytes, readBytes: budget.bytes, elapsedMs: performance.now() - started,
    sourceReadPasses: { retainedInput, retainedRuntime, currentRuntimeBefore, currentRuntimeAfter },
    qualificationPending: true, liveQualified: false, publicationCapability: false, physicalServiceTruth: false, prospectiveQualified: false };
}
