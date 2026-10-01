import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const O=path.dirname(new URL(import.meta.url).pathname),service=process.cwd();
const require=createRequire(service+'/package.json'),ts=require('typescript');
const manifest=JSON.parse(fs.readFileSync(O+'/overlay.json','utf8'));
const contents=new Map(Object.entries(manifest).map(([file,v])=>{
 const source=fs.readFileSync(v.artifact,'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),v.sha256);return [file,source];
}));
const report={typechecks:[],loaded:[],built:false};
for(const config of [service+'/tsconfig.json',service+'/web/tsconfig.json']){
 const parsed=ts.getParsedCommandLineOfConfigFile(config,{noEmit:true},{...ts.sys,onUnRecoverableConfigFileDiagnostic:d=>{throw Error(ts.flattenDiagnosticMessageText(d.messageText,'\n'));}});
 assert.ok(parsed);assert.equal(parsed.errors.length,0);
 const host=ts.createCompilerHost(parsed.options),readFile=host.readFile.bind(host),fileExists=host.fileExists.bind(host);
 host.readFile=p=>contents.has(path.resolve(p))?contents.get(path.resolve(p)):readFile(p);
 host.fileExists=p=>contents.has(path.resolve(p))||fileExists(p);
 const program=ts.createProgram(parsed.fileNames,parsed.options,host);
 const diagnostics=ts.getPreEmitDiagnostics(program);
 if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>service,getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));process.exitCode=1;break;}
 // The backend does not import the planner. The frontend must see all overlays.
 if(config===service+'/web/tsconfig.json')for(const [file,source] of contents){
  assert.equal(program.getSourceFile(file)?.text,source,file);
 }
 report.typechecks.push({config,diagnostics:0,sourceFiles:program.getSourceFiles().length});
 console.log('Passed virtual typecheck: '+config);
}
if(!process.exitCode){
 const vite=await import(pathToFileURL(service+'/web/node_modules/vite/dist/node/index.js').href);
 await vite.build({root:service+'/web',configFile:service+'/web/vite.config.ts',plugins:[{
  name:'eta-artifact-overlay',enforce:'pre',
  resolveId(id,importer){if(id==='./livePickupSelection'&&importer?.startsWith(service+'/web/src/'))return service+'/web/src/livePickupSelection.ts';},
  load(id){if(contents.has(id)){report.loaded.push(id);return contents.get(id);}}
 }],build:{outDir:O+'/dist',emptyOutDir:true,sourcemap:true}});
 assert.deepEqual([...new Set(report.loaded)].sort(),[...contents.keys()].sort());report.built=true;
}
fs.writeFileSync(O+'/overlay-verification.json',JSON.stringify(report,null,2)+'\n');
