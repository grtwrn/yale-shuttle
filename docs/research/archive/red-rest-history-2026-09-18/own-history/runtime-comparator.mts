/** Unchanged runtime component, fixed chronological fitting; no served state. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const archive='/home/gwarren/projects/yale-shuttle-watcher';
const out=archive+'/red-rest-history-2026-09-18/own-history';
const require=createRequire(root+'/package.json');
const Database=require('better-sqlite3');
const load=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const input=load(out+'/runtime-input.json');
const {loadReleaseObservations,fitRelease}=await import(pathToFileURL(root+'/src/calibrator/releaseFit.ts').href);
const {releaseDist,releaseResidual}=await import(pathToFileURL(root+'/web/src/eta/release.ts').href);
const {buildTables,globalClassPools}=await import(pathToFileURL(root+'/web/src/eta/tables.ts').href);
const {lapFactor}=await import(pathToFileURL(root+'/web/src/eta/lap.ts').href);
const {residual}=await import(pathToFileURL(root+'/web/src/eta/dist.ts').href);
const dbPath=archive+'/release-integration-data/outcomes-complete.db';
const db=new Database(dbPath,{readonly:true});
let rows:any[],seq:number[];
try {
  rows=loadReleaseObservations(db,input.cut).filter((r:any)=>r.stop===11);
  seq=JSON.parse(db.prepare('SELECT stops_json FROM routes WHERE id=3').get().stops_json);
} finally {db.close();}
if(rows.length!==input.training.length)throw Error('Runtime training cohort count mismatch');
for(const r of rows){
  const expected=input.training.find((e:any)=>e.a===r.a);
  if(!expected||r.y!==expected.y||r.lap!==expected.lap||r.day!==expected.day||r.ready>=input.cut)throw Error('Runtime training cohort provenance mismatch');
}
const fit=fitRelease(rows,11,input.cut);
if(!fit)throw Error('Missing fit');
const patchPath=archive+'/conditional-replay-data/baseline-patch.json';
const patch=load(patchPath);
const dwells=Object.fromEntries(Object.entries(patch.dwells).map(([rid,ds]:any)=>[rid,Object.fromEntries(Object.entries(ds).map(([sid,v]:any)=>[sid,{n:0,med:0,...v}]))]));
const segments=Object.fromEntries(Object.entries(patch.segments['3']).map(([key,v]:any)=>[key,{n:0,avg:0,...v}]));
const tables=buildTables(seq,{},segments,dwells['3'],undefined,globalClassPools(dwells));
const model=tables.stops[seq.indexOf(11)];
const forecasts=[];
for(const r of input.records){
  const dist=releaseDist(fit,r.pinAt,r.lap??undefined);
  if(Boolean(dist)!==r.lapSupported)throw Error('Lap support mismatch');
  const factor=dist?1:lapFactor(model.lap,r.lap);
  const inverse=dist?releaseResidual(dist,r.elapsed):residual(model.stand,Math.round((r.elapsed/factor)/5)*5);
  const q=input.probabilities.map((u:number)=>factor*inverse(u));
  let lo=0,hi=1-Number.EPSILON;
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(factor*inverse(mid)<=120)lo=mid;else hi=mid;}
  if(q.some((x:number,i:number)=>!Number.isFinite(x)||(i&&x<q[i-1])))throw Error('Invalid runtime quantiles');
  forecasts.push({...r,q,p120:(lo+hi)/2,method:dist?'release':'marginal_lap_fallback'});
}
const files=['src/calibrator/releaseFit.ts','web/src/eta/release.ts','web/src/eta/tables.ts','web/src/eta/lap.ts','web/src/eta/dist.ts'];
const result={fit,forecasts,trainingParity:rows.length,hashes:Object.fromEntries([dbPath,patchPath,...files.map(f=>root+'/'+f)].map(f=>[f,hash(f)])),
  scope:'Same runtime fitRelease/releaseDist/releaseResidual on exactly the160 preSep14 training holds. Unsupported lap uses actual marginal/lap fallback with preSep14 tables. No live mixture, smoothing, departure recognition, journey endpoints, or six-hour fit refresh is simulated.'};
fs.writeFileSync(out+'/runtime-comparator.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({trainingParity:rows.length,fit,forecasts:forecasts.length,methods:forecasts.reduce((a:any,r:any)=>(a[r.method]=(a[r.method]??0)+1,a),{})},null,2));
