/** Read-only public-feed study, using a disposable in-memory collector DB. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, base: { type: 'string' }, network: { type: 'string' },
  raw: { type: 'string' }, out: { type: 'string' }, seconds: { type: 'string', default: '60' },
} });
if (!values.source || !values.base || !values.network || !values.raw || !values.out) {
  throw Error('Required: --source SERVICE_DIR --base BASE_SERVICE_DIR --network BUSES_JSON --raw POSITIONS_JSONL[.gz] --out RESULT_JSON');
}
const source = resolve(values.source), base = resolve(values.base);
const load = (dir: string, file: string) => import(pathToFileURL(join(dir, file)).href);
const { Collector } = await load(source, 'src/collector/collector.ts');
const { Collector: BaseCollector } = await load(base, 'src/collector/collector.ts');
const { UpstreamClient } = await load(source, 'src/collector/upstream.ts');
const { openDb } = await load(source, 'src/db/client.ts');
const { migrate } = await load(source, 'node_modules/drizzle-orm/better-sqlite3/migrator.js');
const { planTracks, reconcileTracks } = await load(source, 'src/collector/detector.ts');
const { distanceMeters } = await load(source, 'src/network/geo.ts');
const { parseCaptureLine, dedupeAndSort, groupPolls } = await load(source, 'scripts/eta-replay/rider-sim/lib.ts');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const rawBytes = readFileSync(values.raw), networkBytes = readFileSync(values.network);
const feed = JSON.parse(networkBytes.toString());
const parsed = (values.raw.endsWith('.gz') ? gunzipSync(rawBytes) : rawBytes).toString().trim().split('\n').map(parseCaptureLine);
if (parsed.some((r: any) => !r)) throw Error('Invalid raw row');
const rows = dedupeAndSort(parsed), polls = groupPolls(rows);
const seconds = Number(values.seconds);
if (!(seconds >= 0 && Number.isFinite(seconds))) throw Error('--seconds must be nonnegative (0 checks every poll)');
let current: any[] = [], at = rows[0].t, lastCheck = -Infinity;
const errors: unknown[] = [], mismatches: unknown[] = [];
const counts = { checkpointPolls: 0, candidateRestores: 0, baseRestores: 0, newlyRestored: 0, outsidePin: 0, beforeRest: 0 };
const routes: Record<string, { restored: number; newlyRestored: number }> = {};
const stops = Object.entries(feed.stop_coords).map(([id, coord]: any) => ({ id: +id, name: feed.stop_names[id], ...coord }));
const definitions = Object.entries(feed.routes).map(([id, stops]) => ({ id: +id, name: id, shortName: id, color: '#00f', stops, path: feed.route_paths?.[id] }));
class Stub extends UpstreamClient {
  constructor() { super({ baseUrl: 'http://invalid.test' }); }
  async buses() { return current; }
  async stops() { return stops; }
  async routes() { return definitions; }
}
const options = { upstream: new Stub(), upstreamEta: false, etaSampler: false,
  logger: { info() {}, warn() {}, error(message: string, meta?: unknown) { errors.push({ at, message, meta }); } } };
const realNow = Date.now;
Date.now = () => at;
const bundle = openDb(':memory:');
migrate(bundle.db, { migrationsFolder: join(source, 'drizzle') });
let reference: any;
try {
  reference = await Collector.create(bundle, options);
  await reference.refreshStaticIfNeeded(true);
  for (const batch of polls) {
    at = batch[0].t;
    current = batch.map((r: any) => ({ id: r.i, name: r.b, route: r.r, lat: r.lat, lon: r.lon, heading: r.h, lastStop: r.l }));
    if (at - lastCheck >= seconds * 1000) {
      lastCheck = at; counts.checkpointPolls++;
      const obs = batch.map((r: any) => ({ busId: r.i, busName: r.b, routeId: r.r, lat: r.lat, lon: r.lon, heading: r.h, lastStopId: r.l, collectedAt: r.t }));
      const plan = planTracks(obs);
      reconcileTracks(reference.states, plan); reconcileTracks(reference.visitStates, plan);
      // Match runPoll's explicit Blue West deadhead filter. No curb or
      // boarding criterion is weakened by this diagnostic.
      const cedar = reference.ref.get().stops.get(10);
      const serving = obs.filter((o: any) => o.routeId !== 16 || o.lastStopId !== 0
        || (cedar && distanceMeters(o, cedar) <= 75));
      const candidate = await Collector.create(bundle, options);
      const baseline = await BaseCollector.create(bundle, options);
      try {
        candidate.recoverOpenVisits(serving, plan); baseline.recoverOpenVisits(serving, plan);
        counts.baseRestores += baseline.states.size;
        for (const [key, detector] of candidate.states) {
          const visit = candidate.visitStates.get(key);
          const expected = { detector: reference.states.get(key), visit: reference.visitStates.get(key) };
          if (!isDeepStrictEqual({ detector, visit }, expected)) {
            mismatches.push(structuredClone({ at, key, routeId: detector.routeId,
              baseRestored: baseline.states.has(key), got: { detector, visit }, expected }));
          }
          counts.candidateRestores++;
          const perRoute = routes[detector.routeId] ??= { restored: 0, newlyRestored: 0 };
          perRoute.restored++;
          if (!baseline.states.has(key)) { counts.newlyRestored++; perRoute.newlyRestored++; }
          const observation = obs.find((o: any) => plan.keys.get(o.busId) === key);
          if (observation && distanceMeters(observation, candidate.ref.get().stops.get(detector.nearestStopId)) > 75) counts.outsidePin++;
          if (visit.pass.arrivedAt === null) counts.beforeRest++;
        }
      } finally { candidate.stop(); baseline.stop(); }
    }
    await reference.runPoll();
  }
  const result = { scope: 'Actual collector and SQL recovery, compared with uninterrupted pre-poll reducers at sampled cold-start checkpoints. Public-feed consistency only; not ETA accuracy or physical boarding truth.',
    uniqueRows: rows.length, polls: polls.length, intervalSeconds: seconds,
    inputs: { rawSha256: sha256(rawBytes), networkSha256: sha256(networkBytes) },
    source: Object.fromEntries(['src/collector/collector.ts', 'src/collector/visitRecovery.ts'].map(file => [file, { candidate: sha256(readFileSync(join(source, file))), base: sha256(readFileSync(join(base, file))) }])),
    counts, routes, mismatches, errors,
  };
  writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ uniqueRows: rows.length, counts, routes, mismatches: mismatches.length, errors: errors.length }));
  if (mismatches.length || errors.length) process.exitCode = 1;
} finally { reference?.stop(); bundle.sqlite.close(); Date.now = realNow; }
