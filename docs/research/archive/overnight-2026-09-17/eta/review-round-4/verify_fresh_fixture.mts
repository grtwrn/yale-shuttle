import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

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


}
const meta={frames:frames.length,fixtureMaxDifference,fixtureDifferentRows,trackingAndOccurrenceAvailabilityMatch:true,exactForecastMatch:fixtureMaxDifference===0,scope:'Fresh-process checkpoint replay WITHOUT observer. Quantitative paired candidate scoring requires resolving divergence or replaying the continuous prefix.'};
fs.writeFileSync('/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4/fresh-fixture-check.json',JSON.stringify({meta,records},null,2)+'\n');console.log(JSON.stringify(meta));
