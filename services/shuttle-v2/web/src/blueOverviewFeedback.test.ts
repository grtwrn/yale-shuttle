import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachServerEta } from './etaSource';
import { planTrip, topVisibleOptions, worthwhileOverviewOption } from './planner';
import { preferredTripOrder } from './tripRanking';
const capture = JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8'));

describe('Blue overview reports #140/#141',()=>{
 it('shows the closest Blue pickup even when a farther pickup arrives sooner',()=>{
  // The feed is contemporaneous with the report. The origin is the same
  // 517 Prospect corridor from an earlier recorded case, not a recorded GPS
  // position from these reports (feedback only records screenshots).
  const s=structuredClone(capture),now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const options=preferredTripOrder(planTrip(s.from,s.to,s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now));
  const blue=options.find(o=>o.routeLabel==='Blue Day')!;
  expect(blue.boardStopId).toBe(100); // Prospect/Canner stays a real choice.
  expect(blue.departed).toBe(false);
  expect(blue.walkToSec).toBeLessThan(120);
  expect(blue.busName).toBe('44');
  expect(blue.busEtaSec).toBeGreaterThan(20*60); // Actual next bus, not #48 passing.
  const faster=blue.pickupAlternatives![0]!;
  expect(faster.boardStopId).toBe(129);
  expect(faster.departed).toBe(false);
  expect(faster.busName).toBe('48');
  expect(faster.totalSec).toBeLessThan(blue.totalSec-180);
  expect(faster.walkToSec+faster.walkFromSec).toBeGreaterThan(blue.directWalkSec/2);
  expect(blue.walkToSec+blue.walkFromSec).toBeLessThan(blue.directWalkSec/2);
  expect(worthwhileOverviewOption(blue)).toBe(true);
  expect(topVisibleOptions(options).map(o=>o.routeLabel)).toEqual(['Red','Walk','Blue Day']);
  // Routes that genuinely require most of the direct walk remain under More.
  for(const label of ['Green','Orange Day'])expect(worthwhileOverviewOption(options.find(o=>o.routeLabel===label)!)).toBe(false);
 });
});
