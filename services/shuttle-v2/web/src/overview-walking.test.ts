import { expect, it } from 'vitest';
import { topVisibleOptions, type TripOption } from './planner';

function shuttle(label: string, to: number, ride: number, from: number, direct: number, wait = 0): TripOption {
  return { mode:'shuttle',routeLabel:label,color:'#000',boardStopId:1,alightStopId:2,
    walkToSec:to*60,waitSec:wait*60,rideSec:ride*60,plannedRideSec:ride*60,walkFromSec:from*60,
    totalSec:(to+wait+ride+from)*60,directWalkSec:direct*60,busName:'test' };
}
const walk = (minutes: number): TripOption => ({ ...shuttle('Walk',0,0,0,minutes),mode:'walk',totalSec:minutes*60 });
it('keeps the walking-heavy Green report out of both overview slots and direct promotion', () => {
  const blue=shuttle('Blue Day',2,22,2,33,4),green=shuttle('Green',8,5,16,33,3),red=shuttle('Red',3,11,2,33,26);
  const all=[blue,green,walk(33),red];
  const before=JSON.stringify(all);
  expect(topVisibleOptions(all).map(o=>o.routeLabel)).toEqual(['Blue Day','Walk','Red']);
  // Even an optimistic ETA/first-place rank cannot promote the same detour.
  expect(topVisibleOptions([{ ...green,totalSec:100,busEtaSec:1 },blue,walk(33),red]).map(o=>o.routeLabel)).toEqual(['Blue Day','Walk','Red']);
  expect(JSON.stringify(all)).toBe(before); // Show more still has the full list.
});
it('filters the analogous Brown one-minute ride and leaves real walking savings visible', () => {
  const red=shuttle('Red',3,8,8,24,3),brown=shuttle('Brown',5,1,16,24,13),blue=shuttle('Blue Day',2,18,8,24,3);
  expect(topVisibleOptions([red,walk(24),brown,blue]).map(o=>o.routeLabel)).toEqual(['Red','Walk','Blue Day']);
});
it('shows walking alone when all shuttle options add little benefit, without deleting those options', () => {
  const green=shuttle('Green',8,5,16,33),all=[green,walk(33)];
  expect(topVisibleOptions(all)).toEqual([all[1]]);
  expect(all).toHaveLength(2);
});
it('uses the current direct walk when the rider has moved, and works when the long walk row is absent', () => {
  const moved=shuttle('Green',5,5,15,45);
  expect(topVisibleOptions([moved,walk(25)]).map(o=>o.routeLabel)).toEqual(['Walk']);
  const long=shuttle('Green',10,20,20,75);
  expect(topVisibleOptions([long])).toEqual([long]);
});
it('does not let a retained third-slot label override the walking-benefit rule', () => {
  const a=shuttle('Red',1,10,2,33),b=shuttle('Blue Day',2,15,3,33),green=shuttle('Green',8,5,16,33);
  expect(topVisibleOptions([a,b,green,walk(33)],'Green').map(o=>o.routeLabel)).toEqual(['Red','Blue Day','Walk']);
});
