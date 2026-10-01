import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const O=new URL('.',import.meta.url).pathname;
const {build}=await import(process.cwd()+'/node_modules/esbuild/lib/main.js');
let count=0;
await build({entryPoints:[O+'replay.mts'],outfile:O+'replay.mjs',bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'warning',plugins:[{
 name:'frozen-own-history-experiment',setup(b){b.onLoad({filter:/\/web\/src\/arrivals\.ts$/},args=>{
  let src=fs.readFileSync(args.path,'utf8');
  const before='stopId: row.stopId, stopsAhead: row.stopsAhead, estimated: row.estimated,';
  assert.equal(src.split(before).length,2);
  src=src.replace(before,before+' experimentalOccurrence: row.occurrence,');
  return {contents:src,loader:'ts'};
 });b.onLoad({filter:/\/web\/src\/eta\/release\.ts$/},args=>{
  let src=fs.readFileSync(args.path,'utf8');
  const signature='  lap: number | undefined,\n): Dist | null {\n';
  assert.equal(src.split(signature).length,2);
  src=src.replace(signature,signature+'  const experimentalFit = offlineHistoryFit(fit, pinAt, lap);\n  if (experimentalFit === null) return null;\n  if (experimentalFit !== undefined) fit = experimentalFit;\n');
  src='import {offlineHistoryFit} from '+JSON.stringify(O+'history-release.ts')+';\n'+src;count++;
  return {contents:src,loader:'ts'};
 });}
}]});
assert.equal(count,1);
const files=['PLAN.json','replay.mts','build.mjs','history-release.ts','replay.mjs','raw-today-frames.jsonl','../own-history/fits.json'];
fs.writeFileSync(O+'build-provenance.json',JSON.stringify({appTree:'9d92b802a3ebb4841381a8a78e0f15bb0309422b (identical tree to production95a21c5)',hook:'Fold frozen history covariates into runtime9-feature fit; unmodified runtime release distribution thereafter.',files:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(fs.readFileSync(O+f)).digest('hex')]))},null,2)+'\n');
