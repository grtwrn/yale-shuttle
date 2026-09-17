// Server snapshots belong to a specific payload, never to hypothetical/replay
// inputs. No estimator code runs here. Empty/stale live snapshots fail closed.
import type { UpcomingArrival } from './arrivals';
import type { StandingAnswer } from './liveAnchor';
import type { BusData } from './map-data';
import { ROUTE_LISTS } from './routes';

export const ETA_MAX_AGE_MS = 45_000;
export type ServerEtaRow = readonly [number, number, number, number, number, number, 0 | 1, number, number];
export type ServerEtaBus = readonly [string, string, number, StandingAnswer | null];
export interface ServerEtaWire {
  v: 2;
  at: number;
  servedAt: number;
  buses: ServerEtaBus[];
  rows: ServerEtaRow[];
  /** Optional row-aligned 50-point quantile distributions; old readers ignore it. */
  distributions?: number[][];
}
interface Snapshot { at: number; rows: UpcomingArrival[]; valid: boolean }
interface Track { snapshot: Snapshot; index: number; standing: StandingAnswer | null }
const snapshots = new WeakMap<readonly BusData[], Snapshot>();
const tracks = new WeakMap<object, Map<string, Track>>();
const colours = new Map(ROUTE_LISTS.map(c => [c.label, c.color]));
const norm = (s: string) => s.replace(/^#/, '');
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const fresh = (s: Snapshot, now: number) => s.valid && now >= s.at - 5000 && now - s.at < ETA_MAX_AGE_MS;

/** Called before publishing the new bus array to React. Missing/invalid server
 * output is an unavailable forecast, not permission to invent a local one. */
export function attachServerEta(buses: BusData[], raw: unknown, receivedAt = Date.now()): boolean {
  const snapshot: Snapshot = { at: receivedAt, rows: [], valid: false };
  snapshots.set(buses, snapshot);
  for (const bus of buses) tracks.set(bus, new Map());
  const w = raw as ServerEtaWire | null;
  if (!w || w.v !== 2 || !finite(w.at) || !finite(w.servedAt) || w.at > w.servedAt
    || !Array.isArray(w.buses) || !Array.isArray(w.rows) || w.buses.length > 200 || w.rows.length > 30_000) return false;
  // Server observation age plus elapsed client time: no dependency on the
  // rider's phone clock agreeing with the server clock.
  snapshot.at = receivedAt - (w.servedAt - w.at);
  const busIndex = new Map<number, { name: string; label: string; colour: string }>();
  for (let i = 0; i < w.buses.length; i++) {
    const b = w.buses[i];
    if (!Array.isArray(b) || b.length !== 4 || typeof b[0] !== 'string' || typeof b[1] !== 'string'
      || !Number.isInteger(b[2]) || b[2] < -1 || !colours.has(b[1])) return false;
    const rest = b[3];
    if (rest !== null && (!rest || !Number.isInteger(rest.stopId) || !finite(rest.standingSec)
      || rest.standingSec < 0 || typeof rest.approach !== 'boolean')) return false;
    const cfg = ROUTE_LISTS.find(c => c.label === b[1])!;
    const live = buses.filter(x => norm(x.bus_name) === norm(b[0]) && cfg.busRouteIds.includes(x.route_id));
    // The server may include lines the frontend's service-hours filter hides.
    if (!live.length) continue;
    busIndex.set(i, { name: norm(b[0]), label: b[1], colour: colours.get(b[1])! });
    for (const bus of live) tracks.get(bus)!.set(b[1], { snapshot, index: b[2], standing: rest });
  }
  for (const [ri, row] of w.rows.entries()) {
    if (!Array.isArray(row) || row.length !== 9 || !row.every(finite)
      || !Number.isInteger(row[0]) || row[0] < 0 || row[0] >= w.buses.length
      || !Number.isInteger(row[1]) || !Number.isInteger(row[5]) || row[5] < 0
      || (row[6] !== 0 && row[6] !== 1) || row[2] < 0 || row[4] < row[3]
      || row[7] < 0) return false;
    const b = busIndex.get(row[0]);
    if (!b) continue;
    const dots = w.distributions?.length === w.rows.length ? w.distributions[ri] : undefined;
    const distribution = Array.isArray(dots) && dots.length === 50
      && dots.every((v, i) => finite(v) && v >= 0 && (i === 0 || v >= dots[i - 1]!)) ? dots : undefined;
    snapshot.rows.push({ ...(distribution ? { distribution } : {}), busName: b.name, routeLabel: b.label, color: b.colour, stopId: row[1],
      eta: row[2], low: row[3], high: row[4], stopsAhead: row[5], estimated: row[6] === 1,
      departNow: row[7], lowFloor: row[8] });
  }
  snapshot.valid = true;
  return fresh(snapshot, receivedAt);
}

/** null means an offline/hypothetical caller, [] means live but unavailable. */
export function serverArrivals(buses: readonly BusData[], targets: readonly number[], now: number): UpcomingArrival[] | null {
  const s = snapshots.get(buses);
  if (!s) return null;
  if (!fresh(s, now)) return [];
  const elapsed = Math.max(0, (now - s.at) / 1000);
  const remaining = (n: number) => Math.max(0, n - elapsed);
  const ids = new Set(targets);
  return s.rows.filter(a => ids.has(a.stopId)).map(a => ({ ...a, eta: remaining(a.eta),
    ...(a.distribution ? { distribution: a.distribution.map(remaining) } : {}),
    low: remaining(a.low), high: remaining(a.high), departNow: remaining(a.departNow), lowFloor: remaining(a.lowFloor) }));
}

export function liveEtaAvailable(buses: readonly BusData[], now = Date.now(), routeLabel?: string): boolean {
  const s = snapshots.get(buses);
  return !s || (fresh(s, now) && (!routeLabel || s.rows.some(a => a.routeLabel === routeLabel)));
}

/** undefined means no server source registered; null means no usable track. */
export function serverTrack(bus: object, label: string, now: number): { index: number; standing: StandingAnswer | null } | null | undefined {
  const m = tracks.get(bus);
  if (!m) return undefined;
  const t = m.get(label);
  if (!t || !fresh(t.snapshot, now)) return null;
  return { index: t.index, standing: t.standing ? { ...t.standing,
    standingSec: t.standing.standingSec + Math.max(0, (now - t.snapshot.at) / 1000) } : null };
}

/** Reject raw at-stop overrides for a bus the server cannot currently price. */
export function liveBusAvailable(bus: BusData, label: string, now: number): boolean {
  return serverTrack(bus, label, now) !== null;
}
