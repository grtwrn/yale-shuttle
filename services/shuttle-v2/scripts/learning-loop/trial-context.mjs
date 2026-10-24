import { createHash } from 'node:crypto';
import { identityHash } from '../reestimate-validation.mjs';
import { etDay, nextDay } from './lib.mjs';
import { validProductionExecutionIdentity } from '../../src/server/executionIdentity.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => identityHash(a) === identityHash(b);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cycle = value => typeof value === 'string' && /^cycle-\d+$/.test(value);
const contextId = (id, startedAt) => cycle(id) && Number(id.slice(6)) === startedAt;
const core = params => { const result = { ...params }; delete result.CONFORMAL; return result; };

/** Immutable statistical trial; producer contexts retain separate seed/chain
 * identities. Callers must retain and verify these original descriptor bytes.
 */
export function freezeTrial(state, execution) {
  const first = nextDay(etDay(state.startedAt));
  if (!contextId(state.id, state.startedAt) || !Number.isSafeInteger(state.startedAt) || !hash(execution?.sha256)
    || !validProductionExecutionIdentity(state.producerExecution)
    || !Number.isFinite(state.champion?.publishedAt) || state.champion.publishedAt >= state.startedAt
    || !state.candidate?.params || !same(state.calibrationDays, [first, nextDay(first)]))
    throw Error('Invalid prospective trial freeze');
  return structuredClone({ v: 1, id: state.id, startedAt: state.startedAt,
    executionSHA256: execution.sha256, producerExecutionSHA256:state.producerExecution.sha256,champion: state.champion, candidate: state.candidate,
    trainingDays: state.trainingDays, trainingInputs: state.trainingInputs,
    requiredRoutes: state.requiredRoutes, calibrationDays: state.calibrationDays });
}

/** Eligibility to seed a new exact execution context, never an attestation
 * that this new producer has computed or served a matching forecast. */
export function handoverDecision(previous, trial, execution, champion, producerExecution=previous?.producerExecution) {
  if (!trial && !previous?.trial && !previous?.trialSHA256)
    return { kind: 'new-trial', reason: 'Legacy or initial statistical trial' };
  if (trial?.v !== 1 || !hash(execution?.sha256)||!validProductionExecutionIdentity(producerExecution))
    return { kind: 'refuse', reason: 'Missing or unsupported trial/execution descriptor' };
  if (!hash(trial.executionSHA256) || !hash(previous?.trialSHA256)
    || previous.trialSHA256 !== identityHash(trial) || !contextId(trial.id, trial.startedAt)
    || !Number.isSafeInteger(trial.startedAt) || trial.startedAt > previous.startedAt)
    return { kind: 'refuse', reason: 'Frozen trial identity is missing or inconsistent' };
  if(!hash(trial.producerExecutionSHA256)||!validProductionExecutionIdentity(previous.producerExecution)
    ||previous.producerExecution.sha256!==trial.producerExecutionSHA256)
    return {kind:'refuse',reason:'Original producer execution identity changed'};
  if (execution?.sha256 !== trial.executionSHA256 || !same(champion, trial.champion)
    ||producerExecution.sha256!==trial.producerExecutionSHA256)
    return { kind: 'new-trial', reason: 'Scientific execution or champion changed' };
  if (previous.promotedAt || previous.publishingVersion)
    return { kind: 'new-trial', reason: 'Previous trial reached publication' };
  if (previous.sourceRefusal || previous.protocolFailures?.count > 0)
    return { kind: 'refuse', reason: 'Original source/protocol refusal remains unresolved' };
  if (!same(previous.champion, trial.champion)
    || !same(core(previous.candidate?.params), core(trial.candidate.params))
    || !same(previous.trainingDays, trial.trainingDays) || !same(previous.trainingInputs, trial.trainingInputs)
    || !same(previous.requiredRoutes, trial.requiredRoutes)
    || !same(previous.calibrationDays?.slice(0, trial.calibrationDays.length), trial.calibrationDays)
    || (!previous.calibratedAt && !same(previous.candidate, trial.candidate)))
    return { kind: 'refuse', reason: 'Candidate, training cohort or calibration calendar changed' };
  return { kind: 'continue-trial', reason: 'Frozen trial unchanged; new exact context remains unqualified' };
}

/** Preserve statistical progress only after the old context has durably
 * settled all pending promises as unknown and flushed its outbox. The bytes
 * supplied here become the immutable link to that exact closed state. Model
 * recovery, source copying and seed validation remain the caller's duties.
 */
export function continueTrial(closedBytes, trial, execution, next) {
  const previous = JSON.parse(Buffer.from(closedBytes).toString());
  const decision = handoverDecision(previous, trial, execution, previous.champion,next?.producerExecution);
  if (decision.kind !== 'continue-trial') throw Error(decision.reason);
  if (!Number.isSafeInteger(previous.invalidatedAt) || !Array.isArray(previous.outbox) || previous.outbox.length
    || Object.values(previous.pending ?? {}).some(p => !p.closed)
    || Object.values(previous.visits ?? {}).some(v => v.candidate))
    throw Error('Old context is not durably settled and closed');
  if (!next || Object.keys(next).some(k => !['id', 'startedAt', 'sourceKey', 'productionBuild', 'source','producerExecution'].includes(k))
    || !contextId(next.id, next.startedAt) || next.id === previous.id || !Number.isSafeInteger(next.startedAt)
    || next.startedAt <= previous.startedAt || previous.invalidatedAt > next.startedAt
    || !hash(next.sourceKey) || typeof next.productionBuild !== 'string' || !next.productionBuild
    || !hash(next.source?.seedSha256) || typeof next.source?.epoch !== 'string' || !next.source.epoch
    || !Number.isSafeInteger(next.source.seedReceivedAt) || next.source.seedReceivedAt > next.startedAt
    || next.source.seedReceivedAt < previous.invalidatedAt
    || (next.source.epoch === previous.source.epoch && next.sourceKey === previous.sourceKey
      && next.productionBuild === previous.productionBuild))
    throw Error('Invalid new exact context identity or clock');
  const contexts = previous.priorContexts ?? [];
  const identities = contexts.map(c => c.id);
  if (new Set(identities).size !== identities.length || identities.includes(previous.id)
    || identities.includes(next.id) || contexts.some(c => !cycle(c.id) || !hash(c.closedStateSHA256)))
    throw Error('Duplicate or malformed prior context link');
  const state = structuredClone(previous);
  for (const field of ['invalidatedAt', 'frozenCandidateSha256', 'lastInputKey', 'lastInputAt',
    'lastReceivedAt', 'contextQualifiedAt', 'contextQualification', 'contextQualificationPending',
    'transition', 'evaluatedDays', 'decision']) delete state[field];
  Object.assign(state, structuredClone(next), { trial: structuredClone(trial), trialSHA256: identityHash(trial),
    priorContexts: [...contexts, { id: previous.id, closedStateSHA256: sha(closedBytes),
      sourceKey: previous.sourceKey, productionBuild: previous.productionBuild,
      seedSha256: previous.source.seedSha256, epoch: previous.source.epoch }],
    contextQualifiedAt: null, outbox: [] });
  return state;
}
