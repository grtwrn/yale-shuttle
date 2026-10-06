import {test, expect} from 'vitest';
import fs from 'node:fs';
import {UpstreamClient} from '../../src/collector/upstream.ts';
import {Collector} from '../../src/collector/collector.ts';
import {BOARD_M, oppositePickupCurb, pastPickup} from './inputs.mjs';
import {haversineM} from '../canary-metrics.mjs';

const controls = JSON.parse(fs.readFileSync(new URL('./__fixtures__/opposite-curb-heading-controls-2026-10.json', import.meta.url), 'utf8'));
const pink = controls.find(c => c.bus.bus_name === '#307');
async function parsedObservation(headingFields) {
  const upstream = {id:pink.bus.bus_id, name:pink.bus.bus_name, route:pink.bus.route_id,
    lat:pink.bus.lat, lon:pink.bus.lon, lastStop:pink.bus.last_stop_id, ...headingFields};
  const client = new UpstreamClient({baseUrl:'http://replay.invalid', fetchImpl:async() =>
    new Response(JSON.stringify([upstream]), {status:200, headers:{'content-type':'application/json'}})});
  const decoded = await client.buses();
  expect(decoded).toHaveLength(1);
  // Invoke the actual pure normalization method, without constructing a DB,
  // starting a collector, or copying its sanitizer into the test.
  const collector = Object.create(Collector.prototype);
  const observations = collector.sanitizeObservations(decoded, pink.bus.observed_at);
  expect(observations).toHaveLength(1);
  return {decoded:decoded[0], observation:observations[0]};
}

for (const [name, fields, nonfinite] of [
  ['omitted', {}, false], ['blank', {heading:''}, false],
  ['malformed string', {heading:'not-a-heading'}, true],
  ['NaN string', {heading:'NaN'}, true], ['infinite string', {heading:'Infinity'}, true],
  ['negative infinite string', {heading:'-Infinity'}, true],
  ['numeric zero', {heading:0}, false], ['string zero', {heading:'0'}, false],
]) test(name + ' upstream heading normalized to zero is not a northward witness', async() => {
  // Synthetic heading mutations of the recorded Pink position/metadata and
  // modelled named16 card. NOT recorded missing headings or physical service.
  const {decoded, observation} = await parsedObservation(fields);
  expect(Number.isFinite(decoded.heading)).toBe(!nonfinite);
  expect(observation.heading).toBe(0);
  expect(oppositePickupCurb({...pink.bus, heading:observation.heading}, pink.target, pink.card, pink.feed)).toBe(false);
});

test('nonzero parsed north evidence still vetoes, while recorded Pink south evidence does not', async() => {
  for (const [heading, veto] of [[30, true], [157, false], [360, true]]) {
    const {observation} = await parsedObservation({heading:String(heading)});
    expect(observation.heading).toBe(heading);
    const bus = {...pink.bus, heading:observation.heading};
    expect(oppositePickupCurb(bus, pink.target, pink.card, pink.feed)).toBe(veto);
    if (heading === 157) {
      // Preserve the recorded correct-direction proximity path. Eligibility
      // is a harness predicate, not proof of walk completion/physical pickup.
      expect(haversineM(bus, pink.feed.stop_coords[pink.target])).toBeLessThanOrEqual(BOARD_M);
      expect(pastPickup(bus, pink.target, pink.feed.stop_coords)).toBe(false);
    }
  }
  // With no provenance bit, even a genuine upstream zero must fail open.
  // 360 is an explicit finite north value; production defaults only to zero.
});
