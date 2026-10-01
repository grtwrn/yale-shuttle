/** Replay recorded watcher payloads through the client, preserving its per-trip memory.
 * Usage: node --import tsx scripts/eta-replay/watcher-replay.ts WATCHER PAYLOAD OUTPUT
 * Calibration is a fixed supplied snapshot, not a reconstruction of historical polls.
 */
import fs from 'node:fs';
import { computeUpcomingArrivals } from '../../web/src/arrivals';
import { registerRoutePaths } from '../../web/src/anchor';
import { applyModelParams } from '../../web/src/eta/params';
import { ringForBus, type AnchorStore } from '../../web/src/eta';
import { situations } from '../../web/src/eta/filter';
import { ROUTE_LISTS, mergedRouteStops } from '../../web/src/routes';
import { anchorKeyFor } from '../../web/src/liveAnchor';
const [input, payload, output] = process.argv.slice(2);
if (!input || !payload || !output) throw new Error('Usage: WATCHER PAYLOAD OUTPUT');
const base = JSON.parse(fs.readFileSync(payload, 'utf8'));
registerRoutePaths(base.route_paths);
if (!applyModelParams(base.model_params)) throw new Error('Invalid model params');
const cfg = ROUTE_LISTS.find(c => c.label === 'Red')!;
const stops = mergedRouteStops(cfg, base.routes);
let store: AnchorStore = new Map(), run = '', prev = 0;
const fd = fs.openSync(output, 'w');
let n = 0;
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n')) {
  const f = JSON.parse(line), now = Date.parse(f.at);
  if (f.runId !== run || now - prev > 60_000) store = new Map();
  run = f.runId; prev = now;
  const buses = f.buses.filter((b: any) => b.route_id === 3);
  const arrivals = computeUpcomingArrivals(stops, buses, base.routes, base.stop_coords, base.segments, now, base.dwells, store);
  for (const bus of buses) {
    const belief = store.get(anchorKeyFor('Red', bus.bus_name))?.belief;
    const ring = ringForBus(bus, stops, base.stop_coords);
    fs.writeSync(fd, JSON.stringify({ at: f.at, runId: run, phase: f.phase, bus,
      arrivals: arrivals.filter(a => a.busName === bus.bus_name.replace(/^#/, '')),
      belief: belief && { lead: belief.lead, rested: belief.rested, restStop: belief.restStop,
        since: belief.restSince, restApproach: belief.restApproach },
      situations: belief && ring ? situations(belief, ring) : [],
    }) + '\n');
  }
  n++;
}
fs.closeSync(fd);
console.log(JSON.stringify({ frames: n, output, params: base.model_params.version }));
