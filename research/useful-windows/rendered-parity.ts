/** Validate research reminder rendering against the actual production helper. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {predictionWindow} from '../../services/shuttle-v2/web/src/arrivalDetails.ts';
import {remainingSec} from '../../services/shuttle-v2/web/src/format.ts';

const dir = process.argv[2];
assert(dir, 'Supply the rider-risk output directory');
let arms = 0, triggers = 0;
function check(f: any, computedAt: number, now: number, expected: any) {
  const window = predictionWindow(f.low, f.high, computedAt, now);
  const actual = window
    ? {sec: window.lowSec < 60 ? 0 : Math.floor(window.lowSec / 60) * 60, basis: 'window', text: window.text}
    : {sec: remainingSec(f.eta, computedAt, now), basis: 'point', text: null};
  assert.deepEqual(actual, expected);
}
const file = `${dir}/rider-risk-records.jsonl.gz`;
for await (const line of readline.createInterface({input: fs.createReadStream(file).pipe(zlib.createGunzip())})) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (r.policy !== 'rendered_lower') continue;
  if (r.renderedAtArm) {
    check(r.armForecast, r.armedAt, r.armedAt, r.renderedAtArm);
    arms++;
  }
  if (r.renderedAtTrigger) {
    check(r.triggerForecast, r.forecastAt, r.leaveNowAt, r.renderedAtTrigger);
    triggers++;
  }
}
assert(arms > 0 && triggers > 0, 'An empty comparison is not a passing parity check');
fs.writeFileSync(`${dir}/rendered-parity.json`, JSON.stringify({arms, triggers, mismatches: 0}, null, 2));
console.log(JSON.stringify({arms, triggers, mismatches: 0}));
