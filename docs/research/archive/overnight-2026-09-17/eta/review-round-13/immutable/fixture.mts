import fs from 'node:fs';import assert from 'node:assert/strict';import {serialize} from 'node:v8';import {gzipSync} from 'node:zlib';
import {ServerEta} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/src/server/serverEta.ts';
import {ROUTE_LISTS} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/routes.ts';
const O=new URL('.',import.meta.url).pathname,[arm,mode]=process.argv.slice(2),cap=JSON.parse(fs.readFileSync('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/src/server/__fixtures__/live-frames.json','utf8'));
const start=mode.startsWith('restart')?Number(mode.slice(7)):0,server:any=new ServerEta({routes:ROUTE_LISTS.map(r=>r.label)}),out:any[]=[];
if(start)server.useCheckpoint({load:()=>fs.readFileSync(O+arm+'-fixture-'+start+'.v8'),save:()=>{}},cap.frames[start].t);
for(let i=start;i<cap.frames.length;i++){
 const f=cap.frames[i];if(mode==='normal'&&[10,20,30].includes(i))fs.writeFileSync(O+arm+'-fixture-'+i+'.v8',serialize({v:1,at:cap.frames[i-1].t,store:server.store,seen:server.seenAt}));
 const wire=server.contribute({...cap.static,buses:mode==='reverse'?[...f.buses].reverse():f.buses},i,f.t);assert.equal(server.stats().failures,0);
 out.push(structuredClone({i,at:f.t,wire,entries:[...server.store],seen:[...server.seenAt]}));
}
const replacer=(_k:string,v:any)=>v instanceof Map?{type:'Map',entries:[...v].sort((a,b)=>String(a[0]).localeCompare(String(b[0])))}:ArrayBuffer.isView(v)?{type:v.constructor.name,values:Array.from(v as any)}:v;
fs.writeFileSync(O+arm+'-fixture-'+mode+'.json.gz',gzipSync(JSON.stringify(out,replacer)));
console.log(JSON.stringify({arm,mode,frames:out.length,restored:server.stats().restored}));
