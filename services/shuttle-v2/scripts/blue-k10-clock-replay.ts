/** Hosted-only: production GPS tracking + startup recovery + forecast overlay,
 * compared with the independent frozen Python/causal-reducer experiment. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { TransitNetwork } from '../src/network/TransitNetwork.js';
import { K10Tracker } from '../src/collector/k10Tracker.js';
import type { BusObservation } from '../src/collector/detector.js';
import { K10_SCOPES, forwardStops } from '../src/collector/k10Scopes.js';
import { applyBlueK10Trial, BLUE_K10_MODELS } from '../src/server/blueK10Trial.js';
import type { ServerEtaWire } from '../web/src/etaSource.js';

const [topology, result] = process.argv.slice(2);
const read = (file: string) => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(s => JSON.parse(s));
const top = JSON.parse(fs.readFileSync(topology!, 'utf8'));
const features = read(`${result}/long90/forecasts.jsonl.gz`).filter(f => f.route === 1 || f.route === 16);
const names = new Set(features.map(f => f.bus));
const cutoff = Date.parse('2026-09-16T04:00:00Z') - 3_600_000;
const raw: BusObservation[] = [];
// Stream the full archive; retain only the buses and dates being compared.
const lines = readline.createInterface({ input: fs.createReadStream(`${result}/raw_positions.jsonl.gz`).pipe(zlib.createGunzip()) });
for await (const line of lines) {
  const r = JSON.parse(line);
  if (r.collected_at < cutoff || !names.has(r.bus_name)) continue;
  raw.push({ busId:r.bus_id,busName:r.bus_name,routeId:r.route_id,lat:r.lat,lon:r.lon,
    heading:r.heading,lastStopId:r.last_stop_id??null,collectedAt:r.collected_at });
}
raw.sort((a,b)=>a.collectedAt-b.collectedAt || a.busId-b.busId);
features.sort((a,b)=>a.asof-b.asof);
const histories = new Map<string, BusObservation[]>();
for (const o of raw) { const rows=histories.get(o.busName)??[]; rows.push(o); histories.set(o.busName,rows); }
const net=TransitNetwork.build(top.stops,top.routes), tracker=new K10Tracker();
const routes=Object.fromEntries(top.routes.map((r:any)=>[String(r.id),r.stops]));
let cursor=0, compared=0, active=0, released=0, restarts=0, maxReplayMs=0, changed=0;
let expired=0, latched=0, conservativeFallbacks=0;
const changedByRoute: Record<string,number> = {}, restartKeys=new Set<string>();
for(const f of features) {
  while(cursor<raw.length && raw[cursor]!.collectedAt<=f.asof) {
    const at=raw[cursor]!.collectedAt, group=[];
    while(cursor<raw.length && raw[cursor]!.collectedAt===at) group.push(raw[cursor++]!);
    tracker.update(net,group);
  }
  const name=f.bus.replace(/^#/,''), snapshot=tracker.snapshot(f.asof), e=snapshot.get(name);
  const model=BLUE_K10_MODELS.find(m=>m.routeId===f.route)!, scope=K10_SCOPES[f.route]!;
  const origin=f.origins[String(scope.sourceIndex)], exit=f.origins[String(scope.waitIndex)];
  if(e && f.at-e.origin.departed<=2_700_000) {
    assert(origin,`unexpected clock ${f.bus}/${f.at}`);
    assert.equal(e.routeId,f.route); assert.equal(e.origin.departed,origin.departed);
    assert.equal(e.origin.knownAt,origin.knownAt); assert.equal(e.index,f.index); assert.equal(e.phase,f.phase);
    const expectedRelease=Boolean(exit && exit.departed>origin.departed)
      || forwardStops(scope.sourceIndex,f.index,scope.stopCount)>10 || (f.index===scope.waitIndex && f.phase==='drive');
    if(e.released!==expectedRelease) {
      // A latched old-lap release is deliberately more conservative than the
      // research. It must never invent an earlier source or enable a forecast.
      assert(e.released && !expectedRelease); latched++;
    }
    compared++; if(e.released)released++;else active++;
    const restartKey=`${name}/${e.observedAt}`;
    if(compared%20===0 && !restartKeys.has(restartKey)) {
      const rows=histories.get(f.bus)!, current=rows.find(o=>o.collectedAt===e.observedAt && o.routeId===f.route);
      assert(current); const recovered=new K10Tracker();
      recovered.update(net,[current],o=>rows.filter(r=>r.collectedAt>=o.collectedAt-3_600_000 && r.collectedAt<o.collectedAt));
      assert.deepEqual(recovered.snapshot(f.asof).get(name),e,`restart ${restartKey}`);
      assert.equal(recovered.stats().errors,0); assert.equal(recovered.stats().rejected,0);
      maxReplayMs=Math.max(maxReplayMs,recovered.stats().maxReplayMs); restarts++; restartKeys.add(restartKey);
    }
  } else if(e) expired++;
  const base:ServerEtaWire={v:2,at:f.at,servedAt:f.at,
    buses:[[name,model.label,(model.sequence.indexOf(f.target)-f.stopsAhead+model.sequence.length)%model.sequence.length,null]],
    rows:[[0,f.target,f.baseline.eta,f.baseline.low,f.baseline.high,f.stopsAhead,0,0,0]],distributions:[Array(50).fill(123)]};
  const trial=applyBlueK10Trial(base,snapshot,routes), expected=f.forecasts.K10;
  if(expected.changed && !trial.trial!.changedRows) {
    assert(e?.released && latched>0,`unexplained lost forecast ${f.bus}/${f.at}/${f.target}`);
    conservativeFallbacks++;
  } else assert.equal(trial.trial!.changedRows,Number(expected.changed),`forecast choice ${f.bus}/${f.at}/${f.target}`);
  if(trial.trial!.changedRows) {
    assert.deepEqual(trial.rows[0]!.slice(2,5),['eta','low','high'].map(k=>Math.round(expected.forecast[k])));
    changed++;changedByRoute[model.label]=(changedByRoute[model.label]??0)+1;
  } else { assert.deepEqual(trial.rows,base.rows);assert.deepEqual(trial.distributions,base.distributions); }
}
assert(compared>2000);assert(active>1000);assert(released>100);assert(restarts>100);assert(changed>1500);
assert.equal(conservativeFallbacks,0,'Any difference from the qualified deployment cohort requires a new audit');
const audit={compared,active,released,restarts,maxReplayMs,changed,changedByRoute,expired,latched,conservativeFallbacks,
  assertion:'production GPS clocks, recovery and forecasts agree with frozen reference'};
fs.writeFileSync('blue-k10-production-audit.json',JSON.stringify(audit,null,2));console.log(JSON.stringify(audit,null,2));
