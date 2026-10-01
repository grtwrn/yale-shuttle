/** Unmodified warm replay, adding read-only missing-board state diagnostics. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-6';
const B=O.replace('cycle-6','cycle-5/traversal-guard'),A='/home/gwarren/projects/yale-shuttle-watcher';
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const load=(p:string)=>import(pathToFileURL(process.cwd()+p).href);
const {ServerEta}=await load('/src/server/serverEta.ts');
const {ringForBus}=await load('/web/src/eta/index.ts');
const {situations}=await load('/web/src/eta/filter.ts');
const {anchorKeyFor}=await load('/web/src/liveAnchor.ts');
const {setSampledFutureLap}=await load('/web/src/eta/arrival.ts');
const {setReleaseModelEnabled}=await load('/web/src/eta/release.ts');
const payload=read(B+'/calibration-payload.json');
const expected=new Map(gunzipSync(fs.readFileSync(B+'/fleet-wire.jsonl.gz')).toString().trim().split('\n').map(l=>{const f=JSON.parse(l);return [f.at,f] as const;}));
const wanted=new Set(read(O+'/missing-cases.json').map((x:any)=>`${x.at}|${x.bus}`));
setSampledFutureLap(true);setReleaseModelEnabled(true);
let server:any,last=0,frames=0,matched=0,rows=0;const end=Math.max(...expected.keys()),states:any[]=[];
for(const l of fs.readFileSync(A+'/conditional-replay-data/raw-frames.jsonl','utf8').trim().split('\n')){
 const f=JSON.parse(l),at=Date.parse(f.at);if(at>end)break;if(at===last)continue;
 if(!last||at-last>60000)server=new ServerEta({routes:['Red']});
 const actual=server.contribute({...payload,buses:f.buses},frames,at);
 assert.equal(server.stats().failures,0);
 if(expected.has(at)){
  assert.equal(JSON.stringify(actual),JSON.stringify(expected.get(at)!.server_eta));matched++;rows+=actual.rows.length;
  for(const bus of f.buses){
   const name=bus.bus_name.replace(/^#/,'');if(!wanted.has(`${at}|${name}`))continue;
   const e=server.store.get(anchorKeyFor('Red',bus.bus_name));assert.ok(e?.belief);
   const b=e.belief,ring=ringForBus(bus,payload.routes['3'],payload.stop_coords);
   const sits=situations(b,ring),lead=sits.find((s:any)=>s.leg===b.lead)??sits[0];
   // Mirrors startChain's existing arrival identity conditions, no values changed.
   const repositioning=!lead.standing&&b.restStop>=0&&lead.inRest>=.5&&[11,121].includes(ring.stops[b.restStop])&&(lead.leg+1)%ring.N===b.restStop;
   states.push({at,bus:name,lead: b.lead,restStop:b.restStop,rested:b.rested,leadSituation:lead,situations:sits,repositioning,
    hasRawStandingLead:lead.standing&&lead.zoneStop>=0,ringStopIds:ring.stops});
  }
 }
 last=at;frames++;if(frames%2000===0)console.log({frames,matched,states:states.length});
}
assert.equal(matched,1172);assert.equal(rows,160496);assert.equal(states.length,34);
const report={frames,matched,rows,states,scope:'Unmodified native ServerEta with continuous raw prefix; exact complete serialized-wire parity. Read-only state observations, no future labels or checkpoint restoration.'};
fs.writeFileSync(O+'/observed-states.json',JSON.stringify(report,null,2)+'\n');console.log({frames,matched,rows,states:states.length});
