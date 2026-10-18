import {describe, expect, it} from 'vitest';
import {attachServerEta, serverArrivals, serverTrack, type ServerEtaWire} from './etaSource';
import {ROUTE_LISTS} from './routes';
import type {BusData} from './map-data';
function example(label = 'Red', clock = '2026-09-03T18:58:00-04:00') {
  const at=Date.parse(clock),cfg=ROUTE_LISTS.find(c=>c.label===label)!;
  const buses: BusData[]=[{bus_id:1,bus_name:'#12',route_id:cfg.busRouteIds[0]!,lat:41.3,lon:-72.9,heading:0,last_stop_id:48}];
  const wire: ServerEtaWire={v:2,at,servedAt:at+10_000,buses:[['12',label,2,null]],
    rows:[[0,48,120,90,180,2,0,120,90],[0,48,3600,3000,4200,31,0,3600,3000]],repeatVisits:[[0,48,31]],
    distributions:[Array.from({length:50},(_,i)=>90+i),Array.from({length:50},(_,i)=>3000+i)]};
  return {buses,wire};
}
describe('end-of-service return visits',()=>{
  it('keeps the current bus, track and raw forecast, withholding only the later canonical return',()=>{
    const {buses,wire}=example(),before=structuredClone(wire);
    expect(attachServerEta(buses,wire,50_000)).toBe(true);
    const rows=serverArrivals(buses,[48],50_000)!;expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({eta:110,stopsAhead:2,distribution:wire.distributions![0]!.map(s=>s-10)});
    expect(serverTrack(buses[0]!,'Red',50_000)).not.toBeNull();expect(wire).toEqual(before);
  });
  it('keeps daytime returns and their aligned distributions',()=>{
    const {buses,wire}=example('Red','2026-09-03T12:00:00-04:00');attachServerEta(buses,wire,50_000);
    const rows=serverArrivals(buses,[48],50_000)!;expect(rows.map(r=>r.eta)).toEqual([110,3590]);
    expect(rows[1]!.distribution).toEqual(wire.distributions![1]!.map(s=>s-10));
  });
  it('uses the server arrival clock even when phones disagree by days',()=>{
    const a=example(),b=example();attachServerEta(a.buses,a.wire,50_000);attachServerEta(b.buses,b.wire,500_000_000);
    expect(serverArrivals(a.buses,[48],55_000)).toEqual(serverArrivals(b.buses,[48],500_005_000));
    expect(serverArrivals(a.buses,[48],55_000)).toHaveLength(1);
  });
  it('keeps a first modeled visit after closing even at a whole-ring hop count',()=>{
    const {buses,wire}=example();wire.rows[0]=[0,48,3600,3000,4200,29,0,3600,3000];attachServerEta(buses,wire,50_000);
    expect(serverArrivals(buses,[48],50_000)?.map(r=>r.stopsAhead)).toEqual([29]);
  });
  it('keeps two first canonical calls at a folded stop',()=>{
    const {buses,wire}=example('Purple','2026-09-03T23:55:00-04:00');wire.rows[1]=[0,48,600,500,700,12,0,600,500];wire.repeatVisits=[];
    attachServerEta(buses,wire,50_000);expect(serverArrivals(buses,[48],50_000)?.map(r=>r.stopsAhead)).toEqual([2,12]);
  });
  it('binds repeats by visit identity after a trial changes ETA ordering',()=>{
    const {buses,wire}=example();wire.rows.reverse();wire.distributions!.reverse();attachServerEta(buses,wire,50_000);
    expect(serverArrivals(buses,[48],50_000)?.map(r=>r.stopsAhead)).toEqual([2]);
  });
  it('honors overnight service and withholds a return after its close',()=>{
    const late=example('Blue Night','2026-09-04T00:10:00-04:00');attachServerEta(late.buses,late.wire,50_000);
    expect(serverArrivals(late.buses,[48],50_000)?.map(r=>r.stopsAhead)).toEqual([2]);
    const early=example('Blue Night','2026-09-03T23:30:00-04:00');attachServerEta(early.buses,early.wire,50_000);
    expect(serverArrivals(early.buses,[48],50_000)).toHaveLength(2);
  });
  it.each([undefined,[[9,48,31]],[[0,48,NaN]],[[0,48,31,1]]])('keeps visits when optional metadata is absent or malformed (%#)',repeatVisits=>{
    const {buses,wire}=example();Object.assign(wire,{repeatVisits});expect(attachServerEta(buses,wire,50_000)).toBe(true);
    expect(serverArrivals(buses,[48],50_000)).toHaveLength(2);
  });
});
