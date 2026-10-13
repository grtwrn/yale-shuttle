#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MiB, atomicJson, readJson, maintainImages, maintainRiderLogs, withStorageLock } from './storage.mjs';
import { maintainLearning } from './learning.mjs';

export async function rotateOutput(file, { maxBytes = 10 * MiB, maxBackups = 3, dryRun = false } = {}) {
  const stat = await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!stat || stat.size <= maxBytes) return { file, freedBytes: 0 };
  if (dryRun) return { file, wouldRotateBytes: stat.size };
  // launchd opens these logs with O_APPEND. Copy/truncate retains its open
  // descriptor; renaming would leave the service writing the retired inode.
  const handle = await fs.open(file, 'r+');
  let keptBytes;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    await handle.read(buffer, 0, buffer.length, stat.size - buffer.length);
    let stamp = Date.now();
    while (await fs.stat(`${file}.${stamp}.gz`).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) stamp++;
    await fs.writeFile(`${file}.${stamp}.gz`, zlib.gzipSync(buffer), { flag: 'wx' });
    await handle.truncate(0); keptBytes = buffer.length;
  } finally { await handle.close(); }
  const dir = path.dirname(file), prefix = path.basename(file) + '.';
  const archives = (await fs.readdir(dir)).filter(n => n.startsWith(prefix) && /\.\d+\.gz$/.test(n)).sort();
  for (const name of archives.slice(0, Math.max(0, archives.length - maxBackups))) await fs.unlink(path.join(dir, name));
  return { file, freedBytes: stat.size, archivedTailBytes: keptBytes };
}
async function maintainUnlocked(service, { dryRun = false, learningRoot = path.join(service, 'scripts/.learning-loop') } = {}) {
  const result = { updatedAt: new Date().toISOString(), dryRun, riders: {}, outputs: [] };
  for (const name of ['.rider-watcher', '.rider-watcher-red']) {
    const root = path.join(service, 'scripts', name);
    if (!await fs.stat(root).catch(() => null)) continue;
    const resume = await readJson(path.join(root, 'resume.json'), null);
    const status = await readJson(path.join(root, 'status.json'), {});
    const activeRunId = resume?.run?.id ?? (status.startedAt ? String(Date.parse(status.startedAt)) : undefined);
    result.riders[name] = { images: await maintainImages(root, { activeRunId, dryRun }), logs: await maintainRiderLogs(root, { dryRun }) };
    result.outputs.push(await rotateOutput(path.join(root, 'dashboard.log'), { dryRun }));
  }
  result.learning = await maintainLearning(learningRoot, { dryRun });
  for (const name of ['watcher.log', 'watcher-red.log', 'learning.log', 'storage.log']) result.outputs.push(await rotateOutput(path.join(service, 'scripts', name), { dryRun }));
  if (!dryRun) {
    const dir = path.join(service, 'scripts/.storage'); await fs.mkdir(dir, { recursive: true });
    await atomicJson(path.join(dir, 'status.json'), result);
  }
  return result;
}
export function maintain(service, options) {
  return withStorageLock(path.join(service, 'scripts/.storage'), () => maintainUnlocked(service, options));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = await maintain(service, { dryRun: process.argv.includes('--dry-run') });
  console.log(JSON.stringify({ ...result, learning: { ...result.learning, removed: undefined } }, null, 2));
}
