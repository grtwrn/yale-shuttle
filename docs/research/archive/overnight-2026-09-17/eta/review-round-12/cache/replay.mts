import fs from 'node:fs';
import assert from 'node:assert/strict';
import {serialize} from 'node:v8';
import {gzipSync,gunzipSync} from 'node:zlib';
import {ServerEta} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/src/server/serverEta.ts';
import {moveKernel} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/filter.ts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12/cache';
const P="/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-4";
const [arm,mode]=process.argv.slice(2);assert.ok(['current','canonical'].includes(arm));assert.ok(['warm','cold','kernel-low','kernel-high'].includes(mode));
if(mode.startsWith('kernel')){
 const a=mode==='kernel-low'?1.951:2.049,b=mode==='kernel-low'?2.049:1.951;
 const ka=Array.from(moveKernel(a)),kb=Array.from(moveKernel(b));
 fs.writeFileSync(`${O}/${arm}-${mode}.json`,JSON.stringify({first:a,second:b,firstKernel:ka,secondKernel:kb}));
}else{
 const payload=JSON.parse(fs.readFileSync(P+'/calibration-payload.json','utf8'));
 const old=JSON.parse(fs.readFileSync(P+'/regression-frames.json','utf8'));
 const start=old[0].at,end=old.at(-1).at;
 let server:any=new ServerEta({routes:['Red']}),frames=0,prior=0,bytes:Buffer|undefined;
 const out:any[]=[];let expected:any[]=[];
 if(mode==='cold'){
  bytes=fs.readFileSync(`${O}/${arm}-warm.v8`);
  server.useCheckpoint({load:()=>bytes,save:()=>{}},start);
  assert.equal(server.stats().restored,3);
  expected=JSON.parse(gunzipSync(fs.readFileSync(`${O}/${arm}-warm.json.gz`)).toString());
 }
 const input=mode==='warm'?fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n').map(l=>{const f=JSON.parse(l);return {...f,at:Date.parse(f.at)};}):old;
 for(const f of input){
  if(f.at>end)break;
  if(f.at===prior)continue;
  if(mode==='warm'&&(!prior||f.at-prior>60000))server=new ServerEta({routes:['Red']});
  if(mode==='warm'&&f.at>=start&&!bytes){bytes=serialize({v:1,at:prior,store:server.store,seen:server.seenAt});fs.writeFileSync(`${O}/${arm}-warm.v8`,bytes);}
  const wire=server.contribute({...payload,buses:f.buses},frames,f.at);
  assert.equal(server.stats().failures,0);
  if(f.at>=start)out.push({at:f.at,buses:f.buses,wire,beliefs:[...server.store].map(([key,e]:any)=>[key,{...e.belief,p:Array.from(e.belief.p)}])});
  frames++;prior=f.at;
 }
 assert.equal(out.length,78);
 let sameProcessMatches:number|null=null;
 if(mode==='warm'){
  const restored:any=new ServerEta({routes:['Red']});restored.useCheckpoint({load:()=>bytes,save:()=>{}},start);sameProcessMatches=0;
  for(const[i,f]of out.entries()){
   const got=restored.contribute({...payload,buses:f.buses},i,f.at);
   assert.deepEqual(got,f.wire);sameProcessMatches++;
  }
 }
 fs.writeFileSync(`${O}/${arm}-${mode}.json.gz`,gzipSync(JSON.stringify(out)));
 const meta={arm,mode,frames,window:out.length,sameProcessMatches,restored:mode==='cold'?server.stats().restored:null};
 fs.writeFileSync(`${O}/${arm}-${mode}-meta.json`,JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
}
