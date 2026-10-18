import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';
import { distanceMeters } from '../../src/network/geo.ts';
import { decodeWitness } from './protocol.mjs';

export const PROGRESS_CONTEXT_MAX_BYTES = 64 * 1024;
const MAX_TRACKS = 128, MAX_ROUTES = 64, MAX_GAP_MS = 60000, SLACK_M = 150;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const identity = v => JSON.stringify([v.busId, v.busName, v.routeId]);
const validIdentity = v => v && integer(v.busId) && integer(v.routeId)
  && typeof v.busName === 'string' && v.busName.length > 0 && v.busName.length <= 100;
const coordinate = p => p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
  && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
const empty = epoch => ({ v: 1, epoch, seq: 0, chain: null, generation: 0,
  geometries: [], tracks: [], lastUnknown: null,
  coverage: { frames: 0, observations: 0, boundObservations: 0, candidateLeads: 0, withholdEvents: {} } });

function validContext(c) {
  return c?.v === 1 && typeof c.epoch === 'string' && integer(c.seq) && integer(c.generation)
    && (c.seq === 0 ? c.chain === null : hash(c.chain)) && Array.isArray(c.geometries) && c.geometries.length <= MAX_ROUTES
    && c.geometries.every(g => integer(g.routeId) && hash(g.sha256) && integer(g.generation) && g.generation <= c.generation)
    && new Set(c.geometries.map(g => g.routeId)).size === c.geometries.length
    && Array.isArray(c.tracks) && c.tracks.length <= MAX_TRACKS
    && c.tracks.every(t => validIdentity(t) && integer(t.at) && integer(t.seq) && t.seq <= c.seq && hash(t.frameSHA256)
      && hash(t.stateSHA256) && hash(t.geometrySHA256) && integer(t.generation) && t.generation <= c.generation)
    && new Set(c.tracks.map(identity)).size === c.tracks.length
    && c.coverage && ['frames','observations','boundObservations','candidateLeads'].every(k => integer(c.coverage[k]))
    && c.coverage.boundObservations <= c.coverage.observations && c.coverage.withholdEvents
    && Object.keys(c.coverage.withholdEvents).length <= 32 && Object.entries(c.coverage.withholdEvents)
      .every(([reason, count]) => /^[a-z-]{1,80}$/.test(reason) && integer(count))
    && Buffer.byteLength(JSON.stringify(c)) <= PROGRESS_CONTEXT_MAX_BYTES;
}

function geometry(route, stops) {
  if (!Array.isArray(route?.stops) || route.stops.length < 2 || !Array.isArray(route.path) || route.path.length < 2) return null;
  const points = route.stops.map(id => stops.get(id));
  if (points.some(p => !coordinate(p)) || route.path.some(p => !Array.isArray(p) || !coordinate({ lat: p[0], lon: p[1] }))) return null;
  return witnessSHA(witnessJSON([route.stops, route.path, points.map(p => ({ lat: p.lat, lon: p.lon }))]));
}

function indexed(network, state) {
  return integer(state?.nearestIndex) && network.routes.get(state.routeId)?.stops[state.nearestIndex] === state.nearestStopId;
}
function competitive(network, before, obs) {
  const route = network.routes.get(obs.routeId), stop = network.stops.get(before.nearestStopId);
  if (!route || !stop) return false;
  let closest = Infinity;
  for (const id of route.stops) {
    const p = network.stops.get(id); if (!p) return false;
    closest = Math.min(closest, distanceMeters(obs, p));
  }
  return distanceMeters(obs, stop) <= closest + SLACK_M;
}

function arrivals(input, obs, next) {
  const rows = [];
  for (const write of input.sourceWrites ?? []) for (const m of write.mutations ?? []) {
    if (m.table !== 'arrivals' || typeof m.afterJSON !== 'string') continue;
    if (witnessSHA(m.afterJSON) !== m.afterSHA256) throw Error('Progress source-row checksum differs');
    const row = decodeWitness(m.afterJSON);
    if (row.bus_id === obs.busId && row.route_id === obs.routeId && row.stop_id === next.nearestStopId
      && row.arrived_at === obs.collectedAt) rows.push({ rowId: row.id, rowSHA256: m.afterSHA256 });
  }
  return rows;
}

/** Requires validatePage records. Context is a bounded witness of actually
 * captured observations, never a seed inferred from a stateBefore snapshot.
 * Geometry generations advance on every frame, including empty bus polls;
 * A→B→A therefore cannot join observations across an unseen geometry change. */
export function anchorProgressLeads(records, previous = null, epoch) {
  if (typeof epoch !== 'string' || !epoch || epoch.length > 100) throw Error('Progress diagnostic epoch required');
  let context = validContext(previous) ? structuredClone(previous) : null;
  if (!context || context.epoch !== epoch) context = empty(epoch);
  const leads = [], fingerprints = new WeakMap();
  for (const { frame, input, topology } of records) {
    if (frame.seq === context.seq && frame.chain === context.chain) continue; // late association revisit
    const unknown = reason => {
      context.lastUnknown = { seq: frame.seq, reason };
      context.coverage.withholdEvents[reason] = (context.coverage.withholdEvents[reason] ?? 0) + 1;
    };
    if (context.seq && (frame.seq !== context.seq + 1 || frame.previousChain !== context.chain)) {
      context = empty(context.epoch); unknown('unbound-frame-prefix');
    }
    context.seq = frame.seq; context.chain = frame.chain;
    context.coverage.frames++; context.coverage.observations += input?.observations?.length ?? 0;
    if (frame.status !== 'recorded' || input?.pollResult !== 'completed' || input.sourceWriteEvidence !== 'recorded' || !topology) {
      context.tracks = []; context.geometries = []; unknown('incomplete-capture'); continue;
    }
    const network = topology.decoded;
    if (!(network?.routes instanceof Map) || !(network.stops instanceof Map) || network.routes.size > MAX_ROUTES) {
      context.tracks = []; context.geometries = []; unknown('geometry-unavailable-or-bound'); continue;
    }
    // validatePage shares each decoded immutable topology within its page.
    // This cache lasts only for this synchronous fold; generations persist
    // in context and therefore do not depend on page/cache boundaries.
    if (!fingerprints.has(topology)) fingerprints.set(topology, new Map([...network.routes]
      .sort((a, b) => a[0] - b[0]).filter(([id]) => integer(id))
      .map(([id, route]) => [id, geometry(route, network.stops)])));
    const oldGeometry = new Map(context.geometries.map(g => [g.routeId, g])), geometries = new Map();
    for (const [routeId, sha256] of fingerprints.get(topology)) {
      if (!sha256) continue;
      const old = oldGeometry.get(routeId);
      if (old?.sha256 !== sha256) context.generation++;
      geometries.set(routeId, { routeId, sha256, generation: old?.sha256 === sha256 ? old.generation : context.generation });
    }
    context.geometries = [...geometries.values()];
    const tracks = new Map(context.tracks.filter(t => frame.at - t.at <= MAX_GAP_MS).map(t => [identity(t), t]));
    const before = decodeWitness(input.stateBeforeJSON), after = decodeWitness(input.stateAfterJSON);
    if (!(before?.states instanceof Map) || !(after?.states instanceof Map) || !Array.isArray(input.observations)
      || input.observations.length > MAX_TRACKS || !Number.isSafeInteger(context.generation)) {
      context.tracks = []; unknown('state-unavailable-or-bound'); continue;
    }
    const names = new Map(), ids = new Map();
    for (const o of input.observations) if (validIdentity(o)) {
      names.set(o.busName, (names.get(o.busName) ?? 0) + 1); ids.set(o.busId, (ids.get(o.busId) ?? 0) + 1);
    }
    const states = map => {
      const values = new Map();
      for (const s of map.values()) if (validIdentity(s)) {
        const key = identity(s); values.set(key, values.has(key) ? null : s);
      }
      return values;
    };
    const beforeStates = states(before.states), afterStates = states(after.states), frameLeads = [];
    for (const obs of input.observations) {
      if (!validIdentity(obs) || !coordinate(obs)) { unknown('invalid-observation'); continue; }
      const key = identity(obs), prior = tracks.get(key), prev = beforeStates.get(key), next = afterStates.get(key);
      // A provider handoff/collision is not evidence of an unchanged track.
      for (const [other, t] of tracks) if (t.busName === obs.busName && other !== key) tracks.delete(other);
      if (names.get(obs.busName) !== 1 || ids.get(obs.busId) !== 1 || !next || obs.collectedAt !== frame.at
        || next.lastObservedAt !== obs.collectedAt || next.lat !== obs.lat || next.lon !== obs.lon
        || prev && obs.collectedAt <= prev.lastObservedAt) {
        tracks.delete(key); unknown('identity-or-observation-unbound'); continue;
      }
      const g = geometries.get(obs.routeId);
      if (!g || !indexed(network, next)) { tracks.delete(key); unknown('indexed-geometry-unavailable'); continue; }
      const gap = prev ? obs.collectedAt - prev.lastObservedAt : Infinity;
      const bound = prior && prev && gap > 0 && gap <= MAX_GAP_MS && indexed(network, prev)
        && prior.at === prev.lastObservedAt && prior.generation === g.generation
        && prior.geometrySHA256 === g.sha256 && prior.stateSHA256 === witnessSHA(witnessJSON(prev));
      if (bound) context.coverage.boundObservations++;
      if (bound && gap > 0 && gap <= MAX_GAP_MS && indexed(network, prev)
        && prev.lat === obs.lat && prev.lon === obs.lon
        && (prev.nearestIndex !== next.nearestIndex || prev.nearestStopId !== next.nearestStopId)
        && competitive(network, prev, obs)) {
        const previousFrame = { seq: prior.seq, at: prior.at, frameSHA256: prior.frameSHA256, stateSHA256: prior.stateSHA256 };
        const evidenceSHA256 = witnessSHA(witnessJSON([previousFrame, frame.sha256, key, input.stateBeforeSHA256, input.stateAfterSHA256, g]));
        frameLeads.push({ kind: 'unchanged-fix-anchor-progress-review', seq: frame.seq, at: frame.at,
          frameSHA256: frame.sha256, topologySHA256: frame.topologySha256, geometrySHA256: g.sha256,
          geometryGeneration: g.generation, evidenceSHA256, previousFrame,
          busId: obs.busId, busName: obs.busName, routeId: obs.routeId, observation: { ...obs },
          fromStopId: prev.nearestStopId, fromIndex: prev.nearestIndex, toStopId: next.nearestStopId, toIndex: next.nearestIndex,
          stateBeforeSHA256: input.stateBeforeSHA256, stateAfterSHA256: input.stateAfterSHA256,
          sourceArrivals: arrivals(input, obs, next),
          scope: 'Review repeated GPS, stable indexed geometry and the captured state/source writes. Not physical service, an ETA accuracy verdict or a source-row correction.' });
      }
      if (!bound) unknown(prior ? 'observation-or-geometry-generation-changed' : 'cold-observation-context');
      tracks.set(key, { busId: obs.busId, busName: obs.busName, routeId: obs.routeId, at: obs.collectedAt,
        seq: frame.seq, frameSHA256: frame.sha256, stateSHA256: witnessSHA(witnessJSON(next)),
        geometrySHA256: g.sha256, generation: g.generation });
    }
    context.tracks = [...tracks.values()].sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
    const priorLeadCount = context.coverage.candidateLeads;
    context.coverage.candidateLeads += frameLeads.length;
    if (context.tracks.length > MAX_TRACKS || Buffer.byteLength(JSON.stringify(context)) > PROGRESS_CONTEXT_MAX_BYTES) {
      context.coverage.candidateLeads = priorLeadCount;
      context.tracks = []; context.geometries = []; unknown('context-bound');
    } else leads.push(...frameLeads);
  }
  return { context, leads };
}

export function anchorProgressSummary(context) {
  return validContext(context) ? { v: 1, lastSeq: context.seq, trackedObservations: context.tracks.length,
    routeGeometries: context.geometries.length, lastUnknown: context.lastUnknown,
    coverage: structuredClone(context.coverage), contextBytes: Buffer.byteLength(JSON.stringify(context)) } : { v: 1, lastSeq: null, trackedObservations: 0,
    routeGeometries: 0, lastUnknown: { reason: 'not-yet-captured' }, contextBytes: 0 };
}
