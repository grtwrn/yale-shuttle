import fs from 'node:fs/promises';
import path from 'node:path';
import { DAY, MiB, atomicJson, readJson } from './storage.mjs';
import { learningCustody } from './custody.mjs';
import { captureLearningControls, assertLearningControlsUnchanged } from './control-snapshot.mjs';

const hour = ms => new Date(ms).toISOString().slice(0, 13).replace('T', '-');
const feedHour = name => /^feed-(\d{4}-\d{2}-\d{2}-\d{2})-\d+\.jsonl\.gz$/.exec(name)?.[1];
function midnight(day) {
  for (const h of [4, 5]) {
    const ms = Date.parse(`${day}T0${h}:00:00Z`);
    if (new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms) === day) return ms;
  }
  throw Error('Invalid calibration date');
}
export async function maintainLearning(root, { now = Date.now(), dryRun = false,
  closedMaxBytes = 256 * MiB, closedMaxAgeMs = 7 * DAY } = {}) {
  const state = await readJson(path.join(root, 'state.json'), null);
  if (!state || !/^cycle-\d+$/.test(state.id)) return { skipped: 'No valid current cycle; no evaluation evidence deleted' };
  const contexts=state.priorContexts??[];
  if(!Array.isArray(contexts)||contexts.some(c=>!/^cycle-\d+$/.test(c?.id??''))
    ||new Set(contexts.map(c=>c.id)).size!==contexts.length)
    return {skipped:'Invalid active trial context links; no evaluation evidence deleted'};
  const activeContexts=new Set([state.id,...contexts.map(c=>c.id)]);
  if(state.trial?.id){
    if(!/^cycle-\d+$/.test(state.trial.id)||!activeContexts.has(state.trial.id))return {skipped:'Original trial context is missing; no evaluation evidence deleted'};
  }
  const controlSnapshot=await captureLearningControls(root,state);
  const retainedHours = new Set([hour(now), hour(now - 3600000)]);
  for (const p of Object.values(state.pending ?? {})) if (!p.closed && Number.isFinite(p.at)) retainedHours.add(hour(p.at));
  for (const v of Object.values(state.visits ?? {})) if (Number.isFinite(v.candidate?.receivedAt)) retainedHours.add(hour(v.candidate.receivedAt));
  // Forecasts only exist from the first calibration date. Preserve the
  // boundary hour too, plus candidate/pending receipts and the open writer.
  const warmingCutoff = state.calibrationDays?.[0] ? midnight(state.calibrationDays[0]) - 47 * 60000 : null;
  const closed = [], warming = [], cycles = [], refusedContexts = new Set(), refusedTrials = new Set();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^cycle-\d+$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const frozen = await readJson(path.join(directory, 'frozen-candidate.json'), null);
    const previous = await readJson(path.join(directory, 'closed-state.json'), null);
    // A new scientific trial must not turn a refused cohort into disposable
    // routine history. Preserve every context sharing that original trial.
    if (previous?.sourceRefusal || previous?.protocolFailures?.count > 0) {
      refusedContexts.add(entry.name);
      if (frozen?.trialSHA256 != null || previous.trialSHA256 != null) {
        if (!/^[a-f0-9]{64}$/.test(frozen.trialSHA256) || previous.trialSHA256 !== frozen.trialSHA256)
          throw Error('Refused learning trial identity differs; no evaluation evidence deleted');
        refusedTrials.add(frozen.trialSHA256);
      }
    }
    cycles.push({ entry, directory, frozen, previous });
  }
  const custody=await learningCustody(root,cycles,{now,dryRun});
  let activeBytes = 0, refusedInputBytes = 0, completedInputBytes=0, pinnedInputBytes=0;
  const refusedTrialContexts = [],completedTrialContexts=[],pinnedTrialContexts=[],archivedTrialContexts=[];
  for (const { entry, directory, frozen } of cycles) {
    const refusedEvidence = refusedContexts.has(entry.name) || refusedTrials.has(frozen?.trialSHA256);
    if (refusedEvidence) refusedTrialContexts.push(entry.name);
    const pinnedEvidence=custody.pinnedTrials.has(frozen?.trialSHA256);
    const archived=custody.archivedTrials.has(frozen?.trialSHA256);
    const completedEvidence=(custody.completedContexts.has(entry.name)||custody.completedTrials.has(frozen?.trialSHA256))&&!archived;
    if(pinnedEvidence)pinnedTrialContexts.push(entry.name);
    if(completedEvidence)completedTrialContexts.push(entry.name);
    if(archived)archivedTrialContexts.push(entry.name);
    const championEvidence = frozen && state.champion?.version === `prospective-${frozen.trial?.startedAt??frozen.startedAt}`;
    for (const file of await fs.readdir(directory, { withFileTypes: true })) {
      const h = feedHour(file.name); if (!file.isFile() || !h) continue;
      const name = path.join(directory, file.name), stat = await fs.stat(name);
      const recordedEnd=Date.parse(h.slice(0,10)+'T'+h.slice(11)+':00:00Z')+3600000;
      if(!Number.isFinite(recordedEnd))throw Error('Invalid learning journal hour; no evaluation evidence deleted');
      const item = { file: name, bytes: stat.size, cycle: entry.name, time: recordedEnd, reason: 'superseded-cycle' };
      if (!activeContexts.has(entry.name) && !championEvidence && !refusedEvidence && !completedEvidence && !pinnedEvidence) closed.push(item);
      else {
        activeBytes += stat.size;
        if (refusedEvidence) refusedInputBytes += stat.size;
        if(completedEvidence)completedInputBytes+=stat.size;
        if(pinnedEvidence)pinnedInputBytes+=stat.size;
        const end = Date.parse(h.slice(0, 10) + 'T' + h.slice(11) + ':00:00Z') + 3600000;
        if (!refusedEvidence && !completedEvidence && !pinnedEvidence && activeContexts.has(entry.name) && state.forecastProtocol !== 'served-control-v2' && warmingCutoff !== null && end < warmingCutoff
          && !retainedHours.has(h) && stat.mtimeMs < now - 60000) warming.push({ ...item, reason: 'unreferenced-warming-input' });
      }
    }
  }
  closed.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
  let closedBytes = closed.reduce((sum, item) => sum + item.bytes, 0);
  const removed = [...warming];
  for (const item of closed) {
    if (item.time >= now - closedMaxAgeMs && closedBytes <= closedMaxBytes) continue;
    removed.push(item); closedBytes -= item.bytes;
  }
  // Recheck the cycle before removing anything. A concurrent cycle transition
  // cannot authorize deleting the new trial's input files.
  const current = await readJson(path.join(root, 'state.json'), null);
  if (current?.id !== state.id) return { skipped: 'Cycle changed during retention planning' };
  await assertLearningControlsUnchanged(root,controlSnapshot,{state:current,acceptedReceipts:custody.acceptedReceipts});
  if (!dryRun) for (const item of removed) await fs.unlink(item.file);
  const result = { updatedAt: new Date(now).toISOString(), activeCycle: state.id, activeContexts:[...activeContexts], dryRun,
    refusedTrialContexts, refusedInputBytes,
    completedTrialContexts,completedInputBytes,pinnedTrialContexts,pinnedInputBytes,archivedTrialContexts,
    deletedFiles: removed.length, freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    protectedInputBytes: activeBytes - warming.reduce((sum, item) => sum + item.bytes, 0),
    retainedSupersededBytes: closedBytes,
    removed: removed.map(item => ({ ...item, file: path.relative(root, item.file) })) };
  if (!dryRun) await atomicJson(path.join(root, 'retention.json'), result);
  return result;
}
