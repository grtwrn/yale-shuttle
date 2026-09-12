import {test} from 'vitest';
import assert from 'node:assert/strict';
import {labeledStopId,destinationMatches,selectDestination} from './inputs.mjs';
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
