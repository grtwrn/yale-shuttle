import { commuteSec, slowerThanWalk, type TripOption } from './planner';

export const RANK_CHANGE_HOLD_MS = 30_000;
const ARRIVAL_MARGIN_SEC = 90;
const COMMUTE_TIE_SEC = 60;

export function optionTier(o: TripOption): number {
  return o.departed || o.etaUnavailable ? 2 : slowerThanWalk(o) ? 1 : 0;
}

/** Full destination windows. Without one, pickup can only bound the earliest
 * destination arrival; it cannot supply a latest time or a ride distribution. */
function windowSec(o: TripOption): [number, number] {
  if (o.mode === 'walk') return [o.totalSec, o.totalSec];
  const j = o.journeyArrival, at = o.computedAtMs;
  if (!j || at === undefined || ![j.lowMs, j.highMs, at].every(Number.isFinite)
    || j.lowMs > j.highMs) {
    const pickupLow = Number.isFinite(o.busLowSec) ? Math.max(0, o.busLowSec!) : 0;
    return [Math.max(o.walkToSec, pickupLow) + o.walkFromSec, Infinity];
  }
  return [Math.max(0, (j.lowMs - at) / 1000), Math.max(0, (j.highMs - at) / 1000)];
}

/** Respect clearly earlier arrivals. Among overlapping/unknown windows choose
 * shorter walks + planned rides. Selecting from an acyclic partial order avoids
 * a non-transitive sort comparator when A overlaps B and B overlaps C. */
export function preferredTripOrder(options: readonly TripOption[], previous: readonly string[] = []): TripOption[] {
  const remaining = [...options], ranked: TripOption[] = [];
  while (remaining.length) {
    const tier = Math.min(...remaining.map(optionTier));
    const group = remaining.filter(o => optionTier(o) === tier);
    const eligible = group.filter(a => !group.some(b => b !== a
      && windowSec(b)[1] + ARRIVAL_MARGIN_SEC < windowSec(a)[0]));
    const bestCost = Math.min(...eligible.map(commuteSec));
    const near = eligible.filter(o => commuteSec(o) <= bestCost + COMMUTE_TIE_SEC);
    near.sort((a, b) => {
      const ai = previous.indexOf(a.routeLabel), bi = previous.indexOf(b.routeLabel);
      if (ai !== bi) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      const walk = (o: TripOption) => o.mode === 'walk' ? o.totalSec : o.walkToSec + o.walkFromSec;
      return walk(a) - walk(b) || commuteSec(a) - commuteSec(b) || a.routeLabel.localeCompare(b.routeLabel);
    });
    const chosen = near[0]!;
    ranked.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return ranked;
}

export interface TripOrderState {
  order: string[];
  tiers: string;
  pending?: { order: string[]; since: number };
}

/** A changed live forecast must persist before moving cards. Availability
 * changes and new plans apply immediately; countdowns always remain live. */
export function stableTripOrder(options: readonly TripOption[], prior: TripOrderState | null, now: number) {
  const tiers = options.map(o => `${o.routeLabel}:${optionTier(o)}`).sort().join('|');
  const samePlan = prior?.tiers === tiers;
  const desired = preferredTripOrder(options, samePlan ? prior.order : []).map(o => o.routeLabel);
  let state: TripOrderState;
  if (!samePlan || desired.join('|') === prior.order.join('|')) {
    state = { order: desired, tiers };
  } else {
    const pending = prior.pending?.order.join('|') === desired.join('|') && now >= prior.pending.since
      ? prior.pending : { order: desired, since: now };
    state = now - pending.since >= RANK_CHANGE_HOLD_MS
      ? { order: desired, tiers } : { order: prior.order, tiers, pending };
  }
  const byLabel = new Map(options.map(o => [o.routeLabel, o]));
  return { state, options: state.order.map(label => byLabel.get(label)!) };
}
