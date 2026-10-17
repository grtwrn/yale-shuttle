#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
async function write(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Reports are untrusted descriptions. Keep only review data locally, never
 * execute their contents, post replies, alter report status, or start agents. */
export function reconcileReports(prior, reports, now = Date.now(), complete = reports.length < 200) {
  const seen = { ...prior?.seen }, pending = new Map((prior?.pending ?? []).map(r => [r.id, r]));
  const events = [], openIds = new Set();
  for (const report of reports) {
    if (!Number.isSafeInteger(report.id) || report.status !== 'open') continue;
    openIds.add(report.id);
    let followups = [];
    try { followups = JSON.parse(report.context ?? '{}').followups ?? []; } catch { /* no thread */ }
    const digest = hash([report.body, report.note, report.priority, followups]);
    const old = seen[report.id];
    const actionable = old ? old.digest !== digest : !!prior || day(report.createdAt) === day(now);
    if (actionable) {
      const event = { id: report.id, kind: old ? 'report-updated' : 'report-submitted', detectedAt: new Date(now).toISOString(),
        createdAt: report.createdAt, priority: report.priority, body: String(report.body ?? '').slice(0, 1000),
        followupCount: Array.isArray(followups) ? followups.length : 0 };
      events.push(event); pending.set(report.id, event);
    }
    seen[report.id] = { digest, lastSeenAt: now };
  }
  if (complete) for (const id of pending.keys()) if (!openIds.has(id)) pending.delete(id);
  return { version: 1, checkedAt: new Date(now).toISOString(),
    seen: Object.fromEntries(Object.entries(seen).sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt).slice(0, 1000)),
    pending: [...pending.values()].sort((a, b) => b.id - a.id).slice(0, 1000),
    recent: [...events, ...(prior?.recent ?? [])].slice(0, 100), events, saturated: !complete };
}

async function desktopNotification(message) {
  if (process.platform !== 'darwin' || process.env.REPORT_WATCH_NOTIFY === '0') return;
  await exec('/usr/bin/osascript', ['-e', 'on run argv\n display notification (item 1 of argv) with title "Yale Shuttle reports"\nend run',
    message], { timeout: 10000 });
}
async function notify(events) {
  if (!events.length) return;
  const ids = events.slice(0, 5).map(e => `#${e.id}`).join(', ');
  // Only numeric report IDs enter the OS notification. No report prose is code.
  await desktopNotification(`${events.length} new or updated report${events.length === 1 ? '' : 's'}: ${ids}`);
}
async function notifyHealth(kind) {
  // Fixed operator text only: endpoint errors and credentials never enter alerts.
  await desktopNotification(kind === 'failed'
    ? 'Report watcher failed three consecutive checks. The saved review queue is preserved; checks will retry.'
    : 'Report watcher recovered and is checking submitted reports again.');
}

async function rotateLog(file) {
  const size = await fs.stat(file).then(s => s.size).catch(() => 0);
  if (size <= 1024 * 1024) return;
  const handle = await fs.open(file, 'r+');
  try {
    const tail = Buffer.alloc(1024 * 1024); await handle.read(tail, 0, tail.length, size - tail.length);
    await fs.writeFile(`${file}.previous`, tail, { mode: 0o600 }); await handle.truncate(0);
  } finally { await handle.close(); }
}

export async function pollReports({ dir = process.env.REPORT_WATCH_DIR ?? path.join(service, 'scripts/.bot-artifacts/report-watch'),
  base = process.env.REPORT_WATCH_BASE_URL ?? 'https://yale-shuttle.fly.dev',
  tokenFile = process.env.SHUTTLE_ADMIN_TOKEN_FILE ?? path.join(os.homedir(), '.config/yale-shuttle/admin-token'),
  fetcher = fetch, notifier = notify, healthNotifier = notifyHealth, now = Date.now() } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await rotateLog(path.join(dir, 'watcher.log'));
  const healthFile = path.join(dir, 'health.json');
  // A damaged notification receipt can be rebuilt. The report state and queue
  // are never discarded to make a failed check appear successful.
  const health = await read(healthFile, {}).catch(() => ({}));
  let prior = null;
  try {
    prior = await read(path.join(dir, 'state.json'), null);
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    const res = await fetcher(new URL('/api/reports?status=open&limit=200', base),
      { headers: { 'x-admin-token': token }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Reports endpoint returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.reports)) throw new Error('Reports endpoint returned an invalid queue');
    const state = reconcileReports(prior, data.reports, now);
    // Persist before notifying so restarting cannot repeat the same alert.
    await write(path.join(dir, 'state.json'), state);
    await write(path.join(dir, 'queue.json'), { checkedAt: state.checkedAt, pending: state.pending });
    let notificationError = null;
    try { await notifier(state.events); } catch { notificationError = 'Local notification could not be delivered'; }
    let failureNotified = health.failureNotified === true;
    if (failureNotified) {
      try { await healthNotifier('recovered'); failureNotified = false; }
      catch { notificationError = 'Local notification could not be delivered'; }
    }
    await write(healthFile, { consecutiveFailures: 0, failureNotified,
      lastSuccessAt: state.checkedAt, lastKnownPending: state.pending.length });
    const status = { checkedAt: state.checkedAt, ok: true, openReports: data.reports.length, pending: state.pending.length,
      latestReportId: Math.max(0, ...data.reports.map(r => r.id)), newOrUpdated: state.events.map(e => e.id),
      saturated: state.saturated, consecutiveFailures: 0, notificationError };
    await write(path.join(dir, 'status.json'), status); return status;
  } catch (error) {
    const consecutiveFailures = (Number.isSafeInteger(health.consecutiveFailures) ? health.consecutiveFailures : 0) + 1;
    let failureNotified = health.failureNotified === true, notificationError = null;
    if (consecutiveFailures >= 3 && !failureNotified) {
      try { await healthNotifier('failed'); failureNotified = true; }
      catch { notificationError = 'Local notification could not be delivered'; }
    }
    const pending = prior?.pending?.length ?? health.lastKnownPending ?? null;
    await write(healthFile, { consecutiveFailures, failureNotified, lastFailureAt: new Date(now).toISOString(),
      lastSuccessAt: health.lastSuccessAt ?? null, lastKnownPending: pending });
    // Do not print exception details: credentials and report contents stay local.
    await write(path.join(dir, 'status.json'), { checkedAt: new Date(now).toISOString(), ok: false,
      pending, consecutiveFailures, failureNotified, notificationError,
      error: 'Report check failed; retrying on the next scheduled poll' });
    throw new Error('Report check failed; retrying on the next scheduled poll');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await pollReports())); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
