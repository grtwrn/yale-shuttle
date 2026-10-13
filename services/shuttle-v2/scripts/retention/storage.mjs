import fs from 'node:fs/promises';
import path from 'node:path';

export const MiB = 1024 * 1024;
export const DAY = 86400000;
export const DEFAULT_RIDER_POLICY = {
  imageMaxBytes: 256 * MiB, imageMaxAgeMs: 7 * DAY,
  samples: { chunkBytes: 5 * MiB, maxFiles: 12, maxAgeMs: 3 * DAY },
  events: { chunkBytes: 5 * MiB, maxFiles: 6, maxAgeMs: 30 * DAY },
  journeys: { chunkBytes: 5 * MiB, maxFiles: 6, maxAgeMs: 90 * DAY },
};
let sequence = 0;
export async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${++sequence}.partial`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function riderPolicy(root) {
  const configured = await readJson(path.join(root, 'storage-policy.json'), {});
  const policy = { ...DEFAULT_RIDER_POLICY, ...configured };
  for (const kind of ['samples', 'events', 'journeys']) policy[kind] = { ...DEFAULT_RIDER_POLICY[kind], ...configured[kind] };
  for (const value of [policy.imageMaxBytes, policy.imageMaxAgeMs,
    ...['samples', 'events', 'journeys'].flatMap(k => Object.values(policy[k]))]) {
    if (!Number.isFinite(value) || value <= 0) throw Error('Storage policy limits must be positive finite numbers');
  }
  for (const kind of ['samples', 'events', 'journeys']) if (!Number.isInteger(policy[kind].maxFiles)) throw Error('maxFiles must be an integer');
  return policy;
}
export async function withStorageLock(root, fn) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'storage.lock'), deadline = Date.now() + 10000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number(await fs.readFile(file, 'utf8').catch(() => ''));
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (status) { if (status.code === 'ESRCH') { await fs.unlink(file).catch(() => {}); continue; } }
      } else {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30000) { await fs.unlink(file).catch(() => {}); continue; }
      }
      if (Date.now() >= deadline) throw Error('Rider storage is busy');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await fn(); }
  finally { await handle.close(); await fs.unlink(file); }
}

const safeImage = name => typeof name === 'string' && path.basename(name) === name && name.endsWith('.jpg');
async function inventory(root) {
  const directory = path.join(root, 'images');
  await fs.mkdir(directory, { recursive: true });
  const metadata = new Map();
  try {
    const raw = await fs.readFile(path.join(root, 'images.jsonl'), 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      const item = JSON.parse(line); if (safeImage(item.name)) metadata.set(item.name, item);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const images = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !safeImage(entry.name)) continue;
    const stat = await fs.stat(path.join(directory, entry.name));
    const item = metadata.get(entry.name) ?? { name: entry.name, at: new Date(stat.mtimeMs).toISOString(), label: 'Recovered capture' };
    images.push({ ...item, bytes: stat.size, time: Number.isFinite(Date.parse(item.at)) ? Date.parse(item.at) : stat.mtimeMs });
  }
  return images.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function writeGallery(root, images, status) {
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="60"><title>Ongoing rider QA</title><style>body{font:16px system-ui;max-width:1000px;margin:24px auto;padding:16px}img{max-width:390px;width:100%}article{display:inline-block;vertical-align:top;margin:12px}p{max-width:850px}</style><h1>Ongoing simulated rider QA</h1><p>GPS-simulated riders follow the operator feed; arrival observations are not independent ground truth. Candidate anomalies require review.</p><p>Updated ' + escape(new Date().toISOString()) + ' · ' + escape(status?.line ?? 'Selecting') + ' · ' + escape(status?.phase ?? 'idle') + '</p><p><a href="status.json">Current status</a> · <a href="events.jsonl">Events</a> · <a href="journeys.jsonl">Completed journeys</a> · <a href="retention.json">Storage</a></p>' + images.slice(-100).reverse().map(i => '<article><p>' + escape(i.at + ' ' + i.label) + '</p><a href="images/' + encodeURIComponent(i.name) + '"><img loading="lazy" src="images/' + encodeURIComponent(i.name) + '"></a></article>').join('');
  const temp = path.join(root, 'index.html.partial'); await fs.writeFile(temp, html); await fs.rename(temp, path.join(root, 'index.html'));
}
async function trimImages(root, { activeRunId, incoming, buffer, now = Date.now(), status, dryRun = false } = {}) {
  const policy = await riderPolicy(root), pins = await readJson(path.join(root, 'storage-pins.json'), {});
  let images = await inventory(root);
  if (incoming) {
    if (!safeImage(incoming.name)) throw Error('Invalid image filename');
    const stem = incoming.name.slice(0, -4);
    for (let suffix = 2; images.some(i => i.name === incoming.name); suffix++) incoming = { ...incoming, name: `${stem}-${suffix}.jpg` };
    if (!dryRun) await fs.writeFile(path.join(root, 'images', incoming.name), buffer, { flag: 'wx' });
    images.push({ ...incoming, bytes: buffer.length, time: now });
  }
  let bytes = images.reduce((sum, item) => sum + item.bytes, 0), freedBytes = 0;
  const removed = new Set();
  const protectedImage = item => item.name === incoming?.name || (activeRunId && item.runId === activeRunId)
    || pins.names?.includes(item.name) || (item.runId && pins.runIds?.includes(item.runId));
  for (const item of images) {
    if (protectedImage(item) || (item.time >= now - policy.imageMaxAgeMs && bytes <= policy.imageMaxBytes)) continue;
    if (!dryRun) await fs.unlink(path.join(root, 'images', item.name));
    removed.add(item.name); bytes -= item.bytes; freedBytes += item.bytes;
  }
  images = images.filter(i => !removed.has(i.name));
  const result = { updatedAt: new Date(now).toISOString(), imageBytes: bytes, imageCount: images.length,
    imageLimitBytes: policy.imageMaxBytes, imageMaxAgeDays: policy.imageMaxAgeMs / DAY,
    protectedOverageBytes: Math.max(0, bytes - policy.imageMaxBytes), deletedImages: removed.size, freedBytes };
  if (!dryRun) {
    const temp = path.join(root, 'images.jsonl.partial');
    await fs.writeFile(temp, images.map(({ time, ...item }) => JSON.stringify(item) + '\n').join(''));
    await fs.rename(temp, path.join(root, 'images.jsonl'));
    await atomicJson(path.join(root, 'retention.json'), result);
    await writeGallery(root, images, status ?? await readJson(path.join(root, 'status.json'), {}));
  }
  return result;
}
export function maintainImages(root, options) { return withStorageLock(root, () => trimImages(root, options)); }
export function saveImage(root, item, buffer, activeRunId, status) {
  return maintainImages(root, { incoming: item, buffer, activeRunId, status });
}

async function rotateLog(root, kind, policy, incomingBytes, now, dryRun) {
  const file = path.join(root, `${kind}.jsonl`);
  const stat = await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat?.size && stat.size + incomingBytes > policy.chunkBytes && !dryRun) {
    let stamp = now;
    while (await fs.stat(path.join(root, `${kind}-${stamp}.jsonl`)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) stamp++;
    await fs.rename(file, path.join(root, `${kind}-${stamp}.jsonl`));
  }
  const archives = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const match = new RegExp(`^${kind}-(\\d+)\\.jsonl$`).exec(entry.name);
    if (entry.isFile() && match) {
      const info = await fs.stat(path.join(root, entry.name));
      archives.push({ name: entry.name, time: Number(match[1]), size: info.size });
    }
  }
  archives.sort((a, b) => b.time - a.time);
  let freedBytes = 0, deletedFiles = 0;
  for (let i = 0; i < archives.length; i++) {
    const item = archives[i];
    if (i < policy.maxFiles - 1 && item.time >= now - policy.maxAgeMs) continue;
    if (!dryRun) await fs.unlink(path.join(root, item.name));
    freedBytes += item.size; deletedFiles++;
  }
  return { freedBytes, deletedFiles };
}
export async function appendRolling(root, kind, row) {
  if (!['samples', 'events', 'journeys'].includes(kind)) throw Error('Unsupported rider log');
  return withStorageLock(root, async () => {
    const policy = await riderPolicy(root), raw = JSON.stringify(row) + '\n';
    await rotateLog(root, kind, policy[kind], Buffer.byteLength(raw), Date.now(), false);
    await fs.appendFile(path.join(root, `${kind}.jsonl`), raw);
  });
}
export function maintainRiderLogs(root, { now = Date.now(), dryRun = false } = {}) {
  return withStorageLock(root, async () => {
    const policy = await riderPolicy(root), results = {};
    for (const kind of ['samples', 'events', 'journeys']) results[kind] = await rotateLog(root, kind, policy[kind], 0, now, dryRun);
    return results;
  });
}
