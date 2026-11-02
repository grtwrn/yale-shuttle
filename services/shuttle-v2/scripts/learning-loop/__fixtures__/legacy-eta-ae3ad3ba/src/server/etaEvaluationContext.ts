import type { CalibrationSource } from '../calibrator/provenance.js';
import { validCalibrationSource } from '../calibrator/provenance.js';
import type { CollectorWitnessReference } from '../collector/witnessCapture.js';
import type { K10Evidence } from '../collector/k10Clock.js';

/** Exact inputs to the post-processing performed at one model observation.
 * Internal authenticated replay metadata; never part of the rider payload. */
export interface EtaEvaluationContext {
  v: 1;
  at: number;
  /** Optional on older producer journals; absence is unknown. */
  calibration?: CalibrationSource | null;
  /** Last captured collector poll. A later fit/static refresh may share it;
   * only its own stored input/topology describes that poll's source writes. */
  collectorWitness?: CollectorWitnessReference | null;
  trial: { enabled: boolean; route: boolean; blue: boolean; evidence: [string, K10Evidence][] };
}

export function validEvaluationContext(value: unknown, at: number): value is EtaEvaluationContext {
  const c = value as EtaEvaluationContext | undefined;
  if (!c || c.v !== 1 || c.at !== at || !Number.isSafeInteger(at) || at < 0 || !c.trial
    || typeof c.trial.enabled !== 'boolean' || typeof c.trial.route !== 'boolean' || typeof c.trial.blue !== 'boolean'
    || !Array.isArray(c.trial.evidence) || c.trial.evidence.length > 200
    || (!c.trial.enabled && c.trial.evidence.length > 0)) return false;
  if (c.calibration !== undefined && c.calibration !== null && !validCalibrationSource(c.calibration)) return false;
  if (c.collectorWitness !== undefined && c.collectorWitness !== null) {
    const w = c.collectorWitness, hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
    if (typeof w.epoch !== 'string' || !w.epoch.length || w.epoch.length > 100
      || !Number.isSafeInteger(w.seq) || w.seq < 1 || !Number.isSafeInteger(w.at) || w.at < 0 || w.at > at + 5000
      || !hash(w.sha256) || !hash(w.chain) || !['recorded', 'unavailable'].includes(w.status)
      || (w.topologySha256 !== null && !hash(w.topologySha256))
      || (w.status === 'recorded' && w.topologySha256 === null)) return false;
  }
  const names = new Set<string>();
  for (const pair of c.trial.evidence) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [name, e] = pair;
    if (typeof name !== 'string' || !name.length || name.length > 100 || names.has(name) || !e || !e.origin
      || ![e.observedAt, e.origin.departed, e.origin.knownAt, e.index].every(Number.isSafeInteger)
      || e.observedAt < 0 || e.origin.departed < 0 || e.origin.knownAt < 0
      || !['hold', 'drive'].includes(e.phase) || typeof e.released !== 'boolean'
      || (e.routeId !== undefined && (!Number.isSafeInteger(e.routeId) || e.routeId < 0))) return false;
    names.add(name);
  }
  // Causal checks remain in the actual overlay functions. A stale/future or
  // otherwise ineligible observation must reproduce the same fallback.
  return Buffer.byteLength(JSON.stringify(c)) <= 256 * 1024;
}
