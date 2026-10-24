import { describe, expect, it } from 'vitest';
import { clusteredImprovement, dayStart, evaluate, excludePending, nextDay,
  observe, phaseAt, qualificationUsesFinalIntervals,recordForecast, scoreEstimate, calibrationObservation, productionControlValid, productionControlInputValid, SETTLE_MS, UNIT } from './lib.mjs';
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
 it('retains earlier promises but creates no new horizon after first curb evidence',()=>{
  const s=state();record(s);
  observe(s,feed(at+30000),at+31000,'arrival');
  const later={eta:250,low:200,high:300};
  recordForecast(s,bus,1,at+32000,later,later,'test','later-forecast');
  expect(Object.values(s.pending)).toHaveLength(1);
  const rows=observe(s,feed(at+40000),at+42000,'confirmation');
  expect(rows).toHaveLength(1);expect(rows[0].at).toBe(at);expect(rows[0].det).toBe(30);
 });
 it('does not turn already received curb evidence into a future promise when clocks differ',()=>{
  const s=state();observe(s,feed(at+1000),at,'arrival');record(s,at);
  expect(Object.values(s.pending)).toHaveLength(0);
  expect(observe(s,feed(at+11000),at+10000,'confirmation')).toEqual([]);
 });
 it('continues sampling other future target stops while the current curb is unconfirmed',()=>{
  const s=state();observe(s,feed(at),at,'arrival');
  record(s,at);recordForecast(s,bus,2,at,estimate,estimate,'test','future-stop');
  expect(Object.values(s.pending)).toHaveLength(1);
  expect(Object.values(s.pending)[0].stop).toBe(2);
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
 it('keeps an extended calibration date unscored after interval freeze',()=>{
  const frozenAt=Date.parse('2026-10-27T15:00:00Z'),s={calibrationDays:['2026-10-25','2026-10-26','2026-10-27'],calibratedAt:frozenAt,testStartDay:'2026-10-28'};
  expect(phaseAt(s,frozenAt-1)).toBe('calibration');expect(phaseAt(s,frozenAt)).toBe('settling-calibration');
  expect(phaseAt(s,frozenAt+1)).toBe('settling-calibration');expect(phaseAt(s,dayStart('2026-10-28'))).toBe('test');expect(s.calibrationDays).toHaveLength(3);
 });
 it('uses the explicit computation ordering when qualification and freezing share a clock tick',()=>{
  const s={calibratedAt:at};expect(qualificationUsesFinalIntervals(s,{at,intervalsFrozenAt:null})).toBe(false);
  expect(qualificationUsesFinalIntervals(s,{at,intervalsFrozenAt:at})).toBe(true);
  expect(qualificationUsesFinalIntervals(s,{at:at+1,intervalsFrozenAt:at})).toBe(true);
 });
 it.each([{at},{at,intervalsFrozenAt:at+1},{at:at+1,intervalsFrozenAt:null}])('refuses a missing/inconsistent interval ordering receipt: %j',receipt=>{
  expect(()=>qualificationUsesFinalIntervals({calibratedAt:at},receipt)).toThrow();
 });
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
 const rows=()=>days.flatMap((day,d)=>Array.from({length:40},(_,i)=>({id:`${day}-${i}`,day,phase:'test',at:at+d*86400000,availableAt:at+d*86400000+100000,inputHash:'hash',r:13,h:'0-2',busId:i,busName:'#'+i,det:100,stop:1,champion:{eta:100,low:0,high:200,raw:{eta:100,low:0,high:200},ageSec:0,control:{modelAt:at+d*86400000,servedAt:at+d*86400000,receivedAt:at+d*86400000,r:13,busId:i,busName:'#'+i,label:'Blue Night',stop:1,stopsAhead:1,reference:[100,0,200]}},challenger:{eta:100,low:50,high:150}})));
 const frozen=()=>({id:'cycle',startedAt:at-3*86400000,calibratedAt:at-10000,champion:{publishedAt:at-4*86400000},candidate:{params:{CONFORMAL:UNIT}},requiredRoutes:[13]});
 it('permits promotion for a complete synthetic cohort with verified controls and passing paired gates',()=>{
  const decision=evaluate(frozen(),rows(),days);
  expect(decision.promote).toBe(true);expect(decision.reasons).toEqual([]);
  expect(decision.uncertainty.clusters).toBe(120);
 });
 it('keeps the original prospective clocks and requires a current-context qualification receipt',()=>{
  const s=frozen();s.trial={id:'original-trial',startedAt:s.startedAt};s.startedAt=at+3*86400000;
  s.calibrationDays=['2026-10-12','2026-10-13'];s.testStartDay='2026-10-14';
  expect(evaluate(s,rows(),days).promote).toBe(false);
  s.contextQualifiedAt=s.startedAt+1000;expect(evaluate(s,rows(),days).promote).toBe(false);
  // Source/HTTP binding is verified separately before this policy function.
  s.contextQualification={at:s.contextQualifiedAt};
  const decision=evaluate(s,rows(),days);expect(decision.promote).toBe(true);expect(decision.reasons).toEqual([]);
  expect(decision.totals.challenger['13|all'].n).toBe(120);
 });
 it('rejects reuse of a calibration date even when later forecasts otherwise pass every paired gate',()=>{
  const s=frozen();s.trial={id:'trial',startedAt:s.startedAt};s.calibrationDays=['2026-10-12','2026-10-14'];s.testStartDay='2026-10-14';
  s.contextQualifiedAt=at+1;s.contextQualification={at:at+1};const decision=evaluate(s,rows(),days);
  expect(decision.promote).toBe(false);expect(decision.reasons.join(' ')).toContain('Untouched test dates overlap');
  expect(decision.totals.challenger['13|all'].n).toBe(120);
 });
 it('refuses unverified controls and a cycle with an observed protocol failure without dropping rows',()=>{
  const bad=rows();delete bad[0].champion.control;
  const noReceipt=evaluate(frozen(),bad,days);expect(noReceipt.promote).toBe(false);
  expect(noReceipt.reasons.join(' ')).toContain('Production-control parity');
  expect(noReceipt.totals.challenger['13|all'].n).toBe(120);
  const broken=frozen();broken.protocolFailures={count:1};
  expect(evaluate(broken,rows(),days).promote).toBe(false);
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
 it('does not promote by counting tracking-ID reissues as different day/bus blocks',()=>{
  const aliases=rows().map(p=>({...p,busName:'#329',champion:{...p.champion,
   control:{...p.champion.control,busName:'#329'}}}));
  const decision=evaluate(frozen(),aliases,days);
  expect(decision.totals.challenger['13|all'].scored).toBe(120);
  expect(decision.uncertainty.clusters).toBe(3);
  expect(decision.promote).toBe(false);
  expect(decision.reasons.join(' ')).toContain('30 day/bus');
 });
 it('groups the recorded Purple329 provider-ID transition and formatting aliases',()=>{
  const sample=rows()[0];
  const aliases=[{...sample,busId:67821,busName:'#329'},
   {...sample,busId:67836,busName:' 329 '}];
  expect(clusteredImprovement(aliases,UNIT).clusters).toBe(1);
 });
 it('keeps one bus together across route changes while retaining independent days',()=>{
  const aliases=rows().map((p,i)=>({...p,r:i%2?10:13,busName:'#329'}));
  expect(clusteredImprovement(aliases,UNIT).clusters).toBe(3);
 });
 it('uses transitive identity evidence from rows without a scored outcome',()=>{
  const p=rows()[0];
  const aliases=[{...p,busId:67821,busName:'#329'},
   {...p,busId:67821,busName:'#old',det:null},
   {...p,busId:67836,busName:'#old'}];
  expect(clusteredImprovement(aliases,UNIT).clusters).toBe(1);
 });
 it('still requires thirty distinct day/bus blocks and preserves paired bootstrap scores',()=>{
  const thirty=rows().filter(p=>p.busId<10);
  const before=clusteredImprovement(thirty,UNIT);
  expect(before).toMatchObject({pass:true,clusters:30});
  expect(clusteredImprovement(thirty.map(p=>({...p,busId:p.busId+10000})),UNIT)).toEqual(before);
  expect(clusteredImprovement(thirty.filter(p=>p.busId<9),UNIT)).toMatchObject({pass:false,clusters:27});
  expect(clusteredImprovement(thirty.map(p=>({...p,challenger:{eta:100,low:-100,high:300}})),UNIT).pass).toBe(false);
 });
 it.each(['name-missing','name-empty','id-missing','id-noninteger','day-missing'])('refuses unverified scored identity: %s',mode=>{
  const unknown=rows();
  if(mode==='name-missing')delete unknown[0].busName;
  if(mode==='name-empty')unknown[0].busName=' # ';
  if(mode==='id-missing')delete unknown[0].busId;
  if(mode==='id-noninteger')unknown[0].busId=1.5;
  if(mode==='day-missing')delete unknown[0].day;
  const result=clusteredImprovement(unknown,UNIT);
  expect(result.pass).toBe(false);
  expect(result.unverifiedIdentityRows).toBe(1);
  expect(result.reason).toContain('verified day/bus');
 });
});

describe('model-time calibration and served-control evidence',()=>{
 const controlled=()=>({at,r:13,busId:100,busName:'#41',stop:1,h:'0-2',champion:{eta:100,low:50,high:150,raw:{eta:100,low:50,high:150},ageSec:0,control:{modelAt:at,servedAt:at,receivedAt:at,r:13,busId:100,busName:'#41',label:'Blue Night',stop:1,stopsAhead:1,reference:[100,50,150]}}});
 const input=()=>({receivedAt:at,feed:{buses:[bus],server_eta:{v:2,at,servedAt:at,buses:[['41','Blue Night',0,null]],rows:[[0,1,100,50,150,1,0,100,50]]}}});
 it('chooses the runtime factor before aging across a horizon boundary',()=>{
  const p={eta:118,low:108,high:128,raw:{eta:122,low:112,high:132},ageSec:4};
  const result=scoreEstimate(p,{'0-2':1,'2-5':2,'5-10':1,'10-30':1});
  // The runtime blends120s over90–150s: factor122s = 1 + 32/60.
  expect(result.eta).toBe(118);expect(result.low).toBeCloseTo(308/3,10);expect(result.high).toBeCloseTo(400/3,10);
 });
 it('widens before clipping an arrival whose cached point is already zero',()=>{
  const p={eta:0,low:-5,high:3,raw:{eta:2,low:0,high:8},ageSec:5};
  expect(scoreEstimate(p,{'0-2':2,'2-5':1,'5-10':1,'10-30':1})).toMatchObject({eta:0,low:0,high:9});
 });
 it('scores a fixed route adjustment without applying a base-model interval factor',()=>{
  const p={eta:118,low:108,high:128,raw:{eta:122,low:112,high:132},ageSec:4,
   forecastSource:'fixed-k10',conformalBounds:{low:false,high:false}};
  expect(scoreEstimate(p,{'0-2':3,'2-5':3,'5-10':3,'10-30':3})).toMatchObject({eta:118,low:108,high:128});
  expect(calibrationObservation({r:3,challenger:p,det:140})).toBeNull();
  expect(p.raw).toEqual({eta:122,low:112,high:132});
 });
 it('retains fixed route adjustments in evaluation cells and rejects contradictory path metadata',()=>{
  const fixed={eta:100,low:50,high:150,raw:{eta:100,low:50,high:150},ageSec:0,
   forecastSource:'fixed-k10',conformalBounds:{low:false,high:false}};
  const scored=scoreEstimate(fixed,{'0-2':4,'2-5':4,'5-10':4,'10-30':4});
  const cells=validationCells([{r:3,h:'0-2',det:140,...scored}],UNIT,{referenceHorizons:true});
  expect(cells['0|all'].scored).toBe(1);
  expect(scoreEstimate({...fixed,conformalBounds:{low:true,high:false}}).low).toBeNull();
  expect(calibrationObservation({r:3,challenger:{...fixed,conformalBounds:{low:true,high:false}},det:140})).toBeNull();
 });
 it('scores the actual runtime interval without repeating a fitted transform after smoothing',()=>{
  const p={raw:{eta:122,low:95,high:150},ageSec:4,forecastSource:'base',
   conformalBounds:{low:true,high:false},runtimeIntervals:true};
  expect(scoreEstimate(p,{'0-2':4,'2-5':4,'5-10':4,'10-30':4})).toMatchObject({eta:118,low:91,high:146});
  expect(calibrationObservation({r:3,challenger:p,det:140})).toBeNull();
 });
 it('fits against model-time truth and retains unavailable/pre-receipt outcomes as missing',()=>{
  const challenger={eta:118,low:108,high:128,raw:{eta:122,low:112,high:132},ageSec:4};
  expect(calibrationObservation({r:13,challenger,det:100})).toEqual({r:13,eta:122,low:112,high:132,det:104});
  expect(calibrationObservation({r:13,challenger,det:null}).det).toBeNull();
  expect(calibrationObservation({r:13,challenger,det:-1}).det).toBeNull();
  expect(calibrationObservation({r:13,challenger:{...challenger,ageSec:Infinity},det:100}).det).toBeNull();
  expect(scoreEstimate({eta:100,low:null,high:null}).low).toBeNull();
 });
 it('accepts recorded control evidence and verifies its actual retained feed row',()=>{
  expect(productionControlValid(controlled())).toBe(true);
  expect(productionControlInputValid(controlled(),input())).toBe(true);
 });
 it.each(['missing','clock','identity','reference','point','horizon'])('rejects %s provenance instead of defaulting a legacy row to valid',mode=>{
  const p=controlled();
  if(mode==='missing')delete p.champion.control;
  if(mode==='clock')p.champion.control.modelAt=at+1;
  if(mode==='identity')p.champion.control.busId=101;
  if(mode==='reference')p.champion.control.reference[0]=110;
  if(mode==='point')p.champion.eta=99;
  if(mode==='horizon')p.h='2-5';
  expect(productionControlValid(p)).toBe(false);
 });
 it('binds the original reference row, not just self-consistent asserted control numbers',()=>{
  const p=controlled(),tampered=input();tampered.feed.server_eta.rows[0][2]=101;
  expect(productionControlInputValid(p,tampered)).toBe(false);
  const missing=input();missing.feed.server_eta.rows=[];
  expect(productionControlInputValid(p,missing)).toBe(false);
 });
});
