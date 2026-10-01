/** Current implementation, frozen historical component inputs; no live server. */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
const root=process.cwd();
const out='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-1';
const archive='/home/gwarren/projects/yale-shuttle-watcher';
const require=createRequire(root+'/package.json');
const Database=require('better-sqlite3');
const load=(f:string)=>JSON.parse(fs.readFileSync(f,'utf8'));
const hash=(f:string)=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const plan=load(out+'/PLAN.json');
const patchPath=archive+'/conditional-replay-data/baseline-patch.json';
const dbPath=archive+'/conditional-replay-data/outcomes.db';
const modules=['src/calibrator/releaseFit.ts','web/src/eta/release.ts','web/src/eta/tables.ts','web/src/eta/lap.ts','web/src/eta/dist.ts'];
const details={createdAtUTC:new Date().toISOString(),baseCommit:plan.baseCommit,releaseEnabled:true,
  fitBefore:plan.fitBefore,marginalTablesBefore:'2026-09-14T04:00:00Z',
  scope:'Current implementation conditional true-rest component with frozen historical fit/tables; not actual published historical forecasts or continuous server replay.',
  Winchester:'fitRelease(loadReleaseObservations(readonly DB,FIT),11,FIT); releaseDist + releaseResidual; absent/out-of-band lap uses actual table fallback.',
  Union:'Actual current marginal stand model buildTables + lapFactor + residual; no experimental Union release hazard.',
  limitation:'Winchester preSep10 coefficients are frozen for chronology-matched exploration; current six-hour fit refresh, tracked mixture and30s arrival pooling are NOT simulated. Marginal patch predates development but includes calibration dates.',
  hashes:Object.fromEntries([patchPath,dbPath,...modules.map(f=>root+'/'+f)].map(f=>[f,hash(f)]))};
if(fs.existsSync(out+'/COMPARATOR_PLAN.json')){
  const old=load(out+'/COMPARATOR_PLAN.json');
  for(const [k,v]of Object.entries(details))if(k!=='createdAtUTC'&&JSON.stringify(v)!==JSON.stringify(old[k]))throw Error('Comparator changed '+k);
}else fs.writeFileSync(out+'/COMPARATOR_PLAN.json',JSON.stringify(details,null,2)+'\n');
const {loadReleaseObservations,fitRelease}=await import(pathToFileURL(root+'/src/calibrator/releaseFit.ts').href);
const {releaseDist,releaseResidual,releaseFitOf}=await import(pathToFileURL(root+'/web/src/eta/release.ts').href);
const {buildTables,globalClassPools}=await import(pathToFileURL(root+'/web/src/eta/tables.ts').href);
const {lapFactor}=await import(pathToFileURL(root+'/web/src/eta/lap.ts').href);
const {residual}=await import(pathToFileURL(root+'/web/src/eta/dist.ts').href);
const db=new Database(dbPath,{readonly:true});
let fit,seq;
try{
 fit=fitRelease(loadReleaseObservations(db,plan.fitBefore),11,plan.fitBefore);
 seq=JSON.parse(db.prepare('SELECT stops_json FROM routes WHERE id=3').get().stops_json);
}finally{db.close();}
if(!releaseFitOf(fit))throw Error('Missing current supported Winchester fit');
const patch=load(patchPath);
const dwells=Object.fromEntries(Object.entries(patch.dwells).map(([rid,ds]:any)=>[rid,Object.fromEntries(Object.entries(ds).map(([sid,v]:any)=>[sid,{n:0,med:0,...v}]))]));
const segments=Object.fromEntries(Object.entries(patch.segments['3']).map(([key,v]:any)=>[key,{n:0,avg:0,...v}]));
const tables=buildTables(seq,{},segments,dwells['3'],undefined,globalClassPools(dwells));
const input=fs.readFileSync(out+'/landmarks.jsonl','utf8').trim().split('\n').map(JSON.parse);
const forecasts=[];
for(const r of input){
 if(r.split!=='development'||r.regime!=='arrival15')continue;
 const model=tables.stops[seq.indexOf(r.stop)];
 const release=r.stop===11?releaseDist(fit,r.pinAt,r.lap??undefined):null;
 const factor=release?1:lapFactor(model.lap,r.lap);
 const inverse=release?releaseResidual(release,r.elapsed):residual(model.stand,Math.round((r.elapsed/factor)/5)*5);
 const q=[.1,.5,.9].map(u=>factor*inverse(u));
 if(q.some(x=>!Number.isFinite(x))||q.some((x,i)=>i&&x<q[i-1]))throw Error('Invalid comparator');
 forecasts.push({id:r.id,stop:r.stop,day:r.day,bus:r.bus,elapsed:r.elapsed,forecastAt:r.forecastAt,
   truthRemaining:r.truthRemaining,landmarkWeight:r.landmarkWeight,q,arm:'current_code_component',
   method:release?'Winchester_release':'marginal_lap_fallback',factor});
}
fs.writeFileSync(out+'/comparator.json',JSON.stringify({fit,forecasts,details},null,2)+'\n');
console.log(JSON.stringify({forecasts:forecasts.length,fit,methods:forecasts.reduce((a:any,r:any)=>(a[r.method]=(a[r.method]??0)+1,a),{})},null,2));
