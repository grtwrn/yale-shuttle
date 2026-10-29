#!/usr/bin/env node
import fs from 'node:fs/promises';
import { probeContainerObserver } from '../learning-runtime/owner.mjs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, withStorageLock, MiB } from '../retention/storage.mjs';
import { rotateOutput } from '../retention/maintain.mjs';
import { identityHash } from '../reestimate-validation.mjs';
import { collectPlatform } from './platform.mjs';
import { advanceTrialProgress } from './progress.mjs';

const exec = promisify(execFile);
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cycleId = state => /^cycle-\d+$/.test(state?.id ?? '') ? state.id : 'unknown';
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (at, now, limit) => Number.isFinite(at) && now - at >= -5000 && now - at <= limit;

/** Operational health only: this neither certifies an accuracy gain nor changes
 * evidence, parameters, cycles or observer processes. Warmup parity is diagnostic. */
export function inspect({ state, status, frozen, observer }, now = Date.now()) {
  const issues = [];
  const add = (code, summary) => issues.push({ code, summary });
  if (!observer?.alive || !observer.expectedCommand) add('observer-process', 'The expected learning observer process is missing or the PID belongs to another command.');
  if (!status?.running || !fresh(stamp(status?.updatedAt), now, 120000)) add('observer-heartbeat', 'The learning observer is stopped or its heartbeat is missing, stale or invalid.');
  if (!fresh(stamp(status?.feedReceivedAt), now, 30000)) add('feed-receipt', 'The learning observer has no fresh HTTP feed receipt.');
  if (!fresh(stamp(status?.lastInputAt), now, 60000)) add('distinct-input', 'The learning observer has not consumed a distinct input recently.');
  if (status?.error) add('observer-error', 'The learning observer reports an error; inspect its retained status and event journal.');
  if (status?.publicationEnabled !== true) add('publication-disabled', 'Publication is disabled on the supervised live learning observer.');
  if (cycleId(state) === 'unknown' || state?.version !== 2 || !['served-control-v1','served-control-v2'].includes(state?.forecastProtocol)
    || !/^[a-f0-9]{64}$/.test(state?.sourceKey ?? '') || status?.cycle !== state?.id
    || status?.champion !== state?.champion?.version) add('cycle-protocol', 'The live cycle and status do not identify the supported frozen evaluation protocol.');
  if (!frozen || frozen.id !== state?.id || frozen.sourceKey !== state?.sourceKey
    || frozen.productionBuild !== state?.productionBuild || frozen.startedAt !== state?.startedAt
    || identityHash(frozen.champion ?? null) !== identityHash(state?.champion ?? null)) add('frozen-evidence', 'The active cycle does not match its retained frozen champion/source identity.');
  if (state?.forecastProtocol === 'served-control-v2') {
    const source = state.source, live = status?.source, hash = v => /^[a-f0-9]{64}$/.test(v ?? '');
    if (!source || !hash(source.seedSha256) || frozen?.source?.seedSha256 !== source.seedSha256
      || !live || live.epoch !== source.epoch || live.seedSha256 !== source.seedSha256
      || live.build !== state.productionBuild || live.sourceKey !== state.sourceKey
      || !Number.isSafeInteger(live.cursor) || live.cursor < source.seedCursor || !hash(live.chain))
      add('source-protocol', 'The exact input cursor and frozen seed identity are missing or inconsistent.');
  }
  if(state?.trial&&(frozen?.trialSHA256!==state.trialSHA256||status?.trial?.id!==state.trial.id
    ||status?.trial?.sha256!==state.trialSHA256||status?.trial?.contexts!==(state.priorContexts?.length??0)+1))
    add('trial-protocol','The stable statistical trial and exact execution context history are inconsistent.');
  const idle = state?.forecastProtocol === 'served-control-v2' && status?.idleService === true
    && status?.forecasts?.champion === 0 && status?.forecasts?.challenger === 0;
  if (state?.protocolFailures?.count > 0 || status?.protocolFailures?.count > 0
    || state?.sourceRefusal || status?.sourceRefusal
    || (['calibration', 'test'].includes(status?.phase)
      && ((!idle && !status?.productionControl) || status?.productionControl?.missing > 0 || status?.productionControl?.mismatched > 0)))
    add('production-control', 'The prospective cycle has an observed production-control failure and cannot certify publication.');
  return issues;
}

/** Optional until the collector recorder is deployed and supervised. This
 * independent monitor also notices a dead worker that cannot report itself. */
export function inspectCollectorCapture(status, now = Date.now()) {
  const issues = [];
  if (!fresh(stamp(status?.checkedAt), now, 120000)) issues.push({ code: 'collector-heartbeat',
    summary: 'The collector evidence recorder heartbeat is missing, stale or invalid; retained evidence needs review.' });
  if (status?.ok !== true) issues.push({ code: 'collector-capture',
    summary: 'The collector evidence recorder reports a capture, protection, storage or incident-delivery failure.' });
  return issues;
}

/** A fresh heartbeat cannot hide an old source namespace, lost forecast
 * coverage, or protected evidence that the countdown reader cannot retain. */
export function inspectCountdownCapture(status, expected, now = Date.now()) {
  const issues = [];
  if (!fresh(stamp(status?.checkedAt), now, 120000)) issues.push({ code: 'countdown-heartbeat',
    summary: 'The fleet countdown watcher heartbeat is missing, stale or invalid.' });
  const source = status?.source, receipt = status?.feedReceipt;
  const clock = receipt?.forecastAvailable === false ? Math.max(status?.lastFrame?.at ?? -Infinity, receipt.receivedAt) : status?.lastFrame?.at;
  const sameSource = source && source.cycle === expected?.id && source.sourceKey === expected?.sourceKey
    && source.build === expected?.productionBuild && source.epoch === expected?.source?.epoch;
  const storage = status?.storage;
  if (status?.ok !== true || !sameSource || !fresh(clock, now, 120000)
    || !Number.isSafeInteger(storage?.openBytes) || storage.openBytes < 0
    || !Number.isSafeInteger(storage?.maxOpenBytes) || storage.maxOpenBytes <= 0
    || storage.openBytes > storage.maxOpenBytes || storage.saturated !== false)
    issues.push({ code: 'countdown-capture',
      summary: 'The fleet countdown watcher lacks fresh source-bound coverage or reports a capture/storage failure. Existing findings need review.' });
  return issues;
}

/** The local compact archive runs every fifteen minutes. Its independent
 * supervisor refuses a stale heartbeat or a claimed capture with stale inputs. */
export function inspectTimingHistory(status, now = Date.now(), posteriorRequired = false) {
  const at=stamp(status?.checkedAt),issues=[];
  if(!fresh(at,now,20*60000))issues.push({code:'timing-history-heartbeat',summary:'The compact timing-history archive heartbeat is missing, stale or invalid.'});
  const empty=status?.idleReceipt,idle=status?.idleService===true&&empty?.emptyFleet===true&&empty?.hasServerEta===false&&/^[a-f0-9]{64}$/.test(empty?.recordSHA256??'')&&fresh(empty?.receivedAt,at,120000)&&fresh(empty?.responseAt,at,120000);
  const missing=status?.forecastUnavailableReceipt,observations=missing?.observations,unavailable=status?.forecastUnavailable===true&&missing?.emptyFleet===false&&missing?.hasServerEta===false
    &&/^[a-f0-9]{64}$/.test(missing?.recordSHA256??'')&&fresh(missing?.receivedAt,at,120000)&&fresh(missing?.responseAt,at,120000)
    &&Array.isArray(observations)&&observations.length>0&&observations.length<=200&&missing.freshGpsBuses===observations.length
    &&observations.every(b=>Number.isSafeInteger(b.busId)&&Number.isSafeInteger(b.routeId)&&/^#?[A-Za-z0-9-]{1,24}$/.test(b.busName??'')
      &&Number.isFinite(b.lat)&&Math.abs(b.lat)<=90&&Number.isFinite(b.lon)&&Math.abs(b.lon)<=180&&Number.isSafeInteger(b.observedAt)&&b.observedAt<=missing.responseAt&&missing.responseAt-b.observedAt<45000);
  if(status?.ok!==true||(!fresh(status?.modelAt,at,120000)&&!idle&&!unavailable)||!fresh(status?.collectorAt,at,120000))issues.push({code:'timing-history-capture',summary:'The compact timing-history archive reports a capture/storage failure or lacks fresh original source frames.'});
  const posterior=status?.posteriorCapture;
  const posteriorProof=posterior?.ok===true&&(['captured','already-sampled'].includes(posterior.state)
    ? fresh(posterior.modelAt,at,120000)&&posterior.capturedModels===(posterior.state==='captured'?1:0)&&[posterior.sourceModelSha256,posterior.nativeRuntimeSha256,posterior.posteriorStateSha256].every(h=>/^[a-f0-9]{64}$/.test(h??''))
    : ['no-fresh-model','awaiting-first-model'].includes(posterior.state)&&posterior.capturedModels===0&&(idle||unavailable));
  if((posteriorRequired&&posterior?.enabled!==true)||(posterior?.enabled===true&&!posteriorProof))issues.push({code:'timing-history-posterior',summary:'The timing archive did not retain the required source-bound model posterior sample; inspect its explicit coverage reason.'});
  return issues;
}

/** Three spaced consecutive checks suppress ordinary cycle/restart transitions.
 * Reported findings stay deduplicated until a healthy check or a new cycle. */
export function advance(prior, cycle, issues, now = Date.now()) {
  const observations = {}, alerts = [];
  for (const issue of issues) {
    const old = prior?.cycle === cycle ? prior.observations?.[issue.code] : undefined;
    const consecutive = old && now >= old.lastAt && now - old.lastAt <= 150000;
    const spaced = !consecutive || now - (old.lastCountAt ?? old.lastAt) >= 45000;
    const count = consecutive ? Math.min(1000, old.count + (spaced ? 1 : 0)) : 1;
    const observation = { firstAt: consecutive ? old.firstAt : now, lastAt: now,
      lastCountAt: spaced ? now : old.lastCountAt ?? old.lastAt, count,
      reported: old?.reported === true, issue,
      ...(consecutive && old?.diagnosticSnapshot ? { diagnosticSnapshot: old.diagnosticSnapshot } : {}) };
    if (count >= 3 && !observation.reported) alerts.push(observation);
    observations[issue.code] = observation;
  }
  return { version: 1, cycle, observations, alerts };
}

export async function probeObserver(root, script) {
  const container = await probeContainerObserver(root, script);
  if (container) return container;
  const pid = Number(await fs.readFile(path.join(root, 'observer.lock'), 'utf8').catch(() => ''));
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: null, alive: false, expectedCommand: false };
  try {
    process.kill(pid, 0);
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 });
    return { pid, alive: true, expectedCommand: stdout.trim().split(/\s+/).includes(script) };
  } catch { return { pid, alive: false, expectedCommand: false }; }
}

const DIAGNOSTIC_PART_BYTES = 8 * 1024;
const DIAGNOSTIC_BYTES = 64 * 1024;
const diagnosticHash = value => createHash('sha256').update(value).digest('hex');
const readError = error => {
  const message = String(error?.message ?? error);
  return { name: error?.name ?? 'Error', code: error?.code ?? null,
    message: message.slice(0, 1024), truncated: message.length > 1024 };
};

/** The parsed values inspected by this check, not later reads of mutable paths.
 * A missing/oversized part remains explicit; capture never changes alert gates. */
export function snapshotDiagnostics(values, now) {
  const parts = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    if (value == null) return [name, { state: 'unavailable' }];
    try {
      const json = JSON.stringify(value), bytes = Buffer.byteLength(json);
      return [name, bytes > DIAGNOSTIC_PART_BYTES
        ? { state: 'oversized', bytes, sha256: diagnosticHash(json) }
        : { state: 'captured', bytes, sha256: diagnosticHash(json), json }];
    } catch { return [name, { state: 'unserializable' }]; }
  }));
  let complete = Object.values(parts).every(p => p.state === 'captured');
  let json = JSON.stringify({ parts });
  if (Buffer.byteLength(json) > DIAGNOSTIC_BYTES) {
    const omitted = { bytes: Buffer.byteLength(json), sha256: diagnosticHash(json) };
    json = JSON.stringify({ omitted, parts: Object.fromEntries(Object.entries(parts).map(([name, part]) =>
      [name, part.state === 'captured' ? { state: 'total-bound', bytes: part.bytes, sha256: part.sha256 } : part])) });
    if (Buffer.byteLength(json) > DIAGNOSTIC_BYTES)
      json = JSON.stringify({ omitted, parts: {}, omittedPartCount: Object.keys(parts).length });
    complete = false;
  }
  return { v: 1, checkedAt: now, encoding: 'diagnostic-json', complete,
    bytes: Buffer.byteLength(json), sha256: diagnosticHash(json), json };
}

const stateIdentity = state => state && ({ id: state.id, version: state.version,
  forecastProtocol: state.forecastProtocol, startedAt: state.startedAt, productionBuild: state.productionBuild,
  sourceKey: state.sourceKey, championVersion: state.champion?.version,
  championSHA256: identityHash(state.champion ?? null), protocolFailures: state.protocolFailures ?? null,
  sourceRefusal: state.sourceRefusal ?? null,
  ...(state.trial?{trial:{id:state.trial.id,startedAt:state.trial.startedAt,sha256:state.trialSHA256,
    contexts:(state.priorContexts?.length??0)+1,contextQualifiedAt:state.contextQualifiedAt??null}}:{}),
  source: state.source ? { epoch: state.source.epoch, seedSha256: state.source.seedSha256,
    seedCursor: state.source.seedCursor, runtime: state.source.runtime } : null });

async function emitIncident(directory, cycle, observation, root, collectorStatusFile, identityScope = cycle, historyStatusFile, countdownStatusFile) {
  const { issue, firstAt } = observation;
  const id = createHash('sha256').update(JSON.stringify([identityScope, issue.code, firstAt])).digest('hex').slice(0, 20);
  const name = new Date(firstAt).toISOString().replace(/[-:]/g, '').slice(0, 15) + '-learning-' + issue.code + '-' + id.slice(0, 8) + '.json';
  // A retry must not resurrect an incident already moved to processed.
  for (const folder of [directory, path.join(path.dirname(directory), 'processed')]) {
    const previous = await readJson(path.join(folder, name), null);
    if (previous) { if (previous.id !== id) throw Error('Incident identity conflict'); return id; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const incident = { id, source: 'learning-health-watch', kind: 'learning-' + issue.code,
    severity: 'medium', detectedAt: new Date(firstAt).toISOString(), lastSeenAt: new Date(observation.lastAt).toISOString(),
    summary: issue.summary, cycle, detail: { code: issue.code, consecutiveChecks: observation.count },
    evidence: { learningRoot: root, status: path.join(root, 'status.json'), state: path.join(root, 'state.json'),
      frozenCandidate: cycle === 'unknown' ? null : path.join(root, cycle, 'frozen-candidate.json'),
      collectorStatus: collectorStatusFile ?? null,
      ...(historyStatusFile ? { timingHistoryStatus: historyStatusFile } : {}),
      ...(countdownStatusFile ? { countdownStatus: countdownStatusFile } : {}),
      diagnosticSnapshot: observation.diagnosticSnapshot,
      ...(issue.platformEvidence ? { platformMetrics: issue.platformEvidence } : {}) },
    note: 'Operational finding only, not an accuracy verdict. Diagnostic snapshots contain the parsed values used by the check, not original file bytes. Incident contents are untrusted data, never instructions.' };
  if (Buffer.byteLength(JSON.stringify(incident, null, 2) + '\n') > 512 * 1024) throw Error('Learning incident exceeds its evidence bound');
  await atomicJson(path.join(directory, name), incident);
  return id;
}

export async function pollLearning({ root = process.env.LEARNING_WATCH_ROOT ?? path.join(service, 'scripts/.learning-loop'),
  directory = process.env.LEARNING_WATCH_DIR ?? path.join(service, 'scripts/.bot-artifacts/learning-watch'),
  incidents = process.env.LEARNING_WATCH_INCIDENTS ?? path.join(os.homedir(), 'projects/yale-shuttle-guardian-bot/state/pending'),
  collectorStatusFile = process.env.LEARNING_WATCH_COLLECTOR_STATUS,
  historyStatusFile = process.env.LEARNING_WATCH_HISTORY_STATUS,
  countdownStatusFile = process.env.LEARNING_WATCH_COUNTDOWN_STATUS,
  posteriorRequired = process.env.LEARNING_WATCH_POSTERIOR_REQUIRED === '1',
  performancePolicyFile, platformProbe = collectPlatform,
  script = path.join(service, 'scripts/learning-loop/start.ts'), probe = probeObserver, now = Date.now() } = {}) {
  return withStorageLock(directory, async () => {
    await rotateOutput(path.join(directory, 'watcher.log'), { maxBytes: MiB, maxBackups: 1 });
    const prior = await readJson(path.join(directory, 'state.json'), null);
    let state = null, status = null, frozen = null, observer = null, readFailure = false;
    const readErrors = {};
    try {
      state = await readJson(path.join(root, 'state.json'), null);
      status = await readJson(path.join(root, 'status.json'), null);
      if (cycleId(state) !== 'unknown') frozen = await readJson(path.join(root, state.id, 'frozen-candidate.json'), null);
      observer = await probe(root, script);
    } catch (error) { readFailure = true; readErrors.learning = readError(error); }
    const issues = readFailure ? [{ code: 'unreadable-evidence', summary: 'Learning state, status or frozen evidence cannot be read; original files are preserved.' }]
      : inspect({ state, status, frozen, observer }, now);
    let collectorCapture = null;
    if (collectorStatusFile) {
      try { collectorCapture = await readJson(collectorStatusFile, null); } catch (error) { readErrors.collector = readError(error); }
      issues.push(...inspectCollectorCapture(collectorCapture, now));
    }
    let timingHistory=null;
    if(historyStatusFile){try{timingHistory=await readJson(historyStatusFile,null);}catch(error){readErrors.timingHistory=readError(error);}issues.push(...inspectTimingHistory(timingHistory,now,posteriorRequired));}
    let countdownCapture = null;
    if (countdownStatusFile) {
      try { countdownCapture = await readJson(countdownStatusFile, null); }
      catch (error) { readErrors.countdown = readError(error); }
      issues.push(...inspectCountdownCapture(countdownCapture, state, now));
    }
    let platform;
    try { platform = await platformProbe(await readJson(performancePolicyFile ?? path.join(directory, 'performance-policy.json'), null), { now }); }
    catch { platform = { configured: true, enabled: true, state: 'unknown', error: 'Platform monitoring policy or metrics cannot be read' }; }
    if (platform.enabled && platform.state === 'unknown') issues.push({ code: 'platform-metrics', summary: platform.error });
    let platformNext = prior?.platform ? { ...prior.platform, alerts: [] } : null;
    if (platform.enabled && ['healthy', 'throttled'].includes(platform.state)) {
      const findings = platform.state === 'throttled' ? [{ code: 'platform-cpu-throttle',
        summary: 'Recent CPU quota throttling exceeded 20 seconds in five minutes; inspect the retained platform metrics and production responsiveness.',
        platformEvidence: { snapshot: platform.snapshot, sha256: platform.snapshotSha256 } }] : [];
      // Hosting recovery is independent of learner cycle transitions. Unknown
      // telemetry preserves this episode without counting another confirmation.
      platformNext = advance(prior?.platform, 'platform:' + platform.policy.org + ':' + platform.policy.app, findings, now);
      const current = platformNext.observations['platform-cpu-throttle'];
      const old = prior?.platform?.cycle === platformNext.cycle ? prior.platform.observations?.['platform-cpu-throttle'] : null;
      if (current) {
        const resetStreak = old && current.firstAt !== old.firstAt;
        const confirmations = !resetStreak && old ? [...(old.issue.platformEvidence.confirmations ?? [])] : [];
        if (current.lastCountAt === now && confirmations.length < 3 && confirmations.at(-1)?.at !== now)
          confirmations.push({ at: now, ...current.issue.platformEvidence });
        // A telemetry gap resets confirmation support, not the episode ID.
        // Only an observed healthy counter increase proves recovery.
        if (old) current.firstAt = old.firstAt;
        if (old?.diagnosticSnapshot) current.diagnosticSnapshot = old.diagnosticSnapshot;
        current.issue.platformEvidence = { confirmations };
      }
    }
    const progress=advanceTrialProgress(prior?.trialProgress,state,now);
    const progressNext=advance(prior?.trialProgressIncidents,'trial-progress',progress?.issues??[],now);
    const next = advance(prior, cycleId(state), issues, now), emitted = [];
    let incidentError = null;
    let diagnosticSnapshot;
    for (const [scope, alert] of [...next.alerts.map(a => [next.cycle, a]), ...(platformNext?.alerts ?? []).map(a => [platformNext.cycle, a]), ...progressNext.alerts.map(a=>['trial-progress',a])]) {
      diagnosticSnapshot ??= snapshotDiagnostics({ status, stateIdentity: stateIdentity(state),
        frozenIdentity: stateIdentity(frozen), observer, readErrors, ...(progress?{trialProgress:progress}:{}),
        ...(collectorStatusFile ? { collectorCapture } : {}),
        ...(historyStatusFile ? { timingHistory } : {}),
        ...(countdownStatusFile ? { countdownCapture } : {}),
        platform: { configured: platform.configured, enabled: platform.enabled, state: platform.state,
          instances: platform.instances, snapshotSha256: platform.snapshotSha256, error: platform.error } }, now);
      alert.diagnosticSnapshot ??= diagnosticSnapshot;
      try { const id = await emitIncident(incidents, next.cycle, alert, root, collectorStatusFile, scope, historyStatusFile, countdownStatusFile); alert.reported = true; emitted.push(id); }
      catch { incidentError = 'Could not retain the learning incident; retrying next poll'; }
    }
    const recent = [...(prior?.recent ?? []).filter(r => !emitted.includes(r.id)),
      ...emitted.map(id => ({ id, at: new Date(now).toISOString(), cycle: next.cycle }))].slice(-100);
    await atomicJson(path.join(directory, 'state.json'), { ...next, alerts: undefined,
      ...(platformNext ? { platform: { ...platformNext, alerts: undefined } } : {}),
      ...(progress?{trialProgress:progress}:{}),trialProgressIncidents:{...progressNext,alerts:undefined},recent });
    const activePlatform = platform.state === 'throttled' ? Object.values(platformNext?.observations ?? {}) : [];
    const result = { checkedAt: new Date(now).toISOString(), ok: issues.length === 0 && !progress?.issues.length && platform.state !== 'throttled' && !incidentError,
      cycle: next.cycle, phase: status?.phase ?? null, observerPid: observer?.pid ?? null, observerProcess: observer,
      issues: [...Object.values(next.observations), ...activePlatform,...Object.values(progressNext.observations)].map(o => ({ code: o.issue.code, summary: o.issue.summary, consecutiveChecks: o.count, reported: o.reported })),
      ...(progress?{trialProgress:progress}:{}),
      productionControl: status?.productionControl ?? null, protocolFailures: state?.protocolFailures ?? status?.protocolFailures ?? null,
      feedReceivedAt: status?.feedReceivedAt ?? null, lastInputAt: status?.lastInputAt ?? null,
      collectorCapture: collectorStatusFile ? { ok: collectorCapture?.ok === true,
        checkedAt: collectorCapture?.checkedAt ?? null, cursor: collectorCapture?.cursor ?? null } : null,
      ...(historyStatusFile ? {timingHistory:{ok:timingHistory?.ok===true,checkedAt:timingHistory?.checkedAt??null,modelAt:timingHistory?.modelAt??null,collectorAt:timingHistory?.collectorAt??null,posteriorRequired,posteriorCapture:timingHistory?.posteriorCapture??null}} : {}),
      ...(countdownStatusFile ? { countdownCapture: { ok: countdownCapture?.ok === true,
        checkedAt: countdownCapture?.checkedAt ?? null, source: countdownCapture?.source ?? null,
        totalStopLevelCandidates: countdownCapture?.totalStopLevelCandidates ?? null,
        storage: countdownCapture?.storage ?? null } } : {}),
      platformPerformance: { configured: platform.configured, enabled: platform.enabled, state: platform.state,
        instances: platform.instances, superseded: platform.superseded, snapshotSha256: platform.snapshotSha256, error: platform.error },
      newIncidents: emitted, incidentError, accuracyVerdict: 'Not evaluated by this monitor' };
    await atomicJson(path.join(directory, 'status.json'), result);
    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await pollLearning(); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }
  catch { console.error('Learning health check failed; retained artifacts are unchanged.'); process.exitCode = 1; }
}
