#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preserveReportEvidence } from './evidence.mjs';
import { monitorFetch, monitorNetworkSummary } from '../monitor-fetch.mjs';

const exec = promisify(execFile);
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const day = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const INITIAL_REPORT_LIMIT = 200, EXPANDED_REPORT_LIMIT = 1000, PENDING_LIMIT = 1000;
const REPORT_BODY_BYTES = 16 * 1024 * 1024;

class ReportWatchCoverageError extends Error {
  constructor(reason) { super('Report coverage is incomplete'); this.reason = reason; }
}

function within(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function boundedReportJson(response, signal, maxBytes) {
  // Native fetch and the monitor DNS fallback expose the decoded body here.
  // Apply the byte limit before parsing, even for a compressed HTTP response.
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0, ended = false;
    try {
      for (;;) {
        const next = await within(reader.read(), signal);
        if (next.done) { ended = true; break; }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new ReportWatchCoverageError('response-bytes');
        chunks.push(Buffer.from(next.value));
      }
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } finally {
      if (!ended) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  // Dependency-injected JSON-only fetchers retain the same admission. Real
  // network responses always use the bounded stream above.
  const data = await within(response.json(), signal);
  if (Buffer.byteLength(JSON.stringify(data)) > maxBytes) throw new ReportWatchCoverageError('response-bytes');
  return data;
}

function validOpenRows(rows, limit) {
  if (!Array.isArray(rows) || rows.length > limit) return false;
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || row.status !== 'open'
      || typeof row.body !== 'string' || !['urgent', 'normal', 'nice_to_have'].includes(row.priority)
      || !(row.note === null || typeof row.note === 'string')
      || !(row.context === null || typeof row.context === 'string')
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return false;
    ids.add(row.id);
  }
  return true;
}

/** Escalate only a full first batch. The final observed set determines
 * completeness; this API has no pagination or durable update cursor. */
export async function loadOpenReports({ fetcher, base, token, budgetMs = 20000, maxBytes = REPORT_BODY_BYTES }) {
  const controller = new AbortController(), began = performance.now();
  const timeout = setTimeout(() => controller.abort(new Error('Report fetch budget exceeded')), budgetMs);
  try {
    for (const limit of [INITIAL_REPORT_LIMIT, EXPANDED_REPORT_LIMIT]) {
      const res = await within(fetcher(new URL(`/api/reports?status=open&limit=${limit}`, base),
        { headers: { 'x-admin-token': token }, signal: controller.signal }), controller.signal);
      if (!res.ok) throw new Error('Reports endpoint check failed');
      const data = await boundedReportJson(res, controller.signal, maxBytes);
      controller.signal.throwIfAborted();
      if (performance.now() - began >= budgetMs) throw new Error('Report fetch budget exceeded');
      if (!data || !validOpenRows(data.reports, limit)) throw new ReportWatchCoverageError('invalid-response');
      if (data.reports.length < limit || limit === EXPANDED_REPORT_LIMIT) return { reports: data.reports,
        coverage: { complete: data.reports.length < limit, limit, observedReports: data.reports.length,
          reason: data.reports.length < limit ? 'complete' : 'response-limit' } };
    }
  } finally { clearTimeout(timeout); controller.abort(); }
}
// The same projection as server/reports.ts riderFacingNote, with a parity
// test. Keep this dependency-free scheduled Node process out of the TS server
// module graph. Internal investigations must not become new rider work.
function visibleNote(note) {
  if (note == null) return null;
  let text = note.replace(/\r\n/g, '\n');
  const rule = text.search(/^[ \t]*-{3,}[ \t]*$/m);
  if (rule >= 0) text = text.slice(0, rule);
  text = text.trim();
  for (;;) {
    const next = text.replace(/^(?:\[[a-z-]+\]|automated(?:-abuse)?:)\s*/i, '');
    if (next === text) break;
    text = next.trimStart();
  }
  return text.length > 0 ? text : null;
}
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
  if (!validOpenRows(reports, EXPANDED_REPORT_LIMIT)) throw new ReportWatchCoverageError('invalid-response');
  const seen = { ...prior?.seen }, pending = new Map((prior?.pending ?? []).map(r => [r.id, r]));
  const events = [], openIds = new Set();
  for (const report of reports) {
    openIds.add(report.id);
    let followups = [];
    try { followups = JSON.parse(report.context ?? '{}').followups ?? []; } catch { /* no thread */ }
    const digest = hash([report.body, visibleNote(report.note), report.priority, followups]);
    const old = seen[report.id];
    // A v1 digest also included the raw operator note. Upgrade unchanged
    // entries quietly, but retain an alert for any unclassified change during
    // migration: the old state cannot prove that only internal text changed.
    const comparisonDigest = old?.fingerprintVersion === 2 ? digest
      : hash([report.body, report.note, report.priority, followups]);
    const actionable = old ? old.digest !== comparisonDigest : !!prior || day(report.createdAt) === day(now);
    if (actionable) {
      const event = { id: report.id, kind: old ? 'report-updated' : 'report-submitted', detectedAt: new Date(now).toISOString(),
        createdAt: report.createdAt, priority: report.priority, body: String(report.body ?? '').slice(0, 1000),
        followupCount: Array.isArray(followups) ? followups.length : 0 };
      events.push(event); pending.set(report.id, event);
    }
    seen[report.id] = { digest, fingerprintVersion: 2, lastSeenAt: now };
  }
  if (complete) for (const id of pending.keys()) if (!openIds.has(id)) pending.delete(id);
  // Unseen pending reports remain protected when a response is incomplete.
  // Refuse a new state before either saved file is replaced; slicing would
  // silently discard the oldest unresolved work.
  if (pending.size > PENDING_LIMIT) throw new ReportWatchCoverageError('pending-capacity');
  return { version: 2, checkedAt: new Date(now).toISOString(),
    seen: Object.fromEntries(Object.entries(seen).sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt).slice(0, 1000)),
    pending: [...pending.values()].sort((a, b) => b.id - a.id),
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
async function notifyHealth(kind, cause) {
  // Fixed operator text only: endpoint errors and credentials never enter alerts.
  await desktopNotification(kind === 'failed' && cause === 'coverage'
    ? 'Report watcher coverage was incomplete for three checks. The saved review queue is preserved; older reports may need review.'
    : kind === 'failed'
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
  fetcher = monitorFetch, notifier = notify, healthNotifier = notifyHealth, now = Date.now() } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await rotateLog(path.join(dir, 'watcher.log'));
  const healthFile = path.join(dir, 'health.json');
  // A damaged notification receipt can be rebuilt. The report state and queue
  // are never discarded to make a failed check appear successful.
  const savedHealth = await read(healthFile, {}).catch(() => ({}));
  const health = savedHealth && typeof savedHealth === 'object' && !Array.isArray(savedHealth) ? savedHealth : {};
  let prior = null, persisted = null, notificationError = null;
  let coverage = { complete: null, limit: INITIAL_REPORT_LIMIT, observedReports: null, reason: 'unavailable' };
  try {
    prior = await read(path.join(dir, 'state.json'), null);
    const token = (await fs.readFile(tokenFile, 'utf8')).trim();
    const loaded = await loadOpenReports({ fetcher, base, token });
    coverage = loaded.coverage;
    const reports = loaded.reports;
    const state = reconcileReports(prior, reports, now, coverage.complete);
    // Persist before notifying so restarting cannot repeat the same alert.
    await write(path.join(dir, 'state.json'), state);
    await write(path.join(dir, 'queue.json'), { checkedAt: state.checkedAt, pending: state.pending });
    persisted = state;
    try { await notifier(state.events); } catch { notificationError = 'Local notification could not be delivered'; }
    // The review queue and its notification survive evidence failures. Every
    // later poll retries incomplete bundles even after event deduplication.
    const evidence = await preserveReportEvidence({dir,reports,base,token,fetcher,now,
      complete:!state.saturated});
    await write(path.join(dir,'evidence-status.json'),{checkedAt:state.checkedAt,...evidence});
    if (!evidence.ok) throw new Error('Report diagnostic evidence capture is incomplete');
    if (!coverage.complete) throw new ReportWatchCoverageError('response-limit');
    let failureNotified = health.failureNotified === true;
    if (failureNotified) {
      try { await healthNotifier('recovered'); failureNotified = false; }
      catch { notificationError = 'Local notification could not be delivered'; }
    }
    await write(healthFile, { consecutiveFailures: 0, failureNotified,
      lastSuccessAt: state.checkedAt, lastKnownPending: state.pending.length });
    const status = { checkedAt: state.checkedAt, ok: true, openReports: reports.length, pending: state.pending.length,
      latestReportId: Math.max(0, ...reports.map(r => r.id)), newOrUpdated: state.events.map(e => e.id), coverage,
      saturated: state.saturated, consecutiveFailures: 0, notificationError,
      ...(fetcher === monitorFetch ? { transport: monitorNetworkSummary() } : {}),
      evidence:{ok:evidence.ok,newlyRetained:evidence.captured.length,newlyUnavailable:evidence.unavailable.length,
        bytes:evidence.bytes,maxBytes:evidence.maxBytes,cleanupUncertain:evidence.cleanupUncertain} };
    await write(path.join(dir, 'status.json'), status); return status;
  } catch (error) {
    if (error instanceof ReportWatchCoverageError) coverage = { ...coverage, complete: false, reason: error.reason };
    const consecutiveFailures = Math.min(1000,
      (Number.isSafeInteger(health.consecutiveFailures) && health.consecutiveFailures >= 0 ? health.consecutiveFailures : 0) + 1);
    let failureNotified = health.failureNotified === true;
    if (consecutiveFailures >= 3 && !failureNotified) {
      try { await healthNotifier('failed', coverage.complete === false ? 'coverage' : undefined); failureNotified = true; }
      catch { notificationError = 'Local notification could not be delivered'; }
    }
    const pending = persisted?.pending?.length ?? prior?.pending?.length ?? health.lastKnownPending ?? null;
    await write(healthFile, { consecutiveFailures, failureNotified, lastFailureAt: new Date(now).toISOString(),
      lastSuccessAt: health.lastSuccessAt ?? null, lastKnownPending: pending });
    // Do not print exception details: credentials and report contents stay local.
    await write(path.join(dir, 'status.json'), { checkedAt: new Date(now).toISOString(), ok: false,
      pending, consecutiveFailures, failureNotified, notificationError, coverage,
      saturated: coverage.reason === 'response-limit' || coverage.reason === 'pending-capacity',
      ...(persisted ? { observedOpenReports: coverage.observedReports,
        newOrUpdated: persisted.events.map(event => event.id) } : {}),
      ...(fetcher === monitorFetch ? { transport: monitorNetworkSummary() } : {}),
      error: coverage.complete === false ? 'Report coverage is incomplete; the saved review queue is preserved'
        : 'Report check failed; retrying on the next scheduled poll' });
    throw new Error('Report check failed; retrying on the next scheduled poll');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await pollReports())); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
