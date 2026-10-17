import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {nextArrivalAfterPinned} from './arrivals';
import {attachServerEta} from './etaSource';
import {computeUpcomingArrivals} from './liveArrivals';
import {pickLiveArrival,planTrip,rideBoardArrivals} from './planner';
import {haversineMeters} from './geo';
import {walkSecFromMeters} from './walk';

it('finds the following arrival after the selected return in the recorded Blue feed (#108)',()=>{
  // A controlled live-origin update exercises the reported class of UI
  // inconsistency. Report108 did not retain its original GPS or raw plan.
  const s=JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8')),now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const start=s.stop_coords[100],moved={lat:41.3528,lon:-72.9229};
  const option=planTrip(start,s.to,s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now).find(o=>o.routeLabel==='Blue Day')!;
  expect(option.boardStopId).toBe(100);expect(option.busName).toBe('48');
  const arrivals=computeUpcomingArrivals([option.boardStopId,option.alightStopId],s.buses,s.routes,s.stop_coords,s.segments,now,s.dwells).filter(a=>a.routeLabel===option.routeLabel);
  const live=rideBoardArrivals(arrivals,option.boardStopId,option.alightStopId);
  const walk=walkSecFromMeters(haversineMeters(moved,start));
  const picked=pickLiveArrival(live,option.busName,walk)!;
  expect(picked.match.busName).toBe('48');expect(picked.match.stopsAhead).toBe(1);
  expect(picked.boardable.busName).toBe('48');expect(picked.boardable.stopsAhead).toBe(32);
  expect(picked.boardable.eta).toBeGreaterThan(53*60);
  const before=JSON.stringify(arrivals);
  const next=nextArrivalAfterPinned(arrivals.filter(a=>a.stopId===100),'48',picked.boardable.eta,picked.boardable.stopsAhead)!;
  expect(next.eta).toBeGreaterThan(picked.boardable.eta);
  expect(next.busName).toBe('44');expect(next.stopsAhead).toBe(42);
  expect(JSON.stringify(arrivals)).toBe(before);
});

describe('following a specific pickup occurrence',()=>{
  const row=(busName:string,eta:number,stopsAhead:number)=>({busName,eta,stopsAhead});
  it('compares with the fresh estimate for the selected return',()=>{
    const rows=[row('48',300,1),row('44',3090,12),row('48',3120,32),row('44',3600,43)];
    expect(nextArrivalAfterPinned(rows,'#48',3060,32)).toBe(rows[3]);
  });
  it('does not offer the selected return as its own following arrival',()=>{
    const rows=[row('48',20,1),row('48',1200,32)];
    expect(nextArrivalAfterPinned(rows,'48',1200,32)).toBeNull();
  });
  it('keeps missing-occurrence fallback after the time on screen',()=>{
    const rows=[row('48',20,1),row('44',500,12),row('41',3600,20)];
    expect(nextArrivalAfterPinned(rows,'48',1200,32)).toBe(rows[2]);
  });
  it('never puts a following forecast before the visible estimate without occurrence metadata',()=>{
    const rows=[row('48',20,1),row('44',500,12),row('41',3600,20)];
    expect(nextArrivalAfterPinned(rows,'48',1200)).toBe(rows[2]);
  });
});
