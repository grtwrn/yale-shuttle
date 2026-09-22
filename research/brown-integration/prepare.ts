/** Construct declared synthetic complete wires around fixed development clocks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {ARMS,type Arm,type ModelManifest} from '../brown-response/model.ts';
import {topologyContract,type AdapterContext} from '../brown-response/adapter.ts';
import {QueryCollector,sha,bodyHash} from './sidecar.ts';
const root='research/brown-integration/',out=root+'results/',dev='research/brown-response/input/development/';
const read=(p:string)=>zlib.gunzipSync(fs.readFileSync(p)).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const top=JSON.parse(fs.readFileSync(dev+'canonical-topology.json','utf8')),topology=topologyContract(top);
const manifestIndex=JSON.parse(fs.readFileSync(out+'models/index.json','utf8'));
const rows=read(dev+'unscored.jsonl.gz'),sources=read(dev+'baseline-source-events.jsonl.gz');
assert(rows.every(r=>r.at<Date.parse('2026-09-21T04:00:00Z')&&!('label'in r)&&!('truth'in r)));
const selections=[rows[0],...['2026-09-18T10:14:45-04:00','2026-09-18T10:17:15-04:00'].map(t=>
  rows.find(r=>r.at===Date.parse(t)&&r.bus==='#304'&&r.target===47))];
assert(selections.every(Boolean));
const coords=Object.fromEntries(top.stops.map((s:any)=>[s.id,{lat:s.lat,lon:s.lon}]));
const names=Object.fromEntries(top.stops.map((s:any)=>[s.id,s.name??String(s.id)]));
const cases:any[]=[],collector=new QueryCollector();
for(const [ci,r]of selections.entries()) {
  const name=`fixed-development-${ci}`,provider=sources.filter(e=>e.bus===r.bus&&e.knownAt<=r.asof).at(-1)?.provider;
  assert(Number.isInteger(provider));
  const snapshot=(variant:'original'|'directed')=>{
    const f=r.clockFeatures[variant];
    return {asof:f.asof,bus:f.bus,route:19,provider,ready:f.ready,index:f.index,nearest:f.nearest,phase:f.phase,began:f.began,
      observedAt:f.observedAt,origins:f.origins,releasedOrigins:f.releasedOrigins,prefixComplete:true,
      prefixSha256:bodyHash({developmentFeatureArtifact:sha(fs.readFileSync(dev+'unscored.jsonl.gz')),feature:f}),variant};
  };
  const snaps={original:snapshot('original'),directed:snapshot('directed')};
  const seq=topology.sequence,anchor=r.anchorIndex;
  const wireRows=seq.map((stop:number,i:number)=>{
    const hops=(i-anchor+seq.length)%seq.length||seq.length,eta=300+hops*110;
    return [0,stop,eta,Math.max(0,eta-200),eta+1200,hops,0,Math.max(0,eta-10),Math.max(0,eta-210)];
  });
  const originalRow=wireRows.find(a=>a[1]===r.target)!;
  originalRow[2]=r.deployed.eta;originalRow[3]=r.deployed.low;originalRow[4]=r.deployed.high;
  wireRows.push(originalRow.slice()); // Same occurrence, separate original ordinal.
  wireRows.push([1,147,600,400,1000,1,0,590,390],[1,121,1100,900,1500,2,0,1090,890]);
  const segments:any={'19':{},'3':{'147-121':{avg:500,sd:30,n:100},'121-147':{avg:500,sd:30,n:100}}};
  seq.forEach((id:number,i:number)=>segments['19'][`${id}-${seq[(i+1)%seq.length]}`]={avg:90,sd:20,n:100});
  const body={buses:[{bus_id:provider,bus_name:r.bus,route_id:19,...coords[seq[anchor]!],heading:0,last_stop_id:seq[anchor],observed_at:r.observedAt},
      {bus_id:90001,bus_name:'#901',route_id:3,...coords[121],heading:0,last_stop_id:121,observed_at:r.at}],
    routes:{'19':seq,'3':[147,121]},route_paths:{'19':topology.path,'3':[[coords[147].lat,coords[147].lon],[coords[121].lat,coords[121].lon]]},
    stop_coords:coords,stop_names:names,segments,dwells:{},dwells_by_bus:{},route_hours:{},route_active:{},route_peaks:{},model_params:null,announcements:[],
    server_eta:{v:2,at:r.at,servedAt:r.at,buses:[[r.bus.replace(/^#/,''),'Brown',anchor,null],['901','Red',1,null]],rows:wireRows,
      distributions:wireRows.map(a=>Array.from({length:50},(_,j)=>a[3]+(a[4]-a[3])*j/49))}};
  const midnight=new Date(r.at);midnight.setHours(0,0,0,0);
  const modelNames={frozen:`frozen_K8`,rolling:`rolling_K5_${midnight.getTime()-86400000}`};
  const scenario={origin:{lat:coords[147].lat+220/111195,lon:coords[147].lon},destination:coords[121]};
  const frames=[0,15000].map((elapsed,i)=>({id:`${name}/${i}`,receivedAt:r.at+elapsed,
    body:{...body,server_eta:{...body.server_eta,servedAt:r.at+elapsed}}}));
  const c={name,at:r.at,scenario,snapshots:snaps,modelNames,frames,originalTarget:r.target,originalCandidates:r.candidates,
    fixtureOnly:true,syntheticCompleteResponse:true,actualFleetResponse:false};cases.push(c);
  for(const frame of frames)for(const arm of ARMS) {
    const m:ModelManifest=manifestIndex[modelNames[arm.startsWith('frozen')?'frozen':'rolling']].manifest;
    const ctx:AdapterContext={responseId:frame.id,receivedAt:frame.receivedAt,arm,topology,model:{manifest:m,fit:()=>{throw Error('Planning cannot execute fit');}},
      allowFixtureArtifacts:true,snapshot:()=>snaps[arm.endsWith('_directed')?'directed':'original']};
    collector.add(frame.body,ctx);
  }
}
fs.mkdirSync(out+'requests',{recursive:true});
for(const [i,request]of collector.all().entries())fs.writeFileSync(out+`requests/${i}.json`,JSON.stringify(request)+'\n');
fs.writeFileSync(out+'cases.json',JSON.stringify({topology,cases})+'\n');
fs.writeFileSync(out+'collection.json',JSON.stringify({cases:cases.length,frames:cases.reduce((n,c)=>n+c.frames.length,0),
  arms:ARMS.length,requests:collector.all().map(r=>({artifactId:r.binding.artifactId,queries:r.queries.length,inputs:r.inputs.length,
    rows:r.inputs.reduce((n,i)=>n+i.rows.length,0)})),outcomesRead:0,prospectiveBodiesRead:0},null,2)+'\n');
