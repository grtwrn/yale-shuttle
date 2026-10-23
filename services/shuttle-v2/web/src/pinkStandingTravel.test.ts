import {afterEach, describe, expect, it} from 'vitest';
import {registerRoutePaths} from './anchor';
import {attachServerEta, serverArrivals, serverTrack, type ServerEtaWire} from './etaSource';
import {anchorIndexOnList, rideStopsToExit} from './liveAnchor';
import type {BusData} from './map-data';
import {mergedRouteStops, ROUTE_LISTS} from './routes';
import fixture from './__fixtures__/pink-standing-travel-20261023.json';

afterEach(()=>registerRoutePaths(null));
describe.each(fixture.snapshots)('Pink added-pass stand at $sampleAt', capture=>{
 const setup=()=>{
  const source=structuredClone(capture),now=Date.parse(source.sampleAt);
  const buses=[source.bus as BusData];
  registerRoutePaths(source.routePaths as unknown as Record<string,[number,number][]>);
  expect(attachServerEta(buses,source.wire as unknown as ServerEtaWire,now)).toBe(true);
  const bus=buses[0]!,cfg=ROUTE_LISTS.find(c=>c.label==='Pink')!;
  const canonical=mergedRouteStops(cfg,source.routeStops);
  const arrivals=serverArrivals(buses,[123],now)!.filter(a=>a.routeLabel==='Pink'&&a.busName==='324');
  return {source,now,bus,cfg,canonical,arrivals};
 };
 it('counts to the next inbound entrance without wrapping round the published loop',()=>{
  const {source,now,bus,cfg,arrivals}=setup();
  expect(rideStopsToExit(bus,cfg,source.routeStops,source.stopCoords,123,arrivals,now,new Map())).toBe(source.expectedCount);
 });
 it('preserves the served travel slot when the physical stand belongs to an added pass',()=>{
  const {source,now,bus,cfg,canonical}=setup();
  const track=serverTrack(bus,'Pink',now)!;
  expect(anchorIndexOnList(bus,cfg,source.routeStops,source.stopCoords,canonical,now,new Map(),true)).toBe(track.travel);
  expect(serverTrack(bus,'Pink',now)).toEqual(track);
 });
 it('continues naming the observed physical stop in the overview',()=>{
  const {source,now,bus,cfg,canonical}=setup();
  const track=serverTrack(bus,'Pink',now)!;
  if(track.standing&&!track.standing.approach){
   expect(canonical[anchorIndexOnList(bus,cfg,source.routeStops,source.stopCoords,canonical,now,new Map())]).toBe(124);
  }else{
   expect(anchorIndexOnList(bus,cfg,source.routeStops,source.stopCoords,canonical,now,new Map())).toBe(track.index);
  }
 });
});
