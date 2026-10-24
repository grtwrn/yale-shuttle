import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { identityHash } from '../reestimate-validation.mjs';
import { readSourceEvent, readTrialPairs, retainSourceEvent, trialContexts, verifyContextTransitions } from './trial-evidence.mjs';
import {fixtureProducerExecution} from './__fixtures__/execution-identity';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(local = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-context-evidence-')); temporary.push(root);
  for (const id of ['cycle-100', 'cycle-200']) fs.mkdirSync(path.join(root, id));
  const champion = { version: 'champion', params: { P: .5 } };
  const producerExecution=fixtureProducerExecution();
  const trial = { v: 1, id: 'cycle-100', startedAt: 100, executionSHA256: sha('execution'),producerExecutionSHA256:producerExecution.sha256 };
  const original: any = { id: 'cycle-100', startedAt: 100, invalidatedAt: 190, sourceKey: sha('old-source'), productionBuild: 'old-build',
    champion, trial,producerExecution, trialSHA256: identityHash(trial), priorContexts: [], outbox: [], pending: {},
    source: { epoch: 'old-epoch', seedReceivedAt: 90, seedCursor: 1, seedAt: 80, runtime: { cursor: 1 } } };
  const next: any = { ...structuredClone(original), id: 'cycle-200', startedAt: 200,
    sourceKey: local ? sha('new-ui-source') : original.sourceKey, productionBuild: local ? 'old-build' : 'new-build',
    source: { epoch: local ? 'old-epoch' : 'new-epoch', seedReceivedAt: 199, seedCursor: local ? 1 : 2, seedAt: local ? 80 : 160 } };
  delete next.invalidatedAt;
  for (const context of [original, next]) {
    const seed = { build: context.productionBuild, epoch: context.source.epoch, cursor: context.source.seedCursor, at: context.source.seedAt, modelParams: champion,execution:producerExecution };
    context.source.seedSha256 = sha(JSON.stringify(seed));
    context.source.seedHTTPReceipt = retainSourceEvent(path.join(root, context.id), context.source,
      { kind: 'context-seed', exchange: { route: '/api/evaluation/seed', status: 200, receivedAt: context.source.seedReceivedAt, raw: JSON.stringify(seed) } });
  }
  const head = { v: 1, build: next.productionBuild, epoch: next.source.epoch, cursor: next.source.seedCursor, at: next.source.seedAt, feed: { model_params: champion },execution:producerExecution };
  const confirmation = retainSourceEvent(path.join(root, original.id), original.source,
    { kind: 'context-head', exchange: { route: '/api/evaluation/inputs', status: 200, receivedAt: 180, raw: JSON.stringify(head) } });
  const trigger = local ? null : retainSourceEvent(path.join(root, original.id), original.source,
    { kind: 'context-trigger', exchange: { route: '/api/evaluation/inputs?epoch=old-epoch&after=1', status: 409, receivedAt: 170, raw: '{"error":"evaluation_epoch"}' } });
  original.transition = { confirmation, trigger, nextSourceKey: next.sourceKey, executionSHA256: trial.executionSHA256 };
  const close = () => {
    const raw = JSON.stringify(original); fs.writeFileSync(path.join(root, original.id, 'closed-state.json'), raw);
    next.priorContexts = [{ id: original.id, closedStateSHA256: sha(raw), sourceKey: original.sourceKey,
      productionBuild: original.productionBuild, seedSha256: original.source.seedSha256, epoch: original.source.epoch }];
  }; close();
  const pairs = (context: any, rows: any[]) => fs.writeFileSync(path.join(root, context.id, 'pairs-2026-10-24.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { root, original, next, close, pairs };
}

describe('complete trial evidence across exact contexts', () => {
  it.each([false, true])('verifies a witnessed producer/local-source transition (local=%s)', local => {
    const f = fixture(local), contexts = trialContexts(f.root, f.next);
    expect(contexts.map(c => c.id)).toEqual(['cycle-100', 'cycle-200']);
    expect(() => verifyContextTransitions(f.root, contexts)).not.toThrow();
  });
  it('keeps unknown rows in their original context and counts each forecast once', () => {
    const f = fixture(); f.pairs(f.original, [{ id: 'visit-1', sourceContextId: f.original.id, det: null, reason: 'cycle-invalidated' }]);
    f.pairs(f.next, [{ id: 'visit-2', sourceContextId: f.next.id, det: 20 }]);
    expect(readTrialPairs(f.root, f.next).map(r => r.det)).toEqual([null, 20]);
  });
  it('refuses a repeated visit identity in a later context', () => {
    const f = fixture(); f.pairs(f.original, [{ id: 'visit-1', sourceContextId: f.original.id, det: null }]);
    f.pairs(f.next, [{ id: 'visit-1', sourceContextId: f.next.id, det: 20 }]);
    expect(() => readTrialPairs(f.root, f.next)).toThrow('cross-context duplicate');
  });
  it('refuses missing or altered closed-state bytes instead of scoring a subset', () => {
    const f = fixture(); fs.appendFileSync(path.join(f.root, f.original.id, 'closed-state.json'), '\n');
    expect(() => trialContexts(f.root, f.next)).toThrow('checksum');
    fs.unlinkSync(path.join(f.root, f.original.id, 'closed-state.json'));
    expect(() => readTrialPairs(f.root, f.next)).toThrow();
  });
  it('refuses a source event whose retained response bytes changed', () => {
    const f = fixture(), receipt = f.original.transition.trigger;
    fs.appendFileSync(path.join(f.root, f.original.id, receipt.file), ' ');
    expect(() => readSourceEvent(path.join(f.root, f.original.id), receipt)).toThrow('bytes changed');
  });
  it('refuses an unwitnessed producer change and a seed preceding confirmation', () => {
    const f = fixture(); f.original.transition.trigger = null; f.close();
    expect(() => verifyContextTransitions(f.root, trialContexts(f.root, f.next))).toThrow('without a local source');
    const g = fixture(); g.next.source.seedAt = 159;
    expect(() => verifyContextTransitions(g.root, trialContexts(g.root, g.next))).toThrow('does not precede');
  });
  it('refuses a missing original context and path traversal in event receipts', () => {
    const f = fixture(); f.next.priorContexts = [];
    expect(() => trialContexts(f.root, f.next)).toThrow('no original context');
    expect(() => readSourceEvent(f.root, { file: 'source-event-../escape.json', sha256: '../escape' })).toThrow('Invalid');
  });
});
