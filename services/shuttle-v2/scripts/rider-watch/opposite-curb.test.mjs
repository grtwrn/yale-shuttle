import {test} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {oppositePickupCurb} from './inputs.mjs';
const fixture=JSON.parse(await fs.readFile(new URL('./__fixtures__/orange-47-opposite-curb-2026-10-06.json',import.meta.url),'utf8'));
const poll=fixture.polls.at(-1), bus=poll.buses.find(b=>b.bus_name==='#47');
const feed={routes:{14:fixture.route.stops},stop_names:fixture.route.stop_names,stop_coords:fixture.route.stop_coords};
const check=(b=bus,text=poll.text,f=feed)=>oppositePickupCurb(b,42,text,f);

test('opposite-curb veto uses the current named card, direct position and nonadjacent route occurrences',()=>{
 assert.equal(check(),true);
 for(const [name,b,text,f] of [
  ['heading agrees with requested direction',{...bus,heading:180},poll.text,feed],
  ['perpendicular heading',{...bus,heading:90},poll.text,feed],
  ['missing heading',{...bus,heading:undefined},poll.text,feed],
  ['invalid heading',{...bus,heading:361},poll.text,feed],
  ['moving / lingering at_stop_id',{...bus,stationary:false},poll.text,feed],
  ['unknown curb',{...bus,at_stop_id:999},poll.text,feed],
  ['requested curb',{...bus,at_stop_id:42},poll.text,feed],
  ['stale north id closer to requested south pole',{...bus,...feed.stop_coords[42]},poll.text,feed],
  ['far from the directly named north curb',{...bus,lat:bus.lat+0.002},poll.text,feed],
  ['another named bus',bus,poll.text.replace('#47 ·','#53 ·'),feed],
  ['one stop away',bus,poll.text.replace('16 stops away','1 stop away'),feed],
  ['unnamed BOARD dwell',bus,'BOARD🚌College/Wall (S)\nGET OFFAmistad/Cedar',feed],
  ['duplicate/conflicting card',bus,poll.text+'\n🚌 #47 · 1 stop away',feed],
  ['ordinary differently named neighbour',bus,poll.text,{...feed,stop_names:{...feed.stop_names,41:'Elm / York (TYCO)'}}],
  ['same compass suffix',bus,poll.text,{...feed,stop_names:{...feed.stop_names,41:'College/Wall (S)'}}],
  ['perpendicular suffix',bus,poll.text,{...feed,stop_names:{...feed.stop_names,41:'College/Wall (E)'}}],
  ['route missing',bus,poll.text,{...feed,routes:{}}],
  ['opposite occurrence off this route',bus,poll.text,{...feed,routes:{14:feed.routes[14].filter(id=>id!==41)}}],
  ['adjacent opposite poles',bus,poll.text,{...feed,routes:{14:[1,41,42,13]}}],
  ['adjacent across loop boundary',bus,poll.text,{...feed,routes:{14:[41,1,13,42]}}],
  ['ambiguous repeated occurrence',bus,poll.text,{...feed,routes:{14:[...feed.routes[14],41]}}],
  ['missing requested coordinate',bus,poll.text,{...feed,stop_coords:{41:feed.stop_coords[41]}}],
 ]) assert.equal(check(b,text,f),false,name);
});
test('the same guard recognizes other nonadjacent N/S and E/W curbs without hardcoded stop ids',()=>{
 for(const [requested,observed,heading] of [[' (N)',' (S)',180],[' (E)',' (W)',270],[' (W)',' (E)',90]]){
  const f={...feed,stop_names:{...feed.stop_names,42:'Other / Place'+requested,41:'Other/Place'+observed}};
  assert.equal(check({...bus,heading},poll.text,f),true);
 }
});

const headingControls=JSON.parse(await fs.readFile(new URL('./__fixtures__/opposite-curb-heading-controls-2026-10.json',import.meta.url),'utf8'));
test('recorded heading distinguishes misleading opposite pole ids from an ambiguous turn',()=>{
 for(const {bus,target,card,feed,source,expectedVeto} of headingControls){
  assert.equal(oppositePickupCurb(bus,target,card,feed),expectedVeto,source);
  // Changing ONLY heading from the other curb's direction to the requested
  // direction switches this veto. A future GPS jump is not current service
  // evidence; never treat these modelled cards as door truth.
  const direction=feed.stop_names[bus.at_stop_id].match(/\(([NS])\)$/)[1];
  assert.equal(oppositePickupCurb({...bus,heading:direction==='N'?0:180},target,card,feed),true);
  assert.equal(oppositePickupCurb({...bus,heading:direction==='N'?180:0},target,card,feed),false);
 }
});
