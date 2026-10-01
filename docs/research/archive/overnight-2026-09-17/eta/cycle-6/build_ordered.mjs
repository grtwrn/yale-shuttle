/** Build one artifact-only browser prototype. Never change worktree source/dist. */
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const service=process.cwd(),O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6';
const {build}=await import(pathToFileURL(service+'/web/node_modules/vite/dist/node/index.js'));
const {needle,replacement}=JSON.parse(await fs.readFile(O+'/ordered-transform.json','utf8'));
let transformed=0;
await build({root:service+'/web',configFile:service+'/web/vite.config.ts',clearScreen:false,
 plugins:[{name:'artifact-only-ordered-journey',enforce:'pre',transform(code,id){
  if(id===service+'/web/src/TransitMap.tsx'){
   assert.equal(code.split(needle).length,2);transformed++;return {code:code.replace(needle,replacement),map:null};
  }
 }}],build:{outDir:O+'/ordered-dist',emptyOutDir:false}});
assert.equal(transformed,1);
console.log(JSON.stringify({transformed,applicationSourceModified:false,outDir:O+'/ordered-dist'}));
