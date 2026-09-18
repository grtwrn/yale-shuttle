import fs from 'node:fs';import {pathToFileURL}from'node:url';
const {loadNet}=await import(pathToFileURL(process.cwd()+'/scripts/eta-replay/common.ts').href);const net=loadNet(),O=new URL('.',import.meta.url).pathname;
const output=[...net.network.routes].map(([id,r]:any)=>({id,label:r.shortName,name:r.name,publishedStops:net.routeById.get(id)?.stops,repairedStops:r.stops,repeatedStopIds:r.stops.filter((s:number,i:number)=>r.stops.indexOf(s)!==i),changed:JSON.stringify(r.stops)!==JSON.stringify(net.routeById.get(id)?.stops)}));
fs.writeFileSync(O+'all-route-topology.json',JSON.stringify(output,null,2));net.db.close();console.log(JSON.stringify(output.map((r:any)=>({id:r.id,count:r.repairedStops.length,repeats:r.repeatedStopIds,changed:r.changed}))));
