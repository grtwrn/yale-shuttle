import {test} from 'vitest';
import assert from 'node:assert/strict';
import {labeledStopId,destinationMatches,selectDestination,followedBusName} from './inputs.mjs';
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
const purple=[{bus_name:'#119',route_id:10,at_stop_id:10},{bus_name:'#321',route_id:10},{bus_name:'#126',route_id:10,at_stop_id:122}];
test('recorded Purple dwell keeps the followed bus instead of an invalid sample',()=>{
 assert.equal(followedBusName(approaching,122,purple,[10]),'#126');
 assert.equal(followedBusName(dwelling,122,purple,[10]),'#126');
 assert.equal(followedBusName(dwelling,122,purple,[10],'#126'),'#126');
});
test('dwell identity fails closed without the board decoration or with unknown ambiguity',()=>{
 assert.equal(followedBusName(dwelling.replace('BOARD🚌','BOARD'),122,purple,[10]),null);
 assert.equal(followedBusName(dwelling,null,purple,[10]),null);
 assert.equal(followedBusName(dwelling,122,purple,[3]),null);
 const two=[...purple,{bus_name:'#300',route_id:10,at_stop_id:122}];
 assert.equal(followedBusName(dwelling,122,two,[10]),null);
 assert.equal(followedBusName(dwelling,122,two,[10],'#300'),'#300');
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
