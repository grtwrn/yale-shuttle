/** Exact production pickup formatter on already-frozen labelled forecasts. */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {predictionWindow} from '../../services/shuttle-v2/web/src/arrivalDetails.ts';
const dir=process.argv[2],out=process.argv[3];fs.mkdirSync(out,{recursive:true});
const forecastEqual=(a:any,b:any)=>['eta','low','high'].every(k=>a[k]===b[k]);
function printed(f:any,at:number){
 const window=predictionWindow(f.low,f.high,at,at);
 if(!window)return {basis:'point',text:null,spanSec:null};
 const parts=window.text.replace(/ min$/,'').split('–');
 const low=parts[0]==='<1'?0:Number(parts[0])*60,high=Number(parts.at(-1))*60;
 assert(Number.isFinite(low)&&Number.isFinite(high)&&low<=high);
 return {basis:'window',text:window.text,spanSec:high-low};
}
assert.deepEqual(printed({low:239,high:481},0),{basis:'window',text:'3–9 min',spanSec:360});
assert.deepEqual(printed({low:59,high:60},0),{basis:'window',text:'<1–1 min',spanSec:60});
assert.deepEqual(printed({low:60,high:60},0),{basis:'window',text:'1 min',spanSec:0});
async function main(){
for(const policy of ['highway25','highway50']){
 const rows:any[]=[];
 for await(const line of readline.createInterface({input:fs.createReadStream(`${dir}/${policy}/forecasts.jsonl.gz`).pipe(zlib.createGunzip())})){
  const r=JSON.parse(line);if(![9,10].includes(r.route))continue;
  const raw:any={},protectedValues:any={};
  for(const arm of Object.keys(r.candidates)){raw[arm]=printed(r.rawCandidates[arm],r.at);protectedValues[arm]=printed(r.candidates[arm],r.at);}
  rows.push({key:[r.at,r.bus,r.route,r.target],visit:r.label.id,route:r.route,original:r.originalCohort,
   rawChanged:Object.keys(r.candidates).filter(a=>!forecastEqual(r.rawCandidates[a],r.deployed)),
   protectedChanged:Object.keys(r.candidates).filter(a=>!forecastEqual(r.candidates[a],r.deployed)),
   deployed:printed(r.deployed,r.at),raw,protected:protectedValues});
 }
 fs.writeFileSync(`${out}/${policy}-printed.jsonl.gz`,zlib.gzipSync(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'));
 console.log(JSON.stringify({policy,rows:rows.length,actualProductionFormatter:true}));
}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
