import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {offlineHistoryFit,setOfflineHistoryArm,offlineHistoryAudit} from '../full-pickup/history-release.ts';
const root='/home/gwarren/projects/yale-shuttle-watcher';
const out=root+'/red-rest-history-2026-09-18/own-history';
const app=root+'/overnight-eta-2026-09-17/services/shuttle-v2';
const {releaseDist,releaseResidual}=await import(pathToFileURL(app+'/web/src/eta/release.ts').href);
const fitted=JSON.parse(fs.readFileSync(out+'/fits.json','utf8'));
const fit={stopId:11,referenceLap:fitted.referenceLap,n:160,days:6,coefficients:fitted.fits.primary.lap_elapsed_clock.coefficients};
const rows=['predictions.jsonl','extension-predictions.jsonl'].flatMap(p=>fs.readFileSync(out+'/'+p,'utf8').trim().split('\n').map(JSON.parse)).filter(r=>r.regime==='primary');
const names={core:'lap_elapsed_clock',union:'plus_own_union_age',history:'plus_previous_winchester_hold'} as const;
let checked=0,maxDelta=0;
for(const [arm,field] of Object.entries(names) as [keyof typeof names,string][]){
  setOfflineHistoryArm(arm);
  for(const r of rows){
    const override=offlineHistoryFit(fit,r.pinAt,r.lap??undefined);
    if(!r.lapSupported){if(arm!=='core'&&override!==null)throw Error('Missing unsupported fallback');continue;}
    if(arm==='core'&&override!==undefined)throw Error('Core was overridden');
    const d=releaseDist(override??fit,r.pinAt,r.lap);
    if(!d)throw Error('Supported prediction lost');
    const inv=releaseResidual(d,r.elapsed);
    for(const [i,p] of [.05,.1,.25,.5,.75,.9,.95].entries()){
      const delta=Math.abs(inv(p)-r.predictions[field].q[i]);
      maxDelta=Math.max(maxDelta,delta);checked++;
      if(delta>.001)throw Error(`Hook quantile mismatch ${arm}/${r.id}/${r.elapsed}/${p}/${delta}`);
    }
  }
}
setOfflineHistoryArm('history');
if(offlineHistoryFit(fit,1234567890,3200)!==undefined)throw Error('Unmatched pin did not retain core');
const supported=rows.find(r=>r.lapSupported)!;
for(const lap of [undefined,NaN,1,999999])if(offlineHistoryFit(fit,supported.pinAt,lap)!==null)throw Error('Unsupported lap override');
const folded=offlineHistoryFit(fit,supported.pinAt,supported.lap)!;
if(!folded)throw Error('Missing valid fold');
if(offlineHistoryFit(folded,supported.pinAt,supported.lap)!==undefined)throw Error('Recursion guard failed');
const alternateLap=Math.min(1.64*fit.referenceLap,supported.lap+120);
const alternate=offlineHistoryFit(fit,supported.pinAt,alternateLap);
if(alternate!==folded)throw Error('Fold should not substitute an episode lap or depend on runtime lap');
const d1=releaseDist(folded,supported.pinAt,supported.lap)!;
const d2=releaseDist(folded,supported.pinAt,alternateLap)!;
if(releaseResidual(d1,0)(.5)===releaseResidual(d2,0)(.5))throw Error('Actual runtime lap did not change pricing');
const result={checkedQuantiles:checked,maxDifferenceSec:maxDelta,guards:'unsupported, unmatched, core, recursion, actual runtime lap all passed',audit:offlineHistoryAudit()};
fs.writeFileSync(out+'/hook-check.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checkedQuantiles:checked,maxDifferenceSec:maxDelta,guards:result.guards}));
