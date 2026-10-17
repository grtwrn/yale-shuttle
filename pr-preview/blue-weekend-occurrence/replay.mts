/** Read-only replay of public fleet captures; run with tsx. See README.md. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, network: { type: 'string' },
  raw: { type: 'string' }, out: { type: 'string' },
} });
if (!values.source || !values.network || !values.raw || !values.out) {
  throw new Error('Required: --source SERVICE_DIRECTORY --network BUSES_JSON --raw POSITIONS_JSONL[.gz] --out RESULT_JSON');
}
const source = resolve(values.source);
const moduleAt = (file: string) => import(pathToFileURL(join(source, file)).href);
const { TransitNetwork } = await moduleAt('src/network/TransitNetwork.ts');
const { stepManyWithVisits } = await moduleAt('src/collector/departure.ts');
const { parseCaptureLine, dedupeAndSort, groupPolls } = await moduleAt('scripts/eta-replay/rider-sim/lib.ts');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const networkBytes = readFileSync(values.network), rawBytes = readFileSync(values.raw);
const feed = JSON.parse(networkBytes.toString());
const net = TransitNetwork.build(
  Object.entries(feed.stop_coords).map(([id, coord]: any) => ({ id: Number(id), name: feed.stop_names[id], ...coord })),
  Object.entries(feed.routes).map(([id, stops]) => ({ id: Number(id), name: id, shortName: id, color: '#00f', stops, path: feed.route_paths?.[id] })),
);
const raw = values.raw.endsWith('.gz') ? gunzipSync(rawBytes) : rawBytes;
const lines = raw.toString().trim().split('\n');
const parsed = lines.map(parseCaptureLine);
if (parsed.some((row: any) => !row)) throw new Error('Malformed capture row');
const rows = dedupeAndSort(parsed);
const states = new Map(), visitStates = new Map();
const events: any[] = [];
for (const batch of groupPolls(rows)) {
  const next = stepManyWithVisits(net, states, visitStates, batch.map((r: any) => ({
    busId: r.i, busName: r.b, routeId: r.r, lat: r.lat, lon: r.lon,
    heading: r.h, lastStopId: r.l, collectedAt: r.t,
  })));
  events.push(...next.events, ...next.visits);
}
const byRoute = Object.fromEntries([...new Set(events.map(e => e.routeId))].map(routeId => {
  const routeEvents = events.filter(e => e.routeId === routeId);
  const visitCounts: Record<string, number> = {}, kinds: Record<string, number> = {};
  for (const e of routeEvents) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.kind === 'visit') visitCounts[e.stopId] = (visitCounts[e.stopId] ?? 0) + 1;
  }
  return [routeId, { count: routeEvents.length, sha256: sha256(JSON.stringify(routeEvents)), kinds, visitCounts }];
}));
const result = {
  scope: 'Detector/visit consistency replay; public feed corroboration is not independent physical boarding truth or an ETA accuracy evaluation.',
  rawRows: parsed.length, uniqueRows: rows.length,
  inputs: { networkSha256: sha256(networkBytes), rawSha256: sha256(rawBytes) },
  source: Object.fromEntries([
    'src/collector/detector.ts', 'src/collector/departure.ts',
    'src/network/TransitNetwork.ts', 'scripts/eta-replay/rider-sim/lib.ts',
    'scripts/eta-replay/rider-sim/served-matching.ts',
  ].map(file => [file, sha256(readFileSync(join(source, file)))])),
  byRoute,
  blueElmYorkVisits: events.filter(e => e.kind === 'visit' && e.routeId === 4 && e.stopId === 53),
};
writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ uniqueRows: rows.length, byRoute }, null, 2));
