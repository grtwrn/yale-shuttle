import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { validateEnvelope, assertNotDowngrade } from './standing-forecast-remote.mjs';
import { STANDING_ALGORITHM, STANDING_FIT_POLICY } from '../src/calibrator/standingForecast.ts';
import { standingDayBounds, standingDayOf } from '../src/calibrator/standingForecastData.ts';

const root=resolve(new URL('../',import.meta.url).pathname), now=Date.now(), [day]=standingDayBounds(now);
const temporary=[];
afterEach(()=>{for(const dir of temporary.splice(0))rmSync(dir,{recursive:true,force:true});});
const identity={algorithm:STANDING_ALGORITHM,policy:STANDING_FIT_POLICY};
const fixture=()=>({ ...identity, fit:{version:'analytic-phase-stack-v2',fittedAt:now-1000,options:{weightObjective:'remaining'},
  cells:{test:{weight:0,samples:[10,20],q:[10,20],n:2,pStop:1,stopCount:2,visitCount:2,phase:null}}},
  request:{cutoff:now-1000,observedAt:now-1000,serviceDayCutoff:day,maximumRows:20000,lookbackDays:30,serviceDaysPerRoute:2,from:day-30*86400000},
  diagnostics:{cutoff:now-1000,serviceDayCutoff:day,trainingRows:2,trainingDates:[{routeId:1,day:standingDayOf(day-1),from:day-86400000,until:day}]}});
test('causal envelope accepts current-day fit and rejects fingerprint/policy/future/day corruption',()=>{
  validateEnvelope(fixture(),identity,day,now);
  for(const mutate of [v=>v.algorithm='old',v=>v.policy={...v.policy,maximumRows:100},v=>v.fit.fittedAt=now+1,v=>v.request.serviceDayCutoff=day-86400000]){
    const v=fixture();mutate(v);assert.throws(()=>validateEnvelope(v,identity,day,now));
  }
});
test('cache publication refuses newer fit and conflicting equal-cutoff statistics',()=>{
  const v=fixture();assert.throws(()=>assertNotDowngrade({fitted_at:now,model:'{}'},v));
  assert.throws(()=>assertNotDowngrade({fitted_at:v.fit.fittedAt,algorithm:v.algorithm,model:'{}'},v));
  assertNotDowngrade({fitted_at:v.fit.fittedAt,algorithm:v.algorithm,model:JSON.stringify(v.fit)},v);
});
test('offloaded source or dependency drift is rejected inside atomic-install helper',()=>{
  const id={...identity,sourceHashes:{a:'hash'},dependencies:{sqlite:'1'}};
  const v={...fixture(),offloadProvenance:{sourceHashes:{a:'hash'},dependencies:{sqlite:'1'}}};
  validateEnvelope(v,id,day,now);
  assert.throws(()=>validateEnvelope(v,{...id,sourceHashes:{a:'different'}},day,now));
  assert.throws(()=>validateEnvelope(v,{...id,dependencies:{sqlite:'2'}},day,now));
});
test('real cache loader and atomic install preserve rollback row; changed cache cannot be rolled back',()=>{
  const dir=mkdtempSync(join(tmpdir(),'standing-remote-test-'));temporary.push(dir);
  const dbPath=join(dir,'state.db'),input=join(dir,'fit.json'),receipt=join(dir,'receipt.json');
  const db=new Database(dbPath);
  db.exec('CREATE TABLE standing_forecast_models(id INTEGER PRIMARY KEY,algorithm TEXT,fitted_at INTEGER,created_at INTEGER,model TEXT,diagnostics TEXT)');
  const old={...fixture(),fit:{...fixture().fit,fittedAt:now-2000}};
  db.prepare('INSERT INTO standing_forecast_models VALUES(1,?,?,?,?,?)').run(old.algorithm,old.fit.fittedAt,now,JSON.stringify(old.fit),JSON.stringify(old.diagnostics));
  const v=fixture();writeFileSync(input,JSON.stringify(v));
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  const run=(action,file,out,checksum=hash(file))=>spawnSync(process.execPath,['--import','tsx','scripts/standing-forecast-remote.mjs',action,'--root',root,'--db',dbPath,'--input',file,'--sha',checksum,'--receipt',out],{cwd:root,encoding:'utf8'});
  assert.equal(run('validate',input,join(dir,'unused-receipt.json')).status,0);
  assert.equal(db.prepare('SELECT fitted_at FROM standing_forecast_models').get().fitted_at,old.fit.fittedAt);
  assert.notEqual(run('install',input,receipt,'bad').status,0);
  assert.equal(db.prepare('SELECT fitted_at FROM standing_forecast_models').get().fitted_at,old.fit.fittedAt);
  let r=run('install',input,receipt);assert.equal(r.status,0,r.stderr);
  assert.equal(db.prepare('SELECT fitted_at FROM standing_forecast_models').get().fitted_at,v.fit.fittedAt);
  assert.equal(JSON.parse(readFileSync(receipt)).previous.fitted_at,old.fit.fittedAt);
  r=run('restore',receipt,join(dir,'restored.json'));assert.equal(r.status,0,r.stderr);
  assert.equal(db.prepare('SELECT fitted_at FROM standing_forecast_models').get().fitted_at,old.fit.fittedAt);
  assert.notEqual(run('restore',receipt,join(dir,'stale-restore.json')).status,0);
  const invalid=fixture();invalid.fit.cells.test.weight=2;writeFileSync(input,JSON.stringify(invalid));
  assert.notEqual(run('install',input,join(dir,'invalid.json')).status,0);
  assert.equal(db.prepare('SELECT fitted_at FROM standing_forecast_models').get().fitted_at,old.fit.fittedAt);
  db.close();
},20000);
