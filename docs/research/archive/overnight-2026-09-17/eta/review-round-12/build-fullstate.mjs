import fs from 'node:fs';
import assert from 'node:assert/strict';
const {build}=await import(process.cwd()+'/node_modules/esbuild/lib/main.js');
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12';
let count=0;
await build({entryPoints:[O+'/fullstate.mts'],outfile:O+'/fullstate.mjs',bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'warning',plugins:[{name:'canonical-only',setup(b){b.onLoad({filter:/\/web\/src\/eta\/filter\.ts$/},args=>{
 const src=fs.readFileSync(args.path,'utf8'),before='const mean = Math.max(0.5, Math.min(40, meanCells));';
 assert.equal(src.split(before).length,2);count++;
 return {contents:src.replace(before,'const mean = Math.round(Math.max(0.5, Math.min(40, meanCells)) * 10) / 10;'),loader:'ts'};
});}}]});
assert.equal(count,1);
