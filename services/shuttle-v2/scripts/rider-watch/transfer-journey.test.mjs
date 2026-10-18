import { test } from 'vitest';
import assert from 'node:assert/strict';
import { boardedTransferMatches, completedLegRecord, nextTransferStage, riderAssignmentAllows, riderLineAllowed, sameTransferLeg, selectTransferTrip, transferChoiceLabels, transferLegTrip, transferWaitingContext, validTransferLeg } from './transfer-journey.mjs';
const a={lat:41.31,lon:-72.92},b={lat:41.311,lon:-72.92},c={lat:41.311,lon:-72.921},d={lat:41.312,lon:-72.921};
const feed={buses:[{bus_name:'#41',route_id:1,...a},{bus_name:'#42',route_id:2,...c}],routes:{1:[1,2,5],2:[3,4,6]},stop_coords:{1:a,2:b,3:c,4:d,5:d,6:a},stop_names:{1:'Origin',2:'First exit',3:'Second pickup',4:'Destination'}};
const first={routeLabel:'Blue Day',boardStopId:1,exitStopId:2},second={routeLabel:'Orange Day',boardStopId:3,exitStopId:4};
const original={origin:{...a,label:'Origin',stopId:1},destination:{...d,display_name:'Destination',stopId:4}};
const section={...first,controls:true,boardBusName:'41',countdownBusName:'39',boardingStopsAhead:2,buttons:["🚌 I'm on #41","🚌 I'm on #39"],text:'actual visible text',controlText:'actual controls'};
function arrived(){const transfer={stage:0,legs:[first,second],originalTrip:original,completedLegs:[],startedAt:'2026-10-18T12:00:00Z'};
 return {id:'test',phase:'arrived',instrumentVersion:'transfer-v1',startedAt:'2026-10-18T12:00:00Z',boardedAt:'2026-10-18T12:01:00Z',arrivedAt:'2026-10-18T12:03:00Z',busName:'#41',line:{label:'Blue Day',busRouteIds:[1]},boardStopId:1,exitStopId:2,trip:transferLegTrip(original,first,feed),transfer,
  arrivalObservation:{receivedAt:'2026-10-18T12:03:00Z',stopId:2,stopName:'First exit',stopCoords:b,bus:{bus_name:'#41',route_id:1,...b},distanceM:0,criterion:'GPS-within-45m'}};}
test('general rider excludes the dedicated line while explicit Red assignment remains valid',()=>{
 assert.equal(riderLineAllowed('Red',undefined,true),false);assert.equal(riderLineAllowed('Red',['Red'],false),true);
 assert.equal(riderLineAllowed('Orange Day',['Blue Day'],true),false);assert.equal(riderLineAllowed('Orange Day',undefined,true),true);
});
test('restart checks both saved transfer legs against the current assignment',()=>{
 assert.equal(riderAssignmentAllows({line:{label:'Red'}},undefined,true),false);
 assert.equal(riderAssignmentAllows({line:{label:'Red'}},['Red'],false),true);
 assert.equal(riderAssignmentAllows({line:{label:'Blue Day'},transfer:{legs:[first,second]}},undefined,true),true);
 assert.equal(riderAssignmentAllows({line:{label:'Blue Day'},transfer:{legs:[first,{routeLabel:'Red'}]}},undefined,true),false);
 assert.equal(riderAssignmentAllows({line:{label:'Unknown'}},undefined,true),false);
});
test('parses actual transfer option labels without confusing a stop containing to',()=>{
 assert.deepEqual(transferChoiceLabels('View Blue Day to Orange Day transfer from Road to Town'),['Blue Day','Orange Day']);
 assert.equal(transferChoiceLabels('View Blue Day trip details'),null);assert.equal(transferChoiceLabels('View Red to Red transfer from Here'),null);
});
test('normal selection skips the dedicated line and selects an eligible live two-leg option',async()=>{
 const clicked=[],choices=['View Blue Day to Red transfer from Origin','View Blue Day to Orange Day transfer from Origin'];
 const page={getByRole:(_,{name})=>String(name).includes('Show')?{first:()=>({isVisible:async()=>false})}:{all:async()=>choices.map(label=>({getAttribute:async()=>label,click:async()=>clicked.push(label)}))},
  getByTestId:()=>({waitFor:async()=>{}}),locator:()=>({evaluateAll:async()=>[section,{...second,controls:false}]})};
 const selected=await selectTransferTrip(page,feed,{label:'Blue Day'},undefined,true);
 assert.equal(selected.legs[1].routeLabel,'Orange Day');assert.deepEqual(clicked,[choices[1]]);
});
test('a selected future-only or ambiguous transfer cannot start a live virtual ride',async()=>{
 const page={getByRole:(_,{name})=>String(name).includes('Show')?{first:()=>({isVisible:async()=>false})}:{all:async()=>[{getAttribute:async()=>'View Blue Day to Orange Day transfer from Origin',click:async()=>{}}]},
  getByTestId:()=>({waitFor:async()=>{}}),locator:()=>({evaluateAll:async()=>[{...section,controls:false},{...second,controls:false}]})};
 await assert.rejects(selectTransferTrip(page,feed,{label:'Blue Day'},undefined,true),/ambiguous or changed/);
});
test('requires exact unique endpoints, geometry and assignment for each transfer leg',()=>{
 assert.equal(validTransferLeg(first,feed,undefined,true),true);assert.equal(validTransferLeg({...first,exitStopId:99},feed,undefined,true),false);
 assert.equal(validTransferLeg(first,{...feed,routes:{...feed.routes,1:[1,2,1]}},undefined,true),false);
 assert.equal(validTransferLeg(first,feed,['Orange Day'],true),false);
});
test('boarding uses the active leg explicit bus, rather than the preview/countdown bus',()=>{
 const read=transferWaitingContext([section,{...second,controls:false}],first,feed);
 assert.equal(read.busName,'#41');assert.equal(read.buttonName,"🚌 I'm on #41");assert.equal(read.countdownBusName,'39');assert.equal(read.assessmentDerivedFromPublicAttributes,true);
 assert.match(read.assessmentText,/#41 · 2 stops away/);assert.equal(read.text,'actual visible text');
});
test('missing or duplicate active sections cannot identify a boarding',()=>{
 assert.equal(transferWaitingContext([{...section,controls:false}],first,feed),null);
 assert.equal(transferWaitingContext([section,section],first,feed),null);assert.equal(transferWaitingContext([section],second,feed),null);
});
test('missing or ambiguous live bus identities remain unnamed',()=>{
 assert.equal(transferWaitingContext([{...section,boardBusName:null}],first,feed).busName,null);
 assert.equal(transferWaitingContext([section],first,{...feed,buses:[...feed.buses,feed.buses[0]]}).busName,null);
});
test('a zero boarding count keeps the at-stop assessment but does not invent proximity',()=>{
 const read=transferWaitingContext([{...section,boardingStopsAhead:0,buttons:["🚌 I'm on it"]}],first,feed);
 assert.match(read.assessmentText,/BOARD🚌Origin/);assert.equal(read.buttonName,"🚌 I'm on it");
});
test('first boarding retains onward identity and the original final destination',()=>{
 const run=arrived(),ride={routeLabel:'Blue Day',boardStopId:1,alightStopId:2,onward:{next:{routeLabel:'Orange Day',boardStopId:3,alightStopId:4},destination:d}};
 assert.equal(boardedTransferMatches(ride,run.transfer),true);assert.equal(boardedTransferMatches({...ride,alightStopId:3},run.transfer),false);
 assert.equal(boardedTransferMatches({...ride,onward:{...ride.onward,destination:a}},run.transfer),false);assert.equal(boardedTransferMatches({...ride,onward:null},run.transfer),false);
});
test('second boarding ends onward state and retains the final destination',()=>{
 const transfer={...arrived().transfer,stage:1},ride={routeLabel:'Orange Day',boardStopId:3,alightStopId:4,toLat:d.lat,toLon:d.lon};
 assert.equal(boardedTransferMatches(ride,transfer),true);assert.equal(boardedTransferMatches({...ride,onward:{}},transfer),false);
 assert.equal(boardedTransferMatches({...ride,toLat:a.lat},transfer),false);
});
test('observed arrival hands over at the actual source fix, preserving first-leg evidence and final destination',()=>{
 const run=arrived(),next=nextTransferStage(run,feed,Date.parse('2026-10-18T12:03:20Z'));
 assert.equal(next.id,run.id);assert.equal(next.phase,'waiting');assert.equal(next.line.label,'Orange Day');assert.equal(next.transfer.stage,1);
 assert.equal(next.trip.origin.lat,run.arrivalObservation.bus.lat);assert.equal(next.trip.origin.lon,run.arrivalObservation.bus.lon);
 assert.deepEqual(next.transfer.originalTrip,original);assert.deepEqual(next.transfer.completedLegs[0].arrivalObservation,run.arrivalObservation);
 assert.equal(next.arrivalObservation,undefined);assert.equal(next.boardedAt,undefined);assert.equal(next.busName,undefined);assert.equal(next.walkUntil,undefined);
 assert.equal(next.excludeAccuracy,true);assert.equal(next.instrumentVersion,'transfer-v1');
});
test('tracking end, missing receipt, wrong bus/stop, or insufficient riding time never establish a transfer arrival',()=>{
 for(const patch of[{phase:'waiting'},{arrivalObservation:null},{exitStopId:3},{busName:'#99'},{boardedAt:'2026-10-18T12:02:50Z'}])assert.throws(()=>nextTransferStage({...arrived(),...patch},feed,Date.now()),/observed first-leg arrival/);
});
test('a distant receipt and changed next-leg assignment withhold transition',()=>{
 const far=arrived();far.arrivalObservation.bus={...far.arrivalObservation.bus,...a};assert.throws(()=>nextTransferStage(far,feed,Date.now()),/observation rule/);
 const changed=arrived();changed.transfer.legs[1]={routeLabel:'Red',boardStopId:3,exitStopId:4};assert.throws(()=>nextTransferStage(changed,feed,Date.now()),/not assigned/);
});
test('per-leg records do not recursively embed the transfer or prior legs',()=>{
 const run=arrived(),leg=completedLegRecord(run);assert.equal(leg.transfer,undefined);assert.equal(leg.busName,'#41');assert.equal(leg.result,'arrived');assert(sameTransferLeg(first,{...first}));
});
