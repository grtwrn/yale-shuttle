/** Offline component screen. Uses production distribution and lap-factor math. */
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const dir='/home/gwarren/projects/yale-shuttle-watcher/red-window-data';
const mod=async(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/eta/'+p).href);
const {fromQuantiles,residual}=await mod('dist.ts');
const {lapFactor}=await mod('lap.ts');
const {classPools,globalClassPools,poolsWithFallback,stopModel}=await mod('tables.ts');
const input=JSON.parse(fs.readFileSync(dir+'/conditional-hold-input.json','utf8'));
const patch=JSON.parse(fs.readFileSync(dir+'/prior-model-0914.json','utf8'));
const route=patch.dwells['3'];
const pools=poolsWithFallback(classPools(route),globalClassPools(patch.dwells));
const q=(v:number[],p:number)=>{const a=[...v].sort((a,b)=>a-b),i=(a.length-1)*p,l=Math.floor(i);return a[l]!+(a[Math.min(l+1,a.length-1)]!-a[l]!)*(i-l)};
const mean=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length;
const levels=[.1,.5,.9],elapsedClocks=[0,60,180,300,420,600],minTailCount=5;
function score(rs:any[]){
 if(!rs.length)return {n:0};
 return {n:rs.length,dates:new Set(rs.map(r=>r.day)).size,covered:rs.filter(r=>r.low<=r.truth&&r.truth<=r.high).length,
 early:rs.filter(r=>r.truth<r.low).length,late:rs.filter(r=>r.truth>r.high).length,
 maeSec:mean(rs.map(r=>Math.abs(r.point-r.truth))),widthSec:mean(rs.map(r=>r.high-r.low)),
 WIS:mean(rs.map(r=>(.5*Math.abs(r.point-r.truth)+.1*(r.high-r.low+10*Math.max(0,r.low-r.truth)+10*Math.max(0,r.truth-r.high)))/1.5)),
 earlyPoint120:rs.filter(r=>r.point-r.truth>120).length,latePoint120:rs.filter(r=>r.truth-r.point>120).length,
 fallback:rs.filter(r=>r.fallback).length,minTailSupport:Math.min(...rs.map(r=>r.tailSupport??Infinity))};
}
const reports=[];
for(const m of input.models){
 const model=stopModel(route[String(m.stop)],pools),fit=model.lap;
 const factor=(r:any)=>lapFactor(fit,r.lap);
 const validBase=(r:any)=>fit&&r.lap!==null&&r.lap>=.65*fit.m&&r.lap<=1.65*fit.m;
 const validAdd=(r:any)=>r.lap!==null&&r.lap>=.65*m.reference&&r.lap<=1.65*m.reference;
 const center=(r:any)=>Math.max(0,m.coefficients[0]+m.coefficients[1]*(r.lap-m.reference)/600);
 const matchedPrior=m.prior.filter(validBase).map((r:any)=>r.y);
 const matched=fromQuantiles(Array.from({length:10},(_,i)=>q(matchedPrior,(i+.5)/10)));
 const normalPrior=m.prior.filter(validBase).map((r:any)=>r.y/factor(r));
 const normalized=fromQuantiles(Array.from({length:10},(_,i)=>q(normalPrior,(i+.5)/10)));
 const additiveResiduals=m.calibration.filter(validAdd).map((r:any)=>r.y-center(r));
 const records:any[]=[];
 for(const r of m.test){
  const f=factor(r),addCenter=validAdd(r)?center(r):0;
  const addDist=fromQuantiles(m.residualQuantiles.map((v:number)=>Math.max(0,addCenter+v)));
  for(const elapsed of elapsedClocks){
   if(r.y<=elapsed)continue;
   const base=levels.map(u=>f*residual(model.stand,elapsed/f)(u));
   for(const arm of ['current_scaled_marginal','matched_marginal_control','normalized_lap_shape','conditional_additive']){
    let values=base,fallback=false,tailSupport:number|null=null;
    if(arm==='matched_marginal_control'){
     tailSupport=matchedPrior.filter((v:number)=>v*f>elapsed).length;
     fallback=!validBase(r)||tailSupport<minTailCount;
     if(!fallback)values=levels.map(u=>f*residual(matched,elapsed/f)(u));
    }
    if(arm==='normalized_lap_shape'){
     tailSupport=normalPrior.filter((v:number)=>v*f>elapsed).length;
     fallback=!validBase(r)||tailSupport<minTailCount;
     if(!fallback)values=levels.map(u=>f*residual(normalized,elapsed/f)(u));
    }
    if(arm==='conditional_additive'){
     tailSupport=additiveResiduals.filter((v:number)=>addCenter+v>elapsed).length;
     fallback=!validAdd(r)||tailSupport<minTailCount;
     if(!fallback)values=levels.map(u=>residual(addDist,elapsed)(u));
    }
    if(!values.every(Number.isFinite)||values[0]<0||values[0]>values[1]||values[1]>values[2])throw new Error('invalid distribution');
    records.push({id:r.id,day:r.day,bus:r.bus,stop:m.stop,elapsed,arm,lap:r.lap,factor:f,truth:r.y-elapsed,low:values[0],point:values[1],high:values[2],fallback,tailSupport});
   }
  }
 }
 const summaries=elapsedClocks.map(elapsed=>({elapsed,arms:Object.fromEntries(['current_scaled_marginal','matched_marginal_control','normalized_lap_shape','conditional_additive'].map(arm=>[arm,score(records.filter(r=>r.elapsed===elapsed&&r.arm===arm))]))}));
 const byDate=Object.fromEntries([...new Set(m.test.map((r:any)=>r.day))].map(day=>[day,elapsedClocks.map(elapsed=>({elapsed,arms:Object.fromEntries(['current_scaled_marginal','matched_marginal_control','normalized_lap_shape','conditional_additive'].map(arm=>[arm,score(records.filter(r=>r.day===day&&r.elapsed===elapsed&&r.arm===arm))]))}))]));
 reports.push({stop:m.stop,priorTable:route[String(m.stop)],trainN:m.train.length,calibrationN:m.calibration.length,testN:m.test.length,trainLapN:m.trainLapN,calLapN:m.calLapN,normalizedN:normalPrior.length,normalizedQ:Array.from({length:10},(_,i)=>q(normalPrior,(i+.5)/10)),summaries,byDate,records});
}
const output={method:input.method,controlNote:'Matched-marginal control added after inspecting initial scores, solely to distinguish cohort/pass-zero/class-shrinkage effects from normalizing lap variation. Same valid-lap stopped prior rows and same knot math as normalized candidate; no hyperparameters fitted on test.',tailRule:'Prespecified fallback to current scaled marginal when fewer than5 actual calibration/normalization values survive at this elapsed clock; no dropped test visits. Exponential tail uses production dist.ts.',baseline:'Production stopModel class shrinkage + lapFactor + residual distribution reconstructed at prior midnight Sep14; contains no later test labels. Component baseline only: no live state mixture, display floor, bias or widening.',reports};
fs.writeFileSync(dir+'/conditional-hold-screen.json',JSON.stringify(output,null,2)+'\n');
for(const r of reports)console.log(JSON.stringify({stop:r.stop,testN:r.testN,normalizedN:r.normalizedN,summaries:r.summaries},null,2));
