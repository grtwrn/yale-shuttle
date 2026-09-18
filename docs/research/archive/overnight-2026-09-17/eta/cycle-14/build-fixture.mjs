import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const O=new URL('.',import.meta.url).pathname.replace(/\/$/,'');
const {build}=await import(process.cwd()+'/node_modules/esbuild/lib/main.js');
const original='const mean = Math.max(0.5, Math.min(40, meanCells));';
const replacement='const mean = Math.round(Math.max(0.5, Math.min(40, meanCells)) * 10) / 10;';
let count=0;
for(const arm of ['current','canonical']){
 await build({entryPoints:[O+'/fixture.mts'],outfile:O+'/'+arm+'-fixture.mjs',bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'warning',plugins:arm==='canonical'?[{name:'artifact-canonical-kernel',setup(b){b.onLoad({filter:/\/web\/src\/eta\/filter\.ts$/},args=>{const src=fs.readFileSync(args.path,'utf8');assert.equal(src.split(original).length,2);count++;return {contents:src.replace(original,replacement),loader:'ts'};});}}]:[]});
}
assert.equal(count,1);
fs.writeFileSync(O+'/fixture-build-provenance.json',JSON.stringify({original,replacement,substitutions:count,bundles:Object.fromEntries(['current','canonical'].map(a=>[a,createHash('sha256').update(fs.readFileSync(O+'/'+a+'-fixture.mjs')).digest('hex')]))},null,2));
