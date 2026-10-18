import { describe, test, expect } from 'vitest';
import { auditPauseMaps, confirmPauseMaps } from './map-pause.mjs';

const at=1_000_000,receivedAt=2_000_000,now=receivedAt+2000;
const feed=()=>({buses:[{bus_name:'#57',bus_id:67840,route_id:14,observed_at:at}],server_eta:{v:2,at,servedAt:at,buses:[['57','Orange Night',0,{stopId:10,standingSec:601,approach:false}]],rows:[[0,2,300,120,540,1,0,120,120]]}});
const missing=()=>[{markers:[{name:'Orange Night #57'}],labels:[]}];
const shown=()=>[{markers:[{name:'Orange Night #57. Waiting 10:03.'}],labels:[{text:'Orange Night #57 Stopped 10:03 · departure time unavailable',visible:true}]}];
const audit=(maps=missing(),f=feed(),time=now,receipt=receivedAt,stable=true)=>auditPauseMaps(maps,f,receipt,time,stable);

describe('served long-pause map clock coverage',()=>{
 test('detects missing visible and accessible clocks without using typical hold/departure tables',()=>{
  const r=audit();expect(r.checked).toBe(1);expect(r.findings).toHaveLength(1);
  expect(r.findings[0]).toMatchObject({label:'Orange Night',bus:'57',stopId:10,standingSec:603,missing:['accessible-clock','visible-clock']});
  expect(r.findings[0].source.forecastRow).toEqual(feed().server_eta.rows[0]);
  expect(audit(shown()).findings).toEqual([]);
 });
 test('counts server age and client elapsed once without assuming phone/server clocks agree',()=>{
  const f=feed();f.server_eta.buses[0][3].standingSec=177;f.server_eta.servedAt+=2404;
  expect(audit(missing(),f).findings[0].standingSec).toBeCloseTo(181.404,10);
  const short=feed();short.server_eta.buses[0][3].standingSec=177;
  expect(audit(missing(),short).checked).toBe(0);
  short.server_eta.buses[0][3].standingSec=178;
  expect(audit(missing(),short).checked).toBe(1);
 });
 test.each(['replacement','receipt-old','receipt-future','settling','forecast-old'])('resets coverage for %s rather than blaming the DOM',mode=>{
  const f=feed();let time=now,receipt=receivedAt,stable=true;
  if(mode==='replacement')stable=false;if(mode==='receipt-old')time=receipt+30001;
  if(mode==='receipt-future')receipt=time+1;if(mode==='settling')time=receipt+999;
  if(mode==='forecast-old')f.server_eta.servedAt=f.server_eta.at+43000;
  expect(audit(missing(),f,time,receipt,stable).checked).toBe(0);
 });
 test.each(['invalid-clock','missing-rows','bad-row','wrong-version','moving','old-GPS','future-GPS'])('unknown %s cannot establish a contradiction',mode=>{
  const f=feed();if(mode==='invalid-clock')f.server_eta.buses[0][3].standingSec=NaN;
  if(mode==='missing-rows')f.server_eta.rows=[];if(mode==='bad-row')f.server_eta.rows.push([0,2,1]);
  if(mode==='wrong-version')f.server_eta.v=3;if(mode==='moving')f.server_eta.buses[0][3]=null;
  if(mode==='old-GPS')f.buses[0].observed_at=at-30000;if(mode==='future-GPS')f.buses[0].observed_at=at+10000;
  expect(audit(missing(),f).findings).toEqual([]);
 });
 test.each(['wrong-route','wrong-bus','passed','duplicate-marker','duplicate-track','duplicate-bus'])('does not borrow identity through %s',mode=>{
  const f=feed(),maps=missing();
  if(mode==='wrong-route')maps[0].markers[0].name='Blue Night #57';
  if(mode==='wrong-bus')maps[0].markers[0].name='Orange Night #570';
  if(mode==='passed')maps[0].markers[0].name='Orange Night #57 — just passed';
  if(mode==='duplicate-marker')maps[0].markers.push({name:'Orange Night #57. Waiting 10:03.'});
  if(mode==='duplicate-track')f.server_eta.buses.push(structuredClone(f.server_eta.buses[0]));
  if(mode==='duplicate-bus')f.buses.push({...f.buses[0],bus_id:999});
  expect(audit(maps,f).checked).toBe(0);
 });
 test('checks both clocks and visible labels within their own map',()=>{
  const maps=shown();maps[0].labels[0].visible=false;
  expect(audit(maps).findings[0].missing).toEqual(['visible-clock']);
  maps[0].labels[0].visible=true;maps[0].markers[0].name='Orange Night #57';
  expect(audit(maps).findings[0].missing).toEqual(['accessible-clock']);
  const other=shown();other[0].markers=[];
  expect(audit([...missing(),...other]).findings).toHaveLength(1);
 });
 test('approach pauses and unknown departure support still require their observed clocks',()=>{
  const f=feed();f.server_eta.buses[0][3].approach=true;
  const maps=shown();maps[0].markers[0].name='Orange Night #57. Waiting nearby 10:03.';
  maps[0].labels[0].text='Orange Night #57 Stopped nearby 10:03 · departure time unavailable';
  expect(audit(maps,f).checked).toBe(1);expect(audit(maps,f).findings).toEqual([]);
 });
});

describe('sustained pause label episodes',()=>{
 const finding=()=>audit().findings[0];
 const later=(f,ms=10000)=>({...f,modelAt:f.modelAt+ms,observedAt:f.observedAt+ms,standingSec:f.standingSec+ms/1000});
 test('requires distinct producer and GPS observations; reports once; recovery allows a later episode',()=>{
  const f=finding(),first=confirmPauseMaps(null,[f],now);expect(first.alerts).toEqual([]);
  const cached=confirmPauseMaps(first.state,[f],now+10000);expect(cached.alerts).toEqual([]);
  const confirmed=confirmPauseMaps(cached.state,[later(f)],now+20000);expect(confirmed.alerts).toHaveLength(1);
  expect(confirmed.alerts[0].firstWitness).toEqual(f);
  expect(confirmPauseMaps(confirmed.state,[later(f,20000)],now+30000).alerts).toEqual([]);
  const cleared=confirmPauseMaps(confirmed.state,[],now+40000);expect(cleared.state).toEqual({});
  expect(confirmPauseMaps(cleared.state,[later(f,30000)],now+50000).alerts).toEqual([]);
 });
 test.each(['same-model','same-GPS','regressed-model','gap','stop-change','route-change'])('%s resets or cannot confirm',mode=>{
  const f=finding(),first=confirmPauseMaps(null,[f],now),next=later(f);let time=now+10000;
  if(mode==='same-model')next.modelAt=f.modelAt;if(mode==='same-GPS')next.observedAt=f.observedAt;
  if(mode==='regressed-model')next.modelAt=f.modelAt-1;if(mode==='gap')time=now+30001;
  if(mode==='stop-change')next.stopId=2;if(mode==='route-change')next.label='Blue Night';
  expect(confirmPauseMaps(first.state,[next],time).alerts).toEqual([]);
 });
});
