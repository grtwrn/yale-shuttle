import { describe, expect, it } from 'vitest';
import { identityHash } from '../reestimate-validation.mjs';
import { continueTrial, freezeTrial, handoverDecision } from './trial-context.mjs';
import {fixtureProducerExecution} from './__fixtures__/execution-identity';

const hash = (n: number) => n.toString(16).padStart(64, '0');
function fixture() {
  const startedAt = Date.parse('2026-10-23T21:18:34Z'), params = { P: .5, CONFORMAL: { '0-2': 1, '2-5': 1, '5-10': 1, '10-30': 1 } };
  const state: any = { version: 2, forecastProtocol: 'served-control-v2', id: `cycle-${startedAt}`, startedAt,
    sourceKey: hash(1), productionBuild: 'old-build',producerExecution:fixtureProducerExecution(), champion: { version: 'champion', params, publishedAt: startedAt - 86400000 },
    candidate: { params: structuredClone(params), n: { P: 1000 }, issues: [] }, trainingDays: ['2026-10-20'],
    trainingInputs: [{ file: 'original-input', sha256: hash(2) }], requiredRoutes: [10], calibrationDays: ['2026-10-24', '2026-10-25'],
    pending: { visit1: { id: 'visit1', closed: true, det: null, reason: 'context-ended' } },
    visits: { bus: { ordinal: 4, latched: true } }, outbox: [], source: { epoch: 'old-epoch', seedSha256: hash(3) } };
  const execution = { sha256: hash(4) }, trial = freezeTrial(state, execution); state.trial = trial; state.trialSHA256 = identityHash(trial);
  state.invalidatedAt = Date.parse('2026-10-24T07:16:04Z');
  const next = { id: `cycle-${state.invalidatedAt + 2000}`, startedAt: state.invalidatedAt + 2000, productionBuild: 'new-build', sourceKey: hash(5),producerExecution:fixtureProducerExecution(),
    source: { epoch: 'new-epoch', seedSha256: hash(6), seedReceivedAt: state.invalidatedAt + 1000 } };
  return { state, execution, trial, next, bytes: () => Buffer.from(JSON.stringify(state)) };
}

describe('frozen trial continuation planning', () => {
  it('preserves dates, original candidate, training, unknown promises and visit latches across a midnight release', () => {
    const f = fixture(), next = continueTrial(f.bytes(), f.trial, f.execution, f.next);
    expect(next.calibrationDays).toEqual(['2026-10-24', '2026-10-25']);
    expect(next.candidate).toEqual(f.state.candidate); expect(next.trainingInputs).toEqual(f.state.trainingInputs);
    expect(next.pending).toEqual(f.state.pending); expect(next.visits).toEqual(f.state.visits);
    expect(next.trial.id).toBe(f.state.id); expect(next.id).toBe(f.next.id);
    expect(next.priorContexts[0].id).toBe(f.state.id); expect(next.contextQualifiedAt).toBeNull();
    expect(next).not.toHaveProperty('invalidatedAt'); expect(f.state.invalidatedAt).toBeTruthy();
  });
  it('retains a previously frozen interval fit and untouched test chronology', () => {
    const f = fixture(); f.state.invalidatedAt = Date.parse('2026-10-27T07:00:00Z');
    f.next.startedAt = f.state.invalidatedAt + 2000; f.next.id = `cycle-${f.next.startedAt}`;
    f.next.source.seedReceivedAt = f.state.invalidatedAt + 1000;
    f.state.calibratedAt = Date.parse('2026-10-26T04:47:00Z'); f.state.candidate.params.CONFORMAL['2-5'] = 1.5;
    f.state.testStartDay = '2026-10-26'; f.state.calibratedCandidateSha256 = hash(7);
    const next = continueTrial(f.bytes(), f.trial, f.execution, f.next);
    expect(next.calibratedAt).toBe(f.state.calibratedAt); expect(next.testStartDay).toBe('2026-10-26');
    expect(next.candidate.params.CONFORMAL['2-5']).toBe(1.5); expect(next.calibratedCandidateSha256).toBe(hash(7));
  });
  it.each(['sourceRefusal', 'protocolFailures'])('preserves a known failure as refusal: %s', key => {
    const f = fixture(); f.state[key] = key === 'protocolFailures' ? { count: 1 } : { reason: 'missing retained inputs' };
    expect(handoverDecision(f.state, f.trial, f.execution, f.state.champion).kind).toBe('refuse');
    expect(() => continueTrial(f.bytes(), f.trial, f.execution, f.next)).toThrow('refusal');
  });
  it.each(['candidate', 'trainingInputs', 'calibrationDays'])('refuses silently changed frozen data: %s', key => {
    const f = fixture(); if (key === 'candidate') f.state.candidate.params.P = .6;
    else if (key === 'trainingInputs') f.state.trainingInputs = [];
    else f.state.calibrationDays = ['2026-10-25', '2026-10-26'];
    expect(handoverDecision(f.state, f.trial, f.execution, f.state.champion).kind).toBe('refuse');
  });
  it('requires a new trial after an actual execution or champion change', () => {
    const f = fixture(); expect(handoverDecision(f.state, f.trial, { sha256: hash(20) }, f.state.champion).kind).toBe('new-trial');
    expect(handoverDecision(f.state, f.trial, f.execution, { ...f.state.champion, version: 'replacement' }).kind).toBe('new-trial');
  });
  it('refuses an unflushed promise, curb confirmation, or outbox', () => {
    for (const change of [(s: any) => { s.pending.visit1.closed = false; }, (s: any) => { s.visits.bus.candidate = { at: 123 }; }, (s: any) => { s.outbox = [{}]; }]) {
      const f = fixture(); change(f.state); expect(() => continueTrial(f.bytes(), f.trial, f.execution, f.next)).toThrow('settled');
    }
  });
  it('refuses duplicate context links and keeps a seed received after closure', () => {
    const f = fixture(); f.state.priorContexts = [{ id: f.next.id, closedStateSHA256: hash(22) }];
    expect(() => continueTrial(f.bytes(), f.trial, f.execution, f.next)).toThrow('context link');
    delete f.state.priorContexts; f.next.source.seedReceivedAt = f.state.invalidatedAt - 1;
    expect(() => continueTrial(f.bytes(), f.trial, f.execution, f.next)).toThrow('clock');
  });
  it('refuses a missing frozen descriptor instead of treating a known trial as legacy', () => {
    const f = fixture(); expect(handoverDecision(f.state, null, f.execution, f.state.champion).kind).toBe('refuse');
    expect(handoverDecision(f.state, f.trial, null, f.state.champion).kind).toBe('refuse');
  });
  it('refuses extra fields that could overwrite the carried statistical state', () => {
    const f = fixture(); expect(() => continueTrial(f.bytes(), f.trial, f.execution, { ...f.next, candidate: {} })).toThrow('identity or clock');
  });
  it('restores the original runtime for the same context instead of silently reseeding', () => {
    const f = fixture(); Object.assign(f.next, { sourceKey: f.state.sourceKey, productionBuild: f.state.productionBuild });
    f.next.source.epoch = f.state.source.epoch;
    expect(() => continueTrial(f.bytes(), f.trial, f.execution, f.next)).toThrow('identity or clock');
  });
  it('starts a new trial when actual producer execution bytes change under an unchanged lockfile',()=>{
    const f=fixture();expect(handoverDecision(f.state,f.trial,f.execution,f.state.champion,fixtureProducerExecution(10)).kind).toBe('new-trial');
    expect(()=>continueTrial(f.bytes(),f.trial,f.execution,{...f.next,producerExecution:fixtureProducerExecution(10)})).toThrow('Scientific execution');
  });
});
