import { expect, it } from 'vitest';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ADDITIONAL_K10_MODELS, applyRouteK10Trial } from './routeK10Trial.js';
import { blueK10GroupPredictions } from './blueK10Trial.js';
import type { K10Evidence } from '../collector/k10Clock.js';
import type { ServerEtaWire } from '../../web/src/etaSource.js';
import { K10_SCOPES } from '../collector/k10Scopes.js';
const fixtures = JSON.parse(gunzipSync(fs.readFileSync(new URL('./__fixtures__/route-k10-parity.json.gz',import.meta.url))).toString()) as {
  route:number; now:number; target:number; stopsAhead:number; anchor:number;
  baseline:{eta:number;low:number;high:number}; evidence:K10Evidence|null;
  expected:{changed:boolean;reason:string;forecast:{eta:number;low:number;high:number}};
}[];
const models = new Map(ADDITIONAL_K10_MODELS.map(m=>[m.routeId,m]));
const routes = Object.fromEntries(ADDITIONAL_K10_MODELS.map(m=>[String(m.routeId),m.sequence]));
const fixture = fixtures.find(f=>f.route===14 && f.expected.changed)!;
function wire(f = fixture): ServerEtaWire {
  return {v:2,at:f.now,servedAt:f.now,buses:[['42',models.get(f.route)!.label,f.anchor,null]],
    rows:[[0,f.target,f.baseline.eta,f.baseline.low,f.baseline.high,f.stopsAhead,0,50,20]],
    distributions:[Array(50).fill(900)]};
}
function evidence(f=fixture): Map<string,K10Evidence> {
  return f.evidence ? new Map([['42',{...f.evidence,routeId:f.route}]]) : new Map();
}
it('matches the independent Python broad-K10 forecast and fallback decisions on Orange Night', () => {
  expect(fixtures.length).toBeGreaterThan(1000);
  let changed=0;
  for(const f of fixtures) {
    const base=wire(f), trial=applyRouteK10Trial(base,evidence(f),routes);
    expect(trial.trial!.changedRows,`${f.route}/${f.now}/${f.target}/${f.expected.reason}`).toBe(Number(f.expected.changed));
    if(f.expected.changed) {
      changed++;
      expect(trial.rows[0]!.slice(2,5)).toEqual(['eta','low','high'].map(k=>Math.round(f.expected.forecast[k as keyof typeof f.expected.forecast])));
      const p=blueK10GroupPredictions(models.get(f.route)!,f.evidence!.origin.departed,f.now)!.get(f.target)!;
      for(const key of ['eta','low','high'] as const)expect(p[key]).toBeCloseTo(f.expected.forecast[key],7);
      expect(p.distribution).toHaveLength(50);expect(p.distribution).toEqual([...p.distribution].sort((a,b)=>a-b));
      expect(trial.rows[0]!.slice(5)).toEqual(base.rows[0]!.slice(5));
    } else {
      expect(trial.rows).toEqual(base.rows);expect(trial.distributions).toEqual(base.distributions);
    }
  }
  expect(changed).toBeGreaterThan(500);
},30_000);
it('pins collector checkpoints to each generated model and does not enable unsupported routes', () => {
  expect([...models.keys()].sort((a,b)=>a-b)).toEqual([14]);
  for(const m of models.values())expect(K10_SCOPES[m.routeId]).toEqual({sourceIndex:m.sourceIndex,waitIndex:m.waitIndex,stopCount:m.sequence.length});
  for(const label of ['Red','Blue Night','Blue Weekend','Green','Orange Day','Gold','Orange East']) {
    const base=wire();base.buses[0]=['42',label,fixture.anchor,null];
    const trial=applyRouteK10Trial(base,evidence(),routes);
    expect(trial.rows).toEqual(base.rows);expect(trial.distributions).toEqual(base.distributions);
  }
});
it('copies the entire live forecast after release and on stale, future, wrong-route or absent evidence', () => {
  const base=wire(), e={...fixture.evidence!,routeId:fixture.route};
  for(const bad of [{...e,released:true},{...e,observedAt:fixture.now-15_001},{...e,observedAt:fixture.now+1},
    {...e,routeId:1},{...e,origin:{...e.origin,knownAt:fixture.now+1}}]) {
    const trial=applyRouteK10Trial(base,new Map([['42',bad]]),routes);
    expect(trial.rows).toEqual(base.rows);expect(trial.distributions).toEqual(base.distributions);
  }
  expect(applyRouteK10Trial(base,new Map(),routes).rows).toEqual(base.rows);
});
it('keeps the model out of other route topologies and later-lap arrivals', () => {
  const base=wire();
  expect(applyRouteK10Trial(base,evidence(),{...routes,'14':routes['14']!.slice(1)}).rows).toEqual(base.rows);
  const later:ServerEtaWire={...base,rows:base.rows.map(r=>[r[0],r[1],r[2],r[3],r[4],r[5]+26,r[6],r[7],r[8]])};
  expect(applyRouteK10Trial(later,evidence(),routes).rows).toEqual(later.rows);
  const expired={...base,at:models.get(14)!.validUntil};
  expect(applyRouteK10Trial(expired,evidence(),routes).rows).toEqual(expired.rows);
});
it('returns the full group to live when even a different target lacks support or reaches expiry', () => {
  const m=models.get(14)!;
  const other=m.sequence.find((id,i)=>i!==m.waitIndex&&id!==fixture.target)!;
  expect(blueK10GroupPredictions({...m,paths:{...m.paths,[other]:[]}},fixture.evidence!.origin.departed,fixture.now)).toBeNull();
  const group=blueK10GroupPredictions(m,fixture.evidence!.origin.departed,fixture.now)!;
  const first=Math.min(...[...group.values()].map(p=>p.eta));
  expect(blueK10GroupPredictions(m,fixture.evidence!.origin.departed,fixture.now+(first-60)*1000+1)).toBeNull();
});
it('sorts competing arrivals and keeps the matching distribution with each row', () => {
  const base=wire();base.buses.push(['other','Green',0,null]);
  base.rows.push([1,fixture.target,1,0,2,1,0,0,0]);base.distributions!.push(Array(50).fill(1));
  const trial=applyRouteK10Trial(base,evidence(),routes);
  expect(trial.rows[0]![0]).toBe(1);expect(trial.distributions![0]).toEqual(Array(50).fill(1));
  expect(trial.trial!.byRoute!['Orange Night']).toBe(1);
});
