import {describe,it,expect,afterEach} from 'vitest';
import fixture from './__fixtures__/purple-return-boarding.json';
import {computeUpcomingArrivals} from './arrivals';
import type {AnchorStore} from './eta';
import {planTrip,boardingVisitAllowed,rideBoardArrivals} from './planner';
import {registerRoutePaths} from './anchor';
import {applyModelParams} from './eta/params';
import type {BusData} from './map-data';
afterEach(()=>{registerRoutePaths(null);applyModelParams(undefined);});
describe('Purple return visit to West Haven',()=>{
 it('does not price return bus #332 as board-now merely because at_stop_id is 127',()=>{
  const poll=fixture.polls.at(-1)!;
  const buses=poll.buses as BusData[];
  const now=Date.parse(poll.at);
  const coords=fixture.stop_coords;
  registerRoutePaths({'10':fixture.route_paths['10'].map(p=>[p[0]!,p[1]!] as [number,number])});
  applyModelParams(fixture.model_params);
  const liveAnchorStore: AnchorStore = new Map();
  for(const p of fixture.polls) computeUpcomingArrivals([127,22],p.buses as BusData[],fixture.routes,coords,fixture.segments,Date.parse(p.at),fixture.dwells,liveAnchorStore);
  const arrivals=computeUpcomingArrivals([127,22],buses,fixture.routes,coords,fixture.segments,now,fixture.dwells,liveAnchorStore);
  expect(boardingVisitAllowed('332',127,22,arrivals)).toBe(false);
  const plans=planTrip(coords[127],coords[22],buses,fixture.routes,coords,fixture.segments,fixture.dwells,null,now,liveAnchorStore);
  const direct=plans.find(p=>p.mode==='shuttle'&&p.routeLabel==='Purple'&&p.boardStopId===127&&p.alightStopId===22);

  expect(direct).toBeDefined();
  expect(direct!.busName).toBe('329');
  expect(direct!.busEtaSec).toBeGreaterThan(60);
  expect(direct!.waitSec).toBeGreaterThan(60);
  });
 it('matches visits by vehicle and occurrence, not nearest ETA',()=>{
  const row=(busName:string,stopId:number,stopsAhead:number,eta:number)=>({busName,stopId,stopsAhead,eta,routeLabel:'Purple',color:'#7B1FA2',estimated:false,low:eta,high:eta,lowFloor:eta,departNow:eta});
  const returning=row('332',127,1,0), outbound=row('332',127,7,2600);
  const rows=[returning,outbound,row('332',22,12,3200),row('329',127,1,180),row('329',22,6,700)];
  expect(rideBoardArrivals(rows,127,22)).toEqual([outbound,rows[3]]);
  expect(rideBoardArrivals([returning,rows[4]!],127,22)).toEqual([returning]);
  expect(boardingVisitAllowed('332',127,22,[returning,rows[4]!])).toBe(true);
  expect(rideBoardArrivals([row('329',127,0,0),row('329',22,5,700)],127,22)).toHaveLength(1);
 });

 it('keeps boarding available without reliable same-route chronological evidence',()=>{
  const row=(stopId:number,stopsAhead:number,eta:number,routeLabel='Purple')=>({busName:'332',stopId,stopsAhead,eta,routeLabel,color:'#7B1FA2',estimated:false,low:eta,high:eta,lowFloor:eta,departNow:eta});
  const pickup=row(127,1,0);
  expect(boardingVisitAllowed('#332',127,22,[])).toBe(true);
  for(const rows of [
   [pickup,row(127,7,100)], // destination beyond horizon
   [pickup,row(127,7,100),row(22,12,200,'Green')], // another route cannot prove a conflict
   [pickup,row(127,7,200),row(22,12,100)], // inconsistent ETA/occurrence ordering
  ]) {
   expect(rideBoardArrivals(rows,127,22)).toContain(pickup);
   expect(boardingVisitAllowed('#332',127,22,rows)).toBe(true);
  }
 });

});
