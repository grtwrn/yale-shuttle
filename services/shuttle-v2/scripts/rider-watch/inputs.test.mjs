import {test} from 'vitest';
import assert from 'node:assert/strict';
import {cardBoardsBus,labeledStopId,destinationMatches,selectDestination,followedBusName,pastPickup,quotedRideMin,quotedWaitMin,rideCapMin,riderConfig,waitCapMin} from './inputs.mjs';
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
// riderpromptmiss20261004: the card's "I'm on it" stores the nearest line bus
// within 100 m of the rider (the app's boardingBusName), so it is a fallback
// for #330 only while #330 is that bus.
test('the card stores our bus only while it is the nearest line bus within 100 m',()=>{
 const rider=coords[127],b330={bus_name:'#330',route_id:10,lat:41.271329,lon:-72.964228};
 assert.equal(cardBoardsBus([b330],[10],rider,'#330'),true);
 assert.equal(cardBoardsBus([b330],[10],rider,'330'),true);
 assert.equal(cardBoardsBus([{...b330,lat:41.270104,lon:-72.969079}],[10],rider,'#330'),false);
 assert.equal(cardBoardsBus([b330,at2134[2]],[10],rider,'#330'),false);
 assert.equal(cardBoardsBus([b330,{...at2134[2],route_id:3}],[10],rider,'#330'),true);
 assert.equal(cardBoardsBus([b330],[3],rider,'#330'),false);
 assert.equal(cardBoardsBus([],[10],rider,'#330'),false);
});
// riderboarddrivethrough20261005: Purple #317 through 100 Church Street South
// (1) at 00:39:24Z and 00:39:34Z; #330 standing 66 m past its pole at
// 09:37:39Z; Blue Weekend #44 7 m from Broadway / York (21) with at_stop_id
// Elm / York (53), its fix changed at 15:37:17Z and unchanged 9.9 s later.
test('a bus is past the pickup once the feed has it last there, moving and not standing at it',()=>{
 const church={1:{lat:41.299671,lon:-72.929425}};
 const b317={bus_name:'#317',route_id:10,lat:41.300357,lon:-72.929531,last_stop_id:9,stationary:false,observed_at:1791160760915,last_moved_at:'2026-10-05T00:39:20.915'};
 assert.equal(pastPickup(b317,1,church),false);
 const passing={...b317,lat:41.299313,lon:-72.929271,last_stop_id:1,observed_at:1791160770893,last_moved_at:'2026-10-05T00:39:30.893'};
 assert.equal(pastPickup(passing,1,church),true);
 // A feed without the movement clock says nothing: not past.
 assert.equal(pastPickup({...passing,last_moved_at:undefined},1,church),false);
 const b330={bus_name:'#330',route_id:10,lat:41.299096,lon:-72.929247,last_stop_id:1,stationary:true,at_stop_id:1,observed_at:1791106654039,last_moved_at:'2026-10-04T09:37:29.203'};
 assert.equal(pastPickup(b330,1,church),false);
 assert.equal(pastPickup({...b330,stationary:false,at_stop_id:undefined},1,church),true);
 assert.equal(pastPickup({...b330,at_stop_id:9},1,church),true);
 assert.equal(pastPickup({...b330,last_stop_id:9,stationary:false,at_stop_id:undefined},1,church),false);
 const york={21:{lat:41.311002,lon:-72.930344}};
 const b44={bus_name:'#44',route_id:4,lat:41.311038,lon:-72.930406,stationary:true,at_stop_id:53,last_stop_id:21,observed_at:1791128237102,last_moved_at:'2026-10-04T15:37:17.102'};
 assert.equal(pastPickup(b44,21,york),true);
 assert.equal(pastPickup({...b44,observed_at:1791128246953},21,york),false);
});
// riderneighbourstop20261005: the app's card for a rider at Broadway / York at
// 15:37:22Z, rendered from the recorded feed; #44 as recorded at 15:37:32Z.
test('the followed bus standing at the pickup is kept when the feed names a neighbouring stop or none',()=>{
 const york={21:{lat:41.311002,lon:-72.930344},53:{lat:41.31086,lon:-72.93054}};
 const card="Blue Weekend\t\n<1\n\t11:47a – 12:09p\n\n🚌 19 min\nBOARD🚌Broadway/York⏸ 1:17\nStop & Shop\nElm/York (TYCO)\nGET OFFProspect/Edwards";
 const b44={bus_name:'#44',route_id:4,lat:41.311038,lon:-72.930406,stationary:true,at_stop_id:53,last_stop_id:21,observed_at:1791128246953,last_moved_at:'2026-10-04T15:37:17.102'};
 assert.equal(followedBusName(card,21,[b44],[4],'#44',york),'#44');
 // No at_stop_id at all (v1compat: stationary is at_stop_id != null).
 assert.equal(followedBusName(card,21,[{...b44,stationary:false,at_stop_id:undefined}],[4],'#44',york),'#44');
 // Another line's bus there does not count.
 assert.equal(followedBusName(card,21,[b44,{...b44,bus_name:'#45',route_id:3}],[4],'#44',york),'#44');
});
test('a bus near the pickup that is moving, too far or not alone there is not inferred',()=>{
 const york={21:{lat:41.311002,lon:-72.930344}};
 const card="🚌 19 min\nBOARD🚌Broadway/York⏸ 1:17\nStop & Shop\nGET OFFProspect/Edwards";
 const b44={bus_name:'#44',route_id:4,lat:41.311038,lon:-72.930406,stationary:true,at_stop_id:53,last_stop_id:21,observed_at:1791128246953,last_moved_at:'2026-10-04T15:37:17.102'};
 // 15:37:22Z: the fix changed with that poll, so it may be driving on.
 assert.equal(followedBusName(card,21,[{...b44,observed_at:1791128237102}],[4],'#44',york),null);
 // A feed without the movement clock does not say it is standing.
 assert.equal(followedBusName(card,21,[{...b44,last_moved_at:undefined}],[4],'#44',york),null);
 // 15:37:02Z: standing 57 m short of the pole, beyond the 45 m boarding radius.
 const short={...b44,lat:41.31051,lon:-72.930152,last_stop_id:150,observed_at:1791128216985,last_moved_at:'2026-10-04T15:36:11.917'};
 assert.equal(followedBusName(card,21,[short],[4],'#44',york),null);
 // Another line bus standing there as well, or at the stop: fail closed.
 const b45={...b44,bus_name:'#45',lat:41.31105,lon:-72.9303};
 assert.equal(followedBusName(card,21,[b44,b45],[4],'#44',york),null);
 assert.equal(followedBusName(card,21,[b44,{...b45,at_stop_id:21}],[4],'#44',york),null);
 // A bus the card did not follow is never taken this way (it may stand at the
 // opposite curb); the one observed at the stop still is, as before.
 assert.equal(followedBusName(card,21,[b44],[4],undefined,york),null);
 assert.equal(followedBusName(card,21,[b44],[4],'#40',york),null);
 assert.equal(followedBusName(card,21,[b44,{...b45,at_stop_id:21}],[4],undefined,york),'#45');
 // Without the card's BOARD🚌 nothing is inferred.
 assert.equal(followedBusName(card.replace('BOARD🚌','BOARD'),21,[b44],[4],'#44',york),null);
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
// 96f99a88, Grocery Ham run 1791026050850's first card, 2026-10-03T11:14:17Z.
test('the wait cap covers the quoted wait, bounded to 45–90 min',()=>{
 const card="Grocery Ham\t\n~44 (33 – 60)\n\t8:11a – 8:47a\n\n🚌 27 min\n🚌 #42 · 4 stops away\nBOARDElm/College\nArrival: About 44 min · Likely 33–60 min\nGET OFFAldi/Walmart";
 assert.equal(quotedWaitMin(card),44);
 assert.equal(waitCapMin(44),66);
 assert.equal(quotedWaitMin('BOARDElm/College\nArrival: About <1 min · Likely ~1 min'),0);
 for(const text of [undefined,'','~44 (33 – 60)\nBOARDX','Arrival: About 20 min\nArrival: About 30 min'])
  assert.equal(quotedWaitMin(text),null);
 assert.equal(waitCapMin(null),45);
 assert.equal(waitCapMin(0),45);
 assert.equal(waitCapMin(25),45);
 assert.equal(waitCapMin(75),90);
});
const redFeed={routes:{3:[11,146,49,48,104,72],1:[106,34]},stop_names:{48:'Division / Prospect',72:'LEPH / 60 College',106:'Elm / High'},
 stop_coords:{48:{lat:41.324769,lon:-72.923522},72:{lat:41.30378,lon:-72.93261},106:{lat:41.31,lon:-72.93}}};
test('the dedicated Red rider repeats Division / Prospect to the School of Public Health',()=>{
 const config=riderConfig({RIDER_LINE:'Red',RIDER_FROM:'48',RIDER_TO:'ysph'},redFeed);
 assert.deepEqual(config.allowedLabels,['Red']);
 assert.deepEqual(config.fixedTrip.origin,{label:'Division / Prospect',lat:41.324769,lon:-72.923522,stopId:48});
 assert.equal(config.fixedTrip.destination.display_name,'School of Public Health (YSPH)');
 assert.equal(config.fixedTrip.destination.class,'yale');
 assert.equal(riderConfig({RIDER_LINE:'Red',RIDER_FROM:'48',RIDER_TO:'72'},redFeed).fixedTrip.destination.stopId,72);
});
test('an unset rider stays random and a bad assignment fails instead of riding elsewhere',()=>{
 assert.deepEqual(riderConfig({},redFeed),{randomLines:true});
 assert.deepEqual(riderConfig({RIDER_LINE:'Red'},redFeed),{allowedLabels:['Red']});
 assert.throws(()=>riderConfig({RIDER_LINE:'Crimson'},redFeed),/Unknown RIDER_LINE/);
 assert.throws(()=>riderConfig({RIDER_FROM:'48',RIDER_TO:'ysph'},redFeed),/need RIDER_LINE/);
 assert.throws(()=>riderConfig({RIDER_LINE:'Red',RIDER_FROM:'106',RIDER_TO:'ysph'},redFeed),/RIDER_FROM=106 is not a Red stop/);
 assert.throws(()=>riderConfig({RIDER_LINE:'Red',RIDER_FROM:'48'},redFeed),/RIDER_TO=undefined/);
});
