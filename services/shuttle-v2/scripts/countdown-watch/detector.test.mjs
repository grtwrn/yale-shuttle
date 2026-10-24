import {it as test} from 'vitest';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDetector} from './detector.mjs';

// Synthetic transport controls, not arrival outcomes or recorded forecasts.
function observation(seq, eta, {at = 1_000_000 + seq * 5000, anchor = 4,
  id = 101, stationary = true, atStop = 25, stand = 25, version = 'fixture-only',
  extraETA = null, unavailable = false, absent = false} = {}) {
  const rows = absent ? [] : [[0, 22, eta, eta - 30, eta + 100, 3, 0, eta, eta - 30]];
  if (!absent && extraETA !== null) rows.push([0, 22, extraETA, extraETA - 30, extraETA + 100, 21, 0, extraETA, extraETA - 30]);
  const wire = unavailable ? null : {v: 2, at, servedAt: at,
    buses: [['101', 'Green', anchor, stand === null ? null : {stopId: stand, standingSec: 20 + seq * 5, approach: false}]],
    travel: [anchor], rows, distributions: rows.map(r => Array(50).fill(r[2])),
    repeatVisits: extraETA === null ? [] : [[0, 22, 21]]};
  const payload = {model_params: {version}, segments: {}, dwells: {},
    buses: [{bus_name: '#101', route_id: 9, bus_id: id, lat: 41.255, lon: -72.993,
      stationary, at_stop_id: atStop, last_stop_id: 143}], server_eta: wire};
  const json = JSON.stringify(payload),contextJson = JSON.stringify({v: 1, at});
  const sha = x => createHash('sha256').update(x).digest('hex');
  return [{seq,at,json,sha256:sha(json),contextJson,contextSha256:sha(contextJson)},payload];
}
function run(values) {const d=createDetector();for(const value of values)d.observe(...value);return d;}

test('a smooth countdown does not create an excursion', () => {
  const d=run([observation(0,180),observation(1,175),observation(2,170)]);
  assert.equal(d.events.length,0);assert.equal(d.counts.largeConsecutiveMoves,0);
});
test('a held-anchor jump and return retains all three offers and distributions', () => {
  const d=run([observation(0,180),observation(1,3022),observation(2,170)]);
  assert.equal(d.events.length,1);const e=d.events[0];
  assert.equal(e.before.minimumETASeconds,180);assert.equal(e.jump.minimumETASeconds,3022);
  assert.equal(e.returned.minimumETASeconds,170);assert.equal(e.samePhysicalIdentity,true);
  assert.equal(e.physicalETAErrorEstablished,false);
  for(const s of [e.before,e.jump,e.returned])assert.equal(s.rows[0].distribution.length,50);
});
test('a sustained reprice is not classified as a completed roundtrip', () => {
  const d=run([observation(0,180),observation(1,3022),observation(2,3017),observation(27,2892)]);
  assert.equal(d.events.length,0);assert.equal(d.counts.expiredExcursions,1);
});
test('advancing the travel anchor ends the held-anchor comparison', () => {
  const d=run([observation(0,180),observation(1,3022),observation(2,170,{anchor:5})]);
  assert.equal(d.events.length,0);assert.equal(d.counts.anchorChangedExcursions,1);
});
test('an unavailable forecast breaks continuity', () => {
  const d=run([observation(0,180),observation(1,3022),observation(2,0,{unavailable:true}),observation(3,165)]);
  assert.equal(d.events.length,0);assert.equal(d.counts.emptyWires,1);
});
test('a missing pickup group breaks continuity', () => {
  const d=run([observation(0,180),observation(1,3022),observation(2,0,{absent:true}),observation(3,165)]);
  assert.equal(d.events.length,0);assert.equal(d.counts.missingGroupExcursions,1);
});
test('a long observation gap cannot close a short roundtrip', () => {
  const d=run([observation(0,180),observation(1,3022),observation(27,45)]);
  assert.equal(d.events.length,0);assert.equal(d.counts.expiredExcursions,1);
});
test('a provider identity change remains explicit and is not called the same physical bus', () => {
  const d=run([observation(0,180),observation(1,3022,{id:102}),observation(2,170,{id:102})]);
  assert.equal(d.events.length,1);assert.equal(d.events[0].samePhysicalIdentity,false);
  assert.equal(d.events[0].physicalETAErrorEstablished,false);
});
test('changed telemetry and stand flags do not suppress the reproduced defect class', () => {
  const d=run([observation(0,180),observation(1,3022,{stationary:false,atStop:null,stand:null}),observation(2,170,{atStop:22,stand:22})]);
  assert.equal(d.events.length,1);assert.equal(d.events[0].jump.rawBuses[0].stationary,false);
  assert.equal(d.events[0].jump.servedBus[3],null);
});
test('every repeated physical-call row and its following flag remain available', () => {
  const d=run([observation(0,180,{extraETA:2800}),observation(1,3022,{extraETA:900}),observation(2,170,{extraETA:2790})]);
  assert.equal(d.events.length,1);const e=d.events[0];
  for(const s of [e.before,e.jump,e.returned]){
    assert.equal(s.rows.length,2);assert.equal(s.rows[1].explicitFollowing,true);
    assert.equal(s.rows[0].distribution.length+s.rows[1].distribution.length,100);
  }
  assert.equal(e.jump.minimumETARows[0].row[4],21);
  assert.equal(e.physicalVisitIdentity,'unknown; no physical-call matching or arrival outcome credit');
});
test('ties preserve both offers rather than manufacturing a unique visit', () => {
  const d=run([observation(0,180,{extraETA:180}),observation(1,3022,{extraETA:3022}),observation(2,170,{extraETA:170})]);
  assert.equal(d.events.length,1);assert.equal(d.counts.minETATies,3);
  for(const s of [d.events[0].before,d.events[0].jump,d.events[0].returned])assert.equal(s.minimumETARows.length,2);
});
test('separate detector instances do not share state across source namespaces', () => {
  const old=createDetector(),next=createDetector();old.observe(...observation(0,180));
  next.observe(...observation(1,3022));next.observe(...observation(2,170));
  assert.equal(old.events.length,0);assert.equal(next.events.length,0);
});
test('changed calibration tables remain review context without becoming a physical error claim', () => {
  const d=run([observation(0,180),observation(1,3022,{version:'other-fixture'}),observation(2,170)]);
  assert.equal(d.events.length,1);assert.equal(d.events[0].calibrationTablesUnchanged,false);
  assert.equal(d.events[0].physicalETAErrorEstablished,false);
});
