/** Experimental release model. Explicitly disabled unless a replay supplies fits. */
import type { Dist } from './dist';
export interface ReleaseFit { stopId: number; referenceLap: number; coefficients: number[] }
export interface ReleasePin { stopId: number; since: number; lapAtPin?: number }
export interface ReleaseExperiment { current: boolean; future: boolean; unclamp: boolean; transition?: boolean; shuffle?: boolean; winchesterOnly?: boolean; smoothSec?: number; freezeLap?: boolean; rawBand?: boolean | 'upper' }
let experiment: ReleaseExperiment = { current: false, future: false, unclamp: false };
let fits = new Map<number, ReleaseFit>();
const cache = new Map<string, Dist>();
export function setReleaseFits(values: ReleaseFit[]): void { fits = new Map(values.map(v => [v.stopId, v])); cache.clear(); }
export function setReleaseExperiment(value: ReleaseExperiment): void { experiment = value; }
export function releaseExperiment(): ReleaseExperiment { return experiment; }

export function releaseDist(stopId: number, pinAt: number, lap: number | undefined): Dist | null {
  const fit = fits.get(stopId);
  if (!fit || lap === undefined || !Number.isFinite(lap) || lap < .65 * fit.referenceLap || lap > 1.65 * fit.referenceLap) return null;
  // Quantization only bounds the simulation cache; the output has no time cap.
  const phase = Math.round((((pinAt / 1000) % 900) + 900) % 900 / 5) * 5;
  const lapSec = Math.round(lap / 5) * 5;
  const key = `${stopId}|${phase}|${lapSec}`;
  const hit = cache.get(key); if (hit) return hit;
  const xs: number[] = [0], ps: number[] = [0];
  let logS = 0, lastHazard = 1 / 240;
  for (let end = 15; end <= 1800; end += 15) {
    const t = end - 7.5, angle = 2 * Math.PI * (phase + t) / 900;
    const x = [1, Math.log1p(t / 60), t / 600, Math.max(0, t - 300) / 600,
      Math.max(0, t - 600) / 600, (lapSec - fit.referenceLap) / 600, 0, Math.sin(angle), Math.cos(angle)];
    const z = x.reduce((a, v, i) => a + v * fit.coefficients[i]!, 0);
    const h = Math.min(1 - 1e-9, Math.max(1e-9, 1 / (1 + Math.exp(-z))));
    lastHazard = -Math.log1p(-h) / 15;
    logS += Math.log1p(-h);
    if (logS < Math.log(1e-6)) break;
    xs.push(end); ps.push(-Math.expm1(logS));
  }
  const d = { xs: Float64Array.from(xs), ps: Float64Array.from(ps), tailHazard: Math.min(1 / 5, Math.max(1 / 1800, lastHazard)) };
  if (cache.size > 32768) cache.clear();
  cache.set(key, d); return d;
}
