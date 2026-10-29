import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { deserialize } from 'node:v8';
import { ServerEta } from '../../../services/shuttle-v2/src/server/serverEta';
import { ROUTE_LISTS } from '../../../services/shuttle-v2/web/src/routes';
const here=path.dirname(new URL(import.meta.url).pathname);
const fixtureBytes=fs.readFileSync(path.join(here,'purple-portable.json.gz'));
const fixture=JSON.parse(gunzipSync(fixtureBytes).toString());
const reference=JSON.parse(fs.readFileSync(path.join(here,'native-reference.json'),'utf8'));
const engine=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label),onServedForecasts:()=>{}});
if(!engine.restoreEvaluation(Buffer.from(fixture.seed.history.data,'base64'),'history',fixture.seed.responseAt,120000))throw Error('Common-past restore refused');
const normalized=(wire:any)=>(wire?.rows??[]).flatMap((r:any,i:number)=>{const b=wire.buses[r[0]];return b[0]==='321'&&b[1]==='Purple'?[[`${b[1]}|${b[0]}|${r[1]}|${r[5]}`,{row:r.slice(1),distribution:wire.distributions?.[i]??null,bus:b}]]:[];}).sort((a:any,b:any)=>a[0].localeCompare(b[0]));
const mismatches:any[]=[];let matched=0,nativeComparison:any=null;
const started=performance.now();
for(const frame of fixture.frames){
 const table=fixture.tables[frame.table];
 if(!engine.useEvaluationContext(frame.context))throw Error('Context refused');
 const wire=engine.contribute({...table,buses:frame.buses},frame.at,frame.at,true),actual=normalized(wire);
 if(JSON.stringify(actual)!==JSON.stringify(frame.expected)){
  if(mismatches.length<64)mismatches.push({seq:frame.seq,at:frame.at,frameSHA256:frame.sha256,actual,expected:frame.expected});
 }else matched++;
 if(frame.seq===32830){
  const bytes=engine.captureEvaluation('runtime')!.bytes,saved=deserialize(bytes),entry=saved.store.get('Purple|#321');
  const p=entry.belief.p;let maximumProbabilityDelta=0,differentCells=0;
  for(let i=0;i<p.length;i++){const delta=Math.abs(p[i]-reference.probabilities[i]);maximumProbabilityDelta=Math.max(maximumProbabilityDelta,delta);if(delta)differentCells++;}
  nativeComparison={maximumProbabilityDelta,differentCells};
  fs.writeFileSync(path.join(here,'before-32830.v8.gz'),gzipSync(bytes));
 }
}
const result={at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,
 scope:fixture.scope,fixtureSHA256:createHash('sha256').update(fixtureBytes).digest('hex'),frames:fixture.frames.length,
 matched,mismatches,nativeComparison,elapsedMs:performance.now()-started};
fs.writeFileSync(path.join(here,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,mismatches:mismatches.map(m=>({seq:m.seq,at:m.at,frameSHA256:m.frameSHA256}))}));
process.exitCode=mismatches.length?1:0;
