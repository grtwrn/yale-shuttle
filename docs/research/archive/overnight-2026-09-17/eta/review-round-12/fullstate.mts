import fs from 'node:fs';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {ServerEta} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/src/server/serverEta.ts';
import {moveKernel} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/filter.ts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12';
const [mode]=process.argv.slice(2);
assert.ok(['prewarmed','empty'].includes(mode));
if(mode==='prewarmed') for(let k=400;k>=5;k--) { moveKernel(k/10+.049); moveKernel(k/10-.049); }
const payload=JSON.parse(fs.readFileSync(O+'/../cycle-4/calibration-payload.json','utf8'));
const frames=JSON.parse(gunzipSync(fs.readFileSync(O+'/cache/canonical-warm.json.gz')).toString());
const server:any=new ServerEta({routes:['Red']});
server.useCheckpoint({load:()=>fs.readFileSync(O+'/cache/canonical-warm.v8'),save:()=>{}},frames[0].at);
assert.equal(server.stats().restored,3);
const out=[];
for(const[i,f]of frames.entries()) {
 const wire=server.contribute({...payload,buses:f.buses},i,f.at);
 assert.deepEqual(wire,f.wire);
 assert.equal(server.stats().failures,0);
 const entries=[...server.store];
 assert.ok(entries.some(([,e]:any)=>e.floors));
 out.push({at:f.at,wire,entries,seen:[...server.seenAt]});
}
// Preserve maps/typed arrays explicitly; ordinary JSON alone erases floor and smoothing maps.
const replacer=(_key:string,v:any)=>v instanceof Map?{type:'Map',entries:[...v]}:
 ArrayBuffer.isView(v)?{type:v.constructor.name,values:Array.from(v as any)}:v;
fs.writeFileSync(O+'/fullstate-'+mode+'.json.gz',gzipSync(JSON.stringify(out,replacer)));
console.log(JSON.stringify({mode,frames:out.length,restored:server.stats().restored,wireMatches:out.length,
 scope:'Complete per-vehicle ModelEntry and seenAt; this does not assert equality of counters/global process caches.'}));
