import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerEta, type EtaPayloadView } from './serverEta';
import { K10_MODEL } from './k10Trial';
import { ROUTE_K10_MODELS } from './routeK10Trial';
import { validEvaluationContext, type EtaEvaluationContext } from './etaEvaluationContext';
import { registerRoutePaths } from '../../web/src/anchor';
import { resetModelParams } from '../../web/src/eta/params';

const cap = JSON.parse(fs.readFileSync(new URL('./__fixtures__/live-frames.json', import.meta.url), 'utf8'));
const models = [{ ...K10_MODEL, label: 'Red', routeId: 3, waitIndex: 10 }, ...ROUTE_K10_MODELS];
afterEach(() => { vi.unstubAllEnvs(); resetModelParams(); registerRoutePaths(null); });

describe('complete served forecast replay', () => {
  it.each(models)('replays $label adjustments and fallbacks in a fresh process', model => {
    const at = Date.parse(model.routeId === 16 ? '2026-09-22T00:10:00Z' : '2026-09-21T13:00:00Z');
    const index = model.waitIndex, stop = model.sequence[index]!, since = new Date(at - 120000).toISOString();
    const p: EtaPayloadView = { ...cap.static, buses: [{ bus_id: 42, bus_name: '#42', route_id: model.routeId,
      ...cap.static.stop_coords[stop], heading: 0, last_stop_id: stop, stationary: true, at_stop_id: stop,
      at_stop_since: since, stationary_since: since, last_moved_at: since, observed_at: at }] };
    let observation = 0;
    const source = (now: number) => new Map(observation >= 7 ? [] : [['42', { routeId: model.routeId, index,
      phase: 'hold' as const, released: observation >= 6, observedAt: now,
      origin: { departed: at - 300000, knownAt: at - 295000 } }]]);
    const instrumented = new ServerEta({ routes: [model.label], onServedForecasts: () => {} });
    const ordinary = new ServerEta({ routes: [model.label] });
    instrumented.useK10Trial(source); ordinary.useK10Trial(source);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-context-process-'));
    const future: { payload: EtaPayloadView; at: number; context: EtaEvaluationContext }[] = [], expected: unknown[] = [];
    let adjusted = 0, fallback = 0;
    try {
      for (observation = 0; observation < 9; observation++) {
        const now = at + observation * 5000, payload = structuredClone(p); payload.buses[0]!.observed_at = now;
        // Context freezes the real environment decisions per observation.
        vi.stubEnv('SHUTTLE_ROUTE_K10', observation === 4 ? '0' : '1');
        vi.stubEnv('SHUTTLE_BLUE_K10', observation === 4 ? '0' : '1');
        const wire = instrumented.contribute(payload, now, now, true);
        expect(wire).toEqual(ordinary.contribute(payload, now, now, true));
        expect(wire?.rows.length).toBeGreaterThan(0);
        const raw = instrumented.evaluationForecasts(), fixed = raw.filter(r => r.forecastSource === 'fixed-k10');
        if (fixed.length) adjusted++; else fallback++;
        expect(fixed.length).toBe(wire?.trial?.changedRows ?? 0);
        for (const row of wire!.rows) {
          const bus = wire!.buses[row[0]]!;
          const original = raw.find(r => r.routeLabel === bus[1] && r.busName === bus[0] && r.stopId === row[1] && r.stopsAhead === row[5])!;
          expect(original).toBeDefined();
          for (const [i, key] of ['eta', 'low', 'high'].entries()) expect(Math.abs(original[key as 'eta'] - row[i + 2]!)).toBeLessThanOrEqual(.5);
          expect(original.conformalBounds).toEqual(original.forecastSource==='fixed-k10'?{low:false,high:false}:original.intervalConformal);
        }
        const context = instrumented.evaluationContext()!;
        expect(validEvaluationContext(context, now)).toBe(true);
        if (observation === 2) fs.writeFileSync(path.join(directory, 'seed.v8'), instrumented.captureEvaluation()!.bytes);
        if (observation > 2) {
          future.push({ payload, at: now, context });
          expected.push({ wire, raw });
        }
      }
      expect(adjusted).toBeGreaterThan(2); expect(fallback).toBeGreaterThan(0);
      fs.writeFileSync(path.join(directory, 'future.json'), JSON.stringify(future));
      const script = path.join(directory, 'replay.mjs');
      fs.writeFileSync(script, `import fs from 'node:fs';import{deserialize}from'node:v8';import{createHash}from'node:crypto';
const{ServerEta}=await import(${JSON.stringify(new URL('./serverEta.ts', import.meta.url).href)});
const seed=fs.readFileSync(process.argv[2]),saved=deserialize(seed),engine=new ServerEta({routes:saved.served,onServedForecasts:()=>{}});
if(!engine.restoreEvaluation(seed,'history',saved.at))throw Error('History restore refused');
const future=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const actual=future.map(f=>{if(process.argv[4]!=='omit-context'&&!engine.useEvaluationContext(f.context))throw Error('Context refused');return{wire:engine.contribute(f.payload,f.at,f.at,true),raw:engine.evaluationForecasts()};});
process.stdout.write(createHash('sha256').update(JSON.stringify(actual)).digest('hex'));`);
      const run = (omitContext = false) => execFileSync(process.execPath,
        [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), script,
          path.join(directory, 'seed.v8'), path.join(directory, 'future.json'), omitContext ? 'omit-context' : 'full-context'],
        { encoding: 'utf8', timeout: 20000, env: { ...process.env, SHUTTLE_ROUTE_K10: '0', SHUTTLE_BLUE_K10: '0' } });
      const expectedHash = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
      expect(run()).toBe(expectedHash);
      expect(run(true)).not.toBe(expectedHash);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 25000);

  it('refuses a context for a different model clock without exporting stale history', () => {
    const at = cap.frames[0].t, engine = new ServerEta({ routes: ['Red'] });
    expect(engine.useEvaluationContext({ v: 1, at, trial: { enabled: false, route: false, blue: false, evidence: [] } })).toBe(true);
    engine.contribute({ ...cap.static, buses: cap.frames[0].buses }, at + 5000, at + 5000);
    expect(engine.stats().failures).toBe(1); expect(engine.captureEvaluation()).toBeNull();
  });

  it('keeps raw served forecasts with the arm own runtime checkpoint', () => {
    const at = cap.frames[0].t, a = new ServerEta({ routes: ['Red'], onServedForecasts: () => {} });
    a.contribute({ ...cap.static, buses: cap.frames[0].buses }, at, at);
    const saved = a.captureEvaluation('runtime')!, b = new ServerEta({ routes: ['Red'], onServedForecasts: () => {} });
    expect(b.restoreEvaluation(saved.bytes, 'runtime', at)).toBe(true);
    expect(b.evaluationForecasts()).toEqual(a.evaluationForecasts());
    expect(b.evaluationForecasts()).not.toBe(a.evaluationForecasts());
  });
});
