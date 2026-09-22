/** Actual application pickup window formatting, all routes and fixed arms. */
import fs from 'node:fs';import zlib from 'node:zlib';import readline from 'node:readline';
import {once} from 'node:events';import {finished} from 'node:stream/promises';import assert from 'node:assert/strict';
import {predictionWindow} from '../../services/shuttle-v2/web/src/arrivalDetails.ts';
function printed(f:any,at:number){
 const w=predictionWindow(f.low,f.high,at,at);if(!w)return{basis:'point',text:null,spanSec:null};
 const parts=w.text.replace(/ min$/,'').split('–');const low=parts[0]==='<1'?0:Number(parts[0])*60,high=Number(parts.at(-1))*60;
 assert(Number.isFinite(low)&&Number.isFinite(high)&&low<=high);return{basis:'window',text:w.text,spanSec:high-low};
}
async function main(){
 const dir=process.argv[2];const zip=zlib.createGzip(),file=fs.createWriteStream(dir+'/printed.jsonl.gz');zip.pipe(file);let count=0;
 for await(const line of readline.createInterface({input:fs.createReadStream(dir+'/forecasts.jsonl.gz').pipe(zlib.createGunzip())})){
  const r=JSON.parse(line);const record={key:[r.at,r.bus,r.route,r.target],deployed:printed(r.deployed,r.at),
   candidates:Object.fromEntries(Object.entries(r.candidates).map(([arm,f])=>[arm,printed(f,r.at)]))};
  if(!zip.write(JSON.stringify(record)+'\n'))await once(zip,'drain');count++;
 }
 zip.end();await finished(file);console.log(JSON.stringify({actualFormatter:true,rows:count}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
