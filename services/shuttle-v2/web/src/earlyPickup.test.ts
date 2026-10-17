import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {earlyPickupArrival} from './earlyPickup';
import {attachServerEta} from './etaSource';
import {computeUpcomingArrivals} from './liveArrivals';
import {pickLiveArrival,planTrip,rideBoardArrivals} from './planner';
import type {UpcomingArrival} from './arrivals';

const row=(stopId:number,hops:number,eta:number,busName='48'):UpcomingArrival=>({busName,stopId,stopsAhead:hops,eta,low:Math.max(0,eta-20),high:eta+80,routeLabel:'Blue Day',color:'blue',estimated:false,departNow:eta,lowFloor:0});

it.each([null,{lat:41.3254,lon:-72.9258}])('retains the approaching Blue forecast beside a later boarding choice (#104), origin %j',from=>{
  // Recorded feed with the prior corridor origin, not report104's missing GPS.
  const s=JSON.parse(readFileSync(new URL('./__fixtures__/blue-hidden-feedback-2026-10-12.json',import.meta.url),'utf8')),now=s.server_eta.servedAt;
  expect(attachServerEta(s.buses,s.server_eta,now)).toBe(true);
  const option=planTrip(from??s.from,s.to,s.buses,s.routes,s.stop_coords,s.segments,s.dwells,null,now).find(o=>o.routeLabel==='Blue Day')!;
  expect(option.boardStopId).toBe(100);
  const arrivals=computeUpcomingArrivals([option.boardStopId,option.alightStopId],s.buses,s.routes,s.stop_coords,s.segments,now,s.dwells).filter(a=>a.routeLabel===option.routeLabel);
  const picked=pickLiveArrival(rideBoardArrivals(arrivals,option.boardStopId,option.alightStopId),option.busName,option.walkToSec)!;
  expect(picked.boardable.busName).toBe('44');
  expect(picked.boardable.eta).toBeGreaterThan(20*60);
  const before=JSON.stringify({option,arrivals,picked});
  const early=earlyPickupArrival(arrivals,option.boardStopId,option.walkToSec,picked.boardable.eta)!;
  expect(early.busName).toBe('48');expect(early.eta).toBeLessThan(60);
  expect(JSON.stringify({option,arrivals,picked})).toBe(before);
});

describe('approaching arrival evidence',()=>{
  it('keeps a sole uncatchable arrival visible without a later boarding estimate',()=>{
    const first=row(100,1,20);expect(earlyPickupArrival([first],100,200,null)).toBe(first);
  });
  it('shows the earlier pass when the later boarding is the same physical bus',()=>{
    const first=row(100,1,20),later=row(100,30,1200);
    expect(earlyPickupArrival([first,later],100,200,1200)).toBe(first);
  });
  it('does not repeat a reachable or already displayed boarding forecast',()=>{
    const first=row(100,1,20);
    expect(earlyPickupArrival([first],100,80,500)).toBeUndefined();
    expect(earlyPickupArrival([first],100,200,20)).toBeUndefined();
    expect(earlyPickupArrival([row(100,0,0)],100,100,0)).toBeUndefined();
  });
  it('uses the earliest valid arrival without mutating input order',()=>{
    const later=row(100,2,500,'44'),first=row(100,1,20),all=[later,first],before=[...all];
    expect(earlyPickupArrival(all,100,200,500)).toBe(first);expect(all).toEqual(before);
  });
  it('retains the first arrival when the itinerary boards a later pass on a folded route',()=>{
    const first=row(100,1,20),returned=row(100,6,150),destination=row(98,9,500);
    expect(rideBoardArrivals([first,returned,destination],100,98)).not.toContain(first);
    expect(earlyPickupArrival([first,returned,destination],100,100,150)).toBe(first);
  });
  it('does not mistake a destination arrival for the pickup',()=>{
    const first=row(100,1,20);
    expect(earlyPickupArrival([row(98,1,0),first],100,200,500)).toBe(first);
  });
  it('leaves missing or invalid evidence unknown',()=>{
    expect(earlyPickupArrival([],100,200,null)).toBeUndefined();
    expect(earlyPickupArrival([row(100,1,NaN)],100,200,null)).toBeUndefined();
    expect(earlyPickupArrival([row(100,1,20)],100,NaN,null)).toBeUndefined();
  });
});
