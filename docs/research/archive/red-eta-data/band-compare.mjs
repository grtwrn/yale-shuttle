import fs from 'node:fs';
import {conformalFactor} from '../red-eta-2026-09-16/services/shuttle-v2/web/src/eta/conformal.mjs';
const root=new URL('./',import.meta.url);
const params=JSON.parse(fs.readFileSync(new URL('params.json',root))).params.CONFORMAL;
const groups={};
for(const line of fs.readFileSync(new URL('gps/pairs.jsonl',root),'utf8').trim().split('\n')){
 const p=JSON.parse(line);if(p.eta<=0||p.eta>1800)continue;
 const h=p.eta<120?'0-2':p.eta<300?'2-5':p.eta<600?'5-10':'10-30';
 for(const truth of ['det','prox']){
  if(p[truth]==null||p[truth]<0)continue;
  for(const route of [String(p.r),'all'])for(const arm of ['baseline','candidate']){
   const f=arm==='baseline'?params[h]:conformalFactor(p.eta,params);
   const low=Math.max(0,p.eta-(p.eta-p.low)*f),high=p.eta+(p.high-p.eta)*f;
   const key=`${truth}/${route}/${arm}`, g=groups[key]??={n:0,inside:0,widths:[]};g.n++;g.inside+=p[truth]>=low&&p[truth]<=high;g.widths.push(high-low);
  }
 }
}
const out={};for(const [key,g] of Object.entries(groups)){g.widths.sort((a,b)=>a-b);out[key]={n:g.n,coveragePct:Math.round(g.inside/g.n*1000)/10,medianWidthSec:Math.round(g.widths[g.n>>1]*10)/10};}
fs.writeFileSync(new URL('band-compare.json',root),JSON.stringify(out,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k])=>/\/(all|3)\//.test(k))),null,2));
