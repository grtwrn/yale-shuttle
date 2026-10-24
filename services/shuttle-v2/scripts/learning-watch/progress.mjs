import { identityHash } from '../reestimate-validation.mjs';

/** Operational history of lost calendar progress. This does not certify
 * support or accuracy and never changes an observer, trial or publication. */
export function advanceTrialProgress(prior, state, now) {
  if (!state?.candidate?.params || !Array.isArray(state.trainingInputs)
    || !Array.isArray(state.trainingDays) || !Array.isArray(state.calibrationDays)) return null;
  const id = state.trial?.id ?? state.id, startedAt = state.trial?.startedAt ?? state.startedAt;
  if (!/^cycle-\d+$/.test(id ?? '') || !Number.isSafeInteger(startedAt) || startedAt > now + 5000) return null;
  const target = identityHash({ champion: state.trial?.champion ?? state.champion,
    candidate: state.trial?.candidate ?? state.candidate,
    trainingInputs: state.trainingInputs, trainingDays: state.trainingDays });
  const history = (Array.isArray(prior?.history) ? prior.history : []).filter(row => row.firstSeenAt >= now - 7 * 86400000 && row.id !== id).slice(-31);
  const old = prior?.history?.find(row => row.id === id);
  const row = { id, startedAt, target, firstSeenAt: old?.firstSeenAt ?? now, lastSeenAt: now,
    calibrationFirstDay: state.trial?.calibrationDays?.[0] ?? state.calibrationDays[0],
    calibratedAt: state.calibratedAt ?? old?.calibratedAt ?? null };
  history.push(row);
  const matching = history.filter(r => r.target === target && r.firstSeenAt >= now - 86400000);
  const postponed = matching.length >= 3 && row.calibrationFirstDay > matching[0].calibrationFirstDay;
  const issues = postponed && !row.calibratedAt ? [{ code: 'trial-calendar-restarts',
    summary: 'Repeated trials with unchanged candidate/champion/training receipts have postponed calibration. Process health does not prove learning progress; inspect the retained trial history.' }] : [];
  return { v: 1, history, currentTrialId: id, currentContextId: state.id,
    sameTargetTrialsLast24Hours: matching.length, warmingAgeMs: Math.max(0, now - startedAt),
    calibrationPostponed: postponed, issues };
}
