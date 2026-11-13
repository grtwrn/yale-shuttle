import type Database from 'better-sqlite3';
import type { TransitNetwork } from '../network/TransitNetwork.js';
import { completeRevisionSchema } from '../db/calibrationSnapshot.js';
import { CollectorWitnessJournal, type WitnessFrame, type WitnessTopology } from './witnessJournal.js';
import { witnessJSON, witnessSHA } from './witnessCodec.js';

export type WitnessTable = 'arrivals' | 'segments' | 'stop_visits' | 'legs';
export interface SourceMutation {
  table: WitnessTable;
  operation: 'insert' | 'update';
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}
interface InputFence { epoch: string; revision: number; arrivals: number; segments: number; stop_visits: number; legs: number }
interface CommittedWrite {
  before: InputFence | null; after: InputFence | null;
  mutations: { table: WitnessTable; operation: SourceMutation['operation']; beforeJSON: string | null;
    afterJSON: string; beforeSHA256: string | null; afterSHA256: string }[];
}
interface Attempt {
  at: number; observations: unknown; versionBefore: number; topology: WitnessTopology;
  stateBeforeJSON: string; inputBefore: InputFence | null; writes: CommittedWrite[]; errors: string[];
}
export interface CollectorWitnessReference {
  epoch: string; seq: number; at: number; sha256: string; chain: string;
  topologySha256: string | null; status: WitnessFrame['status'];
}

/** SQLite/Drizzle return the same row with different names/date wrappers. */
export function sourceWitnessRow(row: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()),
    value instanceof Date ? value.getTime() : typeof value === 'boolean' ? Number(value) : value ?? null,
  ]));
}

/** Capture only. SQL/state decisions remain the collector's. The journal
 * cannot withhold GPS or ETA output when diagnostic capture is unavailable. */
export class CollectorWitnessCapture {
  readonly journal: CollectorWitnessJournal;
  private attempt: Attempt | null = null;
  private latest: CollectorWitnessReference | null = null;
  private errors = 0;

  constructor(private readonly sqlite: Database.Database, journal = new CollectorWitnessJournal()) {
    this.journal = journal;
  }

  begin(at: number, observations: unknown, network: TransitNetwork, version: number, state: unknown): void {
    try {
      if (this.attempt) throw new Error('Previous collector capture was not completed');
      // Capture actual geometry, including any in-place change. A cache keyed
      // only on the network object would silently miss a changed stop/path.
      const topology = CollectorWitnessJournal.topology(network.observationTopology());
      const errors: string[] = [], inputBefore = this.tryFence(errors, 'poll-input-before-unavailable');
      // Snapshot before the reducer mutates its maps or the raw input objects.
      this.attempt = { at, observations: structuredClone(observations), versionBefore: version,
        topology, stateBeforeJSON: witnessJSON(state), inputBefore, writes: [], errors };
    } catch (error) { this.attempt = null; this.unavailable(at, error); }
  }

  /** Each statement's source rows and counter range commit together. This
   * does not make the entire poll atomic: a later failed write remains visible
   * as a failed poll with its earlier committed statements retained. */
  write<T>(action: () => { value: T; mutations: SourceMutation[] }): T {
    const attempt = this.attempt;
    if (!attempt) return action().value;
    if (this.sqlite.inTransaction) {
      attempt.errors.push('outer-source-transaction'); return action().value;
    }
    try {
      const result = this.sqlite.transaction(() => {
        let before: InputFence | null = null;
        try { before = this.fence(); } catch { attempt.errors.push('source-revision-before-unavailable'); }
        const result = action();
        let after: InputFence | null = null;
        try { after = this.fence(); } catch { attempt.errors.push('source-revision-after-unavailable'); }
        return { ...result, before, after };
      }).immediate();
      // Publish the diagnostic receipt only after the source transaction commits.
      try {
        const mutations = result.mutations.map(m => {
          const beforeJSON = m.before === null ? null : witnessJSON(m.before), afterJSON = witnessJSON(m.after);
          return { table: m.table, operation: m.operation, beforeJSON, afterJSON,
            beforeSHA256: beforeJSON === null ? null : witnessSHA(beforeJSON), afterSHA256: witnessSHA(afterJSON) };
        });
        attempt.writes.push({ before: result.before, after: result.after, mutations });
      } catch { attempt.errors.push('source-row-encoding-unavailable'); }
      return result.value;
    } catch (error) {
      // A source transaction failure is never retried here. Diagnostic reads
      // and encoding are handled independently above, so they cannot abort it.
      throw error;
    }
  }

  complete(at: number, version: number, state: unknown, failure?: string): void {
    const attempt = this.attempt; this.attempt = null;
    if (!attempt) return;
    try {
      const inputAfter = this.tryFence(attempt.errors, 'poll-input-after-unavailable');
      let expected = attempt.inputBefore;
      const same = (a: InputFence | null, b: InputFence | null) => a !== null && b !== null
        && a.epoch === b.epoch && a.revision === b.revision
        && a.arrivals === b.arrivals && a.segments === b.segments && a.stop_visits === b.stop_visits && a.legs === b.legs;
      for (const write of attempt.writes) {
        if (expected && write.before && !same(expected, write.before)) attempt.errors.push('intervening-source-writes');
        if (write.before && write.after && (write.before.epoch !== write.after.epoch
          || write.after.revision - write.before.revision !== write.mutations.length))
          attempt.errors.push('source-write-range-mismatch');
        for (const table of ['arrivals', 'segments', 'stop_visits', 'legs'] as const)
          if (write.before && write.after && write.after[table] - write.before[table]
            !== write.mutations.filter(m => m.table === table).length) attempt.errors.push('source-write-table-range-mismatch');
        expected = write.after;
      }
      if (expected && inputAfter && !same(expected, inputAfter)) attempt.errors.push('intervening-source-writes');
      this.errors += attempt.errors.length;
      if (at !== attempt.at) throw new Error('Collector capture clock changed');
      const stateAfterJSON = witnessJSON(state);
      const frame = this.journal.append(at, {
        v: 1, at, origin: 'live-collector', pollResult: failure === undefined ? 'completed' : 'failed',
        error: failure ?? null, observations: attempt.observations,
        observationVersionBefore: attempt.versionBefore, observationVersionAfter: version,
        stateBeforeJSON: attempt.stateBeforeJSON, stateBeforeSHA256: witnessSHA(attempt.stateBeforeJSON),
        stateAfterJSON, stateAfterSHA256: witnessSHA(stateAfterJSON),
        inputBefore: attempt.inputBefore, inputAfter,
        sourceWrites: attempt.writes, sourceWriteEvidence: attempt.errors.length ? 'unavailable' : 'recorded',
        captureErrors: attempt.errors,
        scope: 'Exact current poll input/topology and detector/visit state. Recovery inputs before this journal are unknown; this is not a row-quality verdict.',
      }, attempt.topology);
      this.latest = { epoch: this.journal.epoch, seq: frame.seq, at, sha256: frame.sha256,
        chain: frame.chain, topologySha256: frame.topologySha256, status: frame.status };
    } catch (error) { this.unavailable(at, error); }
  }

  reference(): CollectorWitnessReference | null { return this.latest ? { ...this.latest } : null; }
  stats() { return { ...this.journal.stats(), captureErrors: this.errors }; }
  missed(at: number, error: unknown): void { this.unavailable(at, error); }

  private unavailable(at: number, error: unknown): void {
    this.errors++;
    try { this.journal.fail(at, error instanceof Error ? error.message : String(error)); }
    catch { /* Capturing diagnostics can never throw into the poll loop. */ }
    this.latest = this.journal.reference();
  }

  private fence(): InputFence {
    if (!completeRevisionSchema(this.sqlite)) throw new Error('Incomplete input revision schema');
    const row = this.sqlite.prepare('SELECT epoch,revision,arrivals,segments,stop_visits,legs FROM calibration_input_revision WHERE id=1').get() as InputFence | undefined;
    if (!row || !/^[a-f0-9]{32}$/.test(row.epoch)
      || ![row.revision, row.arrivals, row.segments, row.stop_visits, row.legs].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error('Invalid source input revision');
    if (row.revision !== row.arrivals + row.segments + row.stop_visits + row.legs)
      throw new Error('Inconsistent source input revision');
    return row;
  }

  private tryFence(errors: string[], reason: string): InputFence | null {
    try { return this.fence(); } catch { errors.push(reason); return null; }
  }
}
