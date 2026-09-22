/** Hosted-only reconstruction of visits and their causal knowledge timestamps.
 * No stored/finalized visits, predictions, history seeds or EOF closures enter.
 *
 * Run from repository root after downloading the frozen K-sweep artifact:
 * services/shuttle-v2/node_modules/.bin/tsx research/useful-windows/training-visits.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { TransitNetwork } from '../../services/shuttle-v2/src/network/TransitNetwork.ts';
import { planTracks, type BusObservation, type BusState } from '../../services/shuttle-v2/src/collector/detector.ts';
import { stepManyWithVisits, type VisitState } from '../../services/shuttle-v2/src/collector/departure.ts';
import { visitRowsOf } from '../../services/shuttle-v2/src/collector/visitRows.ts';

const input = 'research/k-sweep/results/raw_positions.jsonl.gz';
const output = 'research/useful-windows/rolling-results/';
const topologyFile = 'research/k-sweep/data/topology.json';
const topologyBytes = fs.readFileSync(topologyFile);
const topology = JSON.parse(topologyBytes.toString());
const network = TransitNetwork.build(topology.stops, topology.routes);
const routeIds = new Set<number>(topology.routes.map((r: { id: number }) => r.id));
const sequenceByRoute = new Map<number, number[]>(topology.routes.map((r: { id: number; stops: number[] }) => [r.id, r.stops]));
// TransitNetwork.build may repair a published route order. Models and its
// frozen wait map still use topology.routes[].stops: do not silently translate
// occurrence indices, or admit the matching fragments of a reordered lap.
const networkSequenceByRoute = new Map([...network.routes].map(([id, route]) => [id, route.stops]));
const sequenceDifferences = Object.fromEntries([...sequenceByRoute].flatMap(([id, sequence]) => {
  const actual = networkSequenceByRoute.get(id);
  return JSON.stringify(sequence) === JSON.stringify(actual) ? [] : [[id, {
    name: network.routes.get(id)?.name ?? null, frozen: sequence, reducer: actual ?? null,
  }]];
}));
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', weekday: 'short' });
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface TrainingVisit {
  id: number;
  known_at: number;
  bus_name: string;
  route_id: number;
  stop_id: number;
  stop_index: number;
  anchored_at: number;
  arrived_at: number | null;
  departed_at: number | null;
  outcome: string;
  how: string | null;
  closest_m: number;
  replay_fit_eligible: boolean;
  replay_topology_exclusion: string | null;
  [key: string]: unknown;
}
interface RouteAudit {
  observations: number;
  visits: number;
  completed: number;
  passed: number;
  stopped: number;
  unresolved: number;
  gaps: number;
  contendedAtEmission: number;
  fitTopologyEligible: number;
  topologyExcluded: number;
  unexpectedCompletedTopology: number;
}
const emptyRouteAudit = (): RouteAudit => ({ observations: 0, visits: 0, completed: 0,
  passed: 0, stopped: 0, unresolved: 0, gaps: 0, contendedAtEmission: 0,
  fitTopologyEligible: 0, topologyExcluded: 0, unexpectedCompletedTopology: 0 });

const raw: BusObservation[] = [];
const rawHash = createHash('sha256');
const compressed = fs.createReadStream(input);
compressed.on('data', chunk => rawHash.update(chunk));
let inputRows = 0;
for await (const line of readline.createInterface({ input: compressed.pipe(zlib.createGunzip()) })) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  inputRows++;
  // The archive contains already-sanitized production observations. Fail on
  // corruption rather than silently changing the training population.
  assert(Number.isSafeInteger(r.collected_at), 'Invalid raw observation timestamp');
  assert(Number.isFinite(r.bus_id) && typeof r.bus_name === 'string' && r.bus_name.length > 0,
    'Invalid raw provider/vehicle identity');
  assert(Number.isFinite(r.route_id) && Number.isFinite(r.lat) && Number.isFinite(r.lon)
    && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && (r.lat !== 0 || r.lon !== 0), 'Invalid raw route/position');
  raw.push({ busId: r.bus_id, busName: r.bus_name, routeId: r.route_id,
    lat: r.lat, lon: r.lon, heading: Number.isFinite(r.heading) ? r.heading : 0,
    lastStopId: Number.isFinite(r.last_stop_id) ? r.last_stop_id : null, collectedAt: r.collected_at });
}
assert(raw.length > 0, 'No raw observations to reconstruct');
raw.sort((a, b) => a.collectedAt - b.collectedAt || a.busId - b.busId);

function replay(observations: readonly BusObservation[]) {
  const states = new Map<string, BusState>();
  const visits = new Map<string, VisitState>();
  const rows: TrainingVisit[] = [];
  const perRoute: Record<string, RouteAudit> = Object.fromEntries([...routeIds].map(id => [id, emptyRouteAudit()]));
  const unknownRouteObservations: Record<string, number> = {};
  let polls = 0, exactDuplicates = 0, contendedNamePolls = 0, discardedLegEvents = 0;
  let lastPoll = -Infinity;
  for (let cursor = 0; cursor < observations.length;) {
    const at = observations[cursor]!.collectedAt;
    assert(at > lastPoll, 'Observation batches must advance strictly');
    lastPoll = at;
    const byProvider = new Map<number, BusObservation>();
    while (cursor < observations.length && observations[cursor]!.collectedAt === at) {
      const o = observations[cursor++]!;
      const duplicate = byProvider.get(o.busId);
      if (duplicate) {
        // Exact overlap between exports is harmless. Two contradictory fixes
        // for one provider in a poll are corrupt, never a choice of best fix.
        assert.deepEqual(o, duplicate, `Conflicting provider ${o.busId} at ${at}`);
        exactDuplicates++;
      } else byProvider.set(o.busId, o);
    }
    const group = [...byProvider.values()];
    const plan = planTracks(group);
    contendedNamePolls += plan.contendedNames.size;
    for (const o of group) {
      if (routeIds.has(o.routeId)) perRoute[o.routeId]!.observations++;
      else unknownRouteObservations[o.routeId] = (unknownRouteObservations[o.routeId] ?? 0) + 1;
    }
    // Pass EVERY assignment to the production reducer, including an assignment
    // outside the frozen topology. Filtering it out could bridge a route change.
    // planTracks preserves simultaneously contended names as provider-qualified
    // tracks; the reducer itself handles provider handoffs and observation gaps.
    const stepped = stepManyWithVisits(network, states, visits, group, plan);
    const emitted = stepped.visits.filter(e => e.kind === 'visit');
    discardedLegEvents += stepped.visits.length - emitted.length;
    assert(emitted.length < 1000, 'Synthetic per-poll visit ID capacity exceeded');
    const mapped = visitRowsOf(emitted).visitRows;
    for (const [ordinal, mappedRow] of mapped.entries()) {
      const row = Object.fromEntries(Object.entries(mappedRow).map(([key, value]) => [
        key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), value instanceof Date ? value.getTime() : value,
      ])) as TrainingVisit;
      const frozenStop = sequenceByRoute.get(row.route_id)?.[row.stop_index];
      const networkStop = networkSequenceByRoute.get(row.route_id)?.[row.stop_index];
      const networkOccurrenceValid = Number.isInteger(row.stop_index) && row.stop_index >= 0
        && networkStop === row.stop_id;
      row.replay_topology_exclusion = !routeIds.has(row.route_id) ? 'route outside frozen topology'
        : !networkOccurrenceValid ? 'emission disagrees with reducer topology'
        : Object.hasOwn(sequenceDifferences, row.route_id) ? 'reducer route order differs from frozen fit topology'
        : frozenStop !== row.stop_id ? 'emission disagrees with frozen fit topology' : null;
      row.replay_fit_eligible = row.replay_topology_exclusion === null;
      if (!row.replay_fit_eligible) {
        // Keep the original event and occurrence fields intact for diagnosis.
        // These rows go to a separate artifact, never to the Models input.
        row.replay_frozen_stop_id = frozenStop ?? null;
        row.replay_network_stop_id = networkStop ?? null;
        row.replay_emitted_event = emitted[ordinal];
        row.replay_emission_observations = group.filter(o => o.busName === row.bus_name || o.busId === row.bus_id);
      }
      // Poll time plus within-poll emission order is deterministic, safe as a
      // JS integer, chronological at tied anchors, and invariant to removing
      // any future suffix. These IDs never join stored evaluation visit IDs.
      row.id = at * 1000 + ordinal;
      assert(Number.isSafeInteger(row.id), 'Unsafe synthetic visit ID');
      row.known_at = at;
      row.replay_contended_at_emission = plan.contendedNames.has(row.bus_name);
      assert(row.anchored_at <= at && (row.arrived_at === null || row.arrived_at <= at)
        && (row.departed_at === null || row.departed_at <= at), 'Visit uses a future event time');
      if (row.arrived_at !== null && row.departed_at !== null) {
        assert(row.arrived_at <= row.departed_at, 'Visit departure precedes arrival');
      }
      // visitRowsOf normally uses process TZ. Pin these descriptive fields to
      // ET without depending on the hosted runner's environment.
      const parts = et.formatToParts(row.arrived_at ?? row.anchored_at);
      row.dow = weekdays.indexOf(parts.find(p => p.type === 'weekday')!.value);
      row.hour = Number(parts.find(p => p.type === 'hour')!.value);
      rows.push(row);
      const count = perRoute[row.route_id] ??= emptyRouteAudit();
      count.visits++;
      const completed = row.arrived_at !== null && row.departed_at !== null && row.outcome !== 'unresolved' && row.how !== 'gap';
      if (completed) count.completed++;
      if (row.replay_fit_eligible) count.fitTopologyEligible++;
      else count.topologyExcluded++;
      if (completed && !networkOccurrenceValid) count.unexpectedCompletedTopology++;
      if (row.outcome === 'passed') count.passed++;
      if (row.outcome === 'stopped') count.stopped++;
      if (row.outcome === 'unresolved') count.unresolved++;
      if (row.how === 'gap') count.gaps++;
      if (row.replay_contended_at_emission) count.contendedAtEmission++;
    }
    polls++;
  }
  // Do not close/prune anything merely because the archive or tested prefix
  // ended. Missing future departure evidence must stay missing.
  return { rows, audit: { polls, observations: observations.length, exactDuplicates,
    contendedNamePolls, discardedLegEvents, perRoute, unknownRouteObservations,
    unfinishedVisitTracks: visits.size, unfinishedPinnedPasses: [...visits.values()].filter(v => v.pass?.pinnedAt != null).length,
    stateTracks: states.size, eofClosures: 0 } };
}

const full = replay(raw);
assert(full.rows.length > 0, 'Reconstruction emitted no visits');
assert(new Set(full.rows.map(r => r.id)).size === full.rows.length, 'Duplicate synthetic visit IDs');
const first = raw[0]!.collectedAt, last = raw.at(-1)!.collectedAt;
// Exercise the first and last fitting cutoffs plus an independent mid-capture
// boundary. Physically remove every future observation before each fresh replay.
const requestedCutoffs = [Date.parse('2026-09-16T00:00:00-04:00'),
  Date.parse('2026-09-19T00:00:00-04:00'), raw[Math.floor(raw.length / 2)]!.collectedAt + 1];
const checks: Array<{ cutoff: number; inputRows: number; deletedFutureRows: number; emittedVisits: number; identical: true }> = [];
for (const cutoff of [...new Set(requestedCutoffs)].filter(t => t > first && t <= last).sort((a, b) => a - b)) {
  const earlier = raw.filter(o => o.collectedAt < cutoff);
  const prefix = replay(earlier);
  const expected = full.rows.filter(v => v.known_at < cutoff);
  assert(expected.length > 0 && expected.length < full.rows.length, 'Vacuous prefix invariance comparison');
  assert.deepEqual(prefix.rows, expected, `Future GPS changed a visit known before ${cutoff}`);
  checks.push({ cutoff, inputRows: earlier.length, deletedFutureRows: raw.length - earlier.length,
    emittedVisits: prefix.rows.length, identical: true });
}
assert(checks.length > 0, 'No nontrivial prefix-deletion checks ran');

fs.mkdirSync(output, { recursive: true });
const fitRows = full.rows.filter(r => r.replay_fit_eligible);
const excludedRows = full.rows.filter(r => !r.replay_fit_eligible);
for (const [file, rows] of [['training-visits', fitRows], ['training-visits-topology-excluded', excludedRows]] as const) {
  fs.writeFileSync(output + file + '.jsonl.gz', zlib.gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')));
}
const exclusionReasons: Record<string, number> = {};
for (const row of excludedRows) exclusionReasons[row.replay_topology_exclusion!] = (exclusionReasons[row.replay_topology_exclusion!] ?? 0) + 1;
const audit = { input, inputSha256: rawHash.digest('hex'), inputRows,
  topology: topologyFile, topologySha256: createHash('sha256').update(topologyBytes).digest('hex'),
  firstObservationAt: first, lastObservationAt: last, emittedVisits: full.rows.length,
  trainingTopologyEligibleVisits: fitRows.length, topologyExcludedVisits: excludedRows.length,
  topologyExclusionReasons: exclusionReasons, routeSequenceDifferences: sequenceDifferences,
  routeNames: Object.fromEntries(topology.routes.map((r: { id: number; name: string }) => [r.id, r.name])),
  topologyExclusionArtifact: 'training-visits-topology-excluded.jsonl.gz',
  topologyPolicy: 'No remapping. Entire differing route sequences and invalid occurrences are excluded from the Models input; original emissions are retained separately.',
  delayedConfirmedDepartures: full.rows.filter(v => v.departed_at !== null && v.known_at > v.departed_at).length,
  storedVisitInputs: false, historicalSeeds: false, knownAtSource: 'actual stepManyWithVisits emission poll',
  identity: 'known_at * 1000 + within-poll emission ordinal; synthetic IDs, not stored visit IDs',
  prefixDeletionChecks: checks, ...full.audit };
fs.writeFileSync(output + 'training-visits-audit.json', JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit));
// A completed event inconsistent with the very network used by the reducer is
// an unexpected defect, unlike a documented published-order repair. Preserve
// diagnostics above before failing so it cannot silently shrink the cohort.
assert.equal(Object.values(full.audit.perRoute).reduce((n, r) => n + r.unexpectedCompletedTopology, 0), 0,
  'Completed emissions disagree with reducer topology; inspect training-visits-topology-excluded.jsonl.gz');
assert(fitRows.length > 0, 'No topology-compatible reconstructed visits remain for fitting');
