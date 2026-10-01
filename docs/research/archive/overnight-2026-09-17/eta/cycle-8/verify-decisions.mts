import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {reprice} from './shell-candidate.generated.mts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-8';
const B='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-5/traversal-guard',C='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=(p:string)=>fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {isBusInService}=await load('schedule.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const {stableTripOrder}=await load('tripRanking.ts');
const payload=read(B+'/calibration-payload.json');registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const frames=new Map(gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const records=lines(B+'/decisions.jsonl'),expected=lines(C+'/ordered-decisions.jsonl'),orders=new Map();
const clean=(v:any)=>JSON.parse(JSON.stringify(v));
let now=0;const realNow=Date.now;Date.now=()=>now;
let gained=0,lost=0,changed=0,nonzeroUnchanged=0;const output=[];
try{
 for(let i=0;i<records.length;i++){
  const r=records[i],want=expected[i];now=r.at;
  const frame=frames.get(now)!;const buses=frame.buses.filter((b:any)=>isBusInService(b,now));assert.ok(attachServerEta(buses,frame.server_eta,now));
  const {options,trace}=reprice(r.stable,buses,payload,r.from,r.to);
  const ranked=stableTripOrder(options,orders.get(r.session)??null,now);orders.set(r.session,ranked.state);
  const option=options.find((o:any)=>o.mode==='shuttle');
  assert.deepEqual(clean(option),want.option);assert.deepEqual(clean(trace),want.trace);assert.deepEqual(clean(ranked.state),want.order);
  const original=r.options.find((o:any)=>o.mode==='shuttle');
  gained+=!original.journeyArrival&&!!option.journeyArrival;lost+=!!original.journeyArrival&&!option.journeyArrival;
  changed+=want.changed;
  if(r.session.endsWith(':150')){assert.equal(want.changed,false);nonzeroUnchanged++;}
  assert.equal(option.busName,original.busName);assert.equal(want.orderChanged,false);
  output.push({session:r.session,at:r.at,option:clean(option),trace:clean(trace),order:clean(ranked.state)});
 }
}finally{Date.now=realNow;}
assert.equal(records.length,4688);assert.equal(gained,30);assert.equal(lost,0);assert.equal(nonzeroUnchanged,2344);
fs.writeFileSync(O+'/candidate-decisions.jsonl',output.map(x=>JSON.stringify(x)).join('\n')+'\n');
const summary={exactPrototypeDecisions:records.length,gained,lost,changed,nonzeroUnchanged,busChanges:0,rankChanges:0,scope:'Current-source numerical shell, same wire inputs as independently reviewed cycle6. Both wire occurrences untouched; scores and regressions transfer only by exact equality.'};
fs.writeFileSync(O+'/decision-parity.json',JSON.stringify(summary,null,2)+'\n');console.log(summary);
