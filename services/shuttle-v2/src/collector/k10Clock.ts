import { K10_SCOPES, forwardStops } from './k10Scopes.js';
import type { BusObservation, BusState, TrackPlan } from './detector.js';
import type { VisitEvent, VisitState } from './departure.js';

export interface CheckpointDeparture { departed: number; knownAt: number }
export interface K10Evidence {
  routeId?: number;
  origin: CheckpointDeparture;
  observedAt: number;
  index: number;
  phase: 'hold' | 'drive';
  released: boolean;
}
interface Clock {
  releasedOrigin?: number;
  first: number;
  last: number;
  origins: Map<number, CheckpointDeparture>;
  release: CheckpointDeparture | undefined;
  evidence: K10Evidence | undefined;
}

/** Only chronological GPS reducer outputs enter this clock. Historical GPS
 * may be replayed; finalized database visits cannot manufacture an origin. */
export class K10Clock {
  private clocks = new Map<string, Clock>();
  constructor(private readonly routeId = 3) {
    if (!K10_SCOPES[routeId]) throw new Error('Unqualified K10 route');
  }

  update(observations: readonly BusObservation[], events: readonly VisitEvent[],
    states: ReadonlyMap<string, BusState>, visits: ReadonlyMap<string, VisitState>, plan: TrackPlan): void {
    const now = Math.max(0, ...observations.map(o => o.collectedAt));
    for (const [name, c] of this.clocks) if (now - c.last > 60_000) this.clocks.delete(name);
    for (const o of observations) {
      if (o.routeId !== this.routeId || plan.contendedNames.has(o.busName)) {
        this.clocks.delete(o.busName); continue;
      }
      let c = this.clocks.get(o.busName);
      if (!c || o.collectedAt <= c.last || o.collectedAt - c.last > 60_000) {
        c = { first: o.collectedAt, last: o.collectedAt, origins: new Map(), release: undefined, evidence: undefined };
        this.clocks.set(o.busName, c);
      }
      c.last = o.collectedAt;
      c.evidence = undefined;
    }
    for (const e of events) {
      const c = this.clocks.get(e.busName);
      if (!c || c.last !== now || e.kind !== 'visit' || e.routeId !== this.routeId || e.how === 'gap'
        || e.outcome === 'unresolved' || e.arrivedAt === null || e.departedAt === null
        || e.departedAt < c.first || e.departedAt > now) continue;
      const departure = { departed: e.departedAt, knownAt: now };
      c.origins.set(e.stopIndex, departure);
      if (e.stopIndex === K10_SCOPES[this.routeId]!.waitIndex) c.release = departure;
    }
    for (const [key, s] of states) {
      const c = this.clocks.get(s.busName), v = visits.get(key);
      if (!c || s.routeId !== this.routeId || s.lastObservedAt !== c.last || !v) continue;
      const pass = v.pass;
      const phase = pass && pass.arrivedAt !== null ? 'hold' : v.transit ? 'drive' : null;
      const index = phase === 'hold' ? pass!.stopIndex : v.transit?.fromIndex ?? -1;
      const began = phase === 'hold' ? pass!.arrivedAt! : v.transit?.departedAt ?? Infinity;
      if (this.routeId !== 3) {
        const scope = K10_SCOPES[this.routeId]!, k = forwardStops(scope.sourceIndex, scope.waitIndex, scope.stopCount);
        const origin = c.origins.get(scope.sourceIndex);
        if (!origin || !phase || index < 0 || index >= scope.stopCount || origin.departed > began
          || c.last - c.first < 600_000 || c.last - origin.departed > 2_700_000) continue;
        const released = c.releasedOrigin === origin.departed
          || Boolean(c.release && c.release.departed > origin.departed && c.release.departed <= began && c.release.knownAt <= c.last)
          || forwardStops(scope.sourceIndex, index, scope.stopCount) > k
          || (index === scope.waitIndex && phase === 'drive');
        // A missing finalized wait visit cannot reactivate the preceding lap
        // when a short loop returns to its source. A new departure starts anew.
        if (released) c.releasedOrigin = origin.departed;
        c.evidence = { routeId: this.routeId, origin, observedAt: c.last, index, phase, released };
        continue;
      }
      // A new upstream occurrence cannot inherit the previous lap's clock.
      if (index < 4) { c.origins.clear(); c.release = undefined; }
      const origin = c.origins.get(4);
      if (!origin || !phase || origin.departed > began || c.last - c.first < 600_000
        || c.last - origin.departed > 2_700_000 || index < 8 || index > 27) continue;
      const upstream = [...c.origins].filter(([i, d]) => i < 14 && d.knownAt <= c.last);
      const latest = Math.max(...upstream.map(([, d]) => d.departed));
      const released = Boolean(c.release && latest < c.release.departed && c.release.knownAt <= c.last)
        || index > 14 || (index === 14 && phase === 'drive');
      c.evidence = { origin, observedAt: c.last, index, phase, released };
    }
  }

  snapshot(now: number): ReadonlyMap<string, K10Evidence> {
    const result = new Map<string, K10Evidence>();
    for (const [name, c] of this.clocks) {
      if (c.evidence && now >= c.last && now - c.last <= 15_000)
        result.set(name.replace(/^#/, ''), c.evidence);
    }
    return result;
  }
}
