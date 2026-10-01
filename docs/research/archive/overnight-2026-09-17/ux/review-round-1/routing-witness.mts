import assert from 'node:assert/strict';
import { preferredTripOrder } from '/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2/web/src/tripRanking.ts';
import { topVisibleOptions, type TripOption } from '/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2/web/src/planner.ts';
import { compareDeadline } from '/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2/web/src/arriveBy.ts';
import { deadlineMessage } from '/home/gwarren/projects/yale-shuttle-watcher/overnight-ux-2026-09-17/services/shuttle-v2/web/src/arriveByMessage.ts';
const now=Date.parse('2026-09-17T14:00:00-04:00');
function shuttle(routeLabel:string, busName:string, rideSec:number, highSec:number):TripOption {
  return {mode:'shuttle', routeLabel, busName, color:'#f00',boardStopId:48,alightStopId:121,
    walkToSec:60,waitSec:300,rideSec,walkFromSec:60,totalSec:rideSec+420,directWalkSec:1500,computedAtMs:now,
    journeyArrival:{busName,pointMs:now+(rideSec+420)*1000,lowMs:now+300_000,highMs:now+highSec*1000,catchRisk:false,estimated:false}};
}
const red=shuttle('Red','309',300,1800);
const walk:TripOption={...red,mode:'walk',routeLabel:'Walk',totalSec:1500,journeyArrival:undefined};
const options=preferredTripOrder([red,shuttle('Green','305',400,1800),shuttle('Brown','507',500,1800),shuttle('Blue Day','410',650,1100),walk]);
const c=compareDeadline(options,now+1200_000,5,now,now,false);
const visible=topVisibleOptions(options);
const m=deadlineMessage(c,{});
assert.equal(c.shuttle?.option.routeLabel,'Red');
assert.equal(m.kind,'buffer');
assert.match(m.explanation,/Blue Day/);
assert(!visible.some(o=>o.routeLabel==='Blue Day'));
console.log(JSON.stringify({kind:'synthetic valid TripOptions using actual production ranking and visibility helpers',ordered:options.map(o=>o.routeLabel),visible:visible.map(o=>o.routeLabel),deadlineRows:[c.shuttle?.option.routeLabel,c.walk?.option.routeLabel],message:m,conclusion:'The route used by the buffer headline can also be behind Show more in the main trip list.'},null,2));
