#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStorageLock, atomicJson } from '../retention/storage.mjs';
import { rotateOutput } from '../retention/maintain.mjs';
import { nativeRecords } from '../trajectory-history/native.mjs';
import { CountdownProjection, sha, WATCH_SCOPE } from './projection.mjs';
import { readBounded, atomicState, maintainFindings, saveFinding, DEFAULT_POLICY } from './storage.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MiB = 1024 * 1024;
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const inputName = value => /^feed-\d{4}-\d\d-\d\d-\d\d-\d+\.jsonl\.gz$/.test(value);
const codeFiles = ['detector.mjs', 'projection.mjs', 'storage.mjs', 'poll.mjs',
  '../canary-metrics.mjs', '../trajectory-history/native.mjs', '../../src/collector/witnessCodec.ts',
  '../retention/storage.mjs', '../retention/maintain.mjs'];
export const COUNTDOWN_CODE_SHA256 = sha(JSON.stringify(codeFiles.map(name =>
  [name, sha(fs.readFileSync(new URL(name, import.meta.url)))])));
const codeSHA256 = COUNTDOWN_CODE_SHA256;
export const DEFAULT_READ_BOUNDS = Object.freeze({ maxFiles: 2, maxBytes: 512 * MiB });

/** Take an oldest-first prefix, never a newer window selected to look fresh.
 * Every budget stays within the original eight-file/512 MiB read ceiling.
 * Each native file retains its compressed/decompressed/line bounds. */
export function boundedFiles(files, bounds = DEFAULT_READ_BOUNDS) {
  if (!bounds || Object.keys(bounds).some(k => !['maxFiles', 'maxBytes'].includes(k))
    || !Number.isSafeInteger(bounds.maxFiles) || bounds.maxFiles < 2 || bounds.maxFiles > 8
    || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || bounds.maxBytes > 512 * MiB)
    throw Error('Invalid countdown read bounds');
  const selected = []; let bytes = 0;
  for (const file of files) {
    if (selected.length >= bounds.maxFiles || bytes + file.bytes > bounds.maxBytes) break;
    selected.push(file); bytes += file.bytes;
  }
  if (!selected.length) throw Error('Native countdown read interval exceeds bound or is unavailable');
  // Once a frontier is completely verified, its next file must fit alongside
  // it or a one-file batch would repeatedly commit the same frontier forever.
  if (selected.length === 1 && files.length > 1)
    throw Error('Native countdown frontier and next file exceed read bound');
  return selected;
}

function canonical(file) {
  let base = path.resolve(file); const suffix = [];
  while (!fs.existsSync(base)) { suffix.unshift(path.basename(base)); base = path.dirname(base); }
  return path.join(fs.realpathSync(base), ...suffix);
}
const identity = state => ({ cycle: state.id, sourceKey: state.sourceKey,
  build: state.productionBuild, epoch: state.source?.epoch });

/** This process only reads native journals and writes its own local directory.
 * It makes no HTTP requests, executes no estimator, and never updates reports,
 * model parameters, publication gates, evaluator state or another process. */
export async function capture({ directory, learningRoot, now = Date.now(), policy = DEFAULT_POLICY,
  coldStartLookbackMs = 120000, readBounds = DEFAULT_READ_BOUNDS } = {}) {
  const before = await readBounded(path.join(directory, 'state.json'), policy.maxStateBytes, null);
  if (before && (before.version !== 1 || before.codeSHA256 !== codeSHA256))
    throw Error('Countdown checkpoint requires explicit source migration');
  const live = await readBounded(path.join(learningRoot, 'state.json'), 64 * MiB, null);
  const status = await readBounded(path.join(learningRoot, 'status.json'), 4 * MiB, null);
  if (!/^cycle-\d+$/.test(live?.id ?? '') || live.forecastProtocol !== 'served-control-v2'
    || !hash(live.sourceKey) || !hash(live.frozenCandidateSha256) || !live.source?.inputFiles
    || live.sourceRefusal || !status?.running || status.error || status.cycle !== live.id
    || !Number.isFinite(Date.parse(status.feedReceivedAt))
    || now - Date.parse(status.feedReceivedAt) > 120000
    || Date.parse(status.feedReceivedAt) > now + 5000) throw Error('Native source is unavailable or stale');
  const cycle = path.join(learningRoot, live.id), stat = await fsp.lstat(cycle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid native cycle directory');
  const frozenFile = path.join(cycle, 'frozen-candidate.json'), frozenBytes = await fsp.readFile(frozenFile);
  if (sha(frozenBytes) !== live.frozenCandidateSha256) throw Error('Frozen native identity differs');
  const frozen = JSON.parse(frozenBytes), source = identity(live);
  if (JSON.stringify(identity(frozen)) !== JSON.stringify(source)) throw Error('Frozen native source differs');
  const sameSource = before && JSON.stringify(before.projection.source) === JSON.stringify(source);
  const projection = new CountdownProjection(before?.projection);
  const initialHour = new Date(now - coldStartLookbackMs).toISOString().slice(0, 13).replace('T', '-');
  const frontier = sameSource ? before.frontier : null;
  const available = Object.entries(live.source.inputFiles).map(([name, bytes]) => {
    if (!inputName(name) || !Number.isSafeInteger(bytes) || bytes <= 0) throw Error('Invalid native input manifest');
    return { name, bytes };
  }).filter(f => frontier ? f.name >= frontier : f.name.slice(5, 18) >= initialHour).sort((a, b) => a.name.localeCompare(b.name));
  if (frontier && (!before.prefixes?.[frontier] || !available.some(f => f.name === frontier)))
    throw Error('Native countdown frontier is unavailable');
  const files = boundedFiles(available, readBounds), pendingFiles = available.length - files.length;
  const prefixes = {}; let inputLines = 0, skippedColdLines = 0;
  for (const spec of files) {
    const file = path.join(cycle, spec.name), previous = sameSource ? before.prefixes?.[spec.name] : null;
    for await (const item of nativeRecords(file, { previous, captureBytes: spec.bytes, maxLineBytes: 64 * MiB })) {
      if (item.prefix) { prefixes[spec.name] = item.prefix; continue; }
      if (previous && item.line <= previous.completeLines) continue;
      inputLines++;
      if (!sameSource && item.record.receivedAt < now - coldStartLookbackMs) { skippedColdLines++; continue; }
      projection.consume(item.record, source, { file: spec.name, line: item.line, rawSHA256: item.rawSHA256 });
    }
    if (prefixes[spec.name]?.partialTail && spec.name !== available.at(-1).name)
      throw Error('Historical native countdown record is incomplete');
  }
  const latest = projection.state.feedReceipt?.forecastAvailable === false
    ? Math.max(projection.state.last?.at ?? -Infinity, projection.state.feedReceipt.receivedAt)
    : projection.state.last?.at;
  if (!Number.isSafeInteger(latest) || latest > now + 5000 || (!pendingFiles && now - latest > 120000))
    throw Error('Countdown capture did not reach a fresh source record');
  const after = await readBounded(path.join(learningRoot, 'state.json'), 64 * MiB, null);
  if (JSON.stringify(identity(after)) !== JSON.stringify(source)) throw Error('Native context changed during capture');
  const storage = await maintainFindings(directory, { policy, now }), findings = projection.findings();
  if (storage.saturated) throw Error('Protected countdown evidence exceeds its bound');
  const saved = [];
  for (const finding of findings) saved.push(await saveFinding(directory, finding, storage, policy));
  const next = { version: 1, codeSHA256, checkedAt: now, projection: projection.snapshot(),
    frontier: files.at(-1).name, prefixes: { [files.at(-1).name]: prefixes[files.at(-1).name] },
    coverageBoundaries: [...(before?.coverageBoundaries ?? []), ...projection.boundaries].slice(-32) };
  await atomicState(path.join(directory, 'state.json'), next, policy.maxStateBytes);
  return { checkedAt: new Date(now).toISOString(), ok: !pendingFiles, caughtUp: !pendingFiles,
    ...(pendingFiles ? { errorCode: 'backfill_pending',
      reason: 'Verified historical countdown inputs committed; fresh coverage is still pending.' } : {}),
    codeSHA256, source,
    lastFrame: projection.state.last, feedReceipt: projection.state.feedReceipt,
    newFrames: projection.newFrames, totalFrames: projection.state.totalFrames,
    totalStopLevelCandidates: projection.state.totalEvents, newFindingParts: saved,
    inputLines, skippedColdLines, boundaries: projection.boundaries, storage,
    read: { files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      pendingFiles, frontier: files.at(-1).name, bounds: readBounds },
    noProductionRequests: true, physicalETAAccuracyQualified: false, scope: WATCH_SCOPE };
}

export async function runOnce({ directory = process.env.COUNTDOWN_WATCH_DIR
  ?? path.join(service, 'scripts/.bot-artifacts/countdown-watch'),
  learningRoot = process.env.COUNTDOWN_WATCH_ROOT ?? path.join(service, 'scripts/.learning-loop'),
  now = Date.now(), policy: options = {}, coldStartLookbackMs, readBounds } = {}) {
  const output = canonical(directory), input = canonical(learningRoot);
  if (output === input || output.startsWith(input + path.sep) || input.startsWith(output + path.sep))
    throw Error('Countdown output must be separate from native evidence');
  const policy = { ...DEFAULT_POLICY, ...options };
  if (Object.values(policy).some(v => !Number.isSafeInteger(v) || v <= 0)
    || coldStartLookbackMs !== undefined && (!Number.isSafeInteger(coldStartLookbackMs) || coldStartLookbackMs < 0))
    throw Error('Invalid countdown storage or capture policy');
  return withStorageLock(directory, async () => {
    let result;
    try {
      await rotateOutput(path.join(directory, 'watcher.log'), { maxBytes: MiB, maxBackups: 1 });
      result = await capture({ directory, learningRoot, now, policy, coldStartLookbackMs, readBounds });
    } catch (error) {
      result = { checkedAt: new Date(now).toISOString(), ok: false,
        reason: String(error.message ?? error).slice(0, 300),
        note: 'Previously committed cursor and unreviewed finding evidence are preserved.',
        noProductionRequests: true, physicalETAAccuracyQualified: false, scope: WATCH_SCOPE };
    }
    await atomicJson(path.join(directory, 'status.json'), result);
    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runOnce(); process.exitCode = result.ok ? 0 : 1;
}
