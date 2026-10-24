import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity,identityHash} from '../reestimate-validation.mjs';

/** Inventory frozen with a native cycle, including shared script dependencies. */
export function learningSourceFiles(service){
 const files=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())walk(file);
  else if(/\.(ts|tsx|mjs|json)$/.test(file)&&!/(\.test\.|__fixtures__)/.test(file))files.push(file);
 }};
 for(const folder of ['src','web/src','scripts/learning-loop'])walk(path.join(service,folder));
 for(const name of ['scripts/reestimate-lib.mjs','scripts/reestimate-validation.mjs','scripts/archive-files.mjs','scripts/canary-metrics.mjs',
  'package.json','package-lock.json','tsconfig.json','web/package.json','web/package-lock.json','web/tsconfig.json'])files.push(path.join(service,name));
 return files;
}

/** Re-enumerate membership as well as bytes; a new source file is a change. */
export function assertLearningSourceUnchanged(service,expected){
 const message='Estimator source changed; restart required to freeze a new cycle';
 let actual;
 try{actual=identityHash(fileIdentity(learningSourceFiles(service)));}
 catch(cause){throw new Error(message,{cause});}
 if(actual!==expected)throw new Error(message);
}
