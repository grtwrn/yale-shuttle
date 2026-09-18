import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const O=new URL('.',import.meta.url).pathname;
const {build}=await import(process.cwd()+'/node_modules/esbuild/lib/main.js');
const substitutions=[['const [wLow, wHigh] = rawUpper ? [widened[0], high] : widened;','const [wLow, wHigh] = rawUpper ? [low, high] : widened;'],['rawUpper && corrected >= eta ? corrected','rawUpper ? corrected']];
let count=0;
for(const arm of ['baseline','candidate']) await build({entryPoints:[O+'replay.mts'],outfile:O+arm+'.mjs',bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'warning',plugins:arm==='candidate'?[{name:'raw-lower-diagnostic',setup(b){b.onLoad({filter:/\/web\/src\/eta\/arrival\.ts$/},args=>{let src=fs.readFileSync(args.path,'utf8');for(const [before,after] of substitutions){assert.equal(src.split(before).length,2);src=src.replace(before,after);count++;}return {contents:src,loader:'ts'};});}}]:[]});
assert.equal(count,2);fs.writeFileSync(O+'build-provenance.json',JSON.stringify({substitutions,bundles:Object.fromEntries(['baseline','candidate'].map(a=>[a,createHash('sha256').update(fs.readFileSync(O+a+'.mjs')).digest('hex')]))},null,2));
