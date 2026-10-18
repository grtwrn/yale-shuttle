import {test} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {otherPickupOccurrence} from './inputs.mjs';
const capture=JSON.parse(await fs.readFile(new URL('../__fixtures__/blue-weekend-58-pickup-occurrence-2026-10-17.json',import.meta.url),'utf8'));
const sample=capture.samples.at(-1),now=Date.parse(sample.at);
const fixture=()=>({bus:structuredClone(sample.bus),feed:{...structuredClone(capture.feedMetadata),server_eta:structuredClone(sample.server_eta)},text:sample.text,at:now});
const check=({bus,feed,text,at}=fixture())=>otherPickupOccurrence(bus,53,text,feed,at);
const track=f=>f.server_eta.buses.find(b=>b[0]==='58');

test('a fresh named card and both stand observations identify the earlier route occurrence',()=>{
 const conflict=check();assert.equal(conflict.pickupStop,53);assert.equal(conflict.standingStop,21);assert.equal(conflict.stopsAway,2);
 for(const heading of [undefined,0,347]){const c=fixture();c.bus.heading=heading;assert(check(c));}
});
test('missing, stale, ambiguous or contradictory witnesses do not assert another occurrence',()=>{
 const cases=[
  ['no model',c=>delete c.feed.server_eta],
  ['old model version',c=>c.feed.server_eta.v=1],
  ['stale model',c=>c.feed.server_eta.at=now-30000],
  ['future model',c=>c.feed.server_eta.at=c.feed.server_eta.servedAt=now+5001],
  ['reversed model clocks',c=>c.feed.server_eta.servedAt=c.feed.server_eta.at-1],
  ['unknown raw clock',c=>delete c.bus.observed_at],
  ['stale raw clock',c=>c.bus.observed_at=now-30000],
  ['future raw clock',c=>c.bus.observed_at=now+5001],
  ['no current clock',c=>c.at=NaN],
  ['moving raw bus',c=>c.bus.stationary=false],
  ['raw bus outside its stand',c=>c.bus.lat+=0.002],
  ['model approach',c=>track(c.feed)[3].approach=true],
  ['missing approach flag',c=>delete track(c.feed)[3].approach],
  ['model moving',c=>track(c.feed)[3]=null],
  ['model at requested pickup',c=>track(c.feed)[3].stopId=53],
  ['model index disagrees',c=>track(c.feed)[2]++],
  ['ambiguous model bus',c=>c.feed.server_eta.buses.push(structuredClone(track(c.feed)))],
  ['another named bus',c=>c.text=c.text.replace('#58 ·','#330 ·')],
  ['conflicting card count',c=>c.text=c.text.replace('2 stops away','3 stops away')],
  ['one stop away',c=>c.text=c.text.replace('2 stops away','1 stop away')],
  ['at-pickup card',c=>c.text='BOARD🚌Elm / York (TYCO)'],
  ['duplicate card',c=>c.text+='\n🚌 #58 · 2 stops away'],
  ['missing route',c=>c.feed.routes={}],
  ['duplicate pickup occurrence',c=>c.feed.routes[4].push(53)],
  ['duplicate stand occurrence',c=>c.feed.routes[4].push(21)],
  ['pickup absent',c=>c.feed.routes[4]=c.feed.routes[4].filter(id=>id!==53)],
 ];
 for(const[label,change]of cases){const c=fixture();change(c);assert.equal(check(c),null,label);}
});
test('forward occurrence counts wrap across the route seam and do not depend on stop names or ids',()=>{
 const c=fixture(),seq=c.feed.routes[4],split=seq.indexOf(116);c.feed.routes[4]=[...seq.slice(split),...seq.slice(0,split)];track(c.feed)[2]=c.feed.routes[4].indexOf(21);assert(check(c));
 const remap=id=>id+1000;c.bus.at_stop_id=remap(c.bus.at_stop_id);c.feed.routes[4]=c.feed.routes[4].map(remap);track(c.feed)[3].stopId=remap(track(c.feed)[3].stopId);c.feed.stop_coords=Object.fromEntries(Object.entries(c.feed.stop_coords).map(([id,v])=>[remap(Number(id)),v]));c.feed.stop_names={};
 assert.equal(otherPickupOccurrence(c.bus,1053,c.text,c.feed,c.at)?.standingStop,1021);
});

const purple=JSON.parse(await fs.readFile(new URL('./__fixtures__/purple-329-pickup-visit-20261018.json',import.meta.url),'utf8'));
test('a named later pickup conflicts with boarding the same pole on an earlier pass',()=>{
 const sample=purple.samples.at(-1),feed={...purple.feedMetadata,server_eta:sample.server_eta};
 const conflict=otherPickupOccurrence(sample.bus,127,sample.text,feed,Date.parse(sample.at));
 assert(conflict);assert.equal(conflict.pickupStop,127);assert.equal(conflict.standingStop,127);assert.equal(conflict.stopsAway,6);
 assert.equal(conflict.reason,'pickup-still-ahead');
 // Recorded model index: requiring a different index or stop reintroduces it.
 assert.equal(conflict.modelIndex,4);
 for(const [label,change]of [
  ['stale source',c=>c.now+=30000],
  ['different named bus',c=>c.text=c.text.replace('#329 ·','#330 ·')],
  ['ambiguous named card',c=>c.text+='\n🚌 #329 · 6 stops away'],
  ['missing served stand',c=>c.feed.server_eta.buses.find(b=>b[0]==='329')[3]=null],
  ['model approach',c=>c.feed.server_eta.buses.find(b=>b[0]==='329')[3].approach=true],
  ['raw bus moving',c=>c.bus.stationary=false],
 ]){const c={bus:structuredClone(sample.bus),text:sample.text,feed:structuredClone(feed),now:Date.parse(sample.at)};change(c);assert.equal(otherPickupOccurrence(c.bus,127,c.text,c.feed,c.now),null,label);}
 assert.equal(otherPickupOccurrence(sample.bus,127,'BOARD🚌West Haven Train Station',feed,Date.parse(sample.at)),null);
});
