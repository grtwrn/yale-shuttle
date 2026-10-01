import {test} from 'vitest';
import assert from 'node:assert/strict';
import {labeledStopId,destinationMatches,selectDestination,followedBusName,quotedRideMin,rideCapMin} from './inputs.mjs';
const names={145:'Science Park Garage',98:'Phelps Gate',48:'Division / Prospect'};
test('recorded Brown boarding prompt resolves on the first poll',()=>{
 const text="BOARD🚌Science Park Garage⏸ 14:04\nWinchester/Sachem\nGET OFFPhelps Gate\n🚌 On Brown #309?";
 assert.equal(labeledStopId(text,'BOARD',names),145);
 assert.equal(labeledStopId(text,'GET OFF',names),98);
});
test('Red plain and dwelling labels resolve identically',()=>{
 for(const line of ['BOARDDivision/Prospect','BOARD🚌Division/Prospect⏸ 0:27'])
  assert.equal(labeledStopId(line,'BOARD',names),48);
});
test('missing, truncated, duplicate labels and ambiguous names fail closed',()=>{
 for(const text of ['', 'BOARDScience Park', 'BOARDScience Park Garage\nBOARDPhelps Gate'])
  assert.equal(labeledStopId(text,'BOARD',names),null);
 assert.equal(labeledStopId('BOARDScience Park Garage','BOARD',{...names,999:'Science Park Garage'}),null);
});
// Purple, 2026-10-01 11:03:41Z then 11:04:11Z: #126 approaches, then dwells
// 18 m from Union Station (S) and the app drops its "🚌 #126 ·" line.
const approaching="🚌 20 min\n🚌 #126 · 1 stop away\n🚌100 Church Street South\nBOARDUnion Station (S)\nGET OFFBuilding 400";
const dwelling="Purple\t\nAt stop\n\t7:19a – 7:34a\n\n🚌 20 min\nBOARD🚌Union Station (S)⏸ 0:29\nWest Haven Train Station\nGET OFFBuilding 400";
const coords={122:{lat:41.297929,lon:-72.926912},127:{lat:41.271172,lon:-72.963517}};
const at126={bus_name:'#126',route_id:10,lat:41.297912,lon:-72.926694,at_stop_id:122,stationary:true};
const purple=[{bus_name:'#119',route_id:10,lat:41.30,lon:-72.94,at_stop_id:10},{bus_name:'#321',route_id:10,lat:41.31,lon:-72.93},at126];
test('recorded Purple dwell keeps the followed bus instead of an invalid sample',()=>{
 assert.equal(followedBusName(approaching,122,purple,[10]),'#126');
 assert.equal(followedBusName(dwelling,122,purple,[10],undefined,coords),'#126');
 assert.equal(followedBusName(dwelling,122,purple,[10],'#126',coords),'#126');
});
test('dwell identity fails closed without the board decoration or with unknown ambiguity',()=>{
 assert.equal(followedBusName(dwelling.replace('BOARD🚌','BOARD'),122,purple,[10],undefined,coords),null);
 assert.equal(followedBusName(dwelling,null,purple,[10],undefined,coords),null);
 assert.equal(followedBusName(dwelling,122,purple,[3],undefined,coords),null);
 assert.equal(followedBusName(dwelling,122,purple,[10]),null);
 const two=[...purple,{...at126,bus_name:'#300',lat:41.297950}];
 assert.equal(followedBusName(dwelling,122,two,[10],undefined,coords),null);
 assert.equal(followedBusName(dwelling,122,two,[10],'#300',coords),'#300');
});
test('at-stop candidates follow the app rule: stationary, at_stop_id, within 75 m',()=>{
 for(const bus of [{...at126,stationary:false},{...at126,at_stop_id:undefined},{...at126,lat:41.2988}])
  assert.equal(followedBusName(dwelling,122,[bus],[10],undefined,coords),null);
});
// Purple run 1790803296841, 2026-09-30T21:34:12Z at West Haven Train Station
// (127). The app still times #321 (card ~32 min, unchanged), which is 75 m
// out, moving, not listed at the stop. #332 is listed there, stationary, 29 m.
// Boarding #332 would measure a ride against a trip planned on #321.
const westHaven="Purple\t\n~32 (23 – 43)\n\t6:06p – 6:26p\n\n🚌 9 min\nBOARD🚌West Haven Train Station\nBuilding 900\nBuilding 800\nBuilding 750\nBuilding 600\nGET OFFBuilding 400";
const at2134=[
 {bus_name:'#321',route_id:10,lat:41.271634,lon:-72.96286,last_stop_id:127,stationary:false},
 {bus_name:'#302',route_id:10,lat:41.289644,lon:-72.922596,last_stop_id:26,stationary:false},
 {bus_name:'#332',route_id:10,lat:41.27122,lon:-72.963864,last_stop_id:26,stationary:true,at_stop_id:127},
];
test('recorded West Haven poll skips while the followed #321 is near, never switching to #332',()=>{
 assert.equal(followedBusName(westHaven,127,at2134,[10],'#321',coords),null);
 // Once the followed bus has left the area, the app's own at-stop bus is it.
 const gone=at2134.map(b=>b.bus_name==='#321'?{...b,lat:41.30,lon:-72.93}:b);
 assert.equal(followedBusName(westHaven,127,gone,[10],'#321',coords),'#332');
});
const intended={display_name:'West Haven Train Station',lat:41.271172,lon:-72.963517};
const resolved={toText:'West Haven Station',toLL:{lat:41.271153,lon:-72.963243}};
test('actual West Haven alias matches geographically; unrelated/missing coordinates do not',()=>{
 assert(destinationMatches(resolved,intended));
 for(const draft of [null,{}, {toLL:{lat:NaN,lon:0}}, {toLL:{lat:41.31,lon:-72.92}}])
  assert.equal(destinationMatches(draft,intended),false);
});
test('selection uses Enter and rejects an unrelated selected result',async()=>{
 const actions=[];
 const page={getByPlaceholder:()=>({fill:async x=>actions.push(x),press:async x=>actions.push(x)}),
  waitForFunction:async()=>{},evaluate:async()=>resolved};
 assert.equal(await selectDestination(page,intended),resolved);
 assert.deepEqual(actions,[intended.display_name,'Enter']);
 page.evaluate=async()=>({toLL:{lat:0,lon:0}});
 await assert.rejects(selectDestination(page,intended),/within 80 m/);
});
// Purple run 1790862386350 pickup card, 2026-10-01T13:54:32Z.
test('the ride cap covers the quoted ride, bounded to 50–90 min',()=>{
 const pickup="Purple\t\nAt stop\n\t10:35a – 11:04a\n\n🚌 54 min\nBOARD🚌West Haven Train Station⏸ 0:26\nGET OFFBuilding 400\n🚌 On Purple #119?";
 assert.equal(quotedRideMin(pickup),54);
 assert.equal(rideCapMin(54),81);
 for(const text of [undefined,'','🚌 <1 min\nBOARDX','🚌 20 min\n🚌 30 min'])
  assert.equal(quotedRideMin(text),null);
 assert.equal(rideCapMin(null),50);
 assert.equal(rideCapMin(20),50);
 assert.equal(rideCapMin(120),90);
});
