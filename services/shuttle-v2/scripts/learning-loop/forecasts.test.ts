import { afterEach, describe, expect, it } from 'vitest';
import feed from './__fixtures__/blue-night-20261011.json';
import { forecastArms } from './forecasts';
import { resetModelParams } from '../../web/src/eta/params';
import { registerRoutePaths } from '../../web/src/anchor';
afterEach(()=>{resetModelParams();registerRoutePaths(null);});
describe('live client shadow forecasts',()=>{
 it('reproduces identical forecasts for identical arms with independent memories',()=>{
  const stores={champion:new Map(),challenger:new Map()},now=feed.buses[0]!.observed_at;
  const result=forecastArms(feed,now,feed.model_params,feed.model_params,stores);
  expect(result.champion.length).toBeGreaterThan(5);
  expect(result.champion).toEqual(result.challenger);
  expect(new Set(result.champion.map(p=>`${p.bus.bus_id}|${p.stop}`)).size).toBe(result.champion.length);
  expect(stores.champion).not.toBe(stores.challenger);
  for(const p of result.champion){expect(Number.isFinite(p.eta)).toBe(true);expect(p.low).toBeLessThanOrEqual(p.eta);expect(p.high).toBeGreaterThanOrEqual(p.eta);}
 });
 it('keeps the champion unchanged when candidate parameters are interleaved',()=>{
  const control={champion:new Map(),challenger:new Map()},shadow={champion:new Map(),challenger:new Map()};
  const candidate=structuredClone(feed.model_params);candidate.params.P_REPEAT_STAND=0.75;
  const now=feed.buses[0]!.observed_at;
  for(let i=0;i<4;i++){
   const expected=forecastArms(feed,now+i*10000,feed.model_params,feed.model_params,control);
   const actual=forecastArms(feed,now+i*10000,feed.model_params,candidate,shadow);
   expect(actual.champion).toEqual(expected.champion);
  }
 });
});
