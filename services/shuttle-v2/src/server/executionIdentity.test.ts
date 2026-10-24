import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {executionTreeHash,productionExecutionIdentity,validProductionExecutionIdentity} from './executionIdentity';

const temporary:string[]=[];
afterEach(()=>{for(const root of temporary.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'production-execution-'));temporary.push(root);
 const write=(name:string,body:string)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
 for(const file of ['src/model.ts','web/src/eta/model.ts','node_modules/library/index.js','drizzle/0001.sql'])write(file,'original');
 for(const file of ['package.json','package-lock.json','tsconfig.json','drizzle.config.ts'])write(file,'{}');
 return {root,write,identity:()=>productionExecutionIdentity(root)};
}
describe('actual production execution provenance',()=>{
 it('binds actual source, installed dependencies, Node binary and runtime settings',()=>{
  const f=fixture(),first=f.identity();expect(validProductionExecutionIdentity(first)).toBe(true);expect(first.runtime.node).toBe(process.version);
  expect(first.nodeBinarySHA256).toMatch(/^[a-f0-9]{64}$/);
  f.write('node_modules/library/index.js','changed without a lockfile change');expect(f.identity().sha256).not.toBe(first.sha256);
  f.write('node_modules/library/index.js','original');f.write('src/model.ts','changed');expect(f.identity().sha256).not.toBe(first.sha256);
 });
 it('keeps static browser assets and generated tooling caches separate',()=>{
  const f=fixture(),first=f.identity();f.write('web/dist/index.html','new UI');f.write('node_modules/.vite/results.json','new cache');
  expect(f.identity().sha256).toBe(first.sha256);
  f.write('web/src/eta/model.ts','changed forecast source');expect(f.identity().sha256).not.toBe(first.sha256);
 });
 it('binds migration and configuration bytes',()=>{
  const f=fixture(),first=f.identity();f.write('drizzle/0001.sql','changed');expect(f.identity().sha256).not.toBe(first.sha256);
  f.write('drizzle/0001.sql','original');f.write('tsconfig.json','{"compilerOptions":{"strict":true}}');expect(f.identity().sha256).not.toBe(first.sha256);
 });
 it('refuses altered checksums and malformed runtime metadata',()=>{
  const f=fixture(),first=f.identity();expect(validProductionExecutionIdentity({...first,dependencyTreeSHA256:'0'.repeat(64)})).toBe(false);
  expect(validProductionExecutionIdentity({...first,runtime:{...first.runtime,versions:'invalid'}})).toBe(false);
 });
 it('does not follow an unretained dependency link outside the package tree',()=>{
  const f=fixture(),g=fixture();fs.symlinkSync(path.join(g.root,'src/model.ts'),path.join(f.root,'node_modules/outside.js'));
  expect(()=>executionTreeHash(path.join(f.root,'node_modules'))).toThrow('leaves its retained tree');
 });
 it('is independent of the checkout directory',()=>{
  const f=fixture(),g=fixture();expect(f.identity().sha256).toBe(g.identity().sha256);
 });
});
