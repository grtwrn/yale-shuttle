import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStorageLock } from '../retention/storage.mjs';
import { COUNTDOWN_CODE_SHA256 } from './poll.mjs';
import { sha } from './projection.mjs';
import { atomicState, DEFAULT_POLICY } from './storage.mjs';

export const PRE_BATCH_CODE_SHA256 = '47ba5fd777abb58043c63f1793d21ad5d81a7b70724e988d2e958a41e9b20d4d';
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');

async function immutable(file, bytes) {
  const stat = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid countdown migration custody file');
    const existing = await fs.readFile(file);
    if (!existing.equals(bytes)) throw Error('Conflicting countdown migration custody file');
    return;
  }
  const temp = file + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fs.link(temp, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Explicit operator migration for the reviewed bounded-batch reader only.
 * The normal poll never calls this. An exact original checkpoint and the
 * reviewed target executable fingerprint are required; pending comparisons,
 * source identity, compressed prefixes and all clocks stay unchanged. */
export async function migrateCheckpoint({ directory, expectedCheckpointSHA256,
  reviewedTargetCodeSHA256, note } = {}) {
  if (typeof directory !== 'string' || !directory || !hash(expectedCheckpointSHA256)
    || reviewedTargetCodeSHA256 !== COUNTDOWN_CODE_SHA256
    || typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 4096)
    throw Error('Explicit countdown migration review is required');
  return withStorageLock(directory, async () => {
    const file = path.join(directory, 'state.json'), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DEFAULT_POLICY.maxStateBytes)
      throw Error('Invalid countdown migration checkpoint');
    const raw = await fs.readFile(file);
    if (sha(raw) !== expectedCheckpointSHA256) throw Error('Countdown migration checkpoint differs');
    const before = JSON.parse(raw);
    if (before.version !== 1 || before.codeSHA256 !== PRE_BATCH_CODE_SHA256
      || before.projection?.version !== 1 || !before.projection.source
      || typeof before.frontier !== 'string' || !before.prefixes?.[before.frontier])
      throw Error('Countdown migration source is not the reviewed checkpoint format');
    const custody = path.join(directory, 'migrations');
    await fs.mkdir(custody, { recursive: true });
    if (!(await fs.lstat(custody)).isDirectory() || (await fs.lstat(custody)).isSymbolicLink())
      throw Error('Invalid countdown migration custody directory');
    const originalName = expectedCheckpointSHA256 + '.state.json';
    await immutable(path.join(custody, originalName), raw);
    const receipt = { version: 1, kind: 'countdown-bounded-reader-migration',
      originalCheckpointSHA256: expectedCheckpointSHA256, originalCheckpointFile: originalName,
      fromCodeSHA256: before.codeSHA256, toCodeSHA256: COUNTDOWN_CODE_SHA256, note,
      originalCheckedAt: before.checkedAt, originalFrontier: before.frontier,
      projectionSHA256: sha(JSON.stringify(before.projection)),
      prefixesSHA256: sha(JSON.stringify(before.prefixes)),
      scope: 'Reader-only source migration. No checkpoint, source identity, detector, cursor, prefix, clock or finding reset.' };
    const receiptRaw = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    const receiptName = expectedCheckpointSHA256 + '.receipt.json';
    await immutable(path.join(custody, receiptName), receiptRaw);
    await atomicState(file, { ...before, codeSHA256: COUNTDOWN_CODE_SHA256 }, DEFAULT_POLICY.maxStateBytes);
    return { ...receipt, receiptFile: path.join(custody, receiptName),
      receiptSHA256: sha(receiptRaw), migrated: true };
  });
}
