/**
 * From a belief on the ring to the distribution of the instant the bus reaches
 * each stop — and from that distribution to the three numbers a row shows.
 *
 * PRICING. Each situation (leg, mode, mass — filter.ts) starts a chain:
 *
 *   standing at stop j, r seconds in     (S_j - r | S_j > r)  +  D_j
 *   resting in the approach of layover j  the same, as if at j (hopPricing.ts #130)
 *   moving, or holding, on leg i at t     D_i x (1 - t)   (stand never prorated;
 *                                         a hold is inside D already: leg_sec)
 *
 * then, for every further stop s on the way: + S_s + D_s. Every term is a
 * distribution (dist.ts) and the sum is taken by STRATIFIED COMMON-RANDOM-NUMBER
 * sampling: K fixed uniforms per hop, the same ones every poll, permuted per
 * hop so hops are independent. The result is a deterministic, smooth function
 * of the belief and the tables — it cannot jitter between polls on its own —
 * and `arrival.test.ts` checks it against exact convolution.
 *
 * DISPLAY. The lead LEG's situations — standing at its stop, moving along
 * it — are one cluster, mixed by their mass; every other situation is an
 * alternative (the other branch of a fold, a lap away, a cold belief's guess)
 * whose fate is the lead hysteresis's (filter.ts), not the mixture's. The
 * row shows the cluster's quantile tau as the number and q10-q90 as the
 * range, and while alternatives still hold a fifth of the mass the range is
 * the full mixture's. So on Red a departure moves the number on the
 * departure poll (the moving variant outweighs the standing one), while on
 * a fold the number does not race across the gap as a branch weight passes
 * 0.5 (#88).
 *
 * THE CLAMP (#119). While a bus stands, the shown arrival instant is
 * non-increasing: the conditional median of a stand rises wherever the stand
 * CDF flattens (the inspection paradox, real and measured), and the operator
 * chose stable. Applied to the shown number only, per (bus, stop), released
 * the moment the lead situation is no longer standing at that stop.
 */

import { quantile, residual, type Dist } from "./dist";
import { clockOrigin, LEAD_SWITCH_MASS, situations, standingSec, type Belief, type Situation } from "./filter";
import type { Ring } from "./ring";
import type { RouteTables } from "./tables";

/** Samples per chain. */
export const K = 256;
/** Beyond this the lap-2 guess is noise (arrivals.ts MAX_ETA_SEC). */
export const MAX_ETA_SEC = 90 * 60;
/** Entries per stop: this lap and the next. */
const MAX_OCCURRENCES = 2;

export interface StopArrival {
  stopId: number;
  /** 0 = the next time the bus reaches the stop, 1 = the time after. */
  occurrence: number;
  /** Hops from the lead situation's leg. */
  stopsAhead: number;
  /** Seconds, quantile tau of the lead cluster. */
  eta: number;
  low: number;
  high: number;
  /** Mass of the lead cluster (1 on a plain loop). */
  leadMass: number;
  /** No served table backed any hop of the lead chain. */
  estimated: boolean;
  /** The lead situation is standing at a stop (the clamp applies). */
  standingAt: number;
}

// -- common random numbers ----------------------------------------------------

/** mulberry32 — a tiny seeded PRNG for the fixed permutations. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRATA = new Float64Array(K);
for (let k = 0; k < K; k++) STRATA[k] = (k + 0.5) / K;
/**
 * One fixed permutation per TERM index, made on demand from a seeded shuffle
 * and cached, so no two terms of a chain ever share one (a fixed pool of 64
 * aliased Orange's 33-stop lap onto itself and reused lap-1 draws for lap 2).
 */
const PERM = new Map<number, Uint16Array>();
function permFor(term: number): Uint16Array {
  let a = PERM.get(term);
  if (a) return a;
  a = new Uint16Array(K);
  for (let k = 0; k < K; k++) a[k] = k;
  const r = rng(0x5eed ^ Math.imul(term + 1, 0x9e3779b1));
  for (let k = K - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    const t = a[k]!; a[k] = a[j]!; a[j] = t;
  }
  PERM.set(term, a);
  return a;
}

/**
 * The draws of `d` under term `term`'s permutation, cached: a table's draws
 * for a fixed permutation never change, so the quantile function is evaluated
 * once per (table, term) and the hot path is additions only.
 */
const distIds = new WeakMap<Dist, number>();
let nextDistId = 1;
const termCache = new Map<string, Float64Array>();
function termDraws(d: Dist, term: number): Float64Array {
  let id = distIds.get(d);
  if (id === undefined) { id = nextDistId++; distIds.set(d, id); }
  const key = `${id}|${term}`;
  const hit = termCache.get(key);
  if (hit) return hit;
  if (termCache.size > 8192) termCache.clear();
  const perm = permFor(term);
  const out = new Float64Array(K);
  for (let k = 0; k < K; k++) out[k] = quantile(d, STRATA[perm[k]!]!);
  termCache.set(key, out);
  return out;
}

/** Add a draw of `d` to every sample, using the permutation for term `term`; `scale` multiplies the draw. */
function addTerm(samples: Float64Array, d: Dist, term: number, scale = 1): void {
  const draws = termDraws(d, term);
  if (scale === 1) for (let k = 0; k < K; k++) samples[k] = samples[k]! + draws[k]!;
  else for (let k = 0; k < K; k++) samples[k] = samples[k]! + draws[k]! * scale;
}

/**
 * The residual draws for (table, elapsed) — cached per 5 s of elapsed time,
 * because the simulator prices the same bus for many riders in one poll.
 */
const residualCache = new Map<string, Float64Array>();
function residualDraws(d: Dist, r: number, term: number): Float64Array {
  let id = distIds.get(d);
  if (id === undefined) { id = nextDistId++; distIds.set(d, id); }
  const key = `${id}|${Math.round(r / 5)}|${term}`;
  const hit = residualCache.get(key);
  if (hit) return hit;
  if (residualCache.size > 4096) residualCache.clear();
  const perm = permFor(term);
  const f = residual(d, Math.round(r / 5) * 5);
  const out = new Float64Array(K);
  for (let k = 0; k < K; k++) out[k] = f(STRATA[perm[k]!]!);
  residualCache.set(key, out);
  return out;
}

function addResidual(samples: Float64Array, d: Dist, r: number, term: number): void {
  const draws = residualDraws(d, r, term);
  for (let k = 0; k < K; k++) samples[k] = samples[k]! + draws[k]!;
}

// -- the route's chain, precomputed -------------------------------------------

function chainKey(stopIdx: number, occ: number): number { return stopIdx * MAX_OCCURRENCES + occ; }

/**
 * The K-sample prefix sums of (S_s + D_s) along the ring, three laps deep, so
 * a chain from any start to any stop is one vector subtraction:
 *
 *   samples(start leg i, stop at position t) = start + prefix[t] - prefix[i + 1]
 *
 * Built once per served table set (cached on the tables' identity) rather than
 * per rider per poll — the first version summed every hop for every rider
 * and cost a second per poll on the simulator.
 */
interface ChainPrefix { prefix: Float64Array[] }
const prefixCache = new WeakMap<RouteTables, ChainPrefix>();

function chainPrefix(tables: RouteTables): ChainPrefix {
  const hit = prefixCache.get(tables);
  if (hit) return hit;
  const N = tables.hops.length;
  const prefix: Float64Array[] = [new Float64Array(K)];
  for (let k = 0; k < 3 * N; k++) {
    const s = k % N;
    const acc = Float64Array.from(prefix[k]!);
    const hop = tables.hops[s]!;
    if (!hop.includesStand) addTerm(acc, tables.stops[s]!.stand, 2 * s);
    addTerm(acc, hop.drive, 2 * s + 1);
    prefix.push(acc);
  }
  const out = { prefix };
  prefixCache.set(tables, out);
  return out;
}

// -- one situation's chain ----------------------------------------------------

interface Chain {
  sit: Situation;
  /** The first hop's samples, unsorted: what the situation adds before the ring's own terms. */
  start: Float64Array;
  /** Position on the unwrapped ring the chain starts from (its leg). */
  leg: number;
  measured: boolean;
  /** Stop index the situation stands at, else -1. */
  standingAt: number;
}

function startChain(sit: Situation, tables: RouteTables, r: number, restStop: number, N: number): Chain {
  const samples = new Float64Array(K);
  let measured = false;
  let standingAt = -1;
  let leg = sit.leg;
  // A bus MOVING inside the rest radius of its own layover, on the leg into
  // the layover stop, is repositioning — it has not left (the collector's
  // definition of the stand, STATIONARY_RADIUS_M) and it is not arriving
  // afresh. Priced as the rest continuing: the residual given the time
  // already stood, then the drive out. Priced as an arrival it was billed a
  // whole new stand on top of the thirteen minutes already stood (Red #304,
  // 14:06Z 9/3: 80 -> 262 s). Mass moving on the layover's OWN leg is the
  // departure hypothesis and keeps the drive-only price.
  const repositioning = !sit.standing && restStop >= 0 && sit.inRest >= 0.5
    && tables.stops[restStop]!.layover && (sit.leg + 1) % N === restStop;
  if ((sit.standing && sit.zoneStop >= 0 && (!sit.approach || tables.stops[sit.zoneStop]!.layover)) || repositioning) {
    // Standing at (or in the approach of) stop j: the rest of the stand, then the drive out of j.
    const j = repositioning ? restStop : sit.zoneStop;
    standingAt = j;
    leg = j;
    const hop = tables.hops[j]!;
    // Term indices past the ring's own (2N + ...) so the residual draws are independent of the chain's.
    if (!hop.includesStand) addResidual(samples, tables.stops[j]!.stand, r, 6 * tables.hops.length + j);
    addTerm(samples, hop.drive, 2 * j + 1);
    measured = hop.measured || tables.stops[j]!.measured;
  } else {
    // Moving, or holding on the road (a light, a queue): the rest of the
    // leg. A hold is NOT priced separately — the served drive quantiles are
    // `legs.leg_sec`, departure to arrival, so the lights are already in
    // them; billing a residual hold on top double-counted the 8% of polls on
    // which the filter, correctly, carries a "came to a hold" mode.
    const hop0 = tables.hops[leg]!;
    addTerm(samples, hop0.drive, 2 * leg + 1, Math.max(0, 1 - sit.frac));
    measured = hop0.measured;
  }
  return { sit, start: samples, leg, measured, standingAt };
}

/** The chain's samples at the stop `h` hops on (h >= 1), into `out`. */
function chainAt(c: Chain, pre: ChainPrefix, h: number, out: Float64Array): void {
  const a = pre.prefix[c.leg + h]!, b = pre.prefix[c.leg + 1]!;
  const s = c.start;
  for (let k = 0; k < K; k++) out[k] = s[k]! + a[k]! - b[k]!;
}

// -- mixing and the clamp -----------------------------------------------------

/**
 * Weighted quantiles of several SORTED sample arrays, by a k-way merge: no
 * comparator sort, no index array — each part is a typed array sorted once.
 */
function mixedQuantiles(parts: { s: Float64Array; w: number }[], ps: readonly number[]): number[] {
  const P = parts.length;
  if (P === 1) {
    const s = parts[0]!.s;
    return ps.map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  }
  const total = parts.reduce((a, p) => a + p.w, 0);
  const idx = new Int32Array(P);
  const out: number[] = [];
  let acc = 0;
  let lastValue = 0;
  for (const p of ps) {
    const target = p * total;
    while (acc < target) {
      // The smallest head among the parts.
      let best = -1, bestV = Infinity;
      for (let i = 0; i < P; i++) {
        const part = parts[i]!;
        if (idx[i]! < part.s.length && part.s[idx[i]!]! < bestV) { bestV = part.s[idx[i]!]!; best = i; }
      }
      if (best < 0) break;
      const part = parts[best]!;
      acc += part.w / part.s.length;
      lastValue = bestV;
      idx[best] = idx[best]! + 1;
    }
    out.push(lastValue);
  }
  return out;
}

export interface Floors {
  /**
   * Per (stopIdx, occurrence): the remaining seconds last SHOWN while the bus
   * stood, and the stand it was shown under. The shown remainder may pause but
   * never climb (#119's rule: `min(prev, raw)` on the standing term); the
   * arrival instant is deliberately NOT what is clamped — pinning that would
   * run the countdown to zero while the bus still sits.
   */
  map: Map<number, { eta: number; standingAt: number; since: number }>;
}

export function priceRoute(
  belief: Belief,
  ring: Ring,
  tables: RouteTables,
  stops: readonly number[],
  targetStopIds: ReadonlySet<number>,
  now: number,
  tau: number,
  floors?: Floors,
): StopArrival[] {
  const sits = situations(belief, ring);
  if (sits.length === 0) return [];
  const N = ring.N;
  const r = standingSec(belief, now);
  const pre = chainPrefix(tables);
  const restStop = belief.rested ? belief.restStop : -1;
  const chains = sits.map((s) => startChain(s, tables, r, restStop, N));
  // The lead chain: the lead leg's situation in the SHOWN mode (a decision
  // with hysteresis, filter.ts `leadMode`), else the heaviest on the leg.
  const lead = chains.find((c) => c.sit.leg === belief.lead && c.sit.standing === belief.leadStanding)
    ?? chains.find((c) => c.sit.leg === belief.lead) ?? chains[0]!;
  const out: StopArrival[] = [];
  const clockSince = clockOrigin(belief);
  // The clamp (#119): while the lead STANDS, the shown remainder may pause
  // and never climb — min(previous shown, raw), keyed on the stand's stop and
  // clock (the rest identity, filter.ts). While the lead is moving the floor
  // is neither applied nor updated, but it is kept: a bus that pulls out of
  // a depot and reverses into the yard returns to the SAME stand, and the
  // number it showed before the pull-out is the ceiling again — not the
  // drive-only figure the moving spell showed. The floor is dropped only
  // when the rest itself ends (the clock changes).
  const clampAt = lead.standingAt;
  const bufs = chains.map(() => new Float64Array(K));
  const leadBuf = new Float64Array(K);
  const anyMeasured = tables.hops.some((x) => x.measured);
  // Walk the lead chain stop by stop; every other chain is read at the same
  // physical stop and occurrence, which may be a different number of hops on.
  const occ = new Map<number, number>();
  // A bus standing AT a stop has arrived there: that stop's next arrival is
  // now, not a lap later. The legacy path left this to the screen's
  // `at_stop_id` check, which lags the belief by a 15 s dwell and a 75 m
  // radius, so the row read "next lap" for the polls in between.
  if (lead.standingAt >= 0) {
    const sid = stops[lead.standingAt]!;
    occ.set(lead.standingAt, 1);
    if (targetStopIds.has(sid)) {
      out.push({ stopId: sid, occurrence: 0, stopsAhead: 0, eta: 0, low: 0, high: 0, leadMass: lead.sit.mass, estimated: !lead.measured && !anyMeasured, standingAt: lead.standingAt });
    }
  }
  for (let h = 1; h <= 2 * N; h++) {
    const cur = (lead.leg + h) % N;
    const o = occ.get(cur) ?? 0;
    if (o >= MAX_OCCURRENCES) continue;
    occ.set(cur, o + 1);
    const sid = stops[cur]!;
    if (!targetStopIds.has(sid)) continue;
    chainAt(lead, pre, h, leadBuf);
    leadBuf.sort();
    const leadMedian = leadBuf[K >> 1]!;
    if (leadMedian > MAX_ETA_SEC) break;
    const parts: { s: Float64Array; w: number }[] = [{ s: leadBuf, w: lead.sit.mass }];
    const all: { s: Float64Array; w: number }[] = [{ s: leadBuf, w: lead.sit.mass }];
    let mass = lead.sit.mass;
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      if (c === lead) continue;
      // Hops from this chain's leg to the same stop, same occurrence: a chain
      // reaches its own leg's start stop only a lap on.
      const first = ((cur - c.leg) % N + N) % N || N;
      const hc = first + o * N;
      if (hc > 2 * N) continue;
      chainAt(c, pre, hc, bufs[i]!);
      bufs[i]!.sort();
      all.push({ s: bufs[i]!, w: c.sit.mass });
      // The number is the lead situation's alone: the lead leg in the shown
      // mode, both decisions with hysteresis (filter.ts). Every other
      // situation — the other mode on the same leg, the other branch of a
      // fold, a lap away, a cold belief's guess two stops back — is an
      // alternative that the RANGE carries. Mixing by raw mass let a 0.65
      // guess two stops back turn "in 1" into "in 5", and let the standing
      // and moving variants flip the number a bucket as their shares
      // crossed 0.5.
    }
    // The number follows the lead cluster (hysteresis lives in the lead leg);
    // the RANGE is honest about the rest: while alternatives still hold a
    // fifth of the mass, low and high come from the full mixture, so a
    // 50/50 fold does not read as "17 s [13-23]" (the review's finding 7).
    const [q10, qt, q90] = mixedQuantiles(parts, [0.1, tau, 0.9]) as [number, number, number];
    let eta = qt, low = q10, high = q90;
    if (mass < LEAD_SWITCH_MASS && all.length > parts.length) {
      const [f10, f90] = mixedQuantiles(all, [0.1, 0.9]) as [number, number];
      low = Math.min(low, f10); high = Math.max(high, f90);
    }
    const key = chainKey(cur, o);
    if (floors && clampAt >= 0) {
      const prev = floors.map.get(key);
      if (prev && prev.standingAt === clampAt && prev.since === clockSince) {
        const shown = Math.min(prev.eta, eta);
        const delta = shown - eta;
        eta = shown; low = Math.max(0, low + delta); high = Math.max(0, high + delta);
        floors.map.set(key, { eta: shown, standingAt: clampAt, since: clockSince });
      } else {
        floors.map.set(key, { eta, standingAt: clampAt, since: clockSince });
      }
    }
    out.push({
      stopId: sid,
      occurrence: o,
      stopsAhead: h,
      eta, low: Math.min(low, eta), high: Math.max(high, eta),
      leadMass: mass,
      estimated: !lead.measured && !anyMeasured,
      standingAt: lead.standingAt,
    });
  }
  return out;
}
