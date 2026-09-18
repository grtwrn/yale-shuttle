// Bounded synthetic mechanism reproduction, not a reconstruction of live belief.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { priceRoute } from '../red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/arrival.ts';
import { stepBelief, situations } from '../red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/filter.ts';
import { buildRing } from '../red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/ring.ts';
import { buildTables } from '../red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/tables.ts';
import { resetModelParams } from '../red-lower-bound-2026-09-18/services/shuttle-v2/web/src/eta/params.ts';

resetModelParams();
const stops=[113,4,42,98];
const coords:Record<number,{lat:number;lon:number}>={113:{lat:41.31,lon:-72.93},4:{lat:41.31,lon:-72.92},42:{lat:41.314,lon:-72.92},98:{lat:41.314,lon:-72.93}};
const path:[number,number][]=[...stops,113].map(id=>[coords[id]!.lat,coords[id]!.lon]);
const ring=buildRing('3',path,stops,coords)!;
const segments=Object.fromEntries(stops.map((id,i)=>[`${id}-${stops[(i+1)%stops.length]}`,{avg:900,n:100,drive:900,driveN:100,dq:Array(10).fill(900),dqn:100}]));
const dwells=Object.fromEntries(stops.map(id=>[id,{med:30,n:100,qn:100,q:Array(10).fill(30)}]));
const tables=buildTables(stops,coords,segments,dwells,ring);
const now=Date.parse('2026-09-18T14:06:52.500Z'),pin=now-30000;
const belief=stepBelief(undefined,ring,{...coords[4]!,stationary_since:new Date(pin).toISOString()},now,stops);
let before=-1;
for(let c=0;c<ring.C;c++)if(ring.leg[c]===0&&(before<0||ring.frac[c]!>ring.frac[before]!))before=c;
assert.ok(before>=0);
belief.p.fill(0);belief.p[ring.C+before]=.78;belief.p[ring.stopCell[1]!]=.22;
belief.lead=0;belief.rested=true;belief.restStop=1;belief.restSince=pin;
const twoHypotheses=situations(belief,ring);
assert.equal(twoHypotheses.length,2);
const rows=priceRoute(belief,ring,tables,stops,new Set([4,42]),now,.5,undefined,undefined,true);
const first=rows.find(r=>r.stopId===4&&r.occurrence===0)!;
assert.ok(first.eta<120&&first.high>600);
belief.p.fill(0);belief.p[ring.C+before]=1;
const approachingOnly=priceRoute(belief,ring,tables,stops,new Set([4,42]),now,.5,undefined,undefined,true);
assert.ok(approachingOnly.find(r=>r.stopId===4&&r.occurrence===0)!.high<120);
belief.p.fill(0);belief.p[ring.stopCell[1]!]=1;belief.lead=1;
const atTargetOnly=priceRoute(belief,ring,tables,stops,new Set([4,42]),now,.5,undefined,undefined,true);
assert.equal(atTargetOnly.find(r=>r.stopId===4&&r.occurrence===0)!.eta,0);
const p=JSON.parse(fs.readFileSync(new URL('live-predeploy.json',import.meta.url),'utf8'));
const wire=p.server_eta,bi=wire.buses.findIndex((b:any)=>b[0]==='309'&&b[1]==='Red');
const observed=wire.rows.flatMap((r:any,i:number)=>r[0]===bi&&[4,42].includes(r[1])?[{row:r,distribution:wire.distributions[i]}]:[]);
const output={method:'Synthetic exact mechanism reproduction plus saved live evidence; not fitted and not the unavailable live posterior.',
  live:{at:wire.at,servedAt:wire.servedAt,track:wire.buses[bi],bus:p.buses.find((b:any)=>b.bus_name==='#309'),observed},
  synthetic:{twoHypotheses,rows,approachingOnly,atTargetOnly}};
fs.writeFileSync(new URL('rosenkranz-mixture-repro.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({hypotheses:twoHypotheses.map(s=>({leg:s.leg,standing:s.standing,zoneStop:s.zoneStop,mass:s.mass})),rows:rows.map(r=>({stop:r.stopId,occurrence:r.occurrence,hops:r.stopsAhead,eta:r.eta,low:r.low,high:r.high}))},null,2));
