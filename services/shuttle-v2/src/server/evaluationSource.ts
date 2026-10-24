import { createHash } from 'node:crypto';
import { EvaluationInputError, EvaluationInputs } from './evaluationInputs.js';
import type { ServerEta } from './serverEta.js';
import type { ProductionExecutionIdentity } from './executionIdentity.js';

/** Admin-only causal history/input access. Public arrival computation and its
 * cache remain authoritative; these methods do not change model parameters. */
export class EvaluationSource {
  constructor(private readonly engine: ServerEta | null, private readonly getPublicJson: () => string,
    readonly inputs: EvaluationInputs, private readonly build: () => string, private readonly clock = Date.now,
    private readonly execution?: () => ProductionExecutionIdentity) {}

  private current() {
    if (!this.engine || this.inputs.stats().failed) throw new EvaluationInputError('unavailable', 'Evaluation source unavailable');
    const feedJson = this.getPublicJson();
    const feed = JSON.parse(feedJson);
    const head = this.inputs.head();
    if (this.inputs.stats().failed || head.at === null || this.engine.evaluationClock() !== head.at)
      throw new EvaluationInputError('unavailable', 'Evaluation source is not ready');
    return { feed, feedJson, head, engine: this.engine };
  }

  head() {
    const { feed, head } = this.current();
    return { v: 1 as const, build: this.build(), ...head, responseAt: this.clock(), feed,
      ...(this.execution?{execution:this.execution()}: {}) };
  }

  seed() {
    const { feed, head, engine } = this.current(), snapshot = engine.captureEvaluation('history');
    const idle = Array.isArray(feed.buses) && feed.buses.length === 0 && !feed.server_eta;
    if (!snapshot || snapshot.at !== head.at || snapshot.at > this.clock() + 5000 || (!idle && this.clock() - snapshot.at > 120000)
      || (!idle && JSON.stringify(snapshot.modelParams ?? null) !== JSON.stringify(feed.model_params ?? null)))
      throw new EvaluationInputError('unavailable', 'No coherent current model history');
    return { v: 1 as const, build: this.build(), ...head, responseAt: this.clock(), idle,
      ...(this.execution?{execution:this.execution()}: {}),
      modelParams: feed.model_params ?? null, pastModelParams: snapshot.modelParams,
      servedRoutes: engine.servedRoutes(), history: { encoding: 'v8-base64', bytes: snapshot.bytes.byteLength,
        sha256: createHash('sha256').update(snapshot.bytes).digest('hex'), data: Buffer.from(snapshot.bytes).toString('base64') }, feed };
  }

  private readPage(epoch: string, after: number, limit: number) {
    const { feed, feedJson } = this.current();
    const result = this.inputs.read(epoch, after, { limit, now: this.clock() });
    return {
      envelope: { v: 1 as const, build: this.build(), ...result, responseAt: this.clock() },
      feed: result.hasMore ? null : feed,
      feedJson: result.hasMore ? 'null' : feedJson,
    };
  }

  read(epoch: string, after: number, limit = 16) {
    const { envelope, feed } = this.readPage(epoch, after, limit);
    return { ...envelope, feed };
  }

  /** Reuse the already validated public JSON rather than serializing its
   * complete feed again for each source poll. Validation and page clocks
   * are shared with the object reader, including failed and idle sources. */
  readJson(epoch: string, after: number, limit = 16): string {
    const { envelope, feedJson } = this.readPage(epoch, after, limit);
    const header = JSON.stringify(envelope);
    return header.slice(0, -1) + ',"feed":' + feedJson + '}';
  }
}
