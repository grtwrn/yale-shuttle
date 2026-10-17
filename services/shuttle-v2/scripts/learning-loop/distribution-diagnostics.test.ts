import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/distribution-sensitivity-20261017.json';
import { DISTRIBUTION_QUANTILES } from '../../web/src/eta/arrival';
import { distributionDiagnostics, distributionLoss, DISTRIBUTION_PROBABILITIES } from './distribution-diagnostics.mjs';
import { evaluate, UNIT } from './lib.mjs';
const estimate=(values:number[],ageSec=0)=>({raw:{distribution:values,distributionProbabilities:[...DISTRIBUTION_QUANTILES]},ageSec});
const fixed=(value:number,age=0)=>estimate(Array(50).fill(value),age);
const pair=(champion:any,challenger:any,det:any=100)=>({r:4,h:'0-2',det,champion,challenger});

describe('retained internal distribution diagnostics',()=>{
 it('uses the exact grid produced by the runtime',()=>{expect(DISTRIBUTION_PROBABILITIES).toEqual(DISTRIBUTION_QUANTILES);});
 it('scores a perfect distribution and keeps paired loss zero',()=>{
  expect(distributionLoss(fixed(100),100)).toMatchObject({scored:true,loss:0});
  const c=distributionDiagnostics([pair(fixed(100),fixed(100))]).cells['0|all'];expect(c).toMatchObject({n:1,paired:1,championMeanLoss:0,challengerMeanLoss:0,meanLossDelta:0});
 });
 it('ages and clips quantiles once without modifying model-time evidence',()=>{
  const input=fixed(5,10),before=structuredClone(input),scored=distributionLoss(input,0);expect(scored).toMatchObject({scored:true,loss:0,remaining:Array(50).fill(0)});expect(input).toEqual(before);
  expect(distributionLoss({...fixed(20,10),runtimeIntervals:true,conformalBounds:{low:true,high:true}},10)).toMatchObject({scored:true,loss:0});
 });
 it('detects the original bimodal sensitivity in both directions without assuming an outcome',()=>{
  const a={...fixture.champion,raw:{...fixture.champion.raw,distributionProbabilities:[...DISTRIBUTION_QUANTILES]}},b={...fixture.challenger,raw:{...fixture.challenger.raw,distributionProbabilities:[...DISTRIBUTION_QUANTILES]}};
  expect(fixture.largestQuantileChange.probability).toBe(.77);expect(b.raw.distribution[38]!-a.raw.distribution[38]!).toBeGreaterThan(2500);
  expect(a.raw.eta).toBe(b.raw.eta);
  expect(distributionDiagnostics([pair(a,b,0)]).cells['0|all'].meanLossDelta).toBeGreaterThan(11);
  expect(distributionDiagnostics([pair(a,b,2700)]).cells['0|all'].meanLossDelta).toBeLessThan(-39);
 });
 it.each([undefined,null,NaN,Infinity,-1])('retains an unknown outcome %s as missing',det=>{expect(distributionDiagnostics([{...pair(fixed(100),fixed(100)),det}]).cells['0|all']).toMatchObject({n:1,paired:0,missingOutcome:1,meanLossDelta:null});});
 it('retains legacy and absent predictions without synthesizing distributions',()=>{
  const c=distributionDiagnostics([pair({raw:{eta:100,low:0,high:200}},fixed(100)),pair(fixed(100),{missing:true})]).cells['4|all'];expect(c).toMatchObject({n:2,paired:0,championUnavailable:1,challengerUnavailable:1,meanLossDelta:null});expect(c.unavailableReasons).toEqual({'champion:missing-distribution':1,'challenger:missing-prediction':1});
 });
 it.each([NaN,Infinity,-1,45,50])('refuses invalid or expired age %s',age=>{expect(distributionLoss(fixed(100,age),100)).toEqual({scored:false,reason:'invalid-age'});});
 it('refuses corrupt, reordered or mismatched grids and distributions',()=>{
  const corruptions=[(p:any)=>p.raw.distribution.pop(),(p:any)=>p.raw.distribution[0]=NaN,(p:any)=>p.raw.distribution[0]=101,(p:any)=>p.raw.distributionProbabilities[0]=0,(p:any)=>p.raw.distributionProbabilities.reverse(),(p:any)=>delete p.raw.distributionProbabilities,(p:any)=>delete p.raw.distribution[1],(p:any)=>delete p.raw.distributionProbabilities[1],(p:any)=>p.raw.distribution[0]='100'];
  for(const corrupt of corruptions){const p=fixed(100);corrupt(p);expect(distributionLoss(p,100)).toEqual({scored:false,reason:'invalid-distribution'});}
 });
 it('refuses an overflowing loss instead of reporting a perfect or infinite diagnostic',()=>{expect(distributionLoss(fixed(Number.MAX_VALUE),0)).toEqual({scored:false,reason:'invalid-distribution'});});
 it('retains unverified controls in the cohort and uses the reference horizon',()=>{
  const c=distributionDiagnostics([pair(fixed(100),fixed(100))],()=>false);expect(c.cells['0|all']).toMatchObject({n:1,paired:0,invalidControl:1});expect(c.cells['4|0-2'].n).toBe(1);expect(c.cells['4|all'].n).toBe(1);
 });
 it('keeps the existing operational decision independent of this secondary diagnostic',()=>{
  const at=Date.parse('2026-10-20T12:00Z'),days=['2026-10-20','2026-10-21','2026-10-22'];
  const rows=days.flatMap((day,d)=>Array.from({length:40},(_,i)=>({id:`${day}-${i}`,day,phase:'test',at:at+d*86400000,availableAt:at+d*86400000+100000,inputHash:'hash',r:13,h:'0-2',busId:i,busName:'#'+i,det:100,stop:1,champion:{eta:100,low:0,high:200,raw:{eta:100,low:0,high:200},ageSec:0,control:{modelAt:at+d*86400000,servedAt:at+d*86400000,receivedAt:at+d*86400000,r:13,busId:i,busName:'#'+i,label:'Blue Night',stop:1,stopsAhead:1,reference:[100,0,200]}},challenger:{eta:100,low:50,high:150}})));
  const state={id:'cycle',startedAt:at-3*86400000,calibratedAt:at-10000,champion:{publishedAt:at-4*86400000},candidate:{params:{CONFORMAL:UNIT}},requiredRoutes:[13]};
  const decision=evaluate(state,rows,days);expect(decision.promote).toBe(true);expect(decision.distributionDiagnostic.cells['0|all']).toMatchObject({n:120,paired:0,championUnavailable:120,challengerUnavailable:120,meanLossDelta:null});
  const withCDF=rows.map(r=>({...r,champion:{...r.champion,raw:{...r.champion.raw,...fixed(100).raw}},challenger:{...r.challenger,raw:{eta:100,low:50,high:150,...fixed(1000).raw}}}));
  const diagnosed=evaluate(state,withCDF,days);expect(diagnosed.promote).toBe(true);expect(diagnosed.reasons).toEqual(decision.reasons);expect(diagnosed.totals).toEqual(decision.totals);expect(diagnosed.distributionDiagnostic.cells['0|all'].meanLossDelta).toBeGreaterThan(0);
 });
});
