/** Current code, release ON only. Outcomes choose output windows, never model inputs. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const archive = '/home/gwarren/projects/yale-shuttle-watcher';
const out = archive + '/overnight-2026-09-17/eta/cycle-2';
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const load = (p: string) => import(pathToFileURL(root + p).href);
const { setSampledFutureLap } = await load('/web/src/eta/arrival.ts');
const { setReleaseModelEnabled } = await load('/web/src/eta/release.ts');
const { computeUpcomingArrivals } = await load('/web/src/arrivals.ts');
const { registerRoutePaths } = await load('/web/src/anchor.ts');
const { applyModelParams } = await load('/web/src/eta/params.ts');
const { anchorKeyFor } = await load('/web/src/liveAnchor.ts');
const { ETA_MAX_AGE_MS } = await load('/web/src/etaSource.ts');
const { ServerEta } = await load('/src/server/serverEta.ts');
const topology = read(archive + '/red-eta-data/payload.json');
const patch = read(archive + '/conditional-replay-data/baseline-patch.json');
const params = read(archive + '/conditional-replay-data/params.json');
const segments: any = {}, dwells: any = {};
for (const [r, entries] of Object.entries(patch.segments) as any) segments[r] = Object.fromEntries(Object.entries(entries).map(([k, v]: any) => [k, { avg: 0, n: 0, ...v }]));
for (const [r, entries] of Object.entries(patch.dwells) as any) dwells[r] = Object.fromEntries(Object.entries(entries).map(([k, v]: any) => [k, { med: 0, n: 0, ...v }]));
for (const [r, v] of Object.entries(patch.pace) as any) (segments[r] ??= {}).__pace = { avg: 0, n: 0, spm: v.spm, spmN: v.n };
dwells['3']['11'].release = read(archive + '/release-integration-data/runtime-fits-pre-sep10.json').fits.find((f: any) => f.stopId === 11);
const payload = { routes: topology.routes, route_paths: topology.route_paths, stop_coords: topology.stop_coords, segments, dwells, model_params: params };
const cases = read(out + '/case-manifest.json').selection;
const windows = cases.map((c: any) => ({ sourceId: c.sourceId, bus: c.visit.bus_name, start: c.visit.pinned_at - 600000, end: Math.max(...c.journeys.map((j: any) => j.targetArrivedAt)) }));
const endAt = Math.max(...windows.map((w: any) => w.end));
const frames = fs.readFileSync(archive + '/conditional-replay-data/raw-frames.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
registerRoutePaths(topology.route_paths); applyModelParams(params);
setSampledFutureLap(true); setReleaseModelEnabled(true);
let store = new Map(), observed = new Map(), seen = new Map(), perBus = new Map();
let last = 0, n = 0, emitted = 0, segmentId = 0, parityChecks = 0;
const gaps: any[] = [];
const fd = fs.openSync(out + '/current-trace.jsonl', 'w');
const started = performance.now();
try {
  for (const frame of frames) {
    const at = Date.parse(frame.at);
    if (at > endAt) break;
    if (at === last) continue;
    if (!last || at - last > 60000) {
      store = new Map(); observed = new Map(); seen = new Map(); perBus = new Map(); segmentId++;
      gaps.push({ at, gapMs: last ? at - last : null });
    }
    const buses = frame.buses.filter((b: any) => b.route_id === 3 && (b.observed_at === undefined || at - b.observed_at < ETA_MAX_AGE_MS)).map((b: any) => {
      const key = b.route_id + '|' + b.bus_name, old = observed.get(key);
      if (old && b.observed_at !== undefined && old.observed_at === b.observed_at) return old;
      observed.set(key, b); return b;
    });
    for (const bus of buses) {
      const old = perBus.get(bus.bus_name);
      if (!old || at - old.last > 60000) perBus.set(bus.bus_name, { first: at, last: at }); else old.last = at;
      seen.set(anchorKeyFor('Red', bus.bus_name), at);
    }
    const arrivals = computeUpcomingArrivals([11, 48, 4], buses, payload.routes, payload.stop_coords, segments, at, dwells, store, true);
    for (const [key, t] of seen) if (at - t > 600000) { seen.delete(key); store.delete(key); }
    if (n % 1000 === 0) {
      const server: any = new ServerEta({ routes: ['Red'] });
      for (const [key, entry] of store) server.store.set(key, structuredClone(entry));
      const wire = server.contribute({ ...payload, buses }, n, at);
      for (const a of arrivals) {
        const bi = wire?.buses.findIndex((b: any) => b[0] === a.busName);
        const row = wire?.rows.find((r: any) => r[0] === bi && r[1] === a.stopId && r[5] === a.stopsAhead);
        if (!row || row[2] !== Math.round(a.eta) || row[3] !== Math.round(a.low) || row[4] !== Math.round(a.high)) throw Error('Full-server target parity mismatch');
        parityChecks++;
      }
    }
    for (const bus of buses) {
      const contexts = windows.filter((w: any) => w.bus === bus.bus_name && w.start <= at && at <= w.end).map((w: any) => w.sourceId);
      if (!contexts.length) continue;
      const entry = store.get(anchorKeyFor('Red', bus.bus_name)), b = entry?.belief;
      const state = b ? Object.fromEntries(['seenAt', 'fixAt', 'restSince', 'rested', 'restStop', 'restApproach', 'leftStop', 'leftSince', 'leftAt', 'serverSince', 'lastStopId', 'lead', 'fresh'].map(k => [k, b[k]])) : null;
      const forecasts = arrivals.filter((a: any) => a.busName === bus.bus_name.replace('#', '')).map((a: any) => ({ target: a.stopId, stopsAhead: a.stopsAhead, eta: a.eta, low: Math.max(0, a.low), high: a.high, departNow: a.departNow, distribution: a.distribution }));
      fs.writeSync(fd, JSON.stringify({ at, contexts, bus: bus.bus_name, segmentId, warmMs: at - perBus.get(bus.bus_name).first, observedAt: bus.observed_at ?? null, observation: bus, state, releasePin: entry?.releasePin ?? null, forecasts }) + '\n'); emitted++;
    }
    last = at; n++;
    if (n % 1000 === 0) console.error(JSON.stringify({ frames: n, emitted, elapsedSec: (performance.now() - started) / 1000 }));
  }
} finally { fs.closeSync(fd); }
const meta = { frames: n, emitted, parityChecks, gaps, elapsedSec: (performance.now() - started) / 1000, endAt, targets: [11, 48, 4], comparator: '40af3c0 release ON with archived causal development calibration', noCandidate: true, collectorClockProvenance: 'reconstructed; raw coordinates recorded', occurrences: 'infer by stopsAhead relative to 29-stop ring; h=29 ambiguous and must remain explicit' };
fs.writeFileSync(out + '/current-trace-meta.json', JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta));
