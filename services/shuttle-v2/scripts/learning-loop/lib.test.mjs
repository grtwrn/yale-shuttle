import { describe, expect, it } from 'vitest';
import { clusteredImprovement, dayStart, evaluate, excludePending, nextDay,
  observe, phaseAt, recordForecast, SETTLE_MS, UNIT } from './lib.mjs';
import { validationCells } from '../reestimate-validation.mjs';

const at=Date.parse('2026-10-14T12:00:00Z');
const bus={bus_id:100,bus_name:'#41',route_id:13,lat:41.3,lon:-72.9};
const estimate={eta:100,low:50,high:150};
const state=()=>({pending:{},visits:{}});
const feed=(t,extra={})=>({buses:[{...bus,observed_at:t,stationary:true,at_stop_id:1,...extra}],stop_coords:{1:{lat:41.3,lon:-72.9}}});
const record=(s,t=at,b=bus)=>recordForecast(s,b,1,t,estimate,estimate,'test','hash');

describe('prospective visit sampling and causal outcomes',()=>{
 it('allocates identity before arrival and retains only one prediction per visit/horizon',()=>{
  const s=state();record(s);record(s,at+10000);
  expect(Object.values(s.pending)).toHaveLength(1);
  expect(Object.values(s.pending)[0].at).toBe(at);
  expect(Object.values(s.pending)[0].visitId).toBe('13|100|#41|1|1');
 });
 it('requires two fresh curb observations, records availability, and suppresses a standing bus',()=>{
  const s=state();record(s);
  expect(observe(s,feed(at+30000),at+31000)).toEqual([]);
  expect(observe(s,feed(at+30000),at+32000)).toEqual([]);
  const rows=observe(s,feed(at+40000),at+42000);
  expect(rows).toHaveLength(1);expect(rows[0].det).toBe(30);
  expect(rows[0].availableAt).toBe(at+42000);
  record(s,at+50000);expect(Object.values(s.pending)).toHaveLength(0);
 });
 it('ignores a wrong curb, a nearby moving bus and stale payloads',()=>{
  const s=state();record(s);
  observe(s,feed(at+30000,{at_stop_id:2}),at+31000);
  observe(s,feed(at+40000,{stationary:false}),at+42000);
  observe(s,feed(at+50000),at+120000);
  expect(Object.values(s.visits).every(v=>!v.latched)).toBe(true);
  expect(Object.values(s.pending)[0].closed).toBeUndefined();
 });
 it('re-arms only after leaving the curb and allocates a new visit id',()=>{
  const s=state();record(s);observe(s,feed(at+30000),at+31000);observe(s,feed(at+40000),at+42000);
  observe(s,feed(at+50000,{lat:41.31,stationary:false}),at+51000);
  record(s,at+60000);
  expect(Object.values(s.pending)[0].visitId).toBe('13|100|#41|1|2');
 });
 it('does not join vehicle identity reissues and records missing outcomes once',()=>{
  const s=state();record(s);record(s,at+10000,{...bus,bus_id:101});
  const rows=observe(s,{buses:[],stop_coords:{}},at+SETTLE_MS+11000);
  expect(rows).toHaveLength(2);expect(rows.every(p=>p.det===null)).toBe(true);
  expect(observe(s,{buses:[],stop_coords:{}},at+SETTLE_MS+20000)).toHaveLength(0);
  record(s,at+SETTLE_MS+30000);expect(Object.values(s.pending)).toHaveLength(2);
 });
 it('excludes a gap without inventing truth or adding replacement samples',()=>{
  const s=state();record(s);
  const rows=excludePending(s,at+10000,'observer-restart');
  expect(rows[0].det).toBeNull();expect(rows[0].reason).toBe('observer-restart');
  record(s,at+20000);expect(Object.values(s.pending)).toHaveLength(1);
 });
});

describe('chronological phases and paired quality gates',()=>{
 it('handles DST day starts and waits for frozen intervals before testing',()=>{
  expect(new Date(dayStart('2026-11-02')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  expect(nextDay('2026-10-31')).toBe('2026-11-01');
  const s={calibrationDays:['2026-10-12','2026-10-13']};
  expect(phaseAt(s,Date.parse('2026-10-11T12:00Z'))).toBe('warming');
  expect(phaseAt(s,Date.parse('2026-10-12T12:00Z'))).toBe('calibration');
  expect(phaseAt(s,at)).toBe('settling-calibration');
  s.calibratedAt=at-10000;expect(phaseAt(s,at)).toBe('test');
 });
 it('assigns both arms to pre-outcome reference horizons despite a shifted estimate',()=>{
  const p={r:13,h:'0-2',eta:400,low:0,high:500,det:100};
  expect(validationCells([p],UNIT, {referenceHorizons:true})['13|0-2'].scored).toBe(1);
  expect(validationCells([p],UNIT)['13|5-10'].scored).toBe(1);
 });
 const days=['2026-10-14','2026-10-15','2026-10-16'];
 const rows=()=>days.flatMap((day,d)=>Array.from({length:40},(_,i)=>({id:`${day}-${i}`,day,phase:'test',at:at+d*86400000,availableAt:at+d*86400000+100000,inputHash:'hash',r:13,h:'0-2',busId:i,busName:'#'+i,det:100,champion:{eta:100,low:0,high:200},challenger:{eta:100,low:50,high:150}})));
 const frozen=()=>({id:'cycle',startedAt:at-3*86400000,calibratedAt:at-10000,champion:{publishedAt:at-4*86400000},candidate:{params:{CONFORMAL:UNIT}},requiredRoutes:[13]});
 it('permits promotion when real evidence and paired route/tail/proper-score gates pass',()=>{
  const decision=evaluate(frozen(),rows(),days);
  expect(decision.promote).toBe(true);expect(decision.reasons).toEqual([]);
  expect(decision.uncertainty.clusters).toBe(120);
 });
 it('fails on missing routes, duplicate identities, future vintages and clocks',()=>{
  const s=frozen();s.requiredRoutes.push(14);expect(evaluate(s,rows(),days).promote).toBe(false);
  const a=rows();a.push(a[0]);expect(evaluate(frozen(),a,days).promote).toBe(false);
  const future=frozen();future.champion.publishedAt=at;expect(evaluate(future,rows(),days).promote).toBe(false);
  const bad=rows();bad[0].availableAt=at-1000;expect(evaluate(frozen(),bad,days).promote).toBe(false);
 });
 it('counts day/bus clusters rather than presenting repeated stops as independent support',()=>{
  const correlated=rows().map(r=>({...r,busId:1}));
  expect(clusteredImprovement(correlated,UNIT).pass).toBe(false);
  const worse=rows().map(r=>({...r,challenger:{eta:100,low:-100,high:300}}));
  expect(evaluate(frozen(),worse,days).promote).toBe(false);
 });
});
