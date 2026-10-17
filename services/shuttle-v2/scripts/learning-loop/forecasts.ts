import { ServerEta } from '../../src/server/serverEta';
import type { UpcomingArrival } from '../../web/src/arrivals';
import { applyModelParams } from '../../web/src/eta/params';
import { ETA_MAX_AGE_MS } from '../../web/src/etaSource';
import { ROUTE_LISTS } from '../../web/src/routes';
import { isBusInService } from '../../web/src/schedule';

interface ArmState { engine: ServerEta; rows: () => readonly UpcomingArrival[]; lastAt: number }
export interface ForecastStores { champion: ArmState; challenger: ArmState }
export function createForecastStores(): ForecastStores {
  const arm = (): ArmState => {
    let rows: readonly UpcomingArrival[] = [];
    const engine = new ServerEta({ routes: ROUTE_LISTS.map(r => r.label), onBaseForecasts: next => { rows = next; } });
    return { engine, rows: () => rows, lastAt: -Infinity };
  };
  return { champion: arm(), challenger: arm() };
}

/** Poll faster than the collector, but consume a distinct observation once.
 * Removed/aged buses still change eligibility even when the ETA clock is fixed. */
export function observationKey(feed: any): string {
  return JSON.stringify([feed.server_eta?.at ?? null, feed.server_eta?.buses ?? null, feed.server_eta?.rows ?? null,
    feed.buses.map((b: any) => [b.route_id, b.bus_id, b.bus_name, b.observed_at])]);
}
const norm = (s: string) => s.replace(/^#/, '');
const key = (label: string, name: string, stop: number, ahead: number) => `${label}|${norm(name)}|${stop}|${ahead}`;

/** Independent production engines: GPS freshness, observation interning,
 * eviction and cached snapshot handling are shared with the real server.
 * The served field only attests the control; it never supplies either arm's
 * predictions. Raw model-time quantiles survive for causal interval fitting. */
export function forecastArms(feed: any, now: number, champion: any, challenger: any, stores: ForecastStores) {
  let reference = feed.server_eta;
  const fresh = feed.buses.some((b: any) => b.observed_at === undefined || now - b.observed_at < ETA_MAX_AGE_MS);
  if (!reference && !fresh) reference = { v: 2, at: now, servedAt: now, buses: [], rows: [] };
  if (!reference || reference.v !== 2 || !Number.isFinite(reference.at) || !Number.isFinite(reference.servedAt)
    || reference.at > reference.servedAt || reference.servedAt - reference.at >= ETA_MAX_AGE_MS
    || reference.servedAt > now + 5000 || !Array.isArray(reference.rows) || !Array.isArray(reference.buses)) {
    throw Error('No fresh, coherent production ETA snapshot for shadow forecasts');
  }
  const ageSec = (reference.servedAt - reference.at) / 1000;
  const served = new Map<string, number[]>();
  for (const row of reference.rows) {
    const bus = reference.buses[row[0]];
    if (!bus || !Array.isArray(row) || !row.slice(1, 6).every(Number.isFinite)) throw Error('Malformed production ETA row');
    served.set(key(bus[1], bus[0], row[1], row[5]), row.slice(2, 5));
  }
  const compute = (params: any, state: ArmState) => {
    if (reference.at < state.lastAt) throw Error('Production ETA observation clock regressed');
    if (!applyModelParams(params)) throw Error('Invalid frozen model parameters');
    const payload = { ...feed, model_params: params };
    const failures = state.engine.stats().failures;
    state.engine.contribute(payload, reference.at, reference.at);
    const visible = state.engine.contribute(payload, reference.at, reference.servedAt);
    if (state.engine.stats().failures > failures) throw Error('Shadow production engine failed');
    state.lastAt = reference.at;
    const allowed = new Set<string>();
    for (const row of visible?.rows ?? []) {
      const b = visible!.buses[row[0]]!;
      allowed.add(key(b[1], b[0], row[1], row[5]));
    }
    const first = new Map<string, any>();
    for (const row of state.rows()) {
      if (!allowed.has(key(row.routeLabel, row.busName, row.stopId, row.stopsAhead))) continue;
      const cfg = ROUTE_LISTS.find(c => c.label === row.routeLabel)!;
      const bus = feed.buses.find((b: any) => norm(b.bus_name) === norm(row.busName) && cfg.busRouteIds.includes(b.route_id));
      if (!bus || !isBusInService(bus, now)) continue;
      const raw = { eta: row.eta, low: row.low, high: row.high };
      const forecast = { bus, stop: row.stopId, stopsAhead: row.stopsAhead, label: row.routeLabel, raw, ageSec,
        eta: Math.max(0, raw.eta - ageSec), low: raw.low - ageSec, high: Math.max(0, raw.high - ageSec) };
      const id = `${bus.route_id}|${bus.bus_id}|${bus.bus_name}|${row.stopId}`;
      if (!first.has(id) || forecast.eta < first.get(id).eta) first.set(id, forecast);
    }
    return [...first.values()];
  };
  const a = compute(champion, stores.champion), b = compute(challenger, stores.challenger);
  let matched = 0, missing = 0, maxAbs = 0;
  for (const row of a) {
    const prediction = served.get(key(row.label, row.bus.bus_name, row.stop, row.stopsAhead)) ?? null;
    row.control = { modelAt: reference.at, servedAt: reference.servedAt, receivedAt: now,
      r: row.bus.route_id, busId: row.bus.bus_id, busName: row.bus.bus_name, label: row.label,
      stop: row.stop, stopsAhead: row.stopsAhead, reference: prediction };
    if (!prediction) { missing++; continue; }
    const delta = Math.max(...[row.eta, row.low, row.high].map((v, i) => Math.abs(Math.max(0, v) - Math.max(0, prediction[i]! - ageSec))));
    maxAbs = Math.max(maxAbs, delta);if (delta <= 0.500001) matched++;
  }
  return { champion: a, challenger: b, productionControl: { modelAt: reference.at, compared: a.length,
    matched, missing, mismatched: a.length - matched - missing, maxAbsSec: maxAbs } };
}
