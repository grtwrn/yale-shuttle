import { K10_SCOPES } from './k10Scopes.js';
import type { TransitNetwork } from '../network/TransitNetwork.js';
import { planTracks, reconcileTracks, type BusObservation, type BusState } from './detector.js';
import { stepManyWithVisits, type VisitState } from './departure.js';
import { K10Clock, type K10Evidence } from './k10Clock.js';

export const K10_HISTORY_MS = 60 * 60_000;
export const K10_HISTORY_LIMIT = 1500;
export type K10History = (current: BusObservation) => readonly BusObservation[];
export interface K10RecoveryStats {
  attempts: number; replayedSamples: number; recovered: number; cold: number;
  rejected: number; errors: number; maxReplayMs: number;
}
class Track {
  states = new Map<string, BusState>();
  visits = new Map<string, VisitState>();
  clock: K10Clock;
  constructor(readonly routeId: number) { this.clock = new K10Clock(routeId); }
  last = 0;
  step(network: TransitNetwork, observations: readonly BusObservation[]): void {
    const at = observations[0]!.collectedAt;
    if (at <= this.last || at - this.last > 60_000) {
      this.states.clear(); this.visits.clear(); this.clock = new K10Clock(this.routeId);
    }
    this.last = at;
    const plan = planTracks(observations);
    reconcileTracks(this.states, plan); reconcileTracks(this.visits, plan);
    const result = stepManyWithVisits(network, this.states, this.visits, observations, plan);
    this.clock.update(observations, result.visits, this.states, this.visits, plan);
  }
}

/** An isolated, read-only replay of actual GPS. Historical reducer outputs are
 * never persisted or injected into the collector's arrival/calibration state.
 * Live polls continue the very same reducers that reconstructed the clock. */
export class K10Tracker {
  private tracks = new Map<string, Track>();
  private topology = '';
  private attempted = new Map<string, number>();
  private counters: K10RecoveryStats = { attempts: 0, replayedSamples: 0, recovered: 0,
    cold: 0, rejected: 0, errors: 0, maxReplayMs: 0 };

  update(network: TransitNetwork, observations: readonly BusObservation[], history?: K10History): void {
    const topology = Object.keys(K10_SCOPES).map(id => network.routes.get(Number(id))?.stops.join(',') ?? '').join('|');
    if (this.topology && this.topology !== topology) { this.tracks.clear(); this.attempted.clear(); }
    this.topology = topology;
    const now = Math.max(0, ...observations.map(o => o.collectedAt));
    for (const [name, track] of this.tracks) if (now - track.last > 60_000) this.tracks.delete(name);
    for (const [name, at] of this.attempted) if (now - at > K10_HISTORY_MS) this.attempted.delete(name);
    const groups = new Map<string, BusObservation[]>();
    for (const o of observations) {
      const group = groups.get(o.busName) ?? []; group.push(o); groups.set(o.busName, group);
    }
    for (const [name, group] of groups) {
      if (group.length !== 1 || !K10_SCOPES[group[0]!.routeId]) {
        this.tracks.delete(name); this.attempted.set(name, now); continue;
      }
      const current = group[0]!;
      let track = this.tracks.get(name), attempted = false;
      if (!track || track.routeId !== current.routeId) {
        track = new Track(current.routeId); this.tracks.set(name, track);
        if (history && !this.attempted.has(name)) {
          attempted = true; this.counters.attempts++;
          const start = performance.now();
          try {
            const rows = history(current);
            if (!this.validHistory(rows, current)) this.counters.rejected++;
            else {
              for (let i = 0; i < rows.length;) {
                const batch: BusObservation[] = [], at = rows[i]!.collectedAt;
                while (i < rows.length && rows[i]!.collectedAt === at) batch.push(rows[i++]!);
                // Ambiguous identities and route changes sever prior evidence.
                if (batch.length !== 1 || batch[0]!.routeId !== current.routeId) track = new Track(current.routeId);
                else track.step(network, batch);
              }
              this.counters.replayedSamples += rows.length;
            }
          } catch {
            track = new Track(current.routeId); this.counters.errors++;
          }
          this.counters.maxReplayMs = Math.max(this.counters.maxReplayMs, performance.now() - start);
          this.tracks.set(name, track);
        }
      }
      this.attempted.set(name, now);
      track.step(network, group);
      if (attempted) {
        if (track.clock.snapshot(now).size) this.counters.recovered++;
        else this.counters.cold++;
      }
    }
  }

  private validHistory(rows: readonly BusObservation[], current: BusObservation): boolean {
    if (rows.length > K10_HISTORY_LIMIT) return false;
    let previous = current.collectedAt - K10_HISTORY_MS;
    for (const o of rows) {
      if (o.busName !== current.busName || !Number.isFinite(o.collectedAt)
        || o.collectedAt < previous || o.collectedAt >= current.collectedAt
        || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return false;
      previous = o.collectedAt;
    }
    return true;
  }

  snapshot(now: number): ReadonlyMap<string, K10Evidence> {
    const result = new Map<string, K10Evidence>();
    for (const track of this.tracks.values()) for (const [name, evidence] of track.clock.snapshot(now)) result.set(name, evidence);
    return result;
  }
  stats(): K10RecoveryStats { return { ...this.counters }; }
}
