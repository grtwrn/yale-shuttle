/** Reviewer reconstruction of the declared component baseline, with no writes to inputs. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const cwd=process.cwd();
const archive='/home/gwarren/projects/yale-shuttle-watcher';
const folder=archive+'/overnight-2026-09-17/eta';
const load=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const require=createRequire(cwd+'/package.json');
const Database=require('better-sqlite3');
const runtime=async(path:string)=>import(pathToFileURL(cwd+'/'+path).href);
const {fitRelease,loadReleaseObservations}=await runtime('src/calibrator/releaseFit.ts');
const {releaseDist,releaseResidual}=await runtime('web/src/eta/release.ts');
const {residual}=await runtime('web/src/eta/dist.ts');
const {lapFactor}=await runtime('web/src/eta/lap.ts');
const {buildTables,globalClassPools}=await runtime('web/src/eta/tables.ts');
const plan=load(folder+'/cycle-1/PLAN.json');
const saved=load(folder+'/cycle-1/comparator.json');
const db=new Database(archive+'/conditional-replay-data/outcomes.db',{readonly:true});
let fit:any,sequence:number[];
try {
  const observations=loadReleaseObservations(db,plan.fitBefore);
  fit=fitRelease(observations,11,plan.fitBefore);
  sequence=JSON.parse(db.prepare('SELECT stops_json FROM routes WHERE id=3').get().stops_json);
} finally {db.close();}
assert.deepEqual(fit,saved.fit);
const patch=load(archive+'/conditional-replay-data/baseline-patch.json');
const dwells:any={};
for(const [route,stops] of Object.entries(patch.dwells)){
  dwells[route]={};
  for(const [stop,value] of Object.entries(stops as any))dwells[route][stop]={n:0,med:0,...value as any};
}
const segments:any={};
for(const [key,value] of Object.entries(patch.segments['3']))segments[key]={n:0,avg:0,...value as any};
const tables=buildTables(sequence!,{},segments,dwells['3'],undefined,globalClassPools(dwells));
const landmarks=fs.readFileSync(folder+'/cycle-1/landmarks.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
const inputs=new Map(landmarks.filter(r=>r.split==='development'&&r.regime==='arrival15').map(r=>[`${r.id}:${r.elapsed}`,r]));
let maxDifference=0;
const methods:Record<string,number>={};
for(const forecast of saved.forecasts){
  const r:any=inputs.get(`${forecast.id}:${forecast.elapsed}`);
  assert.ok(r);
  assert.equal(forecast.forecastAt,r.forecastAt);
  const model=tables.stops[sequence!.indexOf(r.stop)];
  const release=r.stop===11?releaseDist(fit,r.pinAt,r.lap??undefined):null;
  const factor=release?1:lapFactor(model.lap,r.lap);
  const inverse=release?releaseResidual(release,r.elapsed):residual(model.stand,5*Math.round(r.elapsed/factor/5));
  const q=[.1,.5,.9].map(p=>factor*inverse(p));
  const method=release?'Winchester_release':'marginal_lap_fallback';
  assert.equal(method,forecast.method);
  methods[method]=(methods[method]??0)+1;
  q.forEach((value,i)=>{maxDifference=Math.max(maxDifference,Math.abs(value-forecast.q[i]));assert.ok(Math.abs(value-forecast.q[i])<1e-9);});
}
assert.equal(saved.forecasts.length,722);
const result={forecasts:saved.forecasts.length,maxDifferenceSec:maxDifference,methods,fitMatchesExactly:true,
  scope:'Frozen historical conditional components only. No continuously served ETA or rider endpoint comparison.'};
fs.writeFileSync(folder+'/review-round-1/comparator-check.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
