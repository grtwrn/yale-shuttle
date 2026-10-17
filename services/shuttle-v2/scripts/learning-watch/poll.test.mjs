import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { advance, inspect, pollLearning, probeObserver } from './poll.mjs';

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
