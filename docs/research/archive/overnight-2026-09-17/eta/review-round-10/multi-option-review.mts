import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {reprice} from './shell-candidate.generated.mts';
const O=new URL('.',import.meta.url).pathname,B=O+'../cycle-5/traversal-guard/';
const load=(p:string)=>import(pathToFileURL(process.cwd()+'/web/src/'+p).href);
const {attachServerEta}=await load('etaSource.ts');
const {registerRoutePaths}=await load('anchor.ts');
const {applyModelParams}=await load('eta/params.ts');
const payload=JSON.parse(fs.readFileSync(B+'calibration-payload.json','utf8'));registerRoutePaths(payload.route_paths);applyModelParams(payload.model_params);
const records=fs.readFileSync(B+'decisions.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const frames=new Map(gunzipSync(fs.readFileSync(B+'fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
let now=0;const realNow=Date.now;Date.now=()=>now;const seen=new Set(),report:any={batches:0,options:0,distinctSelectionBatches:0,distinctBoardingAmongShuttles:0,scope:'Synthetic simultaneous access options on 100 saved frames; implementation isolation check, not observed rider alternatives.',examples:[]};
try{
 for(const r of records){
  if(seen.has(r.at))continue;seen.add(r.at);now=r.at;
  const f=frames.get(now)!,buses=f.buses.map((b:any)=>({...b}));assert.ok(attachServerEta(buses,f.server_eta,now));
  const shuttle=r.stable.find((o:any)=>o.mode==='shuttle'),walk=r.stable.find((o:any)=>o.mode==='walk');
  const options=[0,150,1000,10000].map(walkToSec=>({...shuttle,walkToSec}));if(walk)options.splice(1,0,walk);
  const board=payload.stop_coords[shuttle.boardStopId],from={lat:board.lat+0.01,lon:board.lon};
  const combined=reprice(options,buses,payload,from,r.to).options;
  const separate=options.map((o:any)=>reprice([o],buses,payload,from,r.to).options[0]);
  assert.deepEqual(combined,separate);report.batches++;report.options+=options.length;
  const identities=new Set(combined.filter((o:any)=>o.mode==='shuttle').map((o:any)=>JSON.stringify(o.livePickupSelection)));
  const boardingKeys=new Set(combined.filter((o:any)=>o.mode==='shuttle'&&o.livePickupSelection).map((o:any)=>{const b=o.livePickupSelection.boarding;return `${b.busName}:${b.stopId}:${b.stopsAhead}`;}));
  if(boardingKeys.size>1)report.distinctBoardingAmongShuttles++;
  if(identities.size>1){report.distinctSelectionBatches++;if(report.examples.length<3)report.examples.push({at:now,selections:combined.map((o:any)=>o.livePickupSelection)});}
  if(report.batches===100)break;
 }
}finally{Date.now=realNow;}
assert.equal(report.batches,100);assert.ok(report.distinctSelectionBatches>0);
fs.writeFileSync(O+'multi-option-review.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({batches:report.batches,options:report.options,distinctSelectionBatches:report.distinctSelectionBatches,distinctBoardingAmongShuttles:report.distinctBoardingAmongShuttles}));
