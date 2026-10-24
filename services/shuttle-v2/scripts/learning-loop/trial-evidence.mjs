import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { identityHash } from '../reestimate-validation.mjs';
import {validProductionExecutionIdentity} from '../../src/server/executionIdentity.ts';

const digest = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^cycle-\d+$/.test(id);
const same = (a, b) => identityHash(a) === identityHash(b);

/** Read the exact immutable closed-state links, oldest first. A missing link
 * is a refusal, never permission to score the remaining convenient subset. */
export function trialContexts(root, state) {
  if (!validId(state?.id)) throw Error('Invalid active context id');
  if (!state.trial) {
    if (state.priorContexts?.length || state.trialSHA256) throw Error('Missing frozen trial descriptor');
    return [state];
  }
  if (state.trialSHA256 !== identityHash(state.trial) || !Array.isArray(state.priorContexts))
    throw Error('Invalid frozen trial or context list');
  const result = [], seen = new Set([state.id]);
  for (const [index, link] of state.priorContexts.entries()) {
    if (!validId(link?.id) || seen.has(link.id)) throw Error('Duplicate or malformed context link');
    seen.add(link.id);
    const raw = fs.readFileSync(path.join(root, link.id, 'closed-state.json'));
    if (digest(raw) !== link.closedStateSHA256) throw Error('Closed context byte checksum mismatch');
    const previous = JSON.parse(raw);
    if (previous.id !== link.id || previous.trialSHA256 !== state.trialSHA256
      || !same(previous.trial, state.trial) || !same(previous.priorContexts, state.priorContexts.slice(0, index))
      || previous.sourceKey !== link.sourceKey || previous.productionBuild !== link.productionBuild
      || previous.source?.seedSha256 !== link.seedSha256 || previous.source?.epoch !== link.epoch
      || !Number.isSafeInteger(previous.invalidatedAt) || previous.invalidatedAt > state.startedAt
      || previous.startedAt >= state.startedAt || previous.outbox?.length
      || Object.values(previous.pending ?? {}).some(p => !p.closed))
      throw Error('Closed context differs from its exact trial link');
    if (result.length && result.at(-1).startedAt >= previous.startedAt)
      throw Error('Context chronology is not strictly increasing');
    result.push(previous);
  }
  if (result.length && result[0].id !== state.trial.id) throw Error('Original trial context is missing');
  if (!result.length && state.id !== state.trial.id) throw Error('Trial has no original context');
  return [...result, state];
}

export function readTrialPairs(root, state) {
  const seen = new Map();
  for (const context of trialContexts(root, state)) {
    const directory = path.join(root, context.id);
    for (const name of fs.readdirSync(directory).filter(n => /^pairs-.*\.jsonl$/.test(n)).sort()) {
      for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line), previous = seen.get(row.id);
        if (state.trial && row.sourceContextId !== context.id) throw Error('Forecast has the wrong execution context');
        if (previous && (previous.context !== context.id || !same(previous.row, row)))
          throw Error('Conflicting or cross-context duplicate forecast visit/horizon identity');
        seen.set(row.id, { context: context.id, row });
      }
    }
  }
  return [...seen.values()].map(value => value.row);
}

/** Bound metadata-only control-plane receipts separately from valid model
 * inputs. Confirmed terminal source changes never become skipped bad frames. */
export function retainSourceEvent(directory, source, value) {
  const raw = Buffer.from(JSON.stringify(value)), sha256 = digest(raw), file = `source-event-${sha256}.json`;
  const target = path.join(directory, file);
  if (fs.existsSync(target)) { if (!fs.readFileSync(target).equals(raw)) throw Error('Source event hash conflict'); }
  else fs.writeFileSync(target, raw, { flag: 'wx' });
  const receipt = { file, sha256, bytes: raw.length };
  source.events ??= {};
  source.events[sha256] = receipt;
  return receipt;
}

export function readSourceEvent(directory, receipt) {
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
    || receipt.file !== `source-event-${receipt.sha256}.json`) throw Error('Invalid source-event receipt');
  const raw = fs.readFileSync(path.join(directory, receipt.file));
  if (raw.length !== receipt.bytes || digest(raw) !== receipt.sha256) throw Error('Source-event bytes changed');
  return JSON.parse(raw);
}

export function verifyContextTransitions(root, contexts) {
  const exchange = (event, route, status) => {
    const value = event?.exchange;
    if (value?.route !== route || value.status !== status || !Number.isSafeInteger(value.receivedAt)
      || typeof value.raw !== 'string') throw Error('Missing original source HTTP exchange');
    return { ...value, value: JSON.parse(value.raw) };
  };
  for (const [index, context] of contexts.entries()) {
    const directory = path.join(root, context.id), events = context.source?.events ?? {};
    for (const [key, receipt] of Object.entries(events)) {
      if (key !== receipt.sha256) throw Error('Source-event membership changed');
      readSourceEvent(directory, receipt);
    }
    if (!context.trial) continue;
    const seed = exchange(readSourceEvent(directory, context.source.seedHTTPReceipt), '/api/evaluation/seed', 200);
    if (seed.receivedAt !== context.source.seedReceivedAt || seed.receivedAt > context.startedAt
      || digest(JSON.stringify(seed.value)) !== context.source.seedSha256
      ||!validProductionExecutionIdentity(seed.value.execution)||!validProductionExecutionIdentity(context.producerExecution)
      ||seed.value.execution.sha256!==context.producerExecution.sha256||seed.value.execution.sha256!==context.trial.producerExecutionSHA256)
      throw Error('Source seed does not match its original HTTP receipt');
    const next = contexts[index + 1];
    if (!next) continue;
    const transition = context.transition;
    if (!transition || transition.nextSourceKey !== next.sourceKey || transition.executionSHA256 !== context.trial.executionSHA256)
      throw Error('Closed context is missing its exact handover witness');
    const head = exchange(readSourceEvent(directory, transition.confirmation), '/api/evaluation/inputs', 200);
    if (head.receivedAt > context.invalidatedAt || head.receivedAt > next.source.seedReceivedAt
      || head.value.build !== next.productionBuild || head.value.epoch !== next.source.epoch
      ||!validProductionExecutionIdentity(head.value.execution)||head.value.execution.sha256!==context.trial.producerExecutionSHA256
      || head.value.cursor > next.source.seedCursor || head.value.at > next.source.seedAt
      || !same({version:head.value.feed?.model_params?.version,params:head.value.feed?.model_params?.params},
        {version:context.champion.version,params:context.champion.params}))
      throw Error('Confirmed producer head does not precede the next exact seed');
    if (transition.trigger) {
      const trigger = readSourceEvent(directory, transition.trigger), http = trigger.exchange;
      if (trigger.kind !== 'context-trigger' || !http || http.receivedAt > head.receivedAt
        || http.receivedAt > context.invalidatedAt) throw Error('Invalid terminal context trigger clock');
      const url = new URL(http.route, 'http://source.invalid');
      if (url.pathname !== '/api/evaluation/inputs' || url.searchParams.get('epoch') !== context.source.epoch
        || Number(url.searchParams.get('after')) !== context.source.runtime.cursor)
        throw Error('Terminal context trigger does not bind the old exact cursor');
      const response = JSON.parse(http.raw);
      if (http.status === 409) {
        if (response.error !== 'evaluation_epoch' || head.value.epoch === context.source.epoch)
          throw Error('Terminal epoch refusal is not confirmed by a new producer');
      } else if (http.status === 200) {
        if (response.build !== head.value.build || response.epoch !== head.value.epoch
          || (response.build === context.productionBuild && response.epoch === context.source.epoch))
          throw Error('Changed source packet is not confirmed by the new producer head');
      } else throw Error('Unsupported terminal context response');
    } else if (context.sourceKey === next.sourceKey) {
      throw Error('Context changed without a local source or confirmed producer trigger');
    }
  }
}
