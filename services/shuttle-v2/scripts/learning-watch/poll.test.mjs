import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { advance, describeObserverReadiness, inspect, inspectCollectorCapture, pollLearning, probeObserver, snapshotDiagnostics } from './poll.mjs';
import { collectPlatform } from './platform.mjs';

const now = Date.parse('2026-10-17T12:00:00Z');
function healthy(at = now) {
  const state = { id: 'cycle-1792236978158', version: 2, forecastProtocol: 'served-control-v1', sourceKey: 'a'.repeat(64),
    startedAt: now - 300000, productionBuild: '7d4cdcc903f4', champion: { version: 'fit', params: { A: 1 } } };
  return { state, frozen: structuredClone(state), observer: { pid: 123, alive: true, expectedCommand: true },
    status: { updatedAt: new Date(at).toISOString(), running: true, publicationEnabled: true, cycle: state.id,
      champion: 'fit', phase: 'warming', feedReceivedAt: new Date(at).toISOString(), lastInputAt: new Date(at).toISOString(),
      productionControl: { compared: 99, matched: 98, missing: 0, mismatched: 1 } } };
}
const codes = snapshot => inspect(snapshot, now).map(x => x.code);
describe('operational evidence rather than an accuracy verdict', () => {
  it('accepts healthy warmup with imperfect parity and ordinary support/score refusals', () => {
    const x = healthy(); x.state.calibrationRefusal = { reason: 'Need200 visits' }; x.state.decision = { promote: false };
    expect(codes(x)).toEqual([]);
  });
  it.each(['calibration', 'test'])('reports unmatched controls during %s', phase => {
    const x = healthy(); x.status.phase = phase; expect(codes(x)).toEqual(['production-control']);
  });
  it('does not accept a missing control diagnostic during calibration', () => {
    const x = healthy(); x.status.phase = 'calibration'; delete x.status.productionControl;
    expect(codes(x)).toEqual(['production-control']);
  });
  it('retains a cycle protocol failure even after the current control matches', () => {
    const x = healthy(); x.status.productionControl.mismatched = 0; x.state.protocolFailures = { count: 1 };
    expect(codes(x)).toEqual(['production-control']);
  });
  it('requires the actual observer command and a fresh heartbeat', () => {
    const x = healthy(); x.observer.expectedCommand = false; x.status.updatedAt = new Date(now - 120001).toISOString();
    expect(codes(x)).toEqual(['observer-process', 'observer-heartbeat']);
    x.observer.alive = false; x.status.updatedAt = new Date(now + 5001).toISOString();
    expect(codes(x)).toContain('observer-heartbeat');
  });
  it('does not treat fresh HTTP receipts as distinct new observations', () => {
    const x = healthy(); x.status.lastInputAt = new Date(now - 60001).toISOString(); expect(codes(x)).toEqual(['distinct-input']);
    x.status.feedReceivedAt = new Date(now - 30001).toISOString(); expect(codes(x)).toContain('feed-receipt');
  });
  it('rejects disabled publication, unsupported protocol and changed frozen champion', () => {
    const x = healthy(); x.status.publicationEnabled = false; x.state.version = 1; x.state.champion.params.A = 2;
    expect(codes(x)).toEqual(['publication-disabled', 'cycle-protocol', 'frozen-evidence']);
    delete x.state.champion; expect(() => codes(x)).not.toThrow();
  });
  it('recognizes a coherent exact-source cycle and reports a changed seed/cursor identity', () => {
    const x = healthy(), seedSha256 = 'b'.repeat(64);
    x.state.forecastProtocol = 'served-control-v2'; x.state.source = { epoch: 'epoch', seedSha256, seedCursor: 10 };
    x.frozen = structuredClone(x.state);
    x.status.source = { epoch: 'epoch', seedSha256, cursor: 11, chain: 'c'.repeat(64),
      sourceKey: x.state.sourceKey, build: x.state.productionBuild };
    expect(codes(x)).toEqual([]);
    x.status.source.cursor = 9; expect(codes(x)).toEqual(['source-protocol']);
  });
  it('allows verified empty service without inventing a control and still reports a refused cycle', () => {
    const x = healthy(), seedSha256 = 'b'.repeat(64);
    x.state.forecastProtocol = 'served-control-v2'; x.state.source = { epoch: 'epoch', seedSha256, seedCursor: 10 };
    x.frozen = structuredClone(x.state); x.status.phase = 'calibration'; x.status.productionControl = null;
    x.status.idleService = true; x.status.forecasts = { champion: 0, challenger: 0 };
    x.status.source = { epoch: 'epoch', seedSha256, cursor: 10, chain: 'c'.repeat(64),
      sourceKey: x.state.sourceKey, build: x.state.productionBuild };
    expect(codes(x)).toEqual([]);
    x.state.sourceRefusal = { reason: 'Missing required frame' }; expect(codes(x)).toEqual(['production-control']);
  });
});

describe('spaced persistence and recovery', () => {
  const issues = [{ code: 'production-control', summary: 'Refused cycle' }];
  it('requires three spaced checks, then deduplicates the persistent finding', () => {
    let s = advance(null, 'cycle', issues, now);
    for (let i = 1; i < 6; i++) s = advance(s, 'cycle', issues, now + i * 1000);
    expect(s.observations['production-control'].count).toBe(1); expect(s.alerts).toEqual([]);
    s = advance(s, 'cycle', issues, now + 60000); expect(s.alerts).toEqual([]);
    s = advance(s, 'cycle', issues, now + 120000); expect(s.alerts).toHaveLength(1);
    s.alerts[0].reported = true;
    expect(advance(s, 'cycle', issues, now + 180000).alerts).toEqual([]);
  });
  it('resets an unconfirmed streak across a long gap, recovery or changed cycle', () => {
    const a = advance(null, 'cycle', issues, now), b = advance(a, 'cycle', issues, now + 60000);
    expect(advance(b, 'cycle', issues, now + 300000).observations['production-control'].count).toBe(1);
    expect(advance(b, 'next', issues, now + 120000).observations['production-control'].count).toBe(1);
    const recovered = advance(b, 'cycle', [], now + 120000);
    expect(advance(recovered, 'cycle', issues, now + 180000).observations['production-control'].count).toBe(1);
  });
});

it('monitors recorder failures and stale heartbeats independently of zero service coverage', () => {
  expect(inspectCollectorCapture({ ok: true, checkedAt: new Date(now).toISOString(), frames: 0 }, now)).toEqual([]);
  expect(inspectCollectorCapture({ ok: false, checkedAt: new Date(now).toISOString() }, now).map(x => x.code)).toEqual(['collector-capture']);
  expect(inspectCollectorCapture({ ok: true, checkedAt: new Date(now - 120001).toISOString() }, now).map(x => x.code)).toEqual(['collector-heartbeat']);
  expect(inspectCollectorCapture(null, now).map(x => x.code)).toEqual(['collector-heartbeat', 'collector-capture']);
});

const temporary = [];
afterEach(async () => { for (const d of temporary.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-watch-')); temporary.push(base);
  const root = path.join(base, 'learning'), directory = path.join(base, 'monitor'), incidents = path.join(base, 'guardian/pending');
  const x = healthy(); await fs.mkdir(path.join(root, x.state.id), { recursive: true });
  const write = async at => {
    x.status.updatedAt = x.status.feedReceivedAt = x.status.lastInputAt = new Date(at).toISOString();
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(x.state));
    await fs.writeFile(path.join(root, 'status.json'), JSON.stringify(x.status));
    await fs.writeFile(path.join(root, x.state.id, 'frozen-candidate.json'), JSON.stringify(x.frozen));
  };
  const probe = async () => x.observer;
  return { base, root, directory, incidents, x, write, probe };
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
function verifiedContainer(startedAt = now - 60000) {
  return { pid:123,alive:true,expectedCommand:true,runtimeKind:'linux-container',runtimeOwner:'fixture-owner',
    containerId:'a'.repeat(64),ownerCreatedAt:new Date(now-61000).toISOString(),
    containerStartedAt:new Date(startedAt).toISOString(),containerStatus:'running' };
}
describe('verified process startup and current status are separate evidence', () => {
  it('attributes a stopped previous context to its original runtime while preserving every health failure', async () => {
    const f=await fixture();f.x.observer=verifiedContainer();f.x.status.running=false;
    f.x.status.error='Original source changed; restart required';await f.write(now-300000);
    const files=['state.json','status.json',f.x.state.id+'/frozen-candidate.json'].map(n=>path.join(f.root,n));
    const before=await Promise.all(files.map(digest)),expectedCodes=inspect(f.x,now).map(x=>x.code);
    const result=await pollLearning({...f,now});
    expect(result.ok).toBe(false);expect(result.phase).toBe('awaiting-current-status');
    expect(result.observerReadiness).toMatchObject({state:'awaiting-current-status',processVerified:true,
      statusAssociation:'previous-runtime',readiness:'unverified',verificationProgress:'unknown',
      priorRuntimeStatus:{updatedAt:new Date(now-300000).toISOString(),cycle:f.x.state.id,running:false,
        error:'Original source changed; restart required'}});
    expect(result.issues.map(x=>x.code)).toEqual(expectedCodes);
    expect(result.issues.some(x=>x.code==='observer-process')).toBe(false);
    expect(await Promise.all(files.map(digest))).toEqual(before);
  });
  it('does not let a fresh healthy status from the previous process certify the new process',async()=>{
    const f=await fixture();f.x.observer=verifiedContainer(now-1000);await f.write(now-2000);
    expect(inspect(f.x,now)).toEqual([]);
    const result=await pollLearning({...f,now});
    expect(result.ok).toBe(false);expect(result.phase).toBe('awaiting-current-status');
    expect(result.issues).toEqual([]);expect(result.observerReadiness.readiness).toBe('unverified');
  });
  it('keeps a current failed status current and applies the existing health checks',async()=>{
    const f=await fixture();f.x.observer=verifiedContainer();f.x.status.error='Current retained-input refusal';await f.write(now);
    const result=await pollLearning({...f,now});
    expect(result.ok).toBe(false);expect(result.phase).toBe('warming');
    expect(result.observerReadiness.state).toBe('current-status');
    expect(result.observerReadiness.priorRuntimeStatus).toBeUndefined();
    expect(result.issues.map(x=>x.code)).toEqual(['observer-error']);
    delete f.x.status.error;await f.write(now);
    expect((await pollLearning({...f,now})).ok).toBe(true);
  });
  it.each([{alive:false,expectedCommand:true},{alive:true,expectedCommand:false}])('does not infer startup from an unverified process %j',patch=>{
    const x=healthy();x.observer={...verifiedContainer(),...patch};x.status.updatedAt=new Date(now-300000).toISOString();
    expect(describeObserverReadiness(x,now)).toMatchObject({state:'unverified',processVerified:false,readiness:'unverified'});
    expect(codes(x)).toContain('observer-process');
  });
  it.each([
    ['equal status/start',new Date(now-60000).toISOString(),new Date(now-60000).toISOString(),'current-status'],
    ['five-second clock allowance',new Date(now+5000).toISOString(),new Date(now-60000).toISOString(),'awaiting-current-status'],
    ['future start beyond allowance',new Date(now+5001).toISOString(),new Date(now-60000).toISOString(),'unverified'],
    ['future status beyond allowance',new Date(now-60000).toISOString(),new Date(now+5001).toISOString(),'unverified'],
    ['missing start',null,new Date(now).toISOString(),'unverified'],
    ['invalid start','invalid',new Date(now).toISOString(),'unverified'],
    ['invalid status',new Date(now-60000).toISOString(),'invalid','unverified'],
  ])('handles %s without inventing current status or green health',async(_name,startedAt,statusAt,expected)=>{
    const f=await fixture();f.x.observer={...verifiedContainer(),containerStartedAt:startedAt};await f.write(now);
    f.x.status.updatedAt=statusAt;await fs.writeFile(path.join(f.root,'status.json'),JSON.stringify(f.x.status));
    const result=await pollLearning({...f,now});
    expect(result.observerReadiness.state).toBe(expected);
    expect(result.ok).toBe(expected==='current-status');
  });
  it('preserves the existing host-process fallback without claiming container status association',async()=>{
    const f=await fixture();await f.write(now);const result=await pollLearning({...f,now});
    expect(result.observerReadiness.statusAssociation).toBe('unknown');expect(result.ok).toBe(true);
  });
  it('reports a missing status without inventing prior runtime or verification progress',()=>{
    expect(describeObserverReadiness({observer:verifiedContainer(),status:null},now)).toMatchObject({
      state:'awaiting-current-status',statusAssociation:'missing',priorRuntimeStatus:null,
      readiness:'unverified',verificationProgress:'unknown'});
  });
});
function decodeDiagnostics(snapshot) {
  expect(snapshot.v).toBe(1); expect(snapshot.encoding).toBe('diagnostic-json');
  expect(snapshot.bytes).toBe(Buffer.byteLength(snapshot.json));
  expect(snapshot.bytes).toBeLessThanOrEqual(64 * 1024);
  expect(snapshot.sha256).toBe(createHash('sha256').update(snapshot.json).digest('hex'));
  const payload = JSON.parse(snapshot.json);
  for (const part of Object.values(payload.parts)) if (part.state === 'captured') {
    expect(part.bytes).toBe(Buffer.byteLength(part.json));
    expect(part.sha256).toBe(createHash('sha256').update(part.json).digest('hex'));
  }
  return payload.parts;
}
describe('failure detail survives mutable diagnostic files', () => {
  it('retains the inspected failure, identity and recorder statuses after recovery without changing learner evidence', async () => {
    const f = await fixture(), collectorStatusFile = path.join(f.base, 'collector.json'), historyStatusFile = path.join(f.base, 'history.json');
    f.x.status.error = 'Original exact-receipt reader failure';
    f.x.state.sourceRefusal = { reason: 'Original required source journal missing' };
    f.x.state.pending = { deliberatelyExcluded: 'large pending state '.repeat(10000) };
    for (let i = 0; i < 3; i++) {
      const at = now + i * 60000; await f.write(at);
      await fs.writeFile(collectorStatusFile, JSON.stringify({ checkedAt: new Date(at).toISOString(), ok: false, error: 'Original collector storage failure' }));
      await fs.writeFile(historyStatusFile, JSON.stringify({ checkedAt: new Date(at).toISOString(), ok: false, error: 'Original archive cursor failure', modelAt: at, collectorAt: at }));
      const files = ['state.json', 'status.json', f.x.state.id + '/frozen-candidate.json'].map(n => path.join(f.root, n));
      const before = await Promise.all(files.map(digest));
      await pollLearning({ ...f, collectorStatusFile, historyStatusFile, now: at });
      expect(await Promise.all(files.map(digest))).toEqual(before);
    }
    const file = (await fs.readdir(f.incidents)).map(n => path.join(f.incidents, n));
    const chosen = (await Promise.all(file.map(read))).find(r => r.kind === 'learning-collector-capture');
    const snapshot = chosen.evidence.diagnosticSnapshot, parts = decodeDiagnostics(snapshot);
    expect(snapshot.checkedAt).toBe(now + 120000); expect(snapshot.complete).toBe(true);
    expect(JSON.parse(parts.status.json).error).toBe('Original exact-receipt reader failure');
    expect(JSON.parse(parts.stateIdentity.json).sourceRefusal.reason).toBe('Original required source journal missing');
    expect(JSON.parse(parts.stateIdentity.json).sourceKey).toBe(f.x.state.sourceKey);
    expect(JSON.parse(parts.frozenIdentity.json).productionBuild).toBe(f.x.frozen.productionBuild);
    expect(JSON.parse(parts.collectorCapture.json).error).toBe('Original collector storage failure');
    expect(JSON.parse(parts.timingHistory.json).error).toBe('Original archive cursor failure');
    expect(JSON.parse(parts.observer.json).expectedCommand).toBe(true);
    expect(snapshot.json).not.toContain('deliberatelyExcluded');
    const hashes = await Promise.all(file.map(digest));
    delete f.x.status.error; delete f.x.state.sourceRefusal; await f.write(now + 180000);
    await fs.writeFile(collectorStatusFile, JSON.stringify({ checkedAt: new Date(now + 180000).toISOString(), ok: true }));
    await fs.writeFile(historyStatusFile, JSON.stringify({ checkedAt: new Date(now + 180000).toISOString(), ok: true, modelAt: now + 180000, collectorAt: now + 180000 }));
    expect((await pollLearning({ ...f, collectorStatusFile, historyStatusFile, now: now + 180000 })).ok).toBe(true);
    expect(await Promise.all(file.map(digest))).toEqual(hashes);
  });
  it('keeps the first alert snapshot through a persistent write retry and a processed acknowledgement retry', async () => {
    const f = await fixture(), collectorStatusFile = path.join(f.base, 'collector.json');
    await fs.mkdir(path.dirname(f.incidents), { recursive: true }); await fs.writeFile(f.incidents, 'blocked destination');
    for (let i = 0; i < 3; i++) {
      const at = now + i * 60000; await f.write(at);
      await fs.writeFile(collectorStatusFile, JSON.stringify({ checkedAt: new Date(at).toISOString(), ok: false, error: 'Failure before delivery retry' }));
      const r = await pollLearning({ ...f, collectorStatusFile, now: at });
      if (i === 2) expect(r.incidentError).toBeTruthy();
    }
    await fs.unlink(f.incidents); await f.write(now + 180000);
    await fs.writeFile(collectorStatusFile, JSON.stringify({ checkedAt: new Date(now + 180000).toISOString(), ok: false, error: 'Later mutable failure detail' }));
    await pollLearning({ ...f, collectorStatusFile, now: now + 180000 });
    const name = (await fs.readdir(f.incidents))[0], file = path.join(f.incidents, name), incident = await read(file);
    expect(incident.evidence.diagnosticSnapshot.checkedAt).toBe(now + 120000);
    const parts = decodeDiagnostics(incident.evidence.diagnosticSnapshot);
    expect(JSON.parse(parts.collectorCapture.json).error).toBe('Failure before delivery retry');
    const processed = path.join(path.dirname(f.incidents), 'processed'); await fs.mkdir(processed);
    await fs.rename(file, path.join(processed, name)); const original = await digest(path.join(processed, name));
    const priorFile = path.join(f.directory, 'state.json'), prior = await read(priorFile);
    prior.observations['collector-capture'].reported = false; await fs.writeFile(priorFile, JSON.stringify(prior));
    await f.write(now + 240000); await pollLearning({ ...f, collectorStatusFile, now: now + 240000 });
    expect(await fs.readdir(f.incidents)).toEqual([]); expect(await digest(path.join(processed, name))).toBe(original);
  });
  it('keeps legacy incident bytes unchanged instead of adding reconstructed diagnostics on retry', async () => {
    const f = await fixture(); f.x.state.protocolFailures = { count: 1 };
    for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, now: now + i * 60000 }); }
    const file = path.join(f.incidents, (await fs.readdir(f.incidents))[0]), legacy = await read(file);
    delete legacy.evidence.diagnosticSnapshot; await fs.writeFile(file, JSON.stringify(legacy)); const original = await digest(file);
    const priorFile = path.join(f.directory, 'state.json'), prior = await read(priorFile);
    prior.observations['production-control'].reported = false; await fs.writeFile(priorFile, JSON.stringify(prior));
    await f.write(now + 180000); await pollLearning({ ...f, now: now + 180000 });
    expect(await digest(file)).toBe(original); expect((await read(file)).evidence.diagnosticSnapshot).toBeUndefined();
  });
  it('records unreadable input and incomplete capture without modifying the corrupt source', async () => {
    const f = await fixture(), collectorStatusFile = path.join(f.base, 'collector.json');
    await fs.writeFile(collectorStatusFile, '{broken collector status');
    for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, collectorStatusFile, now: now + i * 60000 }); }
    const incidents = await Promise.all((await fs.readdir(f.incidents)).map(n => read(path.join(f.incidents, n))));
    expect(incidents.some(r => r.kind === 'learning-collector-capture')).toBe(true);
    for (const r of incidents) {
      const snapshot = r.evidence.diagnosticSnapshot, parts = decodeDiagnostics(snapshot);
      expect(snapshot.complete).toBe(false); expect(parts.collectorCapture.state).toBe('unavailable');
      expect(JSON.parse(parts.readErrors.json).collector.name).toBe('SyntaxError');
    }
    expect(await fs.readFile(collectorStatusFile, 'utf8')).toBe('{broken collector status');
  });
  it('marks oversized, missing and unserializable sections explicitly', () => {
    const cycle = {}; cycle.self = cycle;
    const large = { error: '☃'.repeat(5000) }, snapshot = snapshotDiagnostics({ large, missing: null, cycle }, now), parts = decodeDiagnostics(snapshot);
    expect(snapshot.complete).toBe(false); expect(parts.large.state).toBe('oversized');
    expect(parts.large.bytes).toBe(Buffer.byteLength(JSON.stringify(large)));
    expect(parts.large.sha256).toBe(createHash('sha256').update(JSON.stringify(large)).digest('hex'));
    expect(parts.missing.state).toBe('unavailable'); expect(parts.cycle.state).toBe('unserializable');
    expect(snapshot.json).not.toContain('☃');
  });
  it('bounds aggregate escaping overhead and keeps the omitted payload hashes', () => {
    const values = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['part' + i, '\\'.repeat(3000)]));
    const snapshot = snapshotDiagnostics(values, now), parts = decodeDiagnostics(snapshot);
    expect(snapshot.complete).toBe(false); expect(JSON.parse(snapshot.json).omitted.bytes).toBeGreaterThan(64 * 1024);
    expect(Object.values(parts).every(p => p.state === 'total-bound' && p.sha256.length === 64)).toBe(true);
  });
  it('keeps the total bound even when section names and omission metadata are excessive', () => {
    const values = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['diagnostic-' + i, i]));
    const snapshot = snapshotDiagnostics(values, now), parts = decodeDiagnostics(snapshot);
    expect(snapshot.complete).toBe(false); expect(parts).toEqual({});
    expect(JSON.parse(snapshot.json).omittedPartCount).toBe(2000);
    expect(JSON.parse(snapshot.json).omitted.sha256).toHaveLength(64);
  });
});
async function platformFixture(f) {
  const performancePolicyFile = path.join(f.base, 'performance-policy.json');
  await fs.writeFile(performancePolicyFile, JSON.stringify({ version: 1, enabled: true, org: 'personal', app: 'yale-shuttle' }));
  let seconds = 50, unavailable = false, partial = false;
  const platformProbe = (policy, { now: at }) => collectPlatform(policy, { now: at,
    tokenProvider: async () => 'fm2_private_fixture_not_a_real_credential',
    fetcher: async url => {
      if (unavailable) throw Error('Unreachable fixture');
      const query = new URL(url).searchParams.get('query');
      const n = query.startsWith('increase(') ? seconds : query.startsWith('timestamp(') ? (at - 15000) / 1000 : 20;
      return Response.json({ status: 'success', ...(partial ? { isPartial: true } : {}), data: { resultType: 'vector', result: [{
        metric: { app: 'yale-shuttle', instance: '91854406a779d8', host: '744d', region: 'ewr' }, value: [at / 1000, String(n)],
      }] } });
    } });
  return { performancePolicyFile, platformProbe, seconds: n => { seconds = n; }, unavailable: v => { unavailable = v; }, partial: v => { partial = v; } };
}
it('does not recover or rearm a confirmed CPU episode from a partial zero-throttling response', async () => {
  const f = await fixture(), p = await platformFixture(f);
  for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  const [name] = await fs.readdir(f.incidents), incidentFile = path.join(f.incidents, name), original = await digest(incidentFile);
  const monitorState = path.join(f.directory, 'state.json'), before = (await read(monitorState)).platform;
  p.seconds(0); p.partial(true); await f.write(now + 180000);
  const missing = await pollLearning({ ...f, ...p, now: now + 180000 });
  expect(missing.platformPerformance.state).toBe('unknown'); expect(missing.ok).toBe(false);
  expect(missing.newIncidents).toEqual([]); expect((await read(monitorState)).platform).toEqual(before);
  expect(await fs.readdir(f.incidents)).toEqual([name]); expect(await digest(incidentFile)).toBe(original);
  p.partial(false); p.seconds(50); await f.write(now + 240000);
  expect((await pollLearning({ ...f, ...p, now: now + 240000 })).newIncidents).toEqual([]);
  expect((await read(monitorState)).platform.observations['platform-cpu-throttle'].firstAt)
    .toBe(before.observations['platform-cpu-throttle'].firstAt);
  p.seconds(0); await f.write(now + 300000);
  expect((await pollLearning({ ...f, ...p, now: now + 300000 })).ok).toBe(true);
  expect((await read(monitorState)).platform.observations).toEqual({});
  p.seconds(50);
  for (let i = 6; i < 9; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  expect(await fs.readdir(f.incidents)).toHaveLength(2); expect(await digest(incidentFile)).toBe(original);
});
it('retains a recent CPU stall across healthy learner checks, cycle change, lost acknowledgement and unknown telemetry', async () => {
  const f = await fixture(), p = await platformFixture(f), receipts = [];
  for (let i = 0; i < 3; i++) {
    const at = now + i * 60000; await f.write(at);
    const files = ['state.json', 'status.json', f.x.state.id + '/frozen-candidate.json'].map(n => path.join(f.root, n));
    const before = await Promise.all(files.map(digest));
    receipts.push(await pollLearning({ ...f, ...p, now: at }));
    expect(await Promise.all(files.map(digest))).toEqual(before);
  }
  expect(receipts.map(r => r.newIncidents.length)).toEqual([0, 0, 1]);
  expect(receipts[2].issues).toEqual([{ code: 'platform-cpu-throttle', summary: expect.any(String), consecutiveChecks: 3, reported: true }]);
  const name = (await fs.readdir(f.incidents))[0], file = path.join(f.incidents, name), original = await digest(file), incident = await read(file);
  expect(incident.kind).toBe('learning-platform-cpu-throttle');
  const evidence = incident.evidence.platformMetrics;
  expect(evidence.confirmations.map(r => r.at)).toEqual([now, now + 60000, now + 120000]);
  for (const confirmation of evidence.confirmations) {
    expect(confirmation.sha256).toBe(createHash('sha256').update(JSON.stringify(confirmation.snapshot)).digest('hex'));
    expect(confirmation.snapshot.responses).toHaveLength(3);
    for (const response of confirmation.snapshot.responses) expect(response.sha256).toBe(createHash('sha256').update(response.raw).digest('hex'));
  }
  expect(JSON.stringify(incident)).not.toContain('fm2_private');

  // The write succeeded but its acknowledgement was lost before a new learner cycle.
  const monitorState = path.join(f.directory, 'state.json'), prior = await read(monitorState);
  prior.platform.observations['platform-cpu-throttle'].reported = false;
  await fs.writeFile(monitorState, JSON.stringify(prior));
  f.x.state.id = 'cycle-1792236978159'; f.x.frozen = structuredClone(f.x.state); f.x.status.cycle = f.x.state.id;
  await fs.mkdir(path.join(f.root, f.x.state.id)); await f.write(now + 180000);
  await pollLearning({ ...f, ...p, now: now + 180000 });
  expect(await fs.readdir(f.incidents)).toEqual([name]); expect(await digest(file)).toBe(original);

  p.unavailable(true); await f.write(now + 240000);
  const unknown = await pollLearning({ ...f, ...p, now: now + 240000 });
  expect(unknown.platformPerformance.state).toBe('unknown'); expect(unknown.ok).toBe(false);
  expect((await read(monitorState)).platform.observations['platform-cpu-throttle'].reported).toBe(true);
  p.unavailable(false); await f.write(now + 300000);
  expect((await pollLearning({ ...f, ...p, now: now + 300000 })).newIncidents).toEqual([]);
  expect(await digest(file)).toBe(original);
  p.seconds(0); await f.write(now + 360000);
  expect((await pollLearning({ ...f, ...p, now: now + 360000 })).ok).toBe(true);
  p.seconds(30);
  for (let i = 7; i < 10; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  expect(await fs.readdir(f.incidents)).toHaveLength(2); expect(await digest(file)).toBe(original);
});
it('keeps unknown platform evidence from completing an unconfirmed CPU streak and reports corrupt policy', async () => {
  const f = await fixture(), p = await platformFixture(f);
  for (let i = 0; i < 2; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  p.unavailable(true); await f.write(now + 240000); await pollLearning({ ...f, ...p, now: now + 240000 });
  p.unavailable(false); await f.write(now + 300000);
  const r = await pollLearning({ ...f, ...p, now: now + 300000 });
  expect(r.issues[0].consecutiveChecks).toBe(1); expect(r.newIncidents).toEqual([]);
  await fs.writeFile(p.performancePolicyFile, '{broken policy'); await f.write(now + 360000);
  const damaged = await pollLearning({ ...f, ...p, now: now + 360000 });
  expect(damaged.ok).toBe(false); expect(damaged.platformPerformance.state).toBe('unknown');
  expect(await fs.readFile(p.performancePolicyFile, 'utf8')).toBe('{broken policy');
});
it('keeps the CPU episode identity across a long telemetry gap and lost acknowledgement', async () => {
  const f = await fixture(), p = await platformFixture(f);
  for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  const name = (await fs.readdir(f.incidents))[0], original = await digest(path.join(f.incidents, name));
  const file = path.join(f.directory, 'state.json'), state = await read(file);
  state.platform.observations['platform-cpu-throttle'].reported = false;
  await fs.writeFile(file, JSON.stringify(state)); p.unavailable(true);
  await f.write(now + 300000); await pollLearning({ ...f, ...p, now: now + 300000 });
  p.unavailable(false);
  for (let i = 6; i < 9; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, ...p, now: now + i * 60000 }); }
  expect(await fs.readdir(f.incidents)).toEqual([name]); expect(await digest(path.join(f.incidents, name))).toBe(original);
  const current = await read(file);
  expect(current.platform.observations['platform-cpu-throttle'].issue.platformEvidence.confirmations.map(r => r.at)).toEqual([now + 360000, now + 420000, now + 480000]);
});
it('queues one durable incident for persistent refusal and never changes learner evidence', async () => {
  const f = await fixture(); f.x.state.protocolFailures = { count: 1 }; const receipts = [];
  for (let i = 0; i < 4; i++) {
    const at = now + i * 60000; await f.write(at);
    const files = [path.join(f.root, 'state.json'), path.join(f.root, 'status.json'), path.join(f.root, f.x.state.id, 'frozen-candidate.json')];
    const hashes = await Promise.all(files.map(digest));
    const result = await pollLearning({ ...f, now: at }); receipts.push(result);
    expect(await Promise.all(files.map(digest))).toEqual(hashes);
  }
  expect(receipts.map(r => r.newIncidents.length)).toEqual([0, 0, 1, 0]);
  const names = await fs.readdir(f.incidents); expect(names).toHaveLength(1);
  const incident = await read(path.join(f.incidents, names[0])); expect(incident.kind).toBe('learning-production-control');
  expect(incident.evidence.frozenCandidate).toBe(path.join(f.root, f.x.state.id, 'frozen-candidate.json'));
});
it('retries incident persistence after a filesystem failure without dropping the finding', async () => {
  const f = await fixture(); f.x.state.protocolFailures = { count: 1 };
  const bad = path.join(f.base, 'not-a-directory'); await fs.writeFile(bad, 'retain');
  for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, incidents: bad, now: now + i * 60000 }); }
  let s = await read(path.join(f.directory, 'status.json')); expect(s.incidentError).toBeTruthy(); expect(s.issues[0].reported).toBe(false);
  await f.write(now + 180000); s = await pollLearning({ ...f, now: now + 180000 });
  expect(s.incidentError).toBeNull(); expect(s.newIncidents).toHaveLength(1); expect(s.issues[0].reported).toBe(true);
});
it('preserves malformed learner bytes and reports unreadable evidence', async () => {
  const f = await fixture(); await f.write(now); const file = path.join(f.root, 'state.json'); await fs.writeFile(file, '{broken');
  for (let i = 0; i < 3; i++) await pollLearning({ ...f, now: now + i * 60000 });
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  const s = await read(path.join(f.directory, 'status.json')); expect(s.newIncidents).toHaveLength(1); expect(s.issues[0].code).toBe('unreadable-evidence');
});
it('serializes simultaneous checks without counting rapid probes as separate confirmations', async () => {
  const f = await fixture(); f.x.state.protocolFailures = { count: 1 }; await f.write(now);
  await Promise.all([pollLearning({ ...f, now }), pollLearning({ ...f, now })]);
  const s = await read(path.join(f.directory, 'state.json')); expect(s.observations['production-control'].count).toBe(1);
});
it('does not resurrect a processed incident after replaying an unreported monitor checkpoint', async () => {
  const f = await fixture(); f.x.state.protocolFailures = { count: 1 };
  for (let i = 0; i < 3; i++) { await f.write(now + i * 60000); await pollLearning({ ...f, now: now + i * 60000 }); }
  const name = (await fs.readdir(f.incidents))[0], processed = path.join(f.base, 'guardian/processed'); await fs.mkdir(processed);
  await fs.rename(path.join(f.incidents, name), path.join(processed, name));
  const stateFile = path.join(f.directory, 'state.json'), state = await read(stateFile); state.observations['production-control'].reported = false;
  await fs.writeFile(stateFile, JSON.stringify(state)); await f.write(now + 180000); await pollLearning({ ...f, now: now + 180000 });
  expect(await fs.readdir(f.incidents)).toEqual([]); expect(await fs.readdir(processed)).toEqual([name]);
  expect((await read(stateFile)).recent).toHaveLength(1);
});
it('bounds the monitor output log while preserving its live file', async () => {
  const f = await fixture(); await f.write(now); await fs.mkdir(f.directory);
  const log = path.join(f.directory, 'watcher.log'); await fs.writeFile(log, Buffer.alloc(1024 * 1024 + 128, 46)); const inode = (await fs.stat(log)).ino;
  expect((await pollLearning({ ...f, now })).ok).toBe(true);
  expect((await fs.stat(log)).ino).toBe(inode); expect((await fs.stat(log)).size).toBe(0);
  expect((await fs.readdir(f.directory)).filter(n => /^watcher\.log\.\d+\.gz$/.test(n))).toHaveLength(1);
});
it('queues configured recorder failures across scheduled polls without changing learner or recorder evidence', async () => {
  const f = await fixture(), collectorStatusFile = path.join(f.base, 'collector-status.json');
  await fs.writeFile(collectorStatusFile, '{broken recorder status');
  for (let i = 0; i < 3; i++) {
    const at = now + i * 60000; await f.write(at);
    const before = await digest(path.join(f.root, 'state.json'));
    const result = await pollLearning({ ...f, collectorStatusFile, now: at });
    expect(result.issues.map(x => x.code)).toEqual(['collector-heartbeat', 'collector-capture']);
    expect(await digest(path.join(f.root, 'state.json'))).toBe(before);
    expect(await fs.readFile(collectorStatusFile, 'utf8')).toBe('{broken recorder status');
    if (i === 2) expect(result.newIncidents).toHaveLength(2);
  }
  const at = now + 180000; await f.write(at); await fs.writeFile(collectorStatusFile, JSON.stringify({ ok: true, checkedAt: new Date(at).toISOString(), cursor: 12 }));
  const recovered = await pollLearning({ ...f, collectorStatusFile, now: at });
  expect(recovered.ok).toBe(true); expect(recovered.collectorCapture).toMatchObject({ ok: true, cursor: 12 });
});
it('probes a real process and rejects an unrelated live PID despite a valid-looking lock', async () => {
  const f = await fixture(); const script = path.join(f.base, 'observer.ts');
  await fs.writeFile(script, "console.log('ready');setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error('Fixture process exited: ' + code))); });
    await fs.writeFile(path.join(f.root, 'observer.lock'), String(child.pid));
    expect(await probeObserver(f.root, script)).toEqual({ pid: child.pid, alive: true, expectedCommand: true });
    await fs.writeFile(path.join(f.root, 'observer.lock'), String(process.pid));
    expect((await probeObserver(f.root, script)).expectedCommand).toBe(false);
  } finally { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
  await fs.writeFile(path.join(f.root, 'observer.lock'), String(child.pid));
  expect((await probeObserver(f.root, script)).alive).toBe(false);
});
