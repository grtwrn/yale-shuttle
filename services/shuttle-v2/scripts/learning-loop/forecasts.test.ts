import { afterEach, describe, expect, it } from 'vitest';
import feed from './__fixtures__/blue-night-20261011.json';
import { createForecastStores, forecastArms, observationKey } from './forecasts';
import { ServerEta } from '../../src/server/serverEta';
import { ROUTE_LISTS } from '../../web/src/routes';
import { productionControlValid, productionControlInputValid } from './lib.mjs';
import { resetModelParams } from '../../web/src/eta/params';
import { DISTRIBUTION_QUANTILES } from '../../web/src/eta/arrival';
import { registerRoutePaths } from '../../web/src/anchor';
afterEach(()=>{resetModelParams();registerRoutePaths(null);});
function framed(at:number, producer=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)})) {
 const current=structuredClone(feed) as any;
 for(const b of current.buses)b.observed_at=at;
 current.server_eta=producer.contribute(current,at,at);
 return current;
}
function record(p:any,at:number){return {at,r:p.bus.route_id,busId:p.bus.bus_id,busName:p.bus.bus_name,stop:p.stop,champion:p};}

describe('live client shadow forecasts',()=>{
 it('reproduces identical forecasts for identical arms with independent memories',()=>{
  const stores=createForecastStores(),now=feed.buses[0]!.observed_at;
  const current=framed(now);
  const result=forecastArms(current,now,feed.model_params,feed.model_params,stores);
  expect(result.champion.length).toBeGreaterThan(5);
  expect(result.champion.map(({control,...p})=>p)).toEqual(result.challenger);
  expect(new Set(result.champion.map(p=>`${p.bus.bus_id}|${p.stop}`)).size).toBe(result.champion.length);
  expect(stores.champion).not.toBe(stores.challenger);
  for(const p of result.champion){expect(Number.isFinite(p.eta)).toBe(true);expect(p.low).toBeLessThanOrEqual(p.eta);expect(p.high).toBeGreaterThanOrEqual(p.eta);}
 });
 it('keeps the champion unchanged when candidate parameters are interleaved',()=>{
  const control=createForecastStores(),shadow=createForecastStores(),producer=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)});
  const candidate=structuredClone(feed.model_params);candidate.params.P_REPEAT_STAND=0.75;
  const now=feed.buses[0]!.observed_at;
  for(let i=0;i<4;i++){
   const current=framed(now+i*10000,producer);
   const expected=forecastArms(current,now+i*10000,feed.model_params,feed.model_params,control);
   const actual=forecastArms(current,now+i*10000,feed.model_params,candidate,shadow);
   expect(actual.champion).toEqual(expected.champion);
  }
 });
});

describe('production observation protocol',()=>{
 it('does not forecast a vehicle at the exact45s GPS expiry used by production',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now);
  for(const bus of current.buses)bus.observed_at=now-45000;
  current.server_eta=null;
  const result=forecastArms(current,now,feed.model_params,feed.model_params,createForecastStores());
  expect(result.champion).toEqual([]);expect(result.challenger).toEqual([]);
 });
 it('uses server model time and does not advance beliefs on repeated snapshot responses',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now),stores=createForecastStores();
  const first=forecastArms(current,now,feed.model_params,feed.model_params,stores);
  const repeat=structuredClone(current);repeat.server_eta.servedAt=now+2000;
  const later=forecastArms(repeat,now+2000,feed.model_params,feed.model_params,stores);
  expect(stores.champion.engine.stats().steps).toBe(1);
  expect(stores.challenger.engine.stats().steps).toBe(1);
  expect(later.champion.map(p=>p.raw)).toEqual(first.champion.map(p=>p.raw));
  expect(later.champion[0]!.eta).toBeCloseTo(Math.max(0,first.champion[0]!.eta-2),8);
  expect(observationKey(repeat)).toBe(observationKey(current));
 });
 it('attests the control against the original payload without sourcing candidate forecasts from it',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now);
  const result=forecastArms(current,now,feed.model_params,feed.model_params,createForecastStores());
  expect(result.productionControl.mismatched).toBe(0);
  for(const p of result.champion){
   const row=record(p,now);expect(productionControlValid(row)).toBe(true);
   expect(productionControlInputValid(row,{receivedAt:now,feed:current})).toBe(true);
  }
  const altered=structuredClone(current);for(const row of altered.server_eta.rows)for(const i of [2,3,4])row[i]+=100;
  const other=forecastArms(altered,now,feed.model_params,feed.model_params,createForecastStores());
  expect(other.challenger).toEqual(result.challenger);
  expect(other.champion.map(({control,...p})=>p)).toEqual(result.champion.map(({control,...p})=>p));
  expect(other.productionControl.mismatched).toBeGreaterThan(0);
  expect(other.champion.every(p=>!productionControlValid(record(p,now)))).toBe(true);
 });
 it('preserves independent models and unrounded quantiles for interval fitting',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now),stores=createForecastStores();
  const result=forecastArms(current,now,feed.model_params,feed.model_params,stores);
  expect(stores.champion.engine).not.toBe(stores.challenger.engine);
  expect(result.challenger.some(p=>p.raw.eta!==Math.round(p.raw.eta))).toBe(true);
 });
 it.each(['missing','stale','future','wrong-version'])('refuses a %s control snapshot while fresh GPS is present',mode=>{
  const now=feed.buses[0]!.observed_at,current=framed(now);
  if(mode==='missing')delete current.server_eta;
  if(mode==='stale')current.server_eta.servedAt=now+45000;
  if(mode==='future'){current.server_eta.at=now+10000;current.server_eta.servedAt=now+10000;}
  if(mode==='wrong-version')current.server_eta.v=1;
  expect(()=>forecastArms(current,now,feed.model_params,feed.model_params,createForecastStores())).toThrow();
 });
 it('accepts valid empty service without an ETA field and keeps removal in the snapshot identity',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now),empty={...current,buses:[],server_eta:null};
  expect(forecastArms(empty,now,feed.model_params,feed.model_params,createForecastStores()).champion).toEqual([]);
  expect(observationKey(empty)).not.toBe(observationKey(current));
 });
 it('rejects a regressing model clock without pretending it is new evidence',()=>{
  const now=feed.buses[0]!.observed_at,stores=createForecastStores();
  forecastArms(framed(now),now,feed.model_params,feed.model_params,stores);
  expect(()=>forecastArms(framed(now-5000),now,feed.model_params,feed.model_params,stores)).toThrow('clock regressed');
 });
});

describe('cached per-vehicle observations',()=>{
 it('keeps the last evidence time when another server tick reuses the same GPS observation',()=>{
  const now=feed.buses[0]!.observed_at,current=framed(now),stores=createForecastStores();
  forecastArms(current,now,feed.model_params,feed.model_params,stores);
  const times=()=>[...(stores.champion.engine as any).store.values()].map((v:any)=>v.belief.seenAt);
  const first=times(),next=structuredClone(current);
  next.server_eta.at=now+5000;next.server_eta.servedAt=now+5000;
  forecastArms(next,now+5000,feed.model_params,feed.model_params,stores);
  expect(stores.champion.engine.stats().steps).toBe(2);
  expect(times()).toEqual(first);
 });
});

it('retains unserved controls and notices visibility changes without adding sensor evidence',()=>{
 const now=feed.buses[0]!.observed_at,current=framed(now),stores=createForecastStores();
 const before=forecastArms(current,now,feed.model_params,feed.model_params,stores);
 const withheld=structuredClone(current);withheld.server_eta.rows=[];
 expect(observationKey(withheld)).not.toBe(observationKey(current));
 const after=forecastArms(withheld,now+1000,feed.model_params,feed.model_params,stores);
 expect(after.champion).toHaveLength(before.champion.length);
 expect(after.productionControl.missing).toBe(before.champion.length);
 expect(after.champion.every(p=>!productionControlValid(record(p,now+1000)))).toBe(true);
 expect(stores.champion.engine.stats().steps).toBe(1);
});


describe('retained model distributions',()=>{
 it('retains each sampled engine distribution and its exact probability grid in both arms',()=>{
  const stores=createForecastStores(),now=feed.buses[0]!.observed_at,current=framed(now);
  const sampled=forecastArms(current,now,feed.model_params,feed.model_params,stores);
  expect(sampled.champion.length).toBeGreaterThan(5);
  for(const [name,rows]of [['champion',sampled.champion],['challenger',sampled.challenger]]as const)for(const p of rows){
   const own=stores[name].engine.evaluationForecasts().find(r=>r.routeLabel===p.label&&r.busName.replace(/^#/,'')===p.bus.bus_name.replace(/^#/,'')&&r.stopId===p.stop&&r.stopsAhead===p.stopsAhead)!;
   expect(p.raw.distribution).toEqual(own.distribution);
   expect(p.raw.distributionProbabilities).toEqual(DISTRIBUTION_QUANTILES);
   expect(p.raw.distribution).not.toBe(own.distribution);
   expect(p.raw.distributionProbabilities).not.toBe(DISTRIBUTION_QUANTILES);
  }
 });
 it('keeps raw quantiles at model time and separates the two retained arms from engine memory',()=>{
  const stores=createForecastStores(),now=feed.buses[0]!.observed_at,current=framed(now);
  const initial=forecastArms(current,now,feed.model_params,feed.model_params,stores);
  const before=structuredClone(initial.champion);current.server_eta!.servedAt=now+10_000;
  const aged=forecastArms(current,now+10_000,feed.model_params,feed.model_params,stores);
  expect(aged.champion.length).toBe(before.length);
  for(let i=0;i<aged.champion.length;i++){expect(aged.champion[i]!.ageSec).toBe(10);expect(aged.champion[i]!.raw.distribution).toEqual(before[i]!.raw.distribution);}
  const p=aged.champion[0]!,other=aged.challenger.find(r=>r.bus.bus_id===p.bus.bus_id&&r.stop===p.stop)!;
  const own=stores.champion.engine.evaluationForecasts().find(r=>r.routeLabel===p.label&&r.busName.replace(/^#/,'')===p.bus.bus_name.replace(/^#/,'')&&r.stopId===p.stop&&r.stopsAhead===p.stopsAhead)!;
  const original=own.distribution![0];p.raw.distribution![0]=-999;
  expect(own.distribution![0]).toBe(original);expect(other.raw.distribution![0]).toBe(original);
 });
});
