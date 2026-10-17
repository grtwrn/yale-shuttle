import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEta, type EtaPayloadView, type ServerEtaWire } from './serverEta';
import { ROUTE_LISTS } from '../../web/src/routes';
import { registerRoutePaths } from '../../web/src/anchor';
import { resetModelParams } from '../../web/src/eta/params';

const capture = JSON.parse(fs.readFileSync(new URL('./__fixtures__/live-frames.json', import.meta.url), 'utf8'));
const routes = ROUTE_LISTS.map(r => r.label);
const engine = () => new ServerEta({ routes });
const payload = (i: number): EtaPayloadView => ({ ...capture.static, buses: structuredClone(capture.frames[i].buses) });
afterEach(() => { resetModelParams(); registerRoutePaths(null); });

describe('complete evaluation state fork and recovery', () => {
  it('reproduces the recorded future in a fresh process without sharing module caches', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-state-process-'));
    try {
      const producer = engine();
      for (let i = 0; i < 20; i++) producer.contribute(payload(i), capture.frames[i].t, capture.frames[i].t);
      const seed = producer.captureEvaluation()!; const file = path.join(directory, 'seed.v8'); fs.writeFileSync(file, seed.bytes);
      const expected: (ServerEtaWire | null)[] = capture.frames.slice(20, 40).map((frame: { t: number }, j: number) => producer.contribute(payload(j + 20), frame.t, frame.t));
      const script = path.join(directory, 'child.mjs');
      fs.writeFileSync(script, `import fs from 'node:fs';import {deserialize} from 'node:v8';import {createHash} from 'node:crypto';
const {ServerEta}=await import(${JSON.stringify(new URL('./serverEta.ts', import.meta.url).href)});
const {ROUTE_LISTS}=await import(${JSON.stringify(new URL('../../web/src/routes.ts', import.meta.url).href)});
const cap=JSON.parse(fs.readFileSync(new URL(${JSON.stringify(new URL('./__fixtures__/live-frames.json', import.meta.url).href)}),'utf8'));
const bytes=fs.readFileSync(process.argv[2]),state=deserialize(bytes),engine=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});
if(!engine.restoreEvaluation(bytes,'history',state.at))throw Error('Restore refused');
const wires=cap.frames.slice(20,40).map(f=>engine.contribute({...cap.static,buses:structuredClone(f.buses)},f.t,f.t));
fs.writeFileSync(process.argv[3],JSON.stringify(wires));process.stdout.write(createHash('sha256').update(JSON.stringify(wires)).digest('hex'));`);
      const resultFile = path.join(directory, 'wires.json');
      const actual = execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), script, file, resultFile],
        { encoding: 'utf8', timeout: 20000 });
      const expectedHash = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
      expect(actual).toBe(expectedHash);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 25000);
  it('keeps the recorded future wire identical after a complete history fork', () => {
    const producer = engine(), fork = engine();
    for (let i = 0; i < 20; i++) producer.contribute(payload(i), capture.frames[i].t, capture.frames[i].t);
    const seed = producer.captureEvaluation()!; expect(seed).not.toBeNull();
    expect(fork.restoreEvaluation(seed.bytes, 'history', seed.at)).toBe(true);
    for (let i = 20; i < 40; i++) {
      const p = payload(i), at = capture.frames[i].t;
      expect(fork.contribute(p, at, at)).toEqual(producer.contribute(p, at, at));
    }
  });
  it('does not advance a cached per-vehicle observation after cloning its shared object graph', () => {
    const producer = engine(), fork = engine(), p = payload(0), at = capture.frames[0].t;
    for (const bus of p.buses) bus.observed_at = at;
    producer.contribute(p, at, at); const seed = producer.captureEvaluation()!;
    expect(fork.restoreEvaluation(seed.bytes, 'history', at)).toBe(true);
    const next = structuredClone(p);
    const a = producer.contribute(next, at + 5000, at + 5000), b = fork.contribute(next, at + 5000, at + 5000);
    expect(b).toEqual(a);
    const memory = deserialize(fork.captureEvaluation()!.bytes);
    for (const entry of memory.store.values()) {
      expect(entry.belief.seenAt).toBe(at);
      expect([...memory.observed.values()]).toContain(entry.belief.lastObs);
    }
  });
  it('restores the arm own cached wire without stepping twice or adopting another arm forecast', () => {
    const producer = engine(), resumed = engine(); const p = payload(0), at = capture.frames[0].t;
    producer.contribute(p, at, at); const saved = producer.captureEvaluation('runtime')!;
    expect(resumed.restoreEvaluation(saved.bytes, 'runtime', at + 1000)).toBe(true);
    expect(resumed.contribute(structuredClone(p), at, at + 2000)).toEqual(producer.contribute(p, at, at + 2000));
    expect(resumed.stats().steps).toBe(1);
    expect(resumed.restoreEvaluation(saved.bytes, 'history', at)).toBe(false);
  });
  it('keeps snapshot capture side-effect free and the fork independent', () => {
    const a = engine(), b = engine(), fork = engine();
    for (let i = 0; i < 30; i++) {
      const p = payload(i), at = capture.frames[i].t;
      expect(a.contribute(p, at, at)).toEqual(b.contribute(p, at, at));
      const before = a.stats(); const saved = a.captureEvaluation(); expect(a.stats()).toEqual(before);
      if (i === 10) {
        expect(fork.restoreEvaluation(saved!.bytes, 'history', at)).toBe(true);
        const state = deserialize(fork.captureEvaluation()!.bytes);
        const entry = [...state.store.values()][0] as any; entry.belief.p.fill(0);
        expect(fork.restoreEvaluation(serialize(state), 'history', at)).toBe(true);
      }
    }
  });
  it('rejects corrupt, future, expired, mismatched-route and incomplete snapshots atomically', () => {
    const source = engine(), target = engine(), at = capture.frames[0].t;
    source.contribute(payload(0), at, at); target.contribute(payload(0), at, at);
    const saved = source.captureEvaluation()!, original = Buffer.from(target.captureEvaluation('runtime')!.bytes);
    const cases = [Buffer.from('broken'), saved.bytes];
    expect(target.restoreEvaluation(cases[0]!, 'history', at)).toBe(false);
    expect(target.restoreEvaluation(saved.bytes, 'history', at - 5001)).toBe(false);
    expect(target.restoreEvaluation(saved.bytes, 'history', at + 120001)).toBe(false);
    for (const field of ['observed', 'seen', 'served']) {
      const bad = deserialize(saved.bytes); delete bad[field];
      expect(target.restoreEvaluation(serialize(bad), 'history', at)).toBe(false);
    }
    expect(Buffer.from(target.captureEvaluation('runtime')!.bytes)).toEqual(original);
    expect(new ServerEta({ routes: ['Red'] }).restoreEvaluation(saved.bytes, 'history', at)).toBe(false);
  });
  it('handles a valid empty observation without inventing a forecast', () => {
    const a = engine(), b = engine(), at = capture.frames[0].t, p = { ...payload(0), buses: [] };
    expect(a.captureEvaluation()).toBeNull(); expect(a.contribute(p, at, at)).toBeNull();
    const saved = a.captureEvaluation()!; expect(saved.at).toBe(at);
    expect(b.restoreEvaluation(saved.bytes, 'history', at)).toBe(true);
    expect(b.contribute(p, at + 5000, at + 5000)).toBeNull();
  });
});
