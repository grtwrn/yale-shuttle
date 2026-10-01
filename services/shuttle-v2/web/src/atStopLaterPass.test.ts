import {describe,it,expect,afterEach} from 'vitest';
import fixture from './__fixtures__/purple-west-haven-switch.json';
import {computeUpcomingArrivals, type UpcomingArrival} from './arrivals';
import type {AnchorStore} from './eta';
import {planTrip,boardingVisitAllowed,atStopLaterPass,rawAtStopBoardable} from './planner';
import {registerRoutePaths} from './anchor';
import {applyModelParams} from './eta/params';
import type {BusData} from './map-data';
afterEach(()=>{registerRoutePaths(null);applyModelParams(undefined);});
const buses=(at:string)=>fixture.polls.find(p=>p.at===at)!.buses as BusData[];

// boardswitch20261001: rider-watch, Purple, West Haven Train Station -> Building 400.
// At 13:54:31Z the trip card dropped #321 (25 s out, 8 min ride) for #119, which
// had pulled in on its return leg: "At stop", 54 min ride, arrive 10:35-11:04.
// #321 reached the stop 30 s later and was at Building 900 by 13:59:51.
describe('Purple bus laying over at West Haven on its return leg',()=>{
 const replay=(until:string)=>{
  registerRoutePaths({'10':fixture.route_paths['10'].map(p=>[p[0]!,p[1]!] as [number,number])});
  applyModelParams(fixture.model_params);
  const store: AnchorStore = new Map();
  const polls=fixture.polls.filter(p=>p.at<=until);
  for(const p of polls.slice(0,-1)) computeUpcomingArrivals([127,22],p.buses as BusData[],fixture.routes,fixture.stop_coords,fixture.segments,Date.parse(p.at),fixture.dwells,store);
  const poll=polls.at(-1)!, now=Date.parse(poll.at), buses=poll.buses as BusData[];
  const arrivals=computeUpcomingArrivals([127,22],buses,fixture.routes,fixture.stop_coords,fixture.segments,now,fixture.dwells,store);
  const plans=planTrip(fixture.stop_coords[127],fixture.stop_coords[22],buses,fixture.routes,fixture.stop_coords,fixture.segments,fixture.dwells,null,now,store);
  return {arrivals,direct:plans.find(p=>p.mode==='shuttle'&&p.routeLabel==='Purple'&&p.boardStopId===127&&p.alightStopId===22)};
 };

 it('keeps the approaching bus instead of boarding the return bus for a lap',()=>{
  const {arrivals,direct}=replay('2026-10-01T13:54:31.851Z');
  expect(buses('2026-10-01T13:54:31.851Z').find(b=>b.bus_name==='#119')?.at_stop_id).toBe(127);
  // The folded-route conflict gate alone let it through: its only pickup left is next lap.
  expect(boardingVisitAllowed('#119',127,22,arrivals)).toBe(true);
  expect(atStopLaterPass('#119',127,22,arrivals)).toBe(true);
  expect(rawAtStopBoardable('#119',127,22,arrivals)).toBe(false);
  expect(direct).toBeDefined();
  expect(direct!.busName).toBe('321');
  expect(direct!.waitSec).toBeLessThan(60);
  expect(direct!.rideSec).toBeLessThan(15*60);
 });

 it('made the same choice ten seconds earlier, while the return visit was still modeled',()=>{
  const {direct}=replay('2026-10-01T13:54:21.849Z');
  expect(direct!.busName).toBe('321');
 });
});

describe('atStopLaterPass',()=>{
 const row=(stopId:number,stopsAhead:number,eta:number,busName='119'):UpcomingArrival=>({busName,stopId,stopsAhead,eta,routeLabel:'Purple',color:'#7B1FA2',estimated:false,low:eta,high:eta,lowFloor:eta,departNow:eta});
 it('rejects a pickup a lap away that comes before the destination',()=>{
  expect(atStopLaterPass('#119',127,22,[row(127,6,2649),row(22,11,3264)])).toBe(true);
 });
 it('keeps the bus while the forecast is arriving or closing on the stop',()=>{
  for(const ahead of [0,1]) expect(atStopLaterPass('119',127,22,[row(127,ahead,2649),row(22,ahead+5,3264)])).toBe(false);
 });
 it('keeps a bus the estimator trails by a stop (pickup inside the switch margin)',()=>{
  // Gold #317 flagged at 155 after serving 154; forecast pickup 2 stops / 172 s out.
  expect(atStopLaterPass('317',155,156,[row(155,2,172,'317'),row(156,3,225,'317')])).toBe(false);
 });
 it('keeps the bus when it reaches the destination before coming round again',()=>{
  // Return bus at West Haven, rider bound downtown: 72 comes before its next 127 pickup.
  expect(atStopLaterPass('119',127,72,[row(72,1,120),row(127,6,2649)])).toBe(false);
 });
 it('treats missing or inconsistent evidence as unknown',()=>{
  expect(atStopLaterPass('119',127,22,[])).toBe(false);
  expect(atStopLaterPass('119',127,22,[row(127,6,2649)])).toBe(false);
  expect(atStopLaterPass('119',127,22,[row(127,6,2649),row(22,11,3264,'321')])).toBe(false);
  expect(atStopLaterPass('119',127,22,[row(127,6,2649),{...row(22,11,3264),routeLabel:'Green'}])).toBe(false);
  expect(atStopLaterPass('119',127,22,[row(127,6,2649),row(22,11,2000)])).toBe(false);
 });
});
