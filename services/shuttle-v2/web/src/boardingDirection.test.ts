import {describe,it,expect,afterEach} from 'vitest';
import fixture from './__fixtures__/purple-return-boarding.json';
import {computeUpcomingArrivals} from './arrivals';
import type {AnchorStore} from './eta';
import {planTrip,boardingArrivalNow,rideBoardArrivals} from './planner';
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
  expect(boardingArrivalNow('332',127,rideBoardArrivals(arrivals,127,22))).toBe(false);
  const plans=planTrip(coords[127],coords[22],buses,fixture.routes,coords,fixture.segments,fixture.dwells,null,now,liveAnchorStore);
  const direct=plans.find(p=>p.mode==='shuttle'&&p.routeLabel==='Purple'&&p.boardStopId===127&&p.alightStopId===22);

  expect(direct).toBeDefined();
  expect(direct!.busName).toBe('329');
  expect(direct!.busEtaSec).toBeGreaterThan(60);
  expect(direct!.waitSec).toBeGreaterThan(60);
  });
 it('allows an actual zero arrival only for the matching bus and stop',()=>{
  const arrivals=[{stopId:127,busName:'329',eta:0}];
  expect(boardingArrivalNow('#329',127,arrivals)).toBe(true);
  expect(boardingArrivalNow('332',127,arrivals)).toBe(false);
  expect(boardingArrivalNow('329',22,arrivals)).toBe(false);
  expect(boardingArrivalNow('329',127,[{...arrivals[0]!,eta:30}])).toBe(false);
 });
 it('matches visits by vehicle and occurrence, not nearest ETA',()=>{
  const row=(busName:string,stopId:number,stopsAhead:number,eta:number)=>({busName,stopId,stopsAhead,eta,routeLabel:'Purple',color:'#7B1FA2',estimated:false,low:eta,high:eta,departNow:eta});
  const returning=row('332',127,1,0), outbound=row('332',127,7,2600);
  const rows=[returning,outbound,row('332',22,12,3200),row('329',127,1,180),row('329',22,6,700)];
  expect(rideBoardArrivals(rows,127,22)).toEqual([outbound,rows[3]]);
  expect(rideBoardArrivals([returning,rows[4]!],127,22)).toEqual([]);
  expect(rideBoardArrivals([row('329',127,0,0),row('329',22,5,700)],127,22)).toHaveLength(1);
 });

});
