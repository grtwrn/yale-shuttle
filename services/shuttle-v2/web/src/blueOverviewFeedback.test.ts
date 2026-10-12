import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachServerEta } from './etaSource';
import { planTrip, topVisibleOptions, worthwhileOverviewOption } from './planner';
import { preferredTripOrder } from './tripRanking';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8'));

describe('Blue overview reports #140/#141',()=>{
 it('keeps Blue visible with its catchable Whitney/Canner pickup on the report-time feed',()=>{
  // The feed is contemporaneous with the report. The origin is the same
  // 517 Prospect corridor from an earlier recorded case, not a recorded GPS
  // position from these reports (feedback only records screenshots).
  const s=structuredClone(capture),now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const options=preferredTripOrder(planTrip(s.from,s.to,s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now));
  const blue=options.find(o=>o.routeLabel==='Blue Day')!;
  expect(blue.boardStopId).toBe(129); // The faster catchable pickup stays.
  expect(blue.departed).toBe(false);
  expect(blue.walkToSec+blue.walkFromSec).toBeGreaterThan(blue.directWalkSec/2);
  expect(blue.routeWalkSec).toBeLessThan(blue.directWalkSec/2);
  expect(worthwhileOverviewOption(blue)).toBe(true);
  expect(topVisibleOptions(options).map(o=>o.routeLabel)).toEqual(['Red','Blue Day','Walk']);
  // Routes that genuinely require most of the direct walk remain under More.
  for(const label of ['Green','Orange Day'])expect(worthwhileOverviewOption(options.find(o=>o.routeLabel===label)!)).toBe(false);
 });
});
