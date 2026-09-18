import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4',B=O.replace('/review-round-4','/cycle-4');
const load=(p:string)=>import(pathToFileURL(process.cwd()+p).href),read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const {ServerEta}=await load('/src/server/serverEta.ts');
const {moveKernel}=await load('/web/src/eta/filter.ts');
const seeds=read(O+'/kernel-prefix-seeds.json');
for(const [key,mean] of seeds){assert.equal(key,Math.round(Math.max(.5,Math.min(40,mean))*10));moveKernel(mean);}
const payload=read(B+'/calibration-payload.json'),frames=read(B+'/regression-frames.json');
const server=new ServerEta({routes:['Red']});server.useCheckpoint({load:()=>fs.readFileSync(B+'/regression-warm.v8'),save:()=>{}},frames[0].at);
let matched=0,rows=0;
for(const [i,f] of frames.entries()){
 const wire=server.contribute({...payload,buses:f.buses},i,f.at);assert.equal(server.stats().failures,0);assert.deepEqual(wire,f.expected);matched++;rows+=wire.rows.length;
}
const result={unmodifiedApplicationModules:true,prefixKernelSeeds:seeds.length,frames:matched,exactRowsAndDistributions:rows,restoredBeliefs:server.stats().restored,scope:'Seeds recorded before checkpoint window only; all full wires exactly match original continuous replay. No production fix or portable-cache guarantee.'};
fs.writeFileSync(O+'/native-primed.json',JSON.stringify(result,null,2)+'\n');console.log(result);
