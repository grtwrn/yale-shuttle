import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {pickupContract,forecastVisit} from './pickup-contract.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-10';
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {pickLiveArrival,rideBoardArrivals}=await load('planner.ts');
const {journeyArrival,atStopJourneyBoard}=await load('journeyArrival.ts');
const {tripBusIdentity}=await load('tripBusIdentity.ts');
const row=(busName:string,stopId:number,stopsAhead:number,eta:number)=>({busName,routeLabel:'Red',color:'#C62828',stopId,stopsAhead,eta,low:Math.max(0,eta-20),high:eta+80,departNow:eta,lowFloor:Math.max(0,eta-20),estimated:false});
const first=row('307',48,1,20),later=row('307',48,30,1200),dest=row('307',121,10,500),laterDest=row('307',121,39,1800),other=row('309',48,3,300),otherDest=row('309',121,12,800);
const at=1789668000000,checks:any[]=[];
function probe(name:string,visits:any[],walk:number){
 const selected=pickLiveArrival(rideBoardArrivals(visits,48,121),'#307',walk);
 assert.ok(selected);
 const journey=selected.departed?undefined:journeyArrival(selected.boardable,visits,121,walk,60,at);
 const option={busName:selected.match.busName,boardStopId:48,routeLabel:'Red',computedAtMs:at,departed:selected.departed,busEtaSec:selected.match.eta,journeyArrival:journey};
 const contract=pickupContract(option,[{kind:'pick',p:selected}]);
 const result={name,selected,journey,identity:tripBusIdentity(option),contract};checks.push(result);return result;
}
const same=probe('same bus later pickup must remain distinct despite equal bus name',[first,dest,later,laterDest],200);
assert.equal(same.selected.match,first);assert.equal(same.selected.boardable,later);assert.equal(same.contract.relation,'same-bus-later-visit');assert.equal(same.identity.different,false);assert.equal(same.journey.pointMs,at+1860000);
const missingSame=probe('same bus later pickup remains selected with missing destination',[first,later],200);
assert.equal(missingSame.journey,undefined);assert.deepEqual(missingSame.contract.boarding,same.contract.boarding);
const distinct=probe('distinct bus selected while closing bus stays pinned',[first,other,dest,otherDest,later,laterDest],100);
assert.equal(distinct.contract.relation,'different-bus');assert.equal(distinct.identity.ride,'309');
const missing=probe('known distinct boarding survives missing target rows',[first,other,later],100);
assert.equal(missing.journey,undefined);assert.equal(missing.contract.boarding.busName,'309');assert.equal(missing.identity.ride,'307');
const departed=probe('no catchable arrival does not expose fallback as boardable',[first,dest],1000);
assert.equal(departed.contract.status,'unavailable');assert.equal(departed.contract.reason,'departed');
const ordinary=probe('same current visit with normalized planned identity',[first,dest,later,laterDest],0);
assert.equal(ordinary.contract.relation,'same-visit');
const foldFirst=row('307',48,1,20),foldReturn=row('307',48,6,150),foldDest=row('307',121,9,500);
const fold=probe('folded route retains only permitted pickup occurrence',[foldFirst,foldReturn,foldDest],0);
assert.equal(fold.selected.match,foldReturn);assert.equal(fold.contract.boarding.stopsAhead,6);
const unknownFold=probe('missing folded destination remains unknown, not positively rejected',[foldFirst,foldReturn],0);
assert.equal(unknownFold.selected.match,foldFirst);assert.equal(unknownFold.journey,undefined);
assert.equal(atStopJourneyBoard([dest,later,laterDest],'Red','#307',48,121),undefined);
const rawOption={busName:'#307',routeLabel:'Red',boardStopId:48,busEtaSec:0,computedAtMs:at};
const raw=pickupContract(rawOption,[{kind:'journey',available:false}]);
assert.equal(raw.relation,'raw-current');assert.equal(raw.forecastLink,null);assert.equal(raw.boarding.busName,'307');checks.push({name:'raw current without matching forecast cannot borrow next lap',contract:raw});
for(const flags of [{etaUnavailable:true},{departed:true}]){
 const inactive=pickupContract({...rawOption,...flags},[{kind:'pick',p:distinct.selected}]);assert.equal(inactive.status,'unavailable');checks.push({name:'inactive metadata must clear',flags,contract:inactive});
}
assert.equal(pickupContract({busName:'',routeLabel:'Red'},[]).reason,'no-live-selection');checks.push({name:'future or absent live selection carries no forecast visit'});
const advanced=forecastVisit({...first,stopsAhead:0,eta:0},at+5000);
assert.notDeepEqual(advanced,forecastVisit(first,at));checks.push({name:'relative hops are snapshot-local, not a stable visit identifier',before:forecastVisit(first,at),after:advanced});
fs.writeFileSync(O+'/boundaries.json',JSON.stringify({checks,passed:checks.length,scope:'Synthetic contract boundaries executed against unchanged production selector/journey/display helper. No observed incidence or catch guarantees.'},null,2)+'\n');
console.log(`${checks.length} contract boundary cases passed`);
