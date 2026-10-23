import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import type { TransitNetwork } from '../network/TransitNetwork.js';
import type { NetworkCalibrationStats } from './networkCalibration.js';
import { validCalibrationSource } from './provenance.js';
import { witnessJSON, witnessSHA } from '../collector/witnessCodec.js';

export interface CalibrationRequest {
  id: number;
  topology: ReturnType<TransitNetwork['observationTopology']>;
  topologySHA256: string;
}
export interface CalibrationResult {
  kind: 'result';
  id: number;
  stats: NetworkCalibrationStats;
  tables: ReturnType<TransitNetwork['calibrationTables']>;
  workerElapsedMs: number;
  topologySHA256: string;
}
interface Pending {
  request: CalibrationRequest;
  resolve(value: CalibrationResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One long-lived read-only worker preserves the six-hour cache generations.
 * At most one calculation and one queued static refresh can be outstanding. */
export class CalibrationWorker {
  private worker: Worker | null = null;
  private ready = false;
  private active: Pending | null = null;
  private queued: Pending | null = null;
  private sequence = 0;
  private closed = false;
  constructor(private readonly database: string, private readonly timeoutMs = 120_000) {
    if (!database || database === ':memory:' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('Background calibration requires a file database and positive deadline');
  }
  get busy() { return this.active !== null || this.queued !== null; }

  run(topology: CalibrationRequest['topology']): Promise<CalibrationResult> {
    if (this.closed) return Promise.reject(new Error('Calibration worker is closed'));
    if (this.active && this.queued) return Promise.reject(new Error('Calibration queue is full'));
    return new Promise((resolveResult, reject) => {
      // Freeze queued input now, rather than after another calculation ends.
      const snapshot = structuredClone(topology);
      const request = { id: ++this.sequence, topology: snapshot, topologySHA256: witnessSHA(witnessJSON(snapshot)) };
      const timer = setTimeout(() => this.fail(new Error('Background calibration exceeded its deadline')), this.timeoutMs);
      const pending: Pending = { request, resolve: resolveResult, reject, timer };
      if (this.active) this.queued = pending;
      else this.active = pending;
      if (!this.worker) {
        try { this.start(); }
        catch (error) { this.fail(error instanceof Error ? error : new Error('Calibration worker could not start')); }
      }
      else if (this.ready && this.active === pending) this.dispatch();
    });
  }
  close(): void {
    this.closed = true;
    this.fail(new Error('Calibration worker is closed'));
  }
  private start() {
    const worker = new Worker(new URL('./calibration-worker.mjs', import.meta.url), {
      execArgv: [], workerData: { database: resolve(this.database) },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker = worker;
    worker.on('message', (message: CalibrationResult | { kind: 'ready' } | { kind: 'failure'; id: number; error: string }) => {
      if (this.worker !== worker) return;
      if (!message || typeof message !== 'object') { this.fail(new Error('Invalid calibration message')); return; }
      if (message.kind === 'ready') {
        if (this.ready) { this.fail(new Error('Calibration worker became ready twice')); return; }
        this.ready = true; this.dispatch(); return;
      }
      const pending = this.active;
      if (!pending || message.id !== pending.request.id) { this.fail(new Error('Unexpected calibration result')); return; }
      clearTimeout(pending.timer);
      if (message.kind === 'result' && validCalibrationSource(message.stats?.calibrationSource)
        && message.topologySHA256 === pending.request.topologySHA256
        && Array.isArray(message.stats.lapFitCells) && message.stats.lapFitCells.every(k => typeof k === 'string')
        && Number.isFinite(message.workerElapsedMs) && message.workerElapsedMs >= 0
        && message.tables?.segments instanceof Map && message.tables.dwells instanceof Map && message.tables.pace instanceof Map) {
        pending.resolve(message);
      } else pending.reject(new Error(message.kind === 'failure' ? message.error : 'Invalid calibration result'));
      this.active = this.queued; this.queued = null;
      if (this.active) this.dispatch();
    });
    worker.once('error', error => { if (this.worker === worker) this.fail(error); });
    worker.once('exit', code => { if (this.worker === worker) this.fail(new Error('Calibration worker exited (' + code + ')')); });
    worker.unref();
  }
  private dispatch() {
    if (!this.active || !this.ready || !this.worker) return;
    try { this.worker.postMessage(this.active.request); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Calibration request could not be sent')); }
  }
  private fail(error: Error) {
    const worker = this.worker; this.worker = null; this.ready = false;
    for (const pending of [this.active, this.queued]) if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.active = null; this.queued = null;
    if (worker) void worker.terminate();
  }
}
