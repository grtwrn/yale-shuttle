/** A revision identifies visible database contents, not a historical commit
 * time. Existing rows' write times and observation topology remain unknown. */
export type CalibrationWatermark = {
  status: 'recorded';
  epoch: string;
  revision: number;
  tables: { arrivals: number; segments: number; stopVisits: number; legs: number };
} | { status: 'unavailable'; reason: 'legacy-database' | 'outer-transaction' | 'revision-schema-incomplete' };

export interface CalibrationReadReceipt {
  v: 1;
  id: string;
  asOf: number;
  /** Runtime zone for Date's local day/hour grouping, distinct from asOf UTC. */
  timeZone: string;
  startedAt: number;
  completedAt: number;
  watermark: CalibrationWatermark;
}

export type CalibrationReader = <T>(asOf: number, read: () => T) => {
  value: T;
  receipt: CalibrationReadReceipt;
};

export interface CachedFitSource {
  attemptedAt: number | null;
  readFailed: boolean;
  generation: CalibrationReadReceipt | null;
}

export interface CalibrationSource {
  v: 1;
  main: CalibrationReadReceipt;
  /** The network used by this calibration, never the old rows' topology. */
  topologySha256: string;
  lap: CachedFitSource | null;
  release: CachedFitSource | null;
  hourStand: CachedFitSource | null;
}

const clock = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const uuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);

export function validCalibrationRead(value: unknown): value is CalibrationReadReceipt {
  const r = value as CalibrationReadReceipt | undefined;
  if (!r || r.v !== 1 || !uuid(r.id) || ![r.asOf, r.startedAt, r.completedAt].every(clock)
    || typeof r.timeZone !== 'string' || !r.timeZone.length || r.timeZone.length > 100 || !r.watermark) return false;
  // Wall time can move backwards. These are observed wall clocks, not elapsed
  // durations or an invented commit-availability timestamp.
  const w = r.watermark;
  if (w.status === 'unavailable') return ['legacy-database', 'outer-transaction', 'revision-schema-incomplete'].includes(w.reason);
  return w.status === 'recorded' && /^[0-9a-f]{32}$/.test(w.epoch) && clock(w.revision)
    && !!w.tables && ['arrivals', 'segments', 'stopVisits', 'legs'].every(k => clock(w.tables[k as keyof typeof w.tables]))
    && w.revision === w.tables.arrivals + w.tables.segments + w.tables.stopVisits + w.tables.legs;
}

export function validCalibrationSource(value: unknown): value is CalibrationSource {
  const s = value as CalibrationSource | undefined;
  if (!s || s.v !== 1 || !validCalibrationRead(s.main) || !/^[0-9a-f]{64}$/.test(s.topologySha256)) return false;
  return [s.lap, s.release, s.hourStand].every(c => c === null || (!!c
    && (c.attemptedAt === null || clock(c.attemptedAt)) && typeof c.readFailed === 'boolean'
    && (c.generation === null || validCalibrationRead(c.generation))));
}
