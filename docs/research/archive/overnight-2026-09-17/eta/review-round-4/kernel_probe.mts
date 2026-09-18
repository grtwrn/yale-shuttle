import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ServerEta} from './kernel-src-server-serverEta.mts';
import {kernelCache,kernelSeeds,moveKernel} from './kernel-web-src-eta-filter.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-4';
const B=O.replace('/review-round-4','/cycle-4');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const payload=read(B+'/calibration-payload.json'),frames=read(B+'/regression-frames.json');
const mode=process.argv[2];
// Minimal call-order property: different means in the same bucket yield the first cached kernel.
const a=Array.from(moveKernel(1.01));kernelCache.clear();const b=Array.from(moveKernel(1.04));
assert.notDeepEqual(a,b);assert.deepEqual(Array.from(moveKernel(1.01)),b);kernelCache.clear();kernelSeeds.clear();
if(mode==='prefix'){
 const s:any=new ServerEta({routes:['Red']}); let n=0,matched=0,last=0;
 const raw=fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n');
 for(const l of raw){const f=JSON.parse(l),at=Date.parse(f.at);if(at>frames.at(-1).at)break;if(at===last)continue;
  if(at===frames[0].at)fs.writeFileSync(O+'/kernel-prefix-seeds.json',JSON.stringify([...kernelSeeds])+'\n');
  const wire=s.contribute({...payload,buses:f.buses},n++,at);assert.equal(s.stats().failures,0);
  if(at>=frames[0].at){assert.deepEqual(wire,frames[matched].expected);matched++;}last=at;
 }
 fs.writeFileSync(O+'/kernel-prefix-result.json',JSON.stringify({prefixFrames:n,exactFullWireFrames:matched,seeds:kernelSeeds.size})+'\n');console.log({mode,prefixFrames:n,matched,seeds:kernelSeeds.size});
}else{
 if(mode==='primed')for(const [key,mean] of read(O+'/kernel-prefix-seeds.json'))moveKernel(mean);
 const s:any=new ServerEta({routes:['Red']});s.useCheckpoint({load:()=>fs.readFileSync(B+'/regression-warm.v8'),save:()=>{}},frames[0].at);
 let rows=0,max=0,exact=0;const first:any[]=[];
 for(const [i,f] of frames.entries()){
  const w=s.contribute({...payload,buses:f.buses},i,f.at);assert.equal(s.stats().failures,0);assert.deepEqual(w.buses,f.expected.buses);
  exact+=JSON.stringify(w)===JSON.stringify(f.expected)?1:0;assert.equal(w.rows.length,f.expected.rows.length);
  const expectedRows=new Map(f.expected.rows.map((r:any)=>[`${r[0]}|${r[1]}|${r[5]}`,r]));
  for(let j=0;j<w.rows.length;j++){
   const r=w.rows[j],e:any=expectedRows.get(`${r[0]}|${r[1]}|${r[5]}`);assert.equal(r[0],e[0]);assert.equal(r[1],e[1]);assert.equal(r[5],e[5]);
   const diff=Math.max(...[2,3,4,7,8].map(k=>Math.abs(r[k]-e[k])));if(diff){rows++;if(first.length<3)first.push({at:f.at,r,e});}max=Math.max(max,diff);
  }
 }
 const result={mode,frames:frames.length,exactFullWireFrames:exact,differentNumericRows:rows,maxNumericDifference:max,first};
 fs.writeFileSync(O+'/kernel-'+mode+'-result.json',JSON.stringify(result,null,2)+'\n');console.log(result);
 if(mode==='primed')assert.equal(exact,frames.length);
 else {assert.equal(rows,1828);assert.equal(max,3768);}
}
