/** Frozen unchanged runtime component, including its real unsupported-lap fallback. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const archive='/home/gwarren/projects/yale-shuttle-watcher';
const out=archive+'/red-bunching-2026-09-18';
const load=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const previousPath=archive+'/red-rest-history-2026-09-18/own-history/runtime-comparator.json';
const previous=load(previousPath);
const fit=previous.fit;
if(fit.n!==160||fit.days!==6||fit.referenceLap!==3231.6625)throw Error('Frozen training metadata changed');
const previousIndex=new Map(previous.forecasts.map((r:any)=>[`${r.id}|${r.elapsed}`,r]));
const {releaseDist,releaseResidual}=await import(pathToFileURL(root+'/web/src/eta/release.ts').href);
const {buildTables,globalClassPools}=await import(pathToFileURL(root+'/web/src/eta/tables.ts').href);
const {lapFactor}=await import(pathToFileURL(root+'/web/src/eta/lap.ts').href);
const {residual}=await import(pathToFileURL(root+'/web/src/eta/dist.ts').href);
const frozen=load(out+'/fits.json');
const seq=frozen.tables.sequence;
const patchPath=archive+'/conditional-replay-data/baseline-patch.json';
const patch=load(patchPath);
const dwells=Object.fromEntries(Object.entries(patch.dwells).map(([rid,ds]:any)=>[rid,Object.fromEntries(Object.entries(ds).map(([sid,v]:any)=>[sid,{n:0,med:0,...v}]))]));
const segments=Object.fromEntries(Object.entries(patch.segments['3']).map(([key,v]:any)=>[key,{n:0,avg:0,...v}]));
const tables=buildTables(seq,{},segments,dwells['3'],undefined,globalClassPools(dwells));
const model=tables.stops[seq.indexOf(11)];
const forecasts=[];let priorMatches=0,maxPriorDifference=0;
for(const filename of ['predictions.jsonl','extension-predictions.jsonl']){
  for(const line of fs.readFileSync(out+'/'+filename,'utf8').trim().split('\n').filter(Boolean)){
    const r=JSON.parse(line);if(r.delay!==15)continue;
    const dist=releaseDist(fit,r.pinAt,r.lap??undefined);
    if(Boolean(dist)!==r.lapSupported)throw Error('Lap support mismatch');
    const factor=dist?1:lapFactor(model.lap,r.lap);
    const inverse=dist?releaseResidual(dist,r.elapsed):residual(model.stand,Math.round((r.elapsed/factor)/5)*5);
    const q=[.05,.1,.25,.5,.75,.9,.95].map(u=>factor*inverse(u));
    let lo=0,hi=1-Number.EPSILON;
    for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(factor*inverse(mid)<=120)lo=mid;else hi=mid;}
    const p120=(lo+hi)/2;
    if(q.some((x:number,i:number)=>!Number.isFinite(x)||(i&&x<q[i-1])))throw Error('Invalid runtime quantiles');
    const old:any=previousIndex.get(`${r.id}|${r.elapsed}`);
    if(old){priorMatches++;maxPriorDifference=Math.max(maxPriorDifference,...q.map((v:number,i:number)=>Math.abs(v-old.q[i])),Math.abs(p120-old.p120));}
    forecasts.push({id:r.id,elapsed:r.elapsed,q,p120,method:dist?'release':'marginal_lap_fallback'});
  }
}
if(priorMatches!==previous.forecasts.length||maxPriorDifference>1e-9)throw Error('Existing component comparison parity failed');
const files=['web/src/eta/release.ts','web/src/eta/tables.ts','web/src/eta/lap.ts','web/src/eta/dist.ts'];
const result={fit,forecasts,priorMatches,maxPriorDifference,hashes:Object.fromEntries([previousPath,patchPath,...files.map(f=>root+'/'+f)].map(f=>[f,hash(f)])),
  scope:'Frozen actual9-feature160-hold runtime fit, unchanged releaseDist/releaseResidual and actual marginal/lap fallback. Fixed historical tables. No continuous state, mixture, route movement, observation availability, or pickup endpoint replay. This separate comparator is not the matched10-feature landmark control.'};
fs.writeFileSync(out+'/runtime-comparator.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({priorMatches,maxPriorDifference,forecasts:forecasts.length},null,2));
