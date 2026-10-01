/** Independently observe the wait addend inside forward sampling and the wire. */
import fs from 'node:fs';
import { deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const src = '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/cycle-2';
const out = '/home/gwarren/projects/yale-shuttle-watcher/overnight-2026-09-17/eta/review-round-2';
const load = (p: string) => import(pathToFileURL(root+p).href);
let source = fs.readFileSync(root+'/web/src/eta/arrival.ts', 'utf8');
source = source.replace(/(from\s+)(["'])(\.[^"']+)\2/g,
  (_all, prefix, quote, relative) => prefix+quote+new URL(relative+'.ts', pathToFileURL(root+'/web/src/eta/arrival.ts')).pathname+quote);
const replaceOnce = (before: string, after: string) => {
  assert.equal(source.split(before).length, 2);
  source = source.replace(before, after);
};
replaceOnce('  const paths: Float64Array[] = [ZERO, c.start];',
  '  const paths: Float64Array[] = [ZERO, c.start];\n  const firstWait = new Float64Array(K); let firstWinchester = false;');
replaceOnce('      dep[k] = current[k]! + (hop.includesStand ? 0 : stand * f);',
  '      if (stops[s] === 11 && !firstWinchester) firstWait[k] = hop.includesStand ? 0 : stand * f;\n      dep[k] = current[k]! + (hop.includesStand ? 0 : stand * f);');
replaceOnce('    departed.set(s, dep);',
  '    if (stops[s] === 11) firstWinchester = true;\n    departed.set(s, dep);');
replaceOnce('  c.sampled = paths;', '  c.sampled = paths;\n  reviewWaits.set(c, firstWait);');
replaceOnce('  const out: StopArrival[] = [];',
  '  reviewChains = chains.filter(c => c.sit.leg === lead.sit.leg).map(c => ({ ...c, wait: reviewWaits.get(c) }));\n  const out: StopArrival[] = [];');
source += '\nconst reviewWaits = new WeakMap<any, Float64Array>();\nexport let reviewChains: any[] = [];\n';
fs.writeFileSync(out+'/direct-wait-observer.generated.mts', source);

const observer = await import(pathToFileURL(out+'/direct-wait-observer.generated.mts').href);
const current = await load('/web/src/eta/arrival.ts');
const { registerRoutePaths } = await load('/web/src/anchor.ts');
const { applyModelParams } = await load('/web/src/eta/params.ts');
const { setReleaseModelEnabled } = await load('/web/src/eta/release.ts');
const { ringForBus, globalPoolsFor } = await load('/web/src/eta/index.ts');
const { buildTables } = await load('/web/src/eta/tables.ts');
const { ServerEta } = await load('/src/server/serverEta.ts');
const { anchorKeyFor } = await load('/web/src/liveAnchor.ts');
setReleaseModelEnabled(true);
current.setSampledFutureLap(true); observer.setSampledFutureLap(true);
const snapshots = deserialize(fs.readFileSync(src+'/component-snapshots.v8'));
const reference = JSON.parse(fs.readFileSync(src+'/component-probe.json', 'utf8'));
const result: any[] = [];
let wireRowChecks = 0, directWaitSamples = 0;
for (const snap of snapshots) {
  const {payload, bus, entry, at, sourceId} = snap;
  registerRoutePaths(payload.route_paths); applyModelParams(payload.model_params);
  const ring = ringForBus(bus, payload.routes['3'], payload.stop_coords);
  assert(ring);
  const tables = buildTables(ring.stops, payload.stop_coords, payload.segments['3'], payload.dwells['3'], ring,
    globalPoolsFor(payload.dwells).pools, ring.repaired ? ring.order : undefined);
  const args = [entry.belief, ring, tables, ring.stops, new Set([11,48,4]), at, .5];
  const unchanged = current.priceRoute(...args, structuredClone(entry.floors), bus.lap, true, entry.releasePin);
  const inspected = observer.priceRoute(...args, structuredClone(entry.floors), bus.lap, true, entry.releasePin);
  assert.deepEqual(inspected, unchanged);
  const model = reference.cases.find((c: any) => c.sourceId === sourceId);
  let mass = 0, meanWait = 0;
  for (const chain of observer.reviewChains) {
    const wait = chain.wait;
    assert(wait && wait.length === 256);
    meanWait += chain.sit.mass * wait.reduce((a: number, b: number) => a+b, 0)/wait.length;
    mass += chain.sit.mass; directWaitSamples += wait.length;
  }
  meanWait /= mass;
  assert(Math.abs(meanWait-model.sampledMeansBeforeDisplayCorrections.wait) < 1e-9);
  assert(Math.abs(mass-model.leadClusterMass) < 1e-12);
  const server: any = new ServerEta({routes:['Red']});
  server.store.set(anchorKeyFor('Red', bus.bus_name), structuredClone(entry));
  const wire = server.contribute({...payload, buses:[bus]}, 1, at);
  assert(wire && server.stats().failures === 0);
  const bi = wire.buses.findIndex((b: any) => b[0] === bus.bus_name.replace(/^#/, ''));
  const actual = wire.rows.map((row: any, i: number) => ({row, distribution: wire.distributions[i]}))
    .filter((x: any) => x.row[0] === bi && [11,48,4].includes(x.row[1]));
  assert.equal(actual.length, snap.forecasts.length);
  for (const expected of snap.forecasts) {
    const matching = actual.filter((x: any) => x.row[1] === expected.stopId && x.row[5] === expected.stopsAhead);
    assert.equal(matching.length, 1);
    const {row, distribution} = matching[0];
    for (const [col, field] of [[2,'eta'],[3,'low'],[4,'high'],[7,'departNow'],[8,'lowFloor']] as const)
      assert.equal(row[col], Math.round(expected[field]));
    assert.deepEqual(distribution, expected.distribution.map(Math.round));
    wireRowChecks++;
  }
  assert(!actual.some((x: any) => x.row[1] === 4 && x.row[5] > 29));
  result.push({sourceId, at, directWaitMeanSec:meanWait, leadClusterMass:mass, wireRows:actual.length,
    secondRosenkranzAbsent:true});
}
const report = {snapshots:snapshots.length, wireRowChecks, directWaitSamples, cases:result,
  scope:'Saved historical warm states with frozen calibration, not new continuous replay or exact production HTTP receipts.'};
fs.writeFileSync(out+'/snapshot-check.json', JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report, null, 2));
