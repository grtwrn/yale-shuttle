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
it('keeps report #127 Green behind Show more while preserving Red, Blue and walking', () => {
  // Rounded minutes transcribed from the screenshot, not a saved raw plan.
  const red=shuttle('Red',3,11,8,36),green=shuttle('Green',8,5,15,36),blue=shuttle('Blue Day',2,20,8,36);
  const all=[red,green,walk(36),blue],before=JSON.stringify(all);
  expect(topVisibleOptions(all).map(o=>o.routeLabel)).toEqual(['Red','Walk','Blue Day']);
  expect(topVisibleOptions([{ ...green,totalSec:100,busEtaSec:1 },red,walk(36),blue],'Green').map(o=>o.routeLabel))
    .toEqual(['Red','Walk','Blue Day']);
  expect(JSON.stringify(all)).toBe(before); // Show more retains Green unchanged.
});
it('includes exactly half the direct walk but hides one additional second', () => {
  const half=shuttle('Shuttle',8,5,10,36),direct=walk(36);
  expect(topVisibleOptions([half,direct])).toEqual([half,direct]);
  expect(topVisibleOptions([{ ...half,walkFromSec:half.walkFromSec+1,totalSec:half.totalSec+1 },direct])).toEqual([direct]);
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

it('retains the best available trip when a long direct walk was suppressed', () => {
  const only=shuttle('Green',30,5,30,75);
  expect(topVisibleOptions([only])).toEqual([only]);
  expect(topVisibleOptions([])).toEqual([]);
});

it('moves the slower-than-walking Brown third route under Show more when Red improves every leg (#137)', () => {
  // Rounded legs from the screenshot, not a retained historical plan. Brown
  // falls within the old third-slot allowance despite adding no walking or
  // riding advantage over Red. The full list must still contain it.
  const red=shuttle('Red',3,5,1,20),blue=shuttle('Blue Day',2,13,5,20),brown=shuttle('Brown',5,17,1,20);
  const all=[red,blue,walk(20),brown],before=JSON.stringify(all);
  for (const retained of [null,'Brown']) {
    expect(topVisibleOptions(all,retained).map(o=>o.routeLabel)).toEqual(['Red','Blue Day','Walk']);
  }
  expect(JSON.stringify(all)).toBe(before);
});

it('retains a third route with less walking at either end, even when slower than walking', () => {
  const red=shuttle('Red',3,5,1,20),blue=shuttle('Blue Day',2,13,5,20);
  for (const third of [shuttle('Brown',2,18,1,20),shuttle('Brown',5,18,0,20)]) {
    expect(topVisibleOptions([red,blue,walk(20),third]).map(o=>o.routeLabel)).toContain('Brown');
  }
});

it('retains the closest Blue pickup when the selected farther choice has worse legs', () => {
  const red=shuttle('Red',3,5,1,20),orange=shuttle('Orange Day',2,13,5,20);
  const blue={...shuttle('Blue Day',5,17,1,20),pickupAlternatives:[shuttle('Blue Day',1,19,1,20)]};
  expect(topVisibleOptions([red,orange,walk(20),blue]).map(o=>o.routeLabel)).toContain('Blue Day');
});

it('does not demote the third route on the strength of a departed or unavailable competitor', () => {
  const red=shuttle('Red',3,5,1,20),blue=shuttle('Blue Day',2,13,5,20),brown=shuttle('Brown',5,17,1,20);
  for (const unavailable of [{...red,departed:true},{...red,etaUnavailable:true}]) {
    expect(topVisibleOptions([unavailable,blue,walk(20),brown]).map(o=>o.routeLabel)).toContain('Brown');
  }
});

it('keeps the first two shuttles and a third that still beats walking', () => {
  const red=shuttle('Red',3,5,1,30),blue=shuttle('Blue Day',2,13,5,30),brown=shuttle('Brown',5,17,1,30);
  expect(topVisibleOptions([red,blue,walk(30),brown]).map(o=>o.routeLabel)).toContain('Brown');
  expect(topVisibleOptions([red,{...brown,directWalkSec:20*60},walk(20)]).map(o=>o.routeLabel)).toContain('Brown');
});

it('judges redundant third routes by planned legs rather than live wait or ride fluctuations', () => {
  const red=shuttle('Red',3,5,1,20),blue=shuttle('Blue Day',2,13,5,20),brown=shuttle('Brown',5,17,1,20);
  for (const live of [0,60,3600]) {
    const changed={...brown,waitSec:live,rideSec:live,totalSec:live*2+360};
    expect(topVisibleOptions([red,blue,walk(20),changed],'Brown').map(o=>o.routeLabel))
      .toEqual(['Red','Blue Day','Walk']);
  }
});

it('keeps Blue in the initial list when the rider is at its pickup but the exit walk exceeds half the direct walk (#129)', () => {
  // Screenshot legs: Blue has no pickup walk, 14 min riding and 8 min final
  // walking, versus a 15 min direct walk. Brown and Red have shorter total
  // commutes, but the rider still wants to see the bus from their stop.
  const red=shuttle('Red',2,5,4,15),brown=shuttle('Brown',0,15,1,15),blue=shuttle('Blue Day',0,14,8,15);
  const all=[walk(15),red,brown,blue],before=JSON.stringify(all);
  expect(topVisibleOptions(all).map(o=>o.routeLabel)).toEqual(['Walk','Red','Brown','Blue Day']);
  expect(JSON.stringify(all)).toBe(before);
});

it('keeps a no-pickup-walk choice explicit even when a farther pickup on that line is selected', () => {
  const red=shuttle('Red',2,5,4,15),brown=shuttle('Brown',0,15,1,15);
  const blue={...shuttle('Blue Day',5,8,8,15),pickupAlternatives:[shuttle('Blue Day',0,14,8,15)]};
  expect(topVisibleOptions([walk(15),red,brown,blue]).map(o=>o.routeLabel)).toContain('Blue Day');
});

it('keeps that pickup choice visible as its bus becomes missed or unavailable', () => {
  const red=shuttle('Red',2,5,4,15),brown=shuttle('Brown',0,15,1,15),blue=shuttle('Blue Day',0,14,8,15);
  for(const status of [{departed:true},{etaUnavailable:true}]){
    expect(topVisibleOptions([walk(15),red,brown,{...blue,...status}]).map(o=>o.routeLabel)).toContain('Blue Day');
  }
});

it('requires meaningful walking saved even with no walk to pickup', () => {
  const red=shuttle('Red',2,5,4,15),brown=shuttle('Brown',0,15,1,15);
  const unhelpful=shuttle('Blue Day',0,14,14,15);
  expect(topVisibleOptions([walk(15),red,brown,unhelpful]).map(o=>o.routeLabel)).not.toContain('Blue Day');
});

it('keeps the same pickup benefit when the exit walk falls below half or belongs to another line', () => {
  const red=shuttle('Red',2,5,4,15),brown=shuttle('Brown',1,15,1,15);
  for(const label of ['Blue Day','Green'])for(const exit of [6,8]){
    const fromHere=shuttle(label,0,25,exit,15);
    expect(topVisibleOptions([walk(15),red,brown,fromHere]).map(o=>o.routeLabel)).toContain(label);
  }
});

it('does not promote a slower-than-walking pickup when another bus from that stop improves its ride and exit walk', () => {
  const red=shuttle('Red',0,5,1,15),brown=shuttle('Brown',1,15,1,15),blue=shuttle('Blue Day',0,25,8,15);
  expect(topVisibleOptions([walk(15),red,brown,blue]).map(o=>o.routeLabel)).not.toContain('Blue Day');
});
