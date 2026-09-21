import fs from 'node:fs';
import type { K10Evidence } from '../collector/k10Clock.js';
import type { ServerEtaWire, ServerEtaRow } from '../../web/src/etaSource.js';

export interface K10Model {
  version: string;
  trainBefore: number;
  validUntil: number;
  sequence: number[];
  /** Completed training paths: ET day, departure minute, duration seconds. */
  paths: Record<string, [string, number, number][]>;
}
export const K10_MODEL: K10Model = JSON.parse(fs.readFileSync(new URL('./data/k10-model.json', import.meta.url), 'utf8'));
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' });
function minute(at: number) {
  const p = et.formatToParts(at);
  const get = (t: string) => Number(p.find(x => x.type === t)?.value);
  return get('hour') * 60 + get('minute') + get('second') / 60;
}

/** Same duration-weighted mean as the research implementation: subtract elapsed
 * AFTER averaging, preserving the stopped-time relationship along the route. */
export function k10Prediction(model: K10Model, target: number, departed: number, now: number) {
  if (departed > now || departed < model.trainBefore || now >= model.validUntil || now - departed > 2_700_000) return null;
  const clock = minute(departed), elapsed = (now - departed) / 1000;
  const paths = (model.paths[target] ?? []).map(([day, start, duration]) =>
    ({ day, duration, weight: Math.exp(-0.5 * ((start - clock) / 120) ** 2) })).filter(p => p.weight >= 1e-12);
  const total = paths.reduce((s, p) => s + p.weight, 0);
  const squares = paths.reduce((s, p) => s + p.weight ** 2, 0);
  const days = new Map<string, number>();
  for (const p of paths) days.set(p.day, (days.get(p.day) ?? 0) + p.weight);
  if (!total || total ** 2 / squares < 12 || [...days.values()].filter(w => w >= total * .05).length < 3) return null;
  paths.sort((a, b) => a.duration - b.duration);
  const q = (probability: number) => {
    let acc = 0;
    for (const p of paths) { acc += p.weight; if (acc >= probability * total) return Math.max(0, p.duration - elapsed); }
    return Math.max(0, paths.at(-1)!.duration - elapsed);
  };
  const eta = Math.max(0, paths.reduce((s, p) => s + p.duration * p.weight, 0) / total - elapsed);
  return { eta, low: Math.min(eta, q(.1)), high: Math.max(eta, q(.9)),
    distribution: Array.from({ length: 50 }, (_, i) => q((i + .5) / 50)) };
}

/** Overlay only this lap's validated downstream pickups. Full live rows and
 * distributions survive every fallback and the observed-departure handoff. */
export function applyK10Trial(wire: ServerEtaWire, evidence: ReadonlyMap<string, K10Evidence>,
  sequence: readonly number[] | undefined, model = K10_MODEL): ServerEtaWire {
  const enabled = sequence?.join(',') === model.sequence.join(',') && wire.at < model.validUntil;
  let changed = 0;
  const distributions = wire.rows.map((_, i) => wire.distributions?.[i] ?? []);
  const rows = wire.rows.map((r, i): ServerEtaRow => {
    const b = wire.buses[r[0]], e = b && evidence.get(b[0]);
    const target = model.sequence.indexOf(r[1]);
    if (!enabled || !b || b[1] !== 'Red' || !e || e.released || e.index < 8 || e.index > 14
      || target < 15 || target <= e.index || r[5] <= 0 || r[5] > target - 4
      || b[2] < 4 || b[2] > 14 || r[5] !== target - b[2]
      || e.origin.departed > e.origin.knownAt || e.origin.knownAt > e.observedAt
      || e.observedAt > wire.at || wire.at - e.observedAt > 15_000) return r;
    const p = k10Prediction(model, r[1], e.origin.departed, wire.at);
    // A historical countdown must not become "now" upstream while a cached
    // snapshot is still fresh (45s TTL + the 15s now threshold).
    if (!p || p.eta <= 60) return r;
    changed++;
    distributions[i] = p.distribution.map(Math.round);
    return [r[0], r[1], Math.round(p.eta), Math.round(p.low), Math.round(p.high), r[5], r[6], r[7], r[8]];
  });
  return { ...wire, rows, distributions, trial: { model: model.version, changedRows: changed, validUntil: model.validUntil } };
}
