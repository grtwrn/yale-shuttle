import fs from 'node:fs';
import assert from 'node:assert/strict';
import { traceStopLegs, routeLegMeters, polylineMeters } from '../../services/shuttle-v2/src/network/legs.ts';
import { legSlicesInOrder } from '../../services/shuttle-v2/src/network/alignStops.ts';
const file='research/canonical-windows/results/canonical-topology.json';
const topology=JSON.parse(fs.readFileSync(file,'utf8'));
const stops=new Map(topology.stops.map((s:any)=>[s.id,s]));
const result=[];
for(const route of topology.routes){
 const coords=route.stops.map((id:number)=>stops.get(id));
 let legs=traceStopLegs(route.path,[...coords,coords[0]]);
 if(legs.length===coords.length&&legs.some(l=>l.bridged)){
  const aligned=legSlicesInOrder(route.path,coords);
  if(aligned)legs=aligned.map(slice=>({slice,bridged:false}));
 }
 const metres=routeLegMeters(route.path,coords);
 assert.equal(legs.length,coords.length);
 const entries=legs.map((leg,i)=>{
  if(!leg.bridged)assert(Math.abs(polylineMeters(leg.slice)-metres[i]!)<1e-6);
  else assert.equal(metres[i],null);
  return {...leg,index:i,fromIndex:i,toIndex:(i+1)%coords.length,
   from:coords[i],to:coords[(i+1)%coords.length],metres:metres[i]};
 });
 result.push({...route,legs:entries});
}
fs.mkdirSync('research/canonical-route-context/results',{recursive:true});
fs.writeFileSync('research/canonical-route-context/results/geometry.json',JSON.stringify({stops:topology.stops,routes:result}));
console.log(JSON.stringify({routes:result.length,legs:result.reduce((n,r)=>n+r.legs.length,0),lengthParity:true}));
