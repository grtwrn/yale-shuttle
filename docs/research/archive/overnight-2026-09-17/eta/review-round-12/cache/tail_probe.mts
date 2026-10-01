/** Post-hoc state diagnostics only; never feeds forecasts. */
import fs from 'node:fs';import {gunzipSync} from 'node:zlib';import assert from 'node:assert/strict';
import {buildRing} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/ring.ts';
import {situations,LEAD_SWITCH_MASS} from '/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17/services/shuttle-v2/web/src/eta/filter.ts';
const O='/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-12/cache';
const payload=JSON.parse(fs.readFileSync("/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-4/calibration-payload.json",'utf8'));
const ring=buildRing('3',payload.route_paths['3'],payload.routes['3'],payload.stop_coords)!;assert.ok(ring);
const results=[];
for(const arm of ['current-warm','current-cold','canonical-warm']){
 const frames=JSON.parse(gunzipSync(fs.readFileSync(`${O}/${arm}.json.gz`)).toString());
 const f=frames.find((f:any)=>f.at===1789567542315);const bi=f.wire.buses.findIndex((x:any)=>x[0]==='308');assert.ok(bi>=0);
 const entry=f.beliefs.find(([k]:any)=>k.includes('308'));assert.ok(entry);const belief=entry[1];
 const sits=situations(belief,ring);const leadMass=sits.filter(s=>s.leg===belief.lead).reduce((n,s)=>n+s.mass,0);
 const rows=f.wire.rows.flatMap((r:any,i:number)=>r[0]===bi&&r[1]===115?[{row:r,distribution:f.wire.distributions[i]}]:[]);
 results.push({arm,at:f.at,bus:'308',stop:115,lead:belief.lead,leadMass,threshold:LEAD_SWITCH_MASS,fullMixtureGate:leadMass<LEAD_SWITCH_MASS,situations:sits,rows});
}
assert.equal(results[0].fullMixtureGate,false);assert.equal(results[1].fullMixtureGate,true);assert.equal(results[2].fullMixtureGate,true);
fs.writeFileSync(O+'/tail-probe.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({rows,situations,...r})=>r),null,2));
