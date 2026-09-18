/** Numerical parity prototype for the server's bounded nine-feature hazard fit. */
import fs from 'node:fs';
export interface Observation { a: number; ready: number; stop: number; lap: number | null; y: number; day: string }
export interface Fit { stopId: number; referenceLap: number; coefficients: number[]; n: number; days: number }
const median = (a:number[]) => { a.sort((x,y)=>x-y); return (a[Math.floor((a.length-1)/2)]!+a[Math.ceil((a.length-1)/2)]!)/2; };
function solve(matrix:number[][], rhs:number[]): number[] {
  const a=matrix.map((r,i)=>[...r,rhs[i]!]), n=rhs.length;
  for(let k=0;k<n;k++){
    let best=k;for(let i=k+1;i<n;i++)if(Math.abs(a[i]![k]!)>Math.abs(a[best]![k]!))best=i;
    [a[k],a[best]]=[a[best]!,a[k]!];const pivot=a[k]![k]!;if(Math.abs(pivot)<1e-12)throw Error('singular hazard fit');
    for(let j=k;j<=n;j++)a[k]![j]!/=pivot;
    for(let i=0;i<n;i++)if(i!==k){const f=a[i]![k]!;for(let j=k;j<=n;j++)a[i]![j]!-=f*a[k]![j]!;}
  }return a.map(r=>r[n]!);
}
export function fitRelease(rows:Observation[],stopId:number,before:number):Fit|null{
 const tr=rows.filter(r=>r.stop===stopId&&r.ready<before&&Number.isFinite(r.y)&&r.y>=0);
 const days=new Set(tr.map(r=>r.day)).size;
 const laps=tr.flatMap(r=>r.lap!==null&&r.lap>900&&r.lap<7200?[r.lap]:[]);
 if(tr.length<60||days<3||laps.length<40)return null;
 const referenceLap=median(laps), xx:number[][]=[], yy:number[]=[];
 for(const r of tr){
  const valid=r.lap!==null&&r.lap>=.65*referenceLap&&r.lap<=1.65*referenceLap;
  const lap=valid?(r.lap!-referenceLap)/600:0,bins=Math.max(1,Math.ceil(r.y/15));
  // Completed unusually long waits stay in the likelihood; no duration trim.
  for(let i=0;i<bins;i++){
   const t=(i+.5)*15, angle=2*Math.PI*((Math.floor(r.a/1000)%900)+t)/900;
   xx.push([1,Math.log1p(t/60),t/600,Math.max(t-300,0)/600,Math.max(t-600,0)/600,lap,valid?0:1,Math.sin(angle),Math.cos(angle)]);yy.push(i===bins-1?1:0);
  }
 }
 const objective=(b:number[])=>{
  let out=0;for(let k=0;k<xx.length;k++){const x=xx[k]!,z=x.reduce((s,v,i)=>s+v*b[i]!,0);out+=Math.max(0,z)+Math.log1p(Math.exp(-Math.abs(z)))-yy[k]!*z;}
  for(let i=1;i<9;i++)out+=2*b[i]!*b[i]!;return out;
 };
 let beta=Array(9).fill(0);const p=tr.length/yy.length;beta[0]=Math.log(p/(1-p));let loss=objective(beta),converged=false;
 for(let iter=0;iter<50;iter++){
  const g=Array(9).fill(0),h=Array.from({length:9},()=>Array(9).fill(0));
  for(let k=0;k<xx.length;k++){
   const x=xx[k]!,z=x.reduce((s,v,i)=>s+v*beta[i]!,0),p=1/(1+Math.exp(-z)),w=p*(1-p),e=p-yy[k]!;
   for(let i=0;i<9;i++){g[i]+=e*x[i]!;for(let j=0;j<9;j++)h[i]![j]+=w*x[i]!*x[j]!;}
  }
  for(let i=1;i<9;i++){g[i]+=4*beta[i]!;h[i]![i]+=4;}
  if(Math.max(...g.map(Math.abs))<1e-7){converged=true;break;}
  const step=solve(h,g);let scale=1,trial=beta,trialLoss=Infinity;
  for(let line=0;line<24;line++){trial=beta.map((v,i)=>v-scale*step[i]!);trialLoss=objective(trial);if(trialLoss<=loss)break;scale/=2;}
  if(!Number.isFinite(trialLoss)||trialLoss>loss)return null;
  const change=Math.max(...trial.map((v,i)=>Math.abs(v-beta[i]!)));beta=trial;loss=trialLoss;
  if(change<1e-8){converged=true;break;}
 }
 if(!converged||beta.some(v=>!Number.isFinite(v)))return null;
 return {stopId,referenceLap,coefficients:beta,n:tr.length,days};
}
const root='/home/gwarren/projects/yale-shuttle-watcher';
const source=JSON.parse(fs.readFileSync(root+'/red-window-data/operating-pattern-screen.json','utf8'));
const original=JSON.parse(fs.readFileSync(root+'/red-window-data/release-survival-screen.json','utf8'));
const before=Date.parse(process.env.FIT_BEFORE??'2026-09-10T04:00:00Z'),at=performance.now();
const fits=[11,121].map(s=>fitRelease(source.featureRows,s,before));
const checks=fits.map(f=>({stop:f?.stopId,n:f?.n,days:f?.days,maxCoefficientDifference:f&&Math.max(...f.coefficients.map((v,i)=>Math.abs(v-original.fits.find((o:any)=>o.stop===f.stopId&&o.arm==='hazard_age_lap_clock15').coefficients[i])))}));
fs.writeFileSync(root+'/release-integration-data/runtime-fits.json',JSON.stringify({before,fits,checks,durationMs:performance.now()-at},null,2));console.log(JSON.stringify({checks,durationMs:performance.now()-at}));
