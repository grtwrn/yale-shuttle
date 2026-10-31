import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function syncFile(file){
 const handle=await fs.open(file,'r');
 try{await handle.sync();}finally{await handle.close();}
}
export async function syncDirectories(directories){
 for(const directory of [...new Set(directories)].sort((a,b)=>b.length-a.length)){
  const handle=await fs.open(directory,'r');
  try{await handle.sync();}finally{await handle.close();}
 }
}
export function parentDirectories(files,root){
 const directories=new Set([root,path.dirname(root)]);
 for(const file of files)for(let p=path.dirname(file);p===root||p.startsWith(root+path.sep);p=path.dirname(p))directories.add(p);
 return [...directories];
}
/** Publish a new, synced control record. Existing custody receipts are never
 * overwritten. A sync failure refuses subsequent destructive work. */
export async function durableJson(file,value){
 const raw=Buffer.from(JSON.stringify(value,null,2)+'\n'),temporary=file+'.'+randomUUID()+'.partial';
 const handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
 await fs.link(temporary,file);
 await fs.unlink(temporary);
 await syncDirectories([path.dirname(file),path.dirname(path.dirname(file))]);
 return raw;
}
