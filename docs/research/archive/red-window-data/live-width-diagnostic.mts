import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),base='/home/gwarren/projects/yale-shuttle-watcher/red-window-data';
const req=createRequire(root+'/package.json');
const {ServerEta}=await import(pathToFileURL(root+'/src/server/serverEta.ts').href);
const {createJourneyHistory}=await import(pathToFileURL(root+'/src/server/journeyHistory.ts').href);
const original=JSON.parse(fs.readFileSync(base+'/live-wide-report.json','utf8')).feed;
const warm=JSON.parse(fs.readFileSync(base+'/live-warm-capture.json','utf8'));
const rawInterval=original.server_eta.rows.filter((r:any)=>original.server_eta.buses[r[0]][0]==='300'&&r[1]===48&&r[5]===7).map((r:any)=>({etaSec:r[2],lowSec:r[3],highSec:r[4],beforeWideningLowSec:r[2]-(r[2]-r[3])/1.236,beforeWideningHighSec:r[2]+(r[4]-r[2])/1.236}));
const priced:any={};
for(const mode of ['current','noWidening']){
 const payload=structuredClone(warm.feed);
 if(mode==='noWidening')for(const k of Object.keys(payload.model_params.params.CONFORMAL))payload.model_params.params.CONFORMAL[k]=1;
 const e=new ServerEta({routes:['Red']});e.useCheckpoint({load:()=>Buffer.from(warm.checkpoint,'base64'),save:()=>{}},payload.server_eta.at);
 const out=e.contribute(payload,1,payload.server_eta.at);
 priced[mode]={restored:e.stats().restored,buses:out?.buses,rows:out?.rows.filter((r:any)=>out.buses[r[0]][0]==='300'&&[11,48].includes(r[1])&&r[5]<15)};
}
const D=req('better-sqlite3'),db=new D('/home/gwarren/projects/yale-shuttle-watcher/red-eta-data/replay-lap.db',{readonly:true,fileMustExist:true});
const seq=original.routes['3'],history=createJourneyHistory(db),bus=original.buses.find((b:any)=>b.bus_name==='#300');
const past=history('Red',48,{bus,sequence:seq,index:10,standing:null,stopsAhead:7},{routes:new Map([[3,{id:3,stops:seq}]]),stops:new Map(Object.entries(original.stop_names).map(([id,name])=>[Number(id),{name}]))},original.server_eta.at,100);
const sorted=past.journey.trips.map((t:any)=>t.actualSec).sort((a:number,b:number)=>a-b),q=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];
const report={note:'Diagnostic ablations and historical full departures only; not validation or a model proposal. Checkpoint replay may differ from original issued snapshot.',originalAt:original.server_eta.at,originalInterval:rawInterval,warmAt:warm.feed.server_eta.at,issuedWarmRows:warm.feed.server_eta.rows.filter((r:any)=>warm.feed.server_eta.buses[r[0]][0]==='300'&&[11,48].includes(r[1])&&r[5]<15),priced,history:{from:past.journey.fromName,to:past.journey.toName,n:sorted.length,dates:past.journey.serviceDates,min:sorted[0],q10:q(.1),q50:q(.5),q90:q(.9),max:sorted.at(-1)}};
fs.writeFileSync(base+'/live-width-diagnostic.json',JSON.stringify(report,null,2));fs.writeFileSync(base+'/trumbull-division-history.json',JSON.stringify(past,null,2));console.log(JSON.stringify(report,null,2));db.close();
