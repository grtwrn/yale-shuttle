import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {forecastPickupSelection,rawPickupSelection} from './livePickupSelection.ts';
import {reprice} from './shell-candidate.generated.mts';
import {futureOptions} from './future-guard.generated.mts';
const O=new URL('.',import.meta.url).pathname;
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {pickLiveArrival,rideBoardArrivals}=await load('planner.ts');
const {journeyArrival,atStopJourneyBoard}=await load('journeyArrival.ts');
const row=(busName:string,stopId:number,stopsAhead:number,eta:number)=>({busName,routeLabel:'Red',color:'#C62828',stopId,stopsAhead,eta,low:Math.max(0,eta-20),high:eta+80,departNow:eta,lowFloor:Math.max(0,eta-20),estimated:false});
const first=row('#307',48,1,20),later=row('307',48,30,1200),dest=row('307',121,10,500),laterDest=row('307',121,39,1800),other=row('309',48,3,300),otherDest=row('309',121,12,800);
const at=1789668000000,checks:any[]=[];
function probe(name:string,visits:any[],walk:number){
 const input=JSON.stringify(visits),selected=pickLiveArrival(rideBoardArrivals(visits,48,121),'#307',walk);
 assert.ok(selected);
 const journey=selected.departed?undefined:journeyArrival(selected.boardable,visits,121,walk,60,at);
 const metadata=forecastPickupSelection(selected,at);
 assert.equal(JSON.stringify(visits),input);
 const result={name,metadata,journeyAvailable:!!journey};checks.push(result);return {selected,metadata,journey};
}
const same=probe('same bus later occurrence',[first,dest,later,laterDest],200);
assert.equal(same.selected.match,first);assert.equal(same.selected.boardable,later);assert.equal(same.metadata?.relation,'same-bus-later-visit');
const missingSame=probe('later same bus with missing destination',[first,later],200);
assert.equal(missingSame.journey,undefined);assert.deepEqual(missingSame.metadata,same.metadata);
const distinct=probe('different vehicle with closing countdown',[first,other,dest,otherDest,later,laterDest],100);
assert.equal(distinct.metadata?.relation,'different-bus');assert.equal(distinct.metadata?.boarding.busName,'309');
const missing=probe('different vehicle with missing destination',[first,other,later],100);
assert.equal(missing.journey,undefined);assert.deepEqual(missing.metadata,distinct.metadata);
const departed=probe('fallback when no arrival is catchable',[first,dest],1000);
assert.equal(departed.metadata,undefined);
const buffered=probe('pinned walking tolerance retains selected fallback',[first,dest],129);
assert.equal(buffered.selected.departed,false);assert.equal(buffered.selected.boardable,first);
assert.ok(129>first.eta+60);assert.equal(buffered.metadata?.relation,'same-visit');
const ordinary=probe('normalized bus name, same occurrence',[first,dest,later,laterDest],0);
assert.equal(ordinary.metadata?.relation,'same-visit');assert.equal(ordinary.metadata?.boarding.busName,'307');
const foldFirst=row('307',48,1,20),foldReturn=row('307',48,6,150),foldDest=row('307',121,9,500);
const fold=probe('folded route selects permitted pickup',[foldFirst,foldReturn,foldDest],0);
assert.equal(fold.selected.match,foldReturn);assert.equal((fold.metadata?.boarding as any).stopsAhead,6);
const unknownFold=probe('folded missing destination uses actual changed selection',[foldFirst,foldReturn],0);
assert.equal(unknownFold.selected.match,foldFirst);assert.equal(unknownFold.journey,undefined);assert.equal((unknownFold.metadata?.boarding as any).stopsAhead,1);
assert.equal(atStopJourneyBoard([dest,later,laterDest],'Red','#307',48,121),undefined);
const raw=rawPickupSelection('#307',48,at);
assert.deepEqual(raw,{selectedAtMs:at,countdown:{source:'raw-at-stop',busName:'307',stopId:48},boarding:{source:'raw-at-stop',busName:'307',stopId:48},relation:'raw-current'});
checks.push({name:'raw current without compatible forecast never borrows next lap',metadata:raw});
assert.equal(forecastPickupSelection(null,at),undefined);checks.push({name:'empty selector'});
// Occurrence is defined by selected rows, never equal ETAs or object identity.
const equalTime=forecastPickupSelection({match:first,boardable:{...first,stopsAhead:30},departed:false},at);
assert.equal(equalTime?.relation,'same-bus-later-visit');checks.push({name:'equal times on different occurrences',metadata:equalTime});
const clone=forecastPickupSelection({match:first,boardable:{...first,busName:'307',eta:999},departed:false},at);
assert.equal(clone?.relation,'same-visit');checks.push({name:'same occurrence with copied row/changed time',metadata:clone});
const old=rawPickupSelection('OLD',99,1),record=JSON.parse(fs.readFileSync(O+'../cycle-5/traversal-guard/decisions.jsonl','utf8').split('\n')[0]);
const payload=JSON.parse(fs.readFileSync(O+'../cycle-5/traversal-guard/calibration-payload.json','utf8'));
const seeded=record.stable.map((o:any)=>({...o,livePickupSelection:old}));const seededBefore=JSON.stringify(seeded);
for(const from of [record.from,null]){
 const results=reprice(seeded,[],payload,from,record.to).options;
 assert.ok(results.every((o:any)=>o.livePickupSelection===undefined));
 checks.push({name:from?'missing live and moving-walk clears prior metadata':'missing origin walk clears prior metadata'});
}
const realNow=Date.now;Date.now=()=>at;
try{
 const future=futureOptions(seeded,new Date(at+60001));assert.ok(future.every((o:any)=>o.livePickupSelection===undefined));
 assert.deepEqual(future.map(({livePickupSelection,...o}:any)=>o),seeded.map(({livePickupSelection,...o}:any)=>o));
 assert.equal(futureOptions(seeded,new Date(at+60000)),null);
 assert.equal(futureOptions(seeded,null),null);checks.push({name:'future guard clears only past exact 60-second boundary'});
}finally{Date.now=realNow;}
assert.equal(JSON.stringify(seeded),seededBefore);
checks.push({name:'input options and selected rows never mutated'});
fs.writeFileSync(O+'boundaries.json',JSON.stringify({passed:checks.length,checks},null,2)+'\n');console.log(`${checks.length} executable projection/lifecycle boundary groups passed`);
