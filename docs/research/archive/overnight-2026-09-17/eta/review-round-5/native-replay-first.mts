import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-5';
const B=O.replace('review-round-5','cycle-5/traversal-guard'),A='/home/gwarren/projects/yale-shuttle-watcher';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+p).href);
const {ServerEta}=await load('/src/server/serverEta.ts');
const {poolReleaseArrivals:pool}=await load('/web/src/eta/index.ts');
const {setSampledFutureLap}=await load('/web/src/eta/arrival.ts');
const {setReleaseModelEnabled}=await load('/web/src/eta/release.ts');
const {ServerEta:BaseServer}=await import(B+'/baseline-server.generated.mts');
const payload=read(B+'/calibration-payload.json');
const expected=new Map(gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
setSampledFutureLap(true);setReleaseModelEnabled(true);
let server:any,base:any,last=0,frames=0,matched=0,rows=0,beliefs=0;const end=Math.max(...expected.keys());
for(const l of fs.readFileSync(A+'/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n')){
 const f=JSON.parse(l),at=Date.parse(f.at);if(at>end)break;if(at===last)continue;
 if(!last||at-last>60000){server=new ServerEta({routes:['Red']});base=new BaseServer({routes:['Red']});}
 const view={...payload,buses:f.buses};const before=base.contribute(view,frames,at),actual=server.contribute(view,frames,at);
 assert.equal(server.stats().failures,0);assert.equal(base.stats().failures,0);
 for(const [key,entry] of server.store){assert.deepEqual(entry.belief,base.store.get(key).belief);beliefs++;}
 if(expected.has(at)){const e=expected.get(at)!;assert.deepEqual(f.buses,e.buses);assert.deepEqual(actual,e.server_eta);matched++;rows+=actual.rows.length;}
 last=at;frames++;if(frames%2000===0)console.log({frames,matched,beliefs});
}
assert.equal(matched,1172);assert.equal(rows,160496);
// Independent exact boundary matrix, including non-29-stop rings and elapsed-time edges.
const row=(h:number,eta:number,occ=0)=>({stopId:11,occurrence:occ,stopsAhead:h,eta,low:eta*.8,high:eta*1.2,distribution:[eta*.8,eta,eta*1.2],departNow:7,lowFloor:5,leadMass:1,estimated:false,standingAt:-1});
let boundaryChecks=0;
for(const N of [2,3,29,37])for(const [oldH,newH,doPool] of [[N,0,false],[2*N,N,false],[N+1,N,false],[N,N-1,true],[2*N,2*N-1,true],[N-1,N,false],[N,N,true]])for(const dt of [0,5,15,15.001,-1]){
 const m=new Map([[22,{at:1000,row:row(oldH as number,3000)}]]);const r=row(newH as number,6000),raw=structuredClone(r);pool(m,[r],1000+dt*1000,true,N);
 const should=Boolean(doPool)&&dt>=0&&dt<=15;
 if(!should)assert.deepEqual(r,raw);else{const expected=(3000-dt)*Math.exp(-dt/30)+6000*(1-Math.exp(-dt/30));assert.ok(Math.abs(r.eta-expected)<1e-9);assert.equal(r.departNow,7);assert.equal(r.lowFloor,5);assert.ok(r.eta>3000-dt&&dt>0||dt===0);}
 assert.deepEqual(m.get(22)!.row,r);boundaryChecks++;
}
// Legacy current-stop pollution cannot survive even a same-clock response.
for(const dt of [0,5,15]){const m=new Map([[22,{at:1000,row:row(0,1804)}]]),r=row(0,0);pool(m,[r],1000+dt*1000,true,29);assert.equal(r.eta,0);assert.deepEqual(r.distribution,[0,0,0]);boundaryChecks++;}
const report={frames,matched,rows,beliefs,boundaryChecks,source:'Unmodified exact-head application and frozen exact-base modules; continuous raw prefix; no model fit or future labels.'};
fs.writeFileSync(O+'/native-replay.json',JSON.stringify(report,null,2)+'\n');console.log(report);
