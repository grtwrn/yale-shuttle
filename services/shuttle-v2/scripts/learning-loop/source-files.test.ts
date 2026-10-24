import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {afterEach,describe,expect,it} from 'vitest';
import {fileIdentity,identityHash} from '../reestimate-validation.mjs';
import {assertLearningSourceUnchanged,learningSourceFiles} from './source-files.mjs';

const service=fileURLToPath(new URL('../..',import.meta.url));
const temporary:string[]=[];
afterEach(()=>{for(const folder of temporary.splice(0))fs.rmSync(folder,{recursive:true,force:true});});
function sandbox(){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'learning-source-'));temporary.push(folder);
 const write=(file:string,text='export const value=1;')=>{const target=path.join(folder,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
 for(const file of ['src/engine.ts','web/src/model.ts','scripts/learning-loop/start.ts',
  'scripts/reestimate-lib.mjs','scripts/reestimate-validation.mjs','scripts/archive-files.mjs',
  'scripts/canary-metrics.mjs','package.json','package-lock.json','tsconfig.json','web/package.json','web/package-lock.json','web/tsconfig.json'])write(file);
 const key=()=>identityHash(fileIdentity(learningSourceFiles(folder)));
 return{folder,write,key};
}

describe('native cycle source inventory',()=>{
 it('covers the complete static relative-import closure of the actual observer entry',()=>{
  const declared=new Set(learningSourceFiles(service)),seen=new Set<string>();
  const resolve=(from:string,specifier:string)=>{
   const base=path.resolve(path.dirname(from),specifier),stem=base.replace(/\.js$/,'');
   const candidates=[base,stem+'.ts',stem+'.tsx',base+'.ts',base+'.tsx',base+'.mjs',base+'.js',base+'.json',path.join(base,'index.ts'),path.join(base,'index.mjs')];
   return candidates.find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
  };
  const visit=(file:string)=>{
   if(seen.has(file))return;seen.add(file);
   if(file.endsWith('.json'))return;
   const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
   const inspect=(node:ts.Node)=>{
    let specifier:string|undefined;
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))specifier=node.moduleSpecifier.text;
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]!))specifier=node.arguments[0]!.text;
    if(specifier?.startsWith('.')){const target=resolve(file,specifier);expect(target,`${file}: ${specifier}`).toBeDefined();visit(target!);}
    ts.forEachChild(node,inspect);
   };
   inspect(source);
  };
  visit(path.join(service,'scripts/learning-loop/start.ts'));
  expect([...seen].filter(file=>!declared.has(file))).toEqual([]);
  expect(seen.has(path.join(service,'scripts/canary-metrics.mjs'))).toBe(true);
 });
 it('refuses a changed shared outcome helper',()=>{
  const s=sandbox(),before=s.key();s.write('scripts/canary-metrics.mjs','export const value=2;');
  expect(()=>assertLearningSourceUnchanged(s.folder,before)).toThrow('Estimator source changed');
 });
 it.each(['added','deleted'])('refuses %s source membership',mode=>{
  const s=sandbox(),before=s.key();
  if(mode==='added')s.write('src/late.ts');else fs.unlinkSync(path.join(s.folder,'src/engine.ts'));
  expect(()=>assertLearningSourceUnchanged(s.folder,before)).toThrow('Estimator source changed');
 });
 it('keeps test and fixture writes outside the executable inventory',()=>{
  const s=sandbox(),before=s.key();s.write('src/example.test.ts');s.write('src/__fixtures__/sample.json','{}');
  expect(()=>assertLearningSourceUnchanged(s.folder,before)).not.toThrow();
 });
 it('refuses a missing shared dependency',()=>{
  const s=sandbox(),before=s.key();fs.unlinkSync(path.join(s.folder,'scripts/canary-metrics.mjs'));
  expect(()=>assertLearningSourceUnchanged(s.folder,before)).toThrow('Estimator source changed');
 });
});
