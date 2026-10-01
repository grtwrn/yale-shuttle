import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const {predictionWindow,arrivalSummary}=await import(pathToFileURL(root+'/web/src/arrivalDetails.ts').href);
const out='/tmp/red-wide-window-recency-2026-09-17';
const read=(p:string)=>fs.readFileSync(p,'utf8').trim().split('\n').map(x=>JSON.parse(x));
const current=read(out+'/current-watcher.jsonl'),raw=read(out+'/no-widening-watcher.jsonl');
const feed=read('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/watcher.jsonl');
const metadata=new Map(feed.map(x=>[x.at,x]));
assert.equal(current.length,raw.length);
let pointDifferences=0;
const rows:any[]=[];
for(let i=0;i<current.length;i++){
 const f=current[i],g=raw[i];assert.equal(f.at,g.at);assert.equal(f.bus.bus_name,g.bus.bus_name);assert.equal(f.arrivals.length,g.arrivals.length);
 for(let j=0;j<f.arrivals.length;j++){
  const a=f.arrivals[j],b=g.arrivals[j];assert.equal(a.stopId,b.stopId);assert.equal(a.stopsAhead,b.stopsAhead);
  if(a.eta!==b.eta)pointDifferences++;
  if(f.bus.at_stop_id!==11||a.stopId!==48||a.stopsAhead!==3)continue;
  const now=Date.parse(f.at),m:any=metadata.get(f.at),pin=Date.parse(f.bus.at_stop_since+'Z');
  const band=predictionWindow(a.low,a.high,now,now),base=predictionWindow(b.low,b.high,now,now);
  rows.push({at:f.at,bus:f.bus.bus_name,pin:f.bus.at_stop_since,elapsedSec:(now-pin)/1000,approach:f.belief?.restApproach,feedAgeMs:m?.feedAgeMs,eta:a.eta,low:a.low,high:a.high,widthSec:a.high-a.low,rawLow:b.low,rawHigh:b.high,rawWidthSec:b.high-b.low,display:band.text,noWideningDisplay:base.text,token:arrivalSummary(a.eta,a.low,a.high,now,now).token});
 }
}
const median=(xs:number[])=>{xs.sort((a,b)=>a-b);return xs.length%2?xs[(xs.length-1)/2]:(xs[xs.length/2-1]+xs[xs.length/2])/2;};
const broad=rows.filter(r=>r.display==='<1–15 min');
const selected=broad.find(r=>r.approach===false && r.elapsedSec>=10);
assert.ok(selected);assert.equal(pointDifferences,0);
const report={source:'September 16 watcher capture + fixed fit-2026-09-15 payload; current build 0bcc0ad4ba07. This is a width decomposition, not causal historical accuracy validation.',watcherPolls:feed.length,busFrames:current.length,matchingAtWinchesterToDivisionProspect:rows.length,exact1to15:rows.filter(r=>r.display==='1–15 min').length,lessThan1to15:broad.length,pointDifferences,medianWidthSec:median(rows.map(r=>r.widthSec)),medianWidthNoConformalSec:median(rows.map(r=>r.rawWidthSec)),selected,broadFeedAgeMs:{min:Math.min(...broad.map(r=>r.feedAgeMs)),max:Math.max(...broad.map(r=>r.feedAgeMs))}};
fs.writeFileSync(out+'/replay-summary.json',JSON.stringify(report,null,2));fs.writeFileSync(out+'/standing-replay-rows.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(report,null,2));
