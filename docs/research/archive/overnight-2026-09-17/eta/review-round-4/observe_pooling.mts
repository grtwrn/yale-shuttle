import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import * as observer from '../cycle-4/pool-observer.generated.mts';
const out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-4';
const load=(p:string)=>import(pathToFileURL(process.cwd()+p).href);
const {ServerEta}=await load('/src/server/serverEta.ts');
const {setSampledFutureLap}=await load('/web/src/eta/arrival.ts');
const {setReleaseModelEnabled}=await load('/web/src/eta/release.ts');
setSampledFutureLap(true);setReleaseModelEnabled(true);
const {anchorKeyFor}=await load('/web/src/liveAnchor.ts');
const payload=JSON.parse(fs.readFileSync(out+'/calibration-payload.json','utf8'));
const frames=JSON.parse(fs.readFileSync(out+'/regression-frames.json','utf8'));
const server:any=new ServerEta({routes:['Red']});server.useCheckpoint({load:()=>fs.readFileSync(out+'/regression-warm.v8'),save:()=>{}},frames[0].at);
let parity=0,zeroRaw=0,badPool=0,fixtureMaxDifference=0,fixtureDifferentRows=0;const records:any[]=[];
for(const [i,f] of frames.entries()){
 const wire=server.contribute({...payload,buses:f.buses},i,f.at);
 if(JSON.stringify(wire.buses)!==JSON.stringify(f.expected.buses))throw Error('Tracking differs');
 const expectedRows=new Map(f.expected.rows.map((r:any)=>[`${r[0]}|${r[1]}|${r[5]}`,r]));
 if(wire.rows.length!==f.expected.rows.length)throw Error('Availability differs');
 for(const r of wire.rows){const old:any=expectedRows.get(`${r[0]}|${r[1]}|${r[5]}`);if(!old)throw Error('Occurrence differs');let difference=0;for(const k of [2,3,4,7,8])difference=Math.max(difference,Math.abs(r[k]-old[k]));fixtureMaxDifference=Math.max(fixtureMaxDifference,difference);fixtureDifferentRows+=difference>0?1:0;}

 const bus=f.buses.find((b:any)=>b.bus_name==='#309'),stops=payload.routes['3'];
 const ring=observer.ringForBus(bus,stops,payload.stop_coords)!;
 const result=observer.arrivalsForBus(structuredClone(server.store),anchorKeyFor('Red',bus.bus_name),bus,ring,stops,payload.stop_coords,payload.segments['3'],payload.dwells['3'],new Set([11,48,4]),f.at,undefined,payload.dwells,true);
 const bi=wire.buses.findIndex((b:any)=>b[0]==='309');
 for(const row of result){const w=wire.rows.find((r:any)=>r[0]===bi&&r[1]===row.stopId&&r[5]===row.stopsAhead);if(!w||Math.round(row.eta)!==w[2]||Math.round(row.low)!==w[3]||Math.round(row.high)!==w[4])throw Error('Observer parity');parity++;}
 for(const raw of observer.observedRaw.filter(r=>r.stopId===11)){
  const pooled=result.find(r=>r.stopId===raw.stopId&&r.occurrence===raw.occurrence)!;
  if(raw.stopsAhead===0){if(raw.eta!==0||raw.low!==0||raw.high!==0||raw.distribution.some((v:number)=>v!==0))throw Error('Raw not zero');zeroRaw++;badPool+=pooled.eta>0?1:0;}
  records.push({at:f.at,raw,pooled});
 }
}
const meta={frames:frames.length,fixtureMaxDifference,fixtureDifferentRows,parityRows:parity,rawZeroRows:zeroRaw,positivePooledZeroRows:badPool,proof:'Raw zero current-stop rows become positive only in current production pooling. Observer matches same-process wire; cross-process fixture deviations separately reported. Future occurrence rows retained for follow-up.'};
fs.writeFileSync('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4/pool-observer.json',JSON.stringify({meta,records},null,2)+'\n');console.log(JSON.stringify(meta));
