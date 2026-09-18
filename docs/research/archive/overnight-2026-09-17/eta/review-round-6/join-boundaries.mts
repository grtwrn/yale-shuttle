/** Reviewer-only adversarial cases for the exact declared source transform. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-6';
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {journeyArrival}=await load('journeyArrival.ts');
const {rideBoardArrivals,boardingVisitAllowed}=await load('planner.ts');
const transform=JSON.parse(fs.readFileSync(O+'/ordered-transform.json','utf8'));
const evaluate=new Function('board','visits','o','effectiveWalkToSec','nowMs','hereBus','live','journeyArrival',
 `const norm=s=>s.replace(/^#/,''); ${transform.replacement}; return {forecastBoard,arrival};`);
const row=(stopId:number,stopsAhead:number,eta:number,patch:any={})=>({stopId,stopsAhead,eta,low:eta/2,high:eta*2,
 busName:'307',routeLabel:'Purple',color:'#123',departNow:eta,lowFloor:0,estimated:false,distribution:[eta/2,eta,eta*2],...patch});
let checks=0;
function invoke(visits:any[],walk=0,raw='#307'){
 const o={boardStopId:10,alightStopId:20,walkFromSec:30};
 if(!boardingVisitAllowed(raw,10,20,visits))return {rejected:true};
 const live=rideBoardArrivals(visits,10,20);
 const board=live.find((a:any)=>a.busName.replace(/^#/,'')===raw.replace(/^#/,'')&&a.stopsAhead===0&&a.eta===0);
 return evaluate(board,visits,o,walk,1000,{bus_name:raw},live,journeyArrival);
}
const standard=[row(10,1,10),row(20,6,500),row(10,30,3000),row(20,35,3500)];
let v=invoke(standard);assert.equal(v.forecastBoard.stopsAhead,1);assert.equal(v.arrival.pointMs,531000);assert.deepEqual(v.arrival.distributionMs,[281000,531000,1031000]);checks++;
// Reversed input order and a different vehicle's sooner endpoint cannot change attribution.
v=invoke([row(20,2,20,{busName:'309'}),...standard].reverse());assert.equal(v.arrival.pointMs,531000);assert.equal(v.arrival.busName,'307');checks++;
for(const raw of ['307','#307']){assert.equal(invoke(standard,0,raw).arrival.busName,'307');checks++;}
// A modeled arrived pickup retains priority over a future visit.
v=invoke([row(10,0,0),row(20,6,500),row(10,30,3000)]);assert.equal(v.forecastBoard.stopsAhead,0);checks++;
// The first destination is before the only pickup; never borrow the next lap's destination.
v=invoke([row(20,6,500),row(10,29,3000),row(20,35,3500)]);assert.equal(v.forecastBoard,undefined);assert.equal(v.arrival,undefined);checks++;
for(const visits of [[],[row(10,1,10)],[row(10,1,10),row(20,6,500,{busName:'309'})]]){assert.equal(invoke(visits).arrival,undefined);checks++;}
// Folded route: another pickup occurs before the first destination, so existing visit gate rejects raw override.
v=invoke([row(10,1,10),row(10,5,300),row(20,8,500)]);assert.equal(v.rejected,true);checks++;
// Missing first fold is not invented; an actually served later pickup retains its own forward identity.
v=invoke([row(10,5,300),row(20,8,500)]);assert.equal(v.forecastBoard.stopsAhead,5);assert.equal(v.arrival.pointMs,531000);checks++;
// Available pickup is not a promise of catchability for a walking rider.
assert.equal(invoke(standard,5).arrival.catchRisk,false);assert.equal(invoke(standard,6).arrival.catchRisk,true);checks+=2;
assert.equal(invoke(standard,501).arrival,undefined);checks++;
for(const patch of [{eta:1},{high:NaN},{low:1000,high:900}]){assert.equal(invoke([row(10,1,10),row(20,6,500,patch)]).arrival,undefined);checks++;}
assert.deepEqual(standard,[row(10,1,10),row(20,6,500),row(10,30,3000),row(20,35,3500)]);checks++;
const result={checks,scope:'Exact artifact transform plus current planner gates/journey helper. Synthetic occurrence safety; not a submitted app test or all-route live validation.'};
fs.writeFileSync(O+'/join-boundaries.json',JSON.stringify(result,null,2)+'\n');console.log(result);
