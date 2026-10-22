import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditDisplay, type AuditFeed, type Finding } from './check';
import { matchesProduction } from '../deployment-scope.mjs';

type Observation = { firstAt: number; lastAt: number; firstPoll: number; reported: boolean; finding: Finding };
interface State { build: string; observations: Record<string, Observation>; queue: { at: string; build: string; findings: Finding[] }[] }
const atomic = async (file: string, data: unknown) => {
  await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
};
const readState = async (file: string): Promise<State | null> => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
const MiB = 1024 * 1024;
const FAILURE_PART_BYTES = MiB;
const FAILURE_CHECK_BYTES = 2 * MiB;
const FAILURE_HISTORY_BYTES = 8 * MiB;
const FAILURE_HISTORY_CHECKS = 32;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface DiagnosticPart {
  state: 'captured' | 'oversized' | 'unavailable' | 'unserializable' | 'check-bound';
  bytes?: number; sha256?: string; json?: string;
}
interface FailureRecord { checkedAt: string; bytes: number; sha256: string; json: string }
function diagnosticPart(value: unknown): DiagnosticPart {
  if (value == null) return { state: 'unavailable' };
  try {
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
    return bytes > FAILURE_PART_BYTES ? { state: 'oversized', bytes, sha256: digest(json) }
      : { state: 'captured', bytes, sha256: digest(json), json };
  } catch { return { state: 'unserializable' }; }
}
async function retainUnavailable(directory: string, checkedAt: string, revision: string, error: unknown,
  responseStatus: { health: number | null; feed: number | null }, health: unknown, feed: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const check = { v: 1, checkedAt, complete: false, operatorRevision: revision.slice(0, 128), revisionTruncated: revision.length > 128,
    error: { message: message.slice(0, 1024), truncated: message.length > 1024,
      bytes: Buffer.byteLength(message), sha256: digest(message) }, responseStatus,
    values: { health: diagnosticPart(health), feed: diagnosticPart(feed) } };
  check.complete = Object.values(check.values).every(part => part.state === 'captured');
  let json = JSON.stringify(check);
  if (Buffer.byteLength(json) > FAILURE_CHECK_BYTES) {
    for (const part of Object.values(check.values)) if (part.state === 'captured') {
      part.state = 'check-bound'; delete part.json;
    }
    check.complete = false;
    json = JSON.stringify(check);
  }
  const record: FailureRecord = { checkedAt, bytes: Buffer.byteLength(json), sha256: digest(json), json };
  if (record.bytes > FAILURE_CHECK_BYTES) throw new Error('Unavailable-check metadata exceeds its bound');
  const file = path.join(directory, 'unavailable-history.json');
  let checks: FailureRecord[] = [];
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FAILURE_HISTORY_BYTES) throw new Error('Invalid unavailable-check history');
    const raw = await fs.readFile(file);
    if (raw.length > FAILURE_HISTORY_BYTES) throw new Error('Unavailable-check history exceeds its bound');
    const history = JSON.parse(raw.toString('utf8'));
    if (history?.v !== 1 || !Array.isArray(history.checks) || history.checks.length > FAILURE_HISTORY_CHECKS
      || !history.checks.every((r: FailureRecord) => typeof r?.checkedAt === 'string' && typeof r.json === 'string'
        && Buffer.byteLength(r.json) === r.bytes && digest(r.json) === r.sha256)) throw new Error('Invalid unavailable-check history');
    checks = history.checks;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  checks.push(record);
  let evictedChecks = 0;
  const history = { v: 1, checks, scope: 'Rolling availability diagnostics from parsed check inputs; not original HTTP bytes or an ETA accuracy result.' };
  while (checks.length > FAILURE_HISTORY_CHECKS || Buffer.byteLength(JSON.stringify(history, null, 2) + '\n') > FAILURE_HISTORY_BYTES) {
    checks.shift(); evictedChecks++;
  }
  await atomic(file, history);
  return { file, checkedAt, bytes: record.bytes, sha256: record.sha256, retainedChecks: checks.length, evictedChecks };
}
export async function rotateLog(file: string, limit = 1024 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r+');
    const { size } = await handle.stat();
    if (size <= limit) return;
    const tail = Buffer.alloc(limit);
    await handle.read(tail, 0, limit, size - limit);
    await fs.writeFile(file + '.1', tail, { mode: 0o600 });
    // launchd may retain its stdout descriptor. Keep that inode and truncate
    // it, so future writes cannot grow an unlinked/renamed file indefinitely.
    await handle.truncate(0);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  finally { await handle?.close(); }
}
export function observe(previous: State | null, findings: Finding[], build: string, pollAt: number, now: number) {
  const state: State = { build, observations: {}, queue: previous?.queue ?? [] };
  const alerts: Finding[] = [];
  for (const finding of findings.slice(0, 2000)) {
    const key = JSON.stringify(finding);
    const old = previous?.build === build ? previous.observations[key] : undefined;
    const observation: Observation = old && now - old.lastAt <= 150_000
      ? { ...old, lastAt: now } : { firstAt: now, lastAt: now, firstPoll: pollAt, reported: false, finding };
    if (!observation.reported && now - observation.firstAt >= 5000 && pollAt - observation.firstPoll >= 5000) {
      alerts.push(finding); observation.reported = true;
    }
    state.observations[key] = observation;
  }
  if (alerts.length) state.queue = [...state.queue, { at: new Date(now).toISOString(), build, findings: alerts }].slice(-100);
  return { state, alerts };
}

export async function poll({ directory, revision, sourceClean = true, sourceMatches, base = 'https://yale-shuttle.fly.dev',
  fetchImpl = fetch, clock = Date.now, notify = async (_count: number) => {} }: {
  directory: string; revision: string; sourceClean?: boolean; sourceMatches?: (build: string) => boolean; base?: string;
  fetchImpl?: typeof fetch; clock?: () => number; notify?: (count: number) => Promise<void>;
}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(directory, 'state.json');
  let healthInput: { ok: boolean; build: string } | null = null, feedInput: AuditFeed | null = null;
  const responseStatus: { health: number | null; feed: number | null } = { health: null, feed: null };
  try {
    const previous = await readState(stateFile);
    const [healthResponse, feedResponse] = await Promise.all([
      fetchImpl(base + '/healthz', { signal: AbortSignal.timeout(20_000) }),
      fetchImpl(base + '/api/buses', { signal: AbortSignal.timeout(20_000) }),
    ]);
    responseStatus.health = healthResponse.status; responseStatus.feed = feedResponse.status;
    if (!healthResponse.ok || !feedResponse.ok) throw new Error(`HTTP health=${healthResponse.status}, feed=${feedResponse.status}`);
    const health = healthInput = await healthResponse.json() as { ok: boolean; build: string };
    if (!health?.ok || !sourceClean || typeof health.build !== 'string' || !/^[a-f0-9]{7,40}$/.test(health.build)
      || !(sourceMatches ? sourceMatches(health.build) : revision.startsWith(health.build))) {
      throw new Error('Production build and clean local screen-calculator revision must match');
    }
    const feed = feedInput = await feedResponse.json() as AuditFeed;
    const now = clock();
    const result = auditDisplay(feed, now);
    const pollAt = result.activity === 'idle' ? now : (feed.server_eta as { at: number }).at;
    const { state, alerts } = observe(previous, result.findings, health.build, pollAt, now);
    await atomic(stateFile, state);
    // A bounded, durable operator review queue. Absence of a stand on a later
    // poll does not erase the earlier incident or claim it was fixed.
    await atomic(path.join(directory, 'queue.json'), state.queue);
    if (alerts.length) await atomic(path.join(directory, 'last-failure.json'), { receivedAt: now, build: health.build, findings: alerts, feed });
    let notificationError: string | null = null;
    if (alerts.length) try { await notify(alerts.length); } catch { notificationError = 'Desktop notification failed; incident is saved'; }
    const status = { checkedAt: new Date(now).toISOString(), ok: true, build: health.build, operatorRevision: revision, ...result,
      confirmed: Object.values(state.observations).filter(o => o.reported).length,
      queuedBatches: state.queue.length, newAlerts: alerts.length, notificationError };
    await atomic(path.join(directory, 'status.json'), status);
    await atomic(path.join(directory, 'health.json'), { failures: 0, notified: false });
    return status;
  } catch (error) {
    const checkedAt = new Date(clock()).toISOString();
    let failureEvidence: Awaited<ReturnType<typeof retainUnavailable>> | null = null, failureEvidenceError: string | null = null;
    try { failureEvidence = await retainUnavailable(directory, checkedAt, revision, error, responseStatus, healthInput, feedInput); }
    catch { failureEvidenceError = 'Could not retain unavailable-check inputs; existing evidence is preserved'; }
    const status = { checkedAt, ok: false, error: (error as Error).message, failureEvidence, failureEvidenceError };
    await atomic(path.join(directory, 'status.json'), status);
    const healthFile = path.join(directory, 'health.json');
    let health = { failures: 0, notified: false };
    try { health = JSON.parse(await fs.readFile(healthFile, 'utf8')); } catch { /* a new failure streak */ }
    health.failures = Math.min(health.failures + 1, 1000);
    if (health.failures >= 3 && !health.notified) {
      try { await notify(0); health.notified = true; } catch { /* retry notification on the next failed poll */ }
    }
    await atomic(healthFile, health);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceMatches = (build: string) => matchesProduction(build, { revision });
  const directory = path.resolve(process.env.DISPLAY_AUDIT_DIR ?? 'scripts/.bot-artifacts/display-audit');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const logFile = path.join(directory, 'watcher.log');
  await rotateLog(logFile);
  const notify = async (count: number) => {
    if (process.platform === 'darwin' && process.env.DISPLAY_AUDIT_NOTIFY !== '0') execFileSync('/usr/bin/osascript',
      ['-e', `display notification "${count ? `${count} shuttle display inconsistencies saved for review.` : 'Display checks unavailable for 3 polls. Check monitor status.'}" with title "Yale shuttle monitor"`], { timeout: 10_000 });
  };
  try { console.log(JSON.stringify(await poll({ directory, revision, sourceMatches, notify, base: process.env.BOT_BASE_URL ?? 'https://yale-shuttle.fly.dev' }))); }
  catch (error) { console.error(new Date().toISOString(), (error as Error).message); process.exitCode = 1; }
}
