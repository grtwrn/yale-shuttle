import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {nextArrivalAfterPinned} from './arrivals';
import {attachServerEta} from './etaSource';
import {computeUpcomingArrivals} from './liveArrivals';
import {pickLiveArrival,planTrip,rideBoardArrivals} from './planner';
import {haversineMeters} from './geo';
import {walkSecFromMeters} from './walk';
import {nextArrivalForPickup} from './followingPickup';

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

describe('following a directly observed current curb',()=>{
  const row=(busName:string,eta:number,stopsAhead:number)=>({busName,eta,stopsAhead});
  it('does not reuse the current incoming call as a following shuttle',()=>{
    const rows=[row('44',5,1),row('54',2950,17),row('44',4019,21)];
    expect(nextArrivalForPickup(rows,'#44',0,0,true)).toBe(rows[1]);
  });
  it('does not skip a real following bus when only a later lap is modeled',()=>{
    const rows=[row('54',2953,17),row('44',3991,20)];
    expect(nextArrivalForPickup(rows,'44',0,0,true)).toBe(rows[0]);
  });
  it('keeps a following vehicle that arrives before the modeled current call',()=>{
    const rows=[row('54',3,1),row('44',5,1),row('44',3600,21)];
    expect(nextArrivalForPickup(rows,'44',0,0,true)).toBe(rows[0]);
  });
  it('retains a same-vehicle later call on a one-vehicle route',()=>{
    const rows=[row('44',5,1),row('44',3600,21)];
    expect(nextArrivalForPickup(rows,'44',0,0,true)).toBe(rows[1]);
  });
  it('withholds Next when only the current call is modeled',()=>{
    expect(nextArrivalForPickup([row('44',0,0),row('#44',5,1)],'44',0,0,true)).toBeNull();
  });
  it('preserves the selected future visit and leaves its input rows unchanged',()=>{
    const rows=[row('44',5,1),row('54',2950,17),row('44',4019,21),row('54',6000,37)];
    const before=JSON.stringify(rows);
    expect(nextArrivalForPickup(rows,'44',4000,21,false)).toBe(rows[3]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  const fixture=JSON.parse(readFileSync(new URL('./__fixtures__/blue-night-curb-following-20261025.json',import.meta.url),'utf8'));
  for(const source of fixture.frames)it(`uses the distinct following shuttle in literal Blue Night frame${source.seq}`,()=>{
    const raw=gunzipSync(Buffer.from(source.jsonGzipBase64,'base64'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256);
    const payload=JSON.parse(raw.toString()),now=payload.server_eta.servedAt;
    expect(attachServerEta(payload.buses,payload.server_eta,now)).toBe(true);
    const current=payload.buses.find((bus:{bus_name:string})=>bus.bus_name==='#44');
    expect(current.stationary).toBe(true);expect(current.at_stop_id).toBe(72);
    const rows=computeUpcomingArrivals([72],payload.buses,payload.routes,payload.stop_coords,payload.segments,now,payload.dwells)
      .filter(a=>a.routeLabel==='Blue Night');
    const before=JSON.stringify(rows),next=nextArrivalForPickup(rows,'44',0,0,true);
    expect(next?.busName).toBe('54');expect(next?.eta).toBe(source.seq===241?2950:2953);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
