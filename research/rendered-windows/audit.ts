/** Hosted-only audit of unchanged forecasts using the production formatter. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {predictionWindow} from '../../services/shuttle-v2/web/src/arrivalDetails.ts';

const base = 'research/rendered-windows/', input = base+'input/', out = base+'results/';
const arms = ['frozen','rolling'].flatMap(m => [1,2,3,5,8,10,15].map(k => `${m}_K${k}`));
const ages = [0,5,15,30];
const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
type Forecast = {eta: number; low: number; high: number};
function display(f: Forecast, at: number, age: number) {
  const band = predictionWindow(f.low, f.high, at, at+age*1000);
  if (!band) return null;
  const match = /^(<1|\d+)(?:–(\d+))? min$/.exec(band.text);
  assert(match, `Unrecognized production text: ${band.text}`);
  const low = match[1] === '<1' ? 0 : Number(match[1])*60;
  const high = Number(match[2] ?? match[1])*60;
  assert(Number.isFinite(high) && low <= band.lowSec && high >= band.highSec);
  return {text:band.text, low, high, width:high-low, rawLow:band.lowSec,
          rawHigh:band.highSec, rawWidth:band.highSec-band.lowSec};
}
assert.equal(display({eta:150,low:125,high:185},0,0)?.text,'2–4 min');
assert.equal(display({eta:150,low:125,high:185},0,6)?.text,'1–3 min');
assert.equal(display({eta:30,low:0,high:40},0,0)?.width,60);
assert.equal(display({eta:20,low:10,high:20},0,20),null);
assert.equal(display({eta:20,low:30,high:20},0,0),null);

type Group = {route: number; scope: string; ageSec: number; arm: string;
  attempted: number; alreadyArrived: number; unavailable: number;
  dates:Set<string>; visits:Map<number, {n:number; sums:Record<string,number>}>};
const groups = new Map<string,Group>();
let rows = 0, labelled = 0, unionRows = 0, formatterCalls = 0;
const file = input+'forecasts.jsonl.gz', before = hash(file);
const names = new Map<number,string>(JSON.parse(fs.readFileSync(input+'canonical-topology.json','utf8')).routes.map((r:any)=>[r.id,r.name]));
const date = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'});
const differs = (a:Forecast,b:Forecast) => a.eta!==b.eta || a.low!==b.low || a.high!==b.high;
for await (const line of readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip())})) {
  if (!line.trim()) continue;
  const r = JSON.parse(line); rows++;
  if (!r.label) continue;
  labelled++;
  assert(arms.every(a => r.candidates[a].eta === r.deployed.eta));
  if (!arms.some(a => differs(r.candidates[a],r.deployed))) continue;
  unionRows++;
  const scopes = ['commonUnion',r.deployedChanged ? 'deployedCheckpointApplied' : 'deployedLiveFallback'];
  for (const age of ages) {
    const d = display(r.deployed,r.at,age); formatterCalls++;
    for (const arm of arms) {
      const c = display(r.candidates[arm],r.at,age); formatterCalls++;
      for (const scope of scopes) {
        const key = `${r.route}/${scope}/${age}/${arm}`;
        let g = groups.get(key);
        if (!g) {g={route:r.route,scope,ageSec:age,arm,attempted:0,alreadyArrived:0,unavailable:0,dates:new Set(),visits:new Map()};groups.set(key,g);}
        g.attempted++;
        if (r.truth <= age) {g.alreadyArrived++;continue;}
        if (!d || !c) {g.unavailable++;continue;}
        const truth = r.truth-age;
        const metrics = {
          deployedRawWidth:d.rawWidth, candidateRawWidth:c.rawWidth,
          deployedPrintedWidth:d.width,candidatePrintedWidth:c.width,
          printedSaving:d.width-c.width,rawSaving:d.rawWidth-c.rawWidth,
          identicalText:Number(d.text===c.text), printedNarrower:Number(c.width<d.width),
          printedWider:Number(c.width>d.width), rawSavingHiddenByRounding:Number(c.rawWidth<d.rawWidth && c.text===d.text),
          deployedRawCoverage:Number(d.rawLow<=truth && truth<=d.rawHigh),
          candidateRawCoverage:Number(c.rawLow<=truth && truth<=c.rawHigh),
          deployedPrintedCoverage:Number(d.low<=truth && truth<=d.high),
          candidatePrintedCoverage:Number(c.low<=truth && truth<=c.high),
          deployedPrintedEarly60:Number(truth<d.low-60),candidatePrintedEarly60:Number(truth<c.low-60),
          deployedPrintedLate120:Number(truth>d.high+120),candidatePrintedLate120:Number(truth>c.high+120),
        };
        assert(metrics.candidatePrintedEarly60<=metrics.deployedPrintedEarly60);
        assert(metrics.deployedPrintedCoverage>=metrics.deployedRawCoverage);
        assert(metrics.candidatePrintedCoverage>=metrics.candidateRawCoverage);
        let visit=g.visits.get(r.label.id);
        if(!visit){visit={n:0,sums:{}};g.visits.set(r.label.id,visit);}
        visit.n++;
        for(const [key,value] of Object.entries(metrics))visit.sums[key]=(visit.sums[key]??0)+value;
        g.dates.add(date.format(r.at));
      }
    }
  }
}
assert.equal(rows,38047);assert.equal(labelled,22962);assert.equal(hash(file),before);
const results = [...groups.values()].map(g=>{
  const values:Record<string,number>={};let paired=0;
  for(const v of g.visits.values()){
    paired+=v.n;
    for(const [key,sum] of Object.entries(v.sums))values[key]=(values[key]??0)+sum/v.n/g.visits.size;
  }
  return {route:g.route,name:names.get(g.route),scope:g.scope,ageSec:g.ageSec,arm:g.arm,
    attempted:g.attempted,alreadyArrived:g.alreadyArrived,bandUnavailable:g.unavailable,
    pairedSnapshots:paired,physicalVisits:g.visits.size,dates:[...g.dates].sort(),...values};
});
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'summary.json',JSON.stringify({sourceRun:35685527686,forecastSha256:before,
  rows,labelled,unionRows,formatterCalls,ages,results,limitations:[
    'Widths are the numeric envelope printed by the primary pickup formatter; <1 starts at zero.',
    'Aging sensitivities are hypothetical ticks, not observed rider views or independent arrivals.',
    'Current raw-window gates remain; printed coverage cannot override failures.',
    'No fitting, relabelling, K selection, new dates, or production change.'
  ]},null,2));
const report=['# Printed-window diagnostic','','Unchanged window-only forecasts on reused dates. Same all-K route union; equal weight per physical visit. No model selection or rollout.','',
  '| Line | Arm | Visits | Raw width, s | Printed width, s | Printed narrowing, s | Same text | Printed coverage |',
  '|---|---|---:|---:|---:|---:|---:|---:|'];
for(const r of results.filter(r=>r.scope==='commonUnion'&&r.ageSec===0)) {
  const f=(x:any)=>typeof x==='number'?x.toFixed(1):'—';
  report.push(`| ${r.name} | ${r.arm} | ${r.physicalVisits} | ${f(r.deployedRawWidth)} → ${f(r.candidateRawWidth)} | ${f(r.deployedPrintedWidth)} → ${f(r.candidatePrintedWidth)} | ${f(r.printedSaving)} | ${f(100*r.identicalText)}% | ${f(100*r.deployedPrintedCoverage)}% → ${f(100*r.candidatePrintedCoverage)}% |`);
}
report.push('','Separate current-checkpoint/fallback cohorts, aging sensitivities, unavailable bands and tails are in summary.json. A band that disappears is never counted as zero width. These forecasts do not establish current route-wide rider performance.','');
fs.writeFileSync(out+'REPORT.md',report.join('\n'));
console.log(JSON.stringify({rows,labelled,unionRows,formatterCalls,groups:results.length,forecastSha256:before}));
