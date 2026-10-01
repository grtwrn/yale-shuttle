import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const priorO='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4',B=priorO.replace('/review-round-4','/cycle-4');
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5';
const load=(p:string)=>import(pathToFileURL(process.cwd()+p).href),read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const {ServerEta}=await load('/src/server/serverEta.ts');
const {moveKernel}=await load('/web/src/eta/filter.ts');
const seeds=read(priorO+'/kernel-prefix-seeds.json');
for(const [key,mean] of seeds){assert.equal(key,Math.round(Math.max(.5,Math.min(40,mean))*10));moveKernel(mean);}
const payload=read(B+'/calibration-payload.json'),frames=read(B+'/regression-frames.json');
const server=new ServerEta({routes:['Red']});server.useCheckpoint({load:()=>fs.readFileSync(B+'/regression-warm.v8'),save:()=>{}},frames[0].at);
let matched=0,rows=0,zeros=0,differences=0;
const expected=new Map(JSON.parse(fs.readFileSync(B+'/regression-frames.json','utf8')).map((f:any)=>[f.at,f.expected]));
for(const [i,f] of frames.entries()){
 const wire=server.contribute({...payload,buses:f.buses},i,f.at);assert.equal(server.stats().failures,0);assert.ok(wire); assert.equal(wire.at,f.at); for(const [ri,r] of wire.rows.entries()){ if(r[5]===0){assert.deepEqual(r.slice(2,5),[0,0,0]);assert.deepEqual(wire.distributions[ri],Array(50).fill(0));zeros++;}} differences+=JSON.stringify(wire)!==JSON.stringify(f.expected)?1:0; matched++;rows+=wire.rows.length;
}
const result={unmodifiedApplicationModules:true,prefixKernelSeeds:seeds.length,frames:matched,transportRows:rows,exactZeroRows:zeros,framesDifferentFromLegacy: differences,restoredBeliefs:server.stats().restored,scope:'Load unchanged legacy checkpoint and prime only pre-window cache history; verify all emitted zero-hop rows remain exact zero. Legacy full wires intentionally differ where the defect is repaired. No cold-cache parity claim.'};
fs.writeFileSync(O+'/legacy-checkpoint.json',JSON.stringify(result,null,2)+'\n');console.log(result);
