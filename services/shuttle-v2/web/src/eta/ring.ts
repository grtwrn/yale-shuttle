/**
 * The ring: a route's published polyline cut into cells of ~30 m, in travel
 * order, closed on itself.
 *
 * 30 m is the feed's own quantum (docs/eta-error-budget.md: a new coordinate is
 * reported only once the vehicle has moved about 30 m; p1 of displacement
 * 30.1 m). A cell is therefore the finest position the sensor can distinguish,
 * and "the fix did not change" means "the bus is in the same cell" — the
 * observation model in filter.ts rests on that.
 *
 * Legs come from `traceStopLegs` (geo.ts), which projects each stop onto the
 * polyline and walks forward — the correction that fixed the drawn route lines
 * (CLAUDE.md, "the published geometry is right, drawing it was wrong"). Cell 0
 * of leg i sits on stop i itself, so a stop is a cell and standing at it is a
 * state.
 */

import { haversineMeters, polylineMeters, traceStopLegs, type LatLon } from "../geo";
import type { Dist } from "./dist";

/** Cell pitch, metres. The sensor's deadband. */
export const CELL_M = 30;

/**
 * A cell within this distance of a stop belongs to that stop's standing zone:
 * the collector's own `AT_STOP_PIN_M`, which is the radius the stand tables
 * were measured with (`stop_visits.pinned_at`).
 */
export const NEAR_STOP_M = 75;

/**
 * A rest within this many metres SHORT of the next stop, when that stop is a
 * layover, is that layover (hopPricing.ts `APPROACH_ZONE_M`, measured to fire on
 * one episode in nine hours with the next-stop constraint). Here it is a cell
 * attribute; whether the stop is a layover is decided by its stand table at
 * pricing time.
 */
export const APPROACH_M = 200;

export interface Ring {
  /** Cache key: route id + stop sequence + polyline content hash. */
  key: string;
  /** Number of cells. */
  C: number;
  /** Number of stops (= legs). */
  N: number;
  loopM: number;
  lat: Float64Array;
  lon: Float64Array;
  /** Cumulative metres from stop 0 to the cell. */
  metre: Float64Array;
  /** Leg index per cell: the leg from stop `leg` to stop `leg + 1`. */
  leg: Int32Array;
  /** Fraction of the leg's road length covered at the cell, 0 at the stop. */
  frac: Float32Array;
  /** First cell of each leg — the cell ON stop i. */
  stopCell: Int32Array;
  /** Road metres of each leg. */
  legM: Float64Array;
  /** Per cell: the stop (leg start or leg end) within NEAR_STOP_M, else -1. */
  nearStop: Int32Array;
  /** Per cell: the leg's end stop when the cell is within APPROACH_M short of it and not `nearStop`, else -1. */
  approachOf: Int32Array;
  /** True when any leg had to be bridged with a chord (the published line could not supply it). */
  bridged: boolean;
  /**
   * Per-leg driving speed, m/s, for the transition kernel — set from the
   * served drive tables (`setRingProfile`), DEFAULT_DRIVE_M_S until then. The
   * ring is cached per route so every call site shares one profile.
   */
  legSpeed: Float64Array;
  /** Per-stop P(the bus stops), for the kernel's capture at a stop cell — from the stand tables' mass at zero. */
  pStop: Float64Array;
  /** Per-stop stand distribution, for the departure hazard; null until the tables have been seen. */
  stand: (Dist | null)[];
}

/** Driving speed before any table has been seen (measured p50 6.6-7.1 m/s downtown). */
export const DEFAULT_DRIVE_M_S = 7;
/** P(stops | pass) pooled over every stop, before any table has been seen. */
export const DEFAULT_P_STOP = 0.877;

/** Install the tables' speeds and stop probabilities on the (shared, cached) ring. */
export function setRingProfile(ring: Ring, legSpeed: ArrayLike<number>, pStop: ArrayLike<number>, stand?: ArrayLike<Dist | null>): void {
  for (let i = 0; i < ring.N; i++) {
    const v = legSpeed[i];
    ring.legSpeed[i] = v !== undefined && Number.isFinite(v) && v > 0.5 ? v : DEFAULT_DRIVE_M_S;
    const p = pStop[i];
    ring.pStop[i] = p !== undefined && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : DEFAULT_P_STOP;
    ring.stand[i] = stand ? (stand[i] ?? null) : null;
  }
}

function walkLeg(slice: readonly (readonly [number, number])[], n: number): { lat: number[]; lon: number[]; m: number[] } {
  // Place n cells at metres k * L / n along the slice, k = 0..n-1.
  const L = polylineMeters(slice as [number, number][]);
  const step = L / n;
  const lat: number[] = [], lon: number[] = [], m: number[] = [];
  let seg = 0;
  let segStartM = 0;
  let segLen = seg + 1 < slice.length
    ? haversineMeters({ lat: slice[0]![0], lon: slice[0]![1] }, { lat: slice[1]![0], lon: slice[1]![1] })
    : 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (seg + 1 < slice.length - 1 && segStartM + segLen < target) {
      segStartM += segLen;
      seg++;
      segLen = haversineMeters(
        { lat: slice[seg]![0], lon: slice[seg]![1] },
        { lat: slice[seg + 1]![0], lon: slice[seg + 1]![1] },
      );
    }
    const a = slice[seg]!, b = slice[Math.min(seg + 1, slice.length - 1)]!;
    const t = segLen > 0 ? Math.max(0, Math.min(1, (target - segStartM) / segLen)) : 0;
    lat.push(a[0] + (b[0] - a[0]) * t);
    lon.push(a[1] + (b[1] - a[1]) * t);
    m.push(target);
  }
  return { lat, lon, m };
}

function hashPath(path: readonly (readonly [number, number])[]): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    h = Math.imul(h ^ Math.round(p[0] * 1e6), 16777619);
    h = Math.imul(h ^ Math.round(p[1] * 1e6), 16777619);
  }
  return `${path.length}:${(h >>> 0).toString(16)}`;
}

const ringCache = new Map<string, Ring | null>();

/**
 * Build (or fetch from cache) the ring for a route. Returns null when the
 * geometry cannot be traced — a caller then falls back to the legacy
 * estimator, exactly as `legGeometry` in anchor.ts returns null.
 */
export function ringFor(
  routeId: string | number,
  path: readonly (readonly [number, number])[] | undefined,
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
): Ring | null {
  if (!path || path.length < 2 || stops.length < 2) return null;
  const key = `${routeId}|${stops.join(",")}|${hashPath(path)}`;
  const hit = ringCache.get(key);
  if (hit !== undefined) return hit;
  const built = buildRing(key, path, stops, stopCoords);
  ringCache.set(key, built);
  return built;
}

export function buildRing(
  key: string,
  path: readonly (readonly [number, number])[],
  stops: readonly number[],
  stopCoords: Record<number, LatLon>,
): Ring | null {
  const N = stops.length;
  const coords: LatLon[] = [];
  for (const sid of stops) {
    const c = stopCoords[sid];
    if (!c) return null;
    coords.push(c);
  }
  coords.push(coords[0]!); // close the loop
  const legs = traceStopLegs(path as [number, number][], coords);
  if (legs.length !== N) return null;

  const lat: number[] = [], lon: number[] = [], metre: number[] = [], leg: number[] = [], frac: number[] = [];
  const stopCell: number[] = [], legM: number[] = [];
  let cum = 0;
  let bridged = false;
  for (let i = 0; i < N; i++) {
    const slice = legs[i]!.slice;
    bridged = bridged || legs[i]!.bridged;
    const L = Math.max(1, polylineMeters(slice));
    const n = Math.max(1, Math.round(L / CELL_M));
    const w = walkLeg(slice, n);
    stopCell.push(lat.length);
    legM.push(L);
    for (let k = 0; k < n; k++) {
      lat.push(w.lat[k]!); lon.push(w.lon[k]!);
      metre.push(cum + w.m[k]!);
      leg.push(i);
      frac.push(w.m[k]! / L);
    }
    cum += L;
  }
  const C = lat.length;
  const nearStop = new Int32Array(C).fill(-1);
  const approachOf = new Int32Array(C).fill(-1);
  for (let c = 0; c < C; c++) {
    const i = leg[c]!;
    const j = (i + 1) % N;
    const here = { lat: lat[c]!, lon: lon[c]! };
    const dA = haversineMeters(here, coords[i]!);
    const dB = haversineMeters(here, coords[j]!);
    if (dA <= NEAR_STOP_M || dB <= NEAR_STOP_M) {
      nearStop[c] = dA <= dB ? i : j;
      continue;
    }
    const toEnd = legM[i]! - (metre[c]! - metre[stopCell[i]!]!);
    if (toEnd <= APPROACH_M) approachOf[c] = j;
  }
  return {
    key, C, N, loopM: cum,
    lat: Float64Array.from(lat), lon: Float64Array.from(lon), metre: Float64Array.from(metre),
    leg: Int32Array.from(leg), frac: Float32Array.from(frac),
    stopCell: Int32Array.from(stopCell), legM: Float64Array.from(legM),
    nearStop, approachOf, bridged,
    legSpeed: new Float64Array(N).fill(DEFAULT_DRIVE_M_S),
    pStop: new Float64Array(N).fill(DEFAULT_P_STOP),
    stand: new Array<Dist | null>(N).fill(null),
  };
}

/** Distance from a fix to every cell, metres. */
export function distancesTo(ring: Ring, fix: LatLon, out?: Float64Array): Float64Array {
  const d = out ?? new Float64Array(ring.C);
  for (let c = 0; c < ring.C; c++) d[c] = haversineMeters(fix, { lat: ring.lat[c]!, lon: ring.lon[c]! });
  return d;
}

/** Ring distance forward from cell a to cell b, in cells. */
export function forwardCells(ring: Ring, a: number, b: number): number {
  return ((b - a) % ring.C + ring.C) % ring.C;
}
