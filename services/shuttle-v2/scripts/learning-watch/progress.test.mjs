import { describe, expect, it } from 'vitest';
import { advanceTrialProgress } from './progress.mjs';

const now=Date.parse('2026-10-24T07:00:00Z');
const state=(id,day='2026-10-24')=>({id:`cycle-${id}`,startedAt:id,champion:{version:'fit',params:{P:.5}},candidate:{params:{P:.6}},trainingInputs:[{sha256:'original'}],trainingDays:['2026-10-20'],calibrationDays:[day,'2026-10-26']});
describe('calendar progress across process/source cycles',()=>{
 it('detects the preserved same-candidate midnight reset even while operational health is green',()=>{
  let p=advanceTrialProgress(null,state(now-3*3600000),now-3*3600000);
  p=advanceTrialProgress(p,state(now-2*3600000),now-2*3600000);
  p=advanceTrialProgress(p,state(now,'2026-10-25'),now);
  expect(p.calibrationPostponed).toBe(true);expect(p.issues[0].code).toBe('trial-calendar-restarts');
 });
 it('retains one statistical trial while several exact contexts change',()=>{
  const original=state(now-3*3600000),trial={...original};let p;
  for(let i=0;i<4;i++){const s={...original,id:`cycle-${now+i}`,trial};p=advanceTrialProgress(p,s,now+i);}
  expect(p.history).toHaveLength(1);expect(p.issues).toEqual([]);expect(p.currentContextId).toBe(`cycle-${now+3}`);
 });
 it('distinguishes a changed training cohort and records a frozen calibration',()=>{
  let p=advanceTrialProgress(null,state(now-3000),now-3000);p=advanceTrialProgress(p,state(now-2000),now-2000);
  const s=state(now,'2026-10-25');s.trainingInputs=[{sha256:'different'}];p=advanceTrialProgress(p,s,now);expect(p.issues).toEqual([]);
  s.trainingInputs=[{sha256:'original'}];s.calibratedAt=now;p=advanceTrialProgress(p,s,now+1);expect(p.issues).toEqual([]);
 });
 it('bounds history and tolerates the legacy status without a candidate',()=>{
  let p;for(let i=0;i<60;i++)p=advanceTrialProgress(p,state(now+i),now+i);expect(p.history).toHaveLength(32);
  expect(advanceTrialProgress(p,{id:'cycle-1'},now)).toBeNull();
 });
});
