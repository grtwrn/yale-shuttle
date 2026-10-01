/** Offline pin-history intervention only. Never imported by deployed source.
 * Fold the frozen 11/13-feature hazard into the unchanged nine-feature runtime.
 * No current hold outcome, endpoint, or recorded lap is read by this adapter.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type HistoryArm = 'core' | 'union' | 'history';
interface ReleaseFit {
  stopId: number;
  referenceLap: number;
  coefficients: number[];
  n: number;
  days: number;
}
interface Dist {
  readonly xs: Float64Array;
  readonly ps: Float64Array;
  readonly tailHazard: number;
}
interface PinHistory {
  id: number;
  pinAt: number;
  unionAge: number | null;
  priorStandLog: number;
  priorStandMissing: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const historyRoot = path.resolve(here, '../own-history');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(historyRoot, name), 'utf8'));
const frozen = read('fits.json');
const referenceLap: number = frozen.referenceLap;
const referenceUnionAge: number = frozen.referenceUnionAge;
const coefficients: Record<HistoryArm, number[]> = {
  core: frozen.fits.primary.lap_elapsed_clock.coefficients,
  union: frozen.fits.primary.plus_own_union_age.coefficients,
  history: frozen.fits.primary.plus_previous_winchester_hold.coefficients,
};
for (const [name, n] of [['core', 9], ['union', 11], ['history', 13]] as const) {
  const beta = coefficients[name];
  if (beta.length !== n || beta.some(x => !Number.isFinite(x))) throw Error(`Invalid frozen ${name} fit`);
}

const histories = new Map<number, PinHistory>();
for (const e of [...read('cohort.json'), ...read('extension-cohort.json')]) {
  const pinAt = e.a as number;
  if (!Number.isFinite(pinAt) || histories.has(pinAt)) throw Error(`Nonunique pin history ${pinAt}`);
  const unionAge: number | null = e.ownUnionAge;
  if (unionAge !== null) {
    if (!Number.isFinite(unionAge) || !Number.isFinite(e.ownUnionDeparture) ||
        e.ownUnionDeparture > pinAt - 120_000 ||
        Math.abs((pinAt - e.ownUnionDeparture) / 1000 - unionAge) > 1e-6) {
      throw Error(`Union history not available at pin ${pinAt}`);
    }
  }
  const source = e.histories.primary.latest['11'];
  const features: number[] = e.histories.primary.features;
  const duration: number | null = source.duration;
  const priorStandMissing = duration === null ? 1 : 0;
  const priorStandLog = duration === null ? 0 : Math.log1p(duration / 60);
  if (!Number.isFinite(priorStandLog) ||
      Math.abs(priorStandLog - features[0]!) > 1e-10 || priorStandMissing !== features[1]) {
    throw Error(`Prior Winchester feature mismatch at ${pinAt}`);
  }
  if (duration !== null && (!source.clockUsable || source.knownAt > pinAt || source.departedAt >= pinAt)) {
    throw Error(`Prior Winchester duration not known at ${pinAt}`);
  }
  if (source.id === 65237 && duration !== null) throw Error('Corrupt prior duration was not masked');
  histories.set(pinAt, {id: e.id, pinAt, unionAge, priorStandLog, priorStandMissing});
}

function parseArm(value: string): HistoryArm {
  if (value === 'core' || value === 'union' || value === 'history') return value;
  throw Error(`Unknown offline history arm ${value}`);
}
let arm: HistoryArm = parseArm(process.env.HISTORY_ARM ?? process.env.HISTORY_RELEASE_ARM ?? 'core');
const folded = new WeakSet<object>();
const checkedCore = new WeakSet<object>();
const fitCache = new Map<string, ReleaseFit>();
const counts = Object.fromEntries((['core', 'union', 'history'] as const).map(a => [a, {
  calls: 0, matched: 0, unmatched: 0, unsupported: 0, overrides: 0,
  matchedPins: new Set<number>(), unmatchedPins: new Set<number>(),
  matchedIds: new Set<number>(), overrideIds: new Set<number>(),
}])) as Record<HistoryArm, {
  calls: number; matched: number; unmatched: number; unsupported: number; overrides: number;
  matchedPins: Set<number>; unmatchedPins: Set<number>; matchedIds: Set<number>; overrideIds: Set<number>;
}>;

export function setOfflineHistoryArm(next: HistoryArm): void { arm = parseArm(next); }
export const setHistoryArm = setOfflineHistoryArm;

/** undefined: use original core; null: original unsupported-lap fallback. */
export function offlineHistoryFit(fit: ReleaseFit, pinAt: number, lap: number | undefined): ReleaseFit | null | undefined {
  // A compatibility wrapper may invoke the hooked runtime recursively once.
  if (folded.has(fit)) return undefined;
  if (fit.stopId !== 11) return undefined;
  if (!checkedCore.has(fit)) {
    if (fit.referenceLap !== referenceLap || fit.n !== 160 || fit.days !== 6 ||
        fit.coefficients.length !== 9 ||
        fit.coefficients.some((x, i) => Math.abs(x - coefficients.core[i]!) > 1e-5)) {
      throw Error('Offline replay must use the same frozen 160-hold core fit in every arm');
    }
    checkedCore.add(fit);
  }
  const audit = counts[arm]; audit.calls++;
  const history = histories.get(pinAt);
  if (history) {
    audit.matched++; audit.matchedPins.add(pinAt); audit.matchedIds.add(history.id);
  } else {
    audit.unmatched++; audit.unmatchedPins.add(pinAt);
  }
  const supported = lap !== undefined && Number.isFinite(lap) &&
    lap >= .65 * fit.referenceLap && lap <= 1.65 * fit.referenceLap;
  if (!supported) audit.unsupported++;
  if (arm === 'core' || !history) return undefined;
  if (!supported) return null;
  audit.overrides++; audit.overrideIds.add(history.id);
  const key = `${arm}|${pinAt}`;
  const hit = fitCache.get(key);
  if (hit) return hit;
  const beta = coefficients[arm];
  const core = beta.slice(0, 9);
  if (history.unionAge === null) core[0]! += beta[10]!;
  else {
    core[0]! += beta[9]! * (history.unionAge - referenceUnionAge) / 600;
    // Own Union age advances with deterministic future elapsed time.
    core[2]! += beta[9]!;
  }
  if (arm === 'history') {
    core[0]! += beta[11]! * history.priorStandLog + beta[12]! * history.priorStandMissing;
  }
  const next: ReleaseFit = {...fit, coefficients: core};
  folded.add(next); fitCache.set(key, next);
  return next;
}

/** Optional recursive compatibility API; preferred build hook replaces fit. */
export function offlineHistoryDist(
  fit: ReleaseFit, pinAt: number, lap: number | undefined,
  coreReleaseDist: (fit: ReleaseFit, pinAt: number, lap: number | undefined) => Dist | null,
): Dist | null | undefined {
  const override = offlineHistoryFit(fit, pinAt, lap);
  if (override === undefined || override === null) return override;
  return coreReleaseDist(override, pinAt, lap);
}

export function offlineHistoryAudit() {
  return {
    arm, historyPins: histories.size, referenceLap, referenceUnionAge,
    fitCreatedAt: frozen.createdAt, cachedFits: fitCache.size,
    counts: Object.fromEntries(Object.entries(counts).map(([name, value]) => [name, {
      ...value, matchedPins: [...value.matchedPins].sort((a, b) => a - b),
      unmatchedPins: [...value.unmatchedPins].sort((a, b) => a - b),
      matchedIds: [...value.matchedIds].sort((a, b) => a - b),
      overrideIds: [...value.overrideIds].sort((a, b) => a - b),
    }])),
  };
}
export const historyAudit = offlineHistoryAudit;
