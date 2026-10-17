import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {attachServerEta} from './etaSource';
import {planTrip,topVisibleOptions,worthwhileOverviewOption} from './planner';
import {preferredTripOrder} from './tripRanking';

it('keeps the walking-heavy Brown trip to Payne Whitney behind Show more (#126)',()=>{
  // #126 retained its destination and rounded walking legs, but not GPS.
  // Use the recorded 517 Prospect corridor proxy and October12 feed from
  // the Blue regression. This checks the current selection, not old ETAs.
  const s=JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8'));
  const now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const options=preferredTripOrder(planTrip(s.from,s.stop_coords[96],s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now));
  const brown=options.find(o=>o.routeLabel==='Brown')!;
  expect(brown.walkToSec+brown.walkFromSec).toBeGreaterThan(20*60);
  expect(brown.directWalkSec).toBeLessThan(25*60);
  expect(brown.pickupAlternatives).toBeUndefined();
  expect(worthwhileOverviewOption(brown)).toBe(false);
  const before=JSON.stringify(options);
  expect(topVisibleOptions(options).map(o=>o.routeLabel)).toEqual(['Red','Walk','Blue Day']);
  // A retained slot or an optimistic ETA cannot promote an unhelpful walk.
  const optimistic=options.map(o=>o===brown?{...o,totalSec:1,busEtaSec:1}:o);
  expect(topVisibleOptions(optimistic,'Brown').some(o=>o.routeLabel==='Brown')).toBe(false);
  expect(JSON.stringify(options)).toBe(before); // Full list retains Brown.
});

it('keeps Brown under Show more when its planned ride clears the third-slot slack but Red improves every leg (#137)',()=>{
  const s=JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8'));
  // Controlled near-boundary calibrated cost, not the missing September28
  // report plan. Keep recorded live arrivals and both Blue pickup choices.
  s.segments['19']['145-147'].avg-=120;
  const now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const all=preferredTripOrder(planTrip(s.from,s.to,s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now));
  const brown=all.find(o=>o.routeLabel==='Brown')!,blue=all.find(o=>o.routeLabel==='Blue Day')!;
  expect(brown.walkToSec+brown.plannedRideSec!+brown.walkFromSec).toBeGreaterThan(brown.directWalkSec);
  expect(brown.walkToSec+brown.plannedRideSec!+brown.walkFromSec)
    .toBeLessThan(blue.walkToSec+blue.plannedRideSec!+blue.walkFromSec+300);
  for(const retained of [null,'Brown'])expect(topVisibleOptions(all,retained).map(o=>o.routeLabel))
    .toEqual(['Red','Walk','Blue Day']);
  expect(blue.boardStopId).toBe(100);
  expect(blue.pickupAlternatives?.[0]?.boardStopId).toBe(129);
  expect(all).toContain(brown);
  expect(brown.busName).toBe('310');
});
