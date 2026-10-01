import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {reprice as before} from './shell-base.generated.mts';
import {reprice as after} from './shell-candidate.generated.mts';
import {pathToFileURL} from 'node:url';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-7';
const B=O.replace('review-round-7','cycle-5/traversal-guard');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');const {isBusInService}=await load('schedule.ts');const {compareDeadline}=await load('arriveBy.ts');
const payload=read(B+'/calibration-payload.json');
const frame=gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(JSON.parse).find(f=>f.at===1789561481036);
const sample=fs.readFileSync(B+'/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse).find(r=>r.at===frame.at&&r.session==='57454:48:0');
for(const [i,row] of frame.server_eta.rows.entries()) if(frame.server_eta.buses[row[0]][0]==='309'&&row[1]===121&&row[5]===1){
 row[2]=200;row[3]=150;row[4]=300;row[7]=200;row[8]=150;frame.server_eta.distributions[i]=Array.from({length:50},(_,k)=>150+k*150/49);
}
const real=Date.now;Date.now=()=>frame.at;
try{
 const buses=frame.buses.filter((b:any)=>isBusInService(b,frame.at));assert.ok(attachServerEta(buses,frame.server_eta,frame.at));
 const from={...sample.from,lat:sample.from.lat+100*1.1/6371000*180/Math.PI};
 const stable=sample.stable.map((o:any)=>o.mode==='shuttle'?{...o,walkToSec:100}:o);
 const base=before(stable,buses,payload,from,sample.to).options.find((o:any)=>o.mode==='shuttle');
 const head=after(stable,buses,payload,from,sample.to).options.find((o:any)=>o.mode==='shuttle');
 const deadline=(option:any)=>compareDeadline([option],frame.at+90*60_000,5,frame.at,frame.at,false);
 assert.equal(base.journeyArrival,undefined);assert.equal(deadline(base).shuttle.status,'unknown');
 assert.equal(head.busEtaSec,0);assert.equal(head.walkToSec,100);assert.equal(head.journeyArrival.catchRisk,false);
 assert.equal(deadline(head).shuttle.status,'fits');assert.equal(deadline(head).shuttle.caution,undefined);
 assert.equal(deadline(head).recommendation.option.busName,'309');
 fs.writeFileSync(O+'/risk-logic.json',JSON.stringify({base,head,before:deadline(base),after:deadline(head),scope:'Synthetic valid pickup timing boundary over a recorded current state; exact-base numerical shell versus exact-head numerical shell.'},null,2)+'\n');
 console.log('Confirmed exact-base unknown -> exact-head un-cautioned fits and shuttle recommendation at 100-second walk / raw at-stop / 150-second pickup lower bound.');
}finally{Date.now=real;}
