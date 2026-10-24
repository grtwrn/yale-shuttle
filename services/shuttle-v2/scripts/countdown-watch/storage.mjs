import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { sha } from './projection.mjs';

const MiB = 1024 * 1024;
export const DEFAULT_POLICY = Object.freeze({ maxOpenBytes: 256 * MiB,
  maxReviewedBytes: 64 * MiB, maxReviewedAgeMs: 7 * 86400000,
  maxBundleBytes: 8 * MiB, maxBundleRawBytes: 64 * MiB, maxStateBytes: 64 * MiB });

export async function readBounded(file, limit, fallback) {
  let stat;
  try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('Invalid or oversized countdown file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function atomicState(file, value, limit) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > limit) throw Error('Countdown checkpoint exceeds bound');
  const temp = file + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync();
    await handle.close(); handle = null; await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close(); await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

/** Open and orphaned evidence stays protected. Only a separate explicit review
 * receipt authorizes rolling deletion; saturation refuses cursor advancement. */
export async function maintainFindings(directory, { policy = DEFAULT_POLICY, now = Date.now() } = {}) {
  const findings = path.join(directory, 'findings'), reviews = path.join(directory, 'reviews');
  await fs.mkdir(findings, { recursive: true }); await fs.mkdir(reviews, { recursive: true });
  let openBytes = 0, reviewedBytes = 0, openFindings = 0, removed = 0;
  const reviewed = [];
  for (const entry of await fs.readdir(findings, { withFileTypes: true })) {
    const file = path.join(findings, entry.name), st = await fs.lstat(file);
    if (!entry.isFile() || st.isSymbolicLink()) throw Error('Unexpected countdown evidence entry');
    const id = /^([a-f0-9]{64})\.json\.gz$/.exec(entry.name)?.[1];
    const receipt = id ? await readBounded(path.join(reviews, id + '.json'), 8192, null) : null;
    const at = Date.parse(receipt?.reviewedAt);
    const authorized = typeof id === 'string' && receipt?.id === id && receipt.status === 'reviewed'
      && typeof receipt.note === 'string' && receipt.note.trim().length > 0
      && Number.isFinite(at) && at <= now && /^[a-f0-9]{64}$/.test(receipt.bundleSHA256 ?? '');
    if (authorized && sha(await fs.readFile(file)) === receipt.bundleSHA256) {
      reviewed.push({ file, reviewFile: path.join(reviews, id + '.json'), bytes: st.size, at }); reviewedBytes += st.size;
    } else { openBytes += st.size; openFindings++; }
  }
  reviewed.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  for (const item of reviewed) {
    if (reviewedBytes <= policy.maxReviewedBytes && now - item.at <= policy.maxReviewedAgeMs) continue;
    await fs.unlink(item.file); await fs.unlink(item.reviewFile); reviewedBytes -= item.bytes; removed++;
  }
  // A crash between the two removals can leave a review receipt alone. It
  // expires on the same age policy; open evidence never enters this cleanup.
  for (const entry of await fs.readdir(reviews, { withFileTypes: true })) {
    const id = /^([a-f0-9]{64})\.json$/.exec(entry.name)?.[1];
    if (!id || !entry.isFile()) continue;
    const file = path.join(reviews, entry.name), receipt = await readBounded(file, 8192, null);
    const at = Date.parse(receipt?.reviewedAt);
    if (receipt?.id !== id || receipt?.status !== 'reviewed' || !Number.isFinite(at)
      || now - at <= policy.maxReviewedAgeMs) continue;
    try { await fs.lstat(path.join(findings, id + '.json.gz')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await fs.unlink(file); }
  }
  return { openBytes, reviewedBytes, openFindings, removed,
    maxOpenBytes: policy.maxOpenBytes, maxReviewedBytes: policy.maxReviewedBytes,
    saturated: openBytes > policy.maxOpenBytes };
}

export async function saveFinding(directory, finding, storage, policy = DEFAULT_POLICY) {
  const raw = Buffer.from(JSON.stringify(finding.body));
  if (sha(raw) !== finding.id) throw Error('Countdown finding identity differs');
  if (raw.length > policy.maxBundleRawBytes) throw Error('Countdown finding raw bound exceeded');
  const bytes = gzipSync(raw);
  if (bytes.length > policy.maxBundleBytes) throw Error('Countdown finding compressed bound exceeded');
  const target = path.join(directory, 'findings', finding.id + '.json.gz');
  const prior = await fs.readFile(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (prior) {
    if (!prior.equals(bytes)) throw Error('Conflicting retained countdown finding');
    return { id: finding.id, bytes: bytes.length, existing: true };
  }
  if (storage.openBytes + bytes.length > policy.maxOpenBytes) throw Error('Protected countdown evidence is full');
  const temp = target + '.' + randomUUID() + '.partial';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync();
    await handle.close(); handle = null;
    await fs.link(temp, target); // Atomic publication without overwriting originals.
    const dir = await fs.open(path.dirname(target), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close(); await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  storage.openBytes += bytes.length; storage.openFindings++;
  return { id: finding.id, bytes: bytes.length, existing: false };
}
