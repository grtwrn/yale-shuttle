import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {attachServerEta, type ServerEtaWire} from './etaSource';
import {labelPickupChoices,planTrip,recoveredPickupCatalog,unavailablePickup,type TripOption} from './planner';
import type {BusData} from './map-data';
import type {LatLon} from './geo';
import type {SegmentTimes,DwellTimes} from './arrivals';

const fixture=JSON.parse(readFileSync(new URL('./__fixtures__/blue-pickup-2026-09-28.json',import.meta.url),'utf8')) as {
  from:LatLon;to:LatLon;buses:BusData[];routes:Record<string,number[]>;stop_coords:Record<number,LatLon>;
  segments:SegmentTimes;dwells:DwellTimes;server_eta:ServerEtaWire;
};
const now=fixture.server_eta.servedAt;
function input(missing:'pickup'|'line'|'expired'|'source'='pickup') {
  const buses=structuredClone(fixture.buses),wire=structuredClone(fixture.server_eta);
  const bus=wire.buses.findIndex(b=>b[0]==='38');
  wire.rows=wire.rows.map(row=>row.map((value,col)=>row[0]===bus&&[2,3,4,7,8].includes(col)?value+600:value) as unknown as typeof row);
  const keep=wire.rows.map((row,i)=>({row,i})).filter(({row})=>missing==='line'
    ? wire.buses[row[0]]?.[1]!=='Blue Day' : missing!=='pickup'||row[1]!==100);
  wire.rows=keep.map(x=>x.row);
  if(wire.distributions)wire.distributions=keep.map(x=>wire.distributions![x.i]!);
  if(missing==='expired')wire.at=now-45001;
  attachServerEta(buses,missing==='source'?undefined:wire,now);
  return {buses,wire};
}
const plan=(buses:BusData[])=>planTrip(fixture.from,fixture.to,buses,fixture.routes,fixture.stop_coords,fixture.segments,fixture.dwells,null,now);

describe('closest pickup when forecast rows are missing',()=>{
  it('retains Prospect/Canner without a made-up time or a false missed-bus verdict',()=>{
    const {buses}=input();const blue=plan(buses).find(o=>o.routeLabel==='Blue Day')!;
    expect(blue.boardStopId).toBe(100);
    expect(blue.etaUnavailable).toBe(true);expect(blue.departed).toBe(false);
    expect(blue.busEtaSec).toBeUndefined();expect(blue.journeyArrival).toBeUndefined();
    expect(blue.pickupPreference).toBe('closest-stop');
    expect(blue.pickupAlternatives?.[0]).toMatchObject({boardStopId:129,pickupPreference:'more-walking',departed:false});
    expect(blue.pickupAlternatives?.[0]?.etaUnavailable).not.toBe(true);
  });
  it('keeps the closest route geometry when its fresh model track has no forecast rows',()=>{
    const {buses}=input('line');const blue=plan(buses).find(o=>o.routeLabel==='Blue Day')!;
    expect(blue).toBeDefined();expect(blue.boardStopId).toBe(100);expect(blue.etaUnavailable).toBe(true);
    expect(blue.busName).toBe('');expect(blue.busEtaSec).toBeUndefined();expect(blue.journeyArrival).toBeUndefined();
  });
  it.each(['expired','source'] as const)('does not invent live ETA rows from %s model context',missing=>{
    const {buses}=input(missing);expect(plan(buses).find(o=>o.routeLabel==='Blue Day')).toBeUndefined();
  });
  it('preserves real raw-at-stop boarding evidence when that pickup forecast is absent',()=>{
    const {buses,wire}=input();const bus=buses.find(b=>b.bus_name.replace(/^#/,'')==='38')!;
    Object.assign(bus,fixture.stop_coords[100],{at_stop_id:100,at_stop_since:new Date(now-60000).toISOString().slice(0,19)});
    expect(attachServerEta(buses,wire,now)).toBe(true);
    const blue=plan(buses).find(o=>o.routeLabel==='Blue Day')!;
    expect(blue.boardStopId).toBe(100);expect(blue.busEtaSec).toBe(0);expect(blue.etaUnavailable).not.toBe(true);
  });
});

describe('pickup evidence recovery',()=>{
  const close:TripOption={mode:'shuttle',routeLabel:'Blue Day',color:'#1565c0',boardStopId:100,alightStopId:97,
    walkToSec:120,walkFromSec:60,waitSec:2400,rideSec:600,plannedRideSec:600,totalSec:3180,
    directWalkSec:1800,busName:'44',busEtaSec:2520,departed:false};
  const farther:TripOption={...close,boardStopId:129,walkToSec:480,totalSec:840,busName:'48',busEtaSec:480};
  it('clears every stale forecast while retaining the pickup and its last known vehicle',()=>{
    const stale={...close,departed:true,missedBus:'48',busDepartNowSec:2300,busLowSec:2000,busHighSec:3000,
      busDistribution:[2000,2500,3000],busBoardHops:[[3,100]] as [number,number][],computedAtMs:now};
    const unavailable=unavailablePickup(stale);
    expect(unavailable).toMatchObject({boardStopId:100,alightStopId:97,busName:'44',etaUnavailable:true,departed:false,
      totalSec:780,rideSec:600,waitSec:0});
    for(const key of ['missedBus','busEtaSec','busDepartNowSec','busLowSec','busHighSec','busDistribution',
      'busBoardHops','computedAtMs','journeyArrival','livePickupSelection'] as const)expect(unavailable[key]).toBeUndefined();
    expect(stale.busEtaSec).toBe(2520);expect(stale.departed).toBe(true);
  });
  it('labels an available farther choice without comparing it to an unknown arrival',()=>{
    const selected=unavailablePickup(close);
    expect(labelPickupChoices([farther,selected]).map(o=>[o.boardStopId,o.pickupPreference]))
      .toEqual([[129,'more-walking'],[100,'closest-stop']]);
    expect(labelPickupChoices([farther,close]).map(o=>o.pickupPreference)).toEqual(['arrive-sooner','closest-stop']);
    expect(labelPickupChoices([farther,{...close,totalSec:900}])[0]!.pickupPreference).toBe('more-walking');
    expect(labelPickupChoices([farther,{...close,departed:true}])[0]!.pickupPreference).toBe('more-walking');
  });
  it('discovers recovered alternatives without replacing the original pickup or exit',()=>{
    const initial=unavailablePickup(close),fresh={...close,alightStopId:98,pickupAlternatives:[farther]};
    const catalog=recoveredPickupCatalog(initial,fresh)!;
    expect(catalog.map(o=>[o.boardStopId,o.alightStopId])).toEqual([[100,97],[129,97]]);
    expect(catalog[0]).toBe(initial);expect(initial.pickupAlternatives).toBeUndefined();
    expect(recoveredPickupCatalog(initial,unavailablePickup(close))).toBeUndefined();
    expect(recoveredPickupCatalog(close,fresh)).toBeUndefined();
    expect(recoveredPickupCatalog(initial,undefined)).toBeUndefined();
  });
});
