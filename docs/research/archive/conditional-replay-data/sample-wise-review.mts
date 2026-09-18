/** Bounded invariants/counterexamples against the actual experimental helper.
 * Bundles a read-only source copy with diagnostic exports; no app-file edits.
 */
import{createHash}from'node:crypto';import fs from'node:fs';import path from'node:path';import{pathToFileURL}from'node:url';import{createRequire}from'node:module';
const root=process.cwd(),D='/home/gwarren/projects/yale-shuttle-watcher/conditional-replay-data';const req=createRequire(root+'/package.json');const esbuild=req('esbuild');
const src=root+'/web/src/eta/arrival.ts';const source=fs.readFileSync(src,'utf8');
const compiled=await esbuild.build({stdin:{contents:source+'\nexport { sampleFutureLaps, ownDeparture };',resolveDir:path.dirname(src),sourcefile:src,loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
fs.writeFileSync(D+'/sample-wise-review-bundle.mjs',compiled.outputFiles[0].text);
const{sampleFutureLaps,ownDeparture,K,setConditionalLapScope}=await import(pathToFileURL(D+'/sample-wise-review-bundle.mjs').href);
const point=(x:number)=>({xs:Float64Array.of(x),ps:Float64Array.of(.999999),tailHazard:.2});const a=(v:number)=>new Float64Array(K).fill(v);
const hop=(v:number)=>({drive:point(v),includesStand:false});const stop=(v:number,fit:any=null)=>({stand:point(v),lap:fit});
setConditionalLapScope('both');const out:any={sourceSha256:createHash('sha256').update(source).digest('hex')};
// Earlier departure need not produce a lower arrival under duration-scaled regulation.
const fit={b:-.001,m:3000,n:100000};const t={hops:[hop(100),hop(100)],stops:[stop(500),stop(1500,fit)]};
const current:any={leg:0,standingAt:0,start:a(600)},now:any={leg:0,standingAt:0,start:a(100)};
sampleFutureLaps(current,t,[11,121],{121:2400},null);sampleFutureLaps(now,t,[11,121],{121:2400},null);
out.departNowNotMathematicalFloor={originalArrival:current.sampled[2][0],leaveNowArrival:now.sampled[2][0],currentRestRemoved:500};
if(!(now.sampled[2][0]>current.sampled[2][0]))throw Error('Expected counterexample');
// A moving alternate must seed its own departure when the lead still stands.
const belief={rested:true,restStop:0,restApproach:false,leftStop:-1};const ages={11:1000};
const leadBridge=ownDeparture(belief,[11,121],ages,0,300,300000);const alternateBridge=ownDeparture(belief,[11,121],ages,-1,300,300000);
const t2={hops:[hop(100),hop(100)],stops:[stop(800,{b:-.001,m:1000,n:100000}),stop(0)]};const shared:any={leg:0,standingAt:-1,start:a(100)},perChain:any={leg:0,standingAt:-1,start:a(100)};
sampleFutureLaps(shared,t2,[11,121],ages,leadBridge);sampleFutureLaps(perChain,t2,[11,121],ages,alternateBridge);
out.movingAlternateBridge={leadBridge,alternateBridge,arrivalWithLeadBridge:shared.sampled[3][0],arrivalWithOwnBridge:perChain.sampled[3][0]};
if(leadBridge!==null||alternateBridge?.depT!==0||shared.sampled[3][0]===perChain.sampled[3][0])throw Error('Expected per-hypothesis bridge difference');
// Preserving common zero atoms preserves pass outcomes sample-by-sample.
const zeroMix=(v:number)=>({xs:Float64Array.of(0,v),ps:Float64Array.of(.25,.999999),tailHazard:.2});
const t3={hops:[hop(100),hop(100)],stops:[stop(0),{stand:zeroMix(100),lapStand:zeroMix(200),lap:fit}]};
const p:any={leg:0,standingAt:-1,start:Float64Array.from({length:K},(_,k)=>100+k)};sampleFutureLaps(p,t3,[11,121],{121:1800},null);
const zeros=p.sampled[2].filter((v:number,k:number)=>v===p.start[k]+100).length;
out.passMass={zeroCount:zeros,samples:K,expected:K*.25,note:'Paths straddle the lower lap support boundary; same zero atom survives both distribution branches'};if(zeros!==K*.25)throw Error('Pass atom changed');
const absent:any={leg:0,standingAt:-1,start:a(100)};sampleFutureLaps(absent,t3,[11,121],{},null);out.unsupportedFirstLap={arrival:absent.sampled[2][0],allH1Unchanged:Array.from(absent.sampled[1]).every(v=>v===100)};if(!out.unsupportedFirstLap.allH1Unchanged)throw Error('Initial segment changed');
fs.writeFileSync(D+'/sample-wise-review-checks.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
