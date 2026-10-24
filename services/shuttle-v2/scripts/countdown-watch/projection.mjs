import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDetector } from './detector.mjs';
import { THRESHOLDS } from '../canary-metrics.mjs';

export const sha = value => createHash('sha256').update(value).digest('hex');
const integer = Number.isSafeInteger;
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
export const WATCH_SCOPE = 'Original published forecast offers requiring operator review. '
  + 'No rendered-card, physical boarding, independent arrival accuracy or model-promotion verdict.';

/** Every original physical-call row and quantile survives detection. Namespace
 * and source gaps reset comparisons; changed GPS/stand flags remain evidence. */
export class CountdownProjection {
  constructor(state = {}) {
    if (Object.keys(state).length) assert.equal(state.version, 1, 'Unsupported countdown state');
    this.state = structuredClone(state);
    this.state.version = 1;
    this.state.frames ??= {};
    this.state.episodes ??= {};
    this.state.totalFrames ??= 0;
    this.state.totalEvents ??= 0;
    this.detector = createDetector({ state: state.detector });
    this.parts = new Map();
    this.boundaries = [];
    this.newFrames = 0;
  }

  boundary(reason, source, at) {
    this.boundaries.push({ reason, at, previous: this.state.last ?? null, source,
      interruptedExcursions: this.detector.unfinishedExcursions,
      scope: 'Comparison coverage boundary; missing history remains unknown.' });
    this.detector = createDetector();
    this.state.frames = {};
    this.state.episodes = {};
    if (reason !== 'current-forecast-unavailable') this.state.last = null;
  }

  consume(record, source, receipt = {}) {
    const packet = record?.source;
    assert(/^cycle-\d+$/.test(source?.cycle ?? '') && hash(source.sourceKey), 'Invalid frozen source identity');
    assert(typeof source.build === 'string' && source.build && typeof source.epoch === 'string' && source.epoch);
    assert(packet && packet.build === source.build && packet.epoch === source.epoch
      && Array.isArray(packet.frames), 'Native packet differs from frozen source');
    const namespace = sha(JSON.stringify(source));
    if (namespace !== this.state.namespace) {
      this.boundary(this.state.namespace ? 'source-changed' : 'first-capture', source, record.receivedAt);
      this.state.namespace = namespace;
      this.state.source = structuredClone(source);
      this.state.feedReceipt = null;
    }
    this.detector.notePacket();
    for (const frame of packet.frames) {
      assert(integer(frame.seq) && frame.seq > 0 && integer(frame.at) && frame.at >= 0
        && typeof frame.json === 'string' && hash(frame.sha256) && sha(frame.json) === frame.sha256
        && Buffer.byteLength(frame.json) === frame.bytes
        && typeof frame.contextJson === 'string' && hash(frame.contextSha256)
        && sha(frame.contextJson) === frame.contextSha256
        && Buffer.byteLength(frame.contextJson) === frame.contextBytes, 'Native frame commitment differs');
      const last = this.state.last;
      if (last && frame.seq <= last.seq) {
        assert(frame.seq === last.seq && frame.sha256 === last.sha256
          && frame.contextSha256 === last.contextSha256, 'Conflicting or regressed native cursor');
        continue;
      }
      const payload = JSON.parse(frame.json), context = JSON.parse(frame.contextJson), wire = payload.server_eta;
      assert(context.at === frame.at && Array.isArray(payload.buses), 'Invalid native frame context');
      if (wire != null) {
        assert(wire.v === 2 && wire.at === frame.at && wire.servedAt === frame.at
          && Array.isArray(wire.buses) && Array.isArray(wire.rows)
          && Array.isArray(wire.distributions) && wire.rows.length === wire.distributions.length,
        'Invalid original forecast wire');
        for (const [i, row] of wire.rows.entries()) {
          const q = wire.distributions[i];
          assert(Array.isArray(row) && row.length >= 9 && row.slice(0, 9).every(Number.isFinite)
            && integer(row[0]) && row[0] >= 0 && wire.buses[row[0]]
            && Array.isArray(q) && q.length === 50
            && q.every((value, j) => Number.isFinite(value) && (j === 0 || value >= q[j - 1])),
          'Invalid original forecast row or quantiles');
        }
      }
      if (last && (frame.seq !== last.seq + 1 || frame.at <= last.at
        || frame.at - last.at > THRESHOLDS.maxGapSec * 1000)) {
        this.boundary('cursor-or-clock-gap', source, frame.at);
      }
      this.state.frames[frame.sha256] = { frame: structuredClone(frame), receipt: {
        ...receipt, receivedAt: record.receivedAt, build: packet.build, epoch: packet.epoch } };
      this.detector.observe(frame, payload);
      for (const event of this.detector.events.splice(0)) this.record(event);
      this.state.last = { seq: frame.seq, at: frame.at, sha256: frame.sha256,
        contextSha256: frame.contextSha256 };
      this.state.totalFrames++; this.newFrames++;
      // A completed motif spans at most two minutes. Keep a second full
      // window for restart recovery, including every original frame byte.
      for (const [key, value] of Object.entries(this.state.frames))
        if (frame.at - value.frame.at > THRESHOLDS.maxGapSec * 2000) delete this.state.frames[key];
      for (const [key, value] of Object.entries(this.state.episodes))
        if (frame.at - value.lastEndAt > THRESHOLDS.maxGapSec * 1000) delete this.state.episodes[key];
    }
    if (packet.hasMore === false && Array.isArray(packet.feed?.buses)) {
      assert(integer(record.receivedAt) && integer(packet.responseAt)
        && record.receivedAt - packet.responseAt <= 120000
        && packet.responseAt - record.receivedAt <= 5000, 'Invalid native feed receipt');
      if (record.receivedAt > (this.state.feedReceipt?.receivedAt ?? -Infinity)) {
        const missing = packet.feed.server_eta == null;
        const wasMissing = this.state.feedReceipt?.forecastAvailable === false;
        this.state.feedReceipt = { receivedAt: record.receivedAt, responseAt: packet.responseAt,
          cursor: packet.cursor, emptyFleet: packet.feed.buses.length === 0,
          forecastAvailable: !missing, ...receipt };
        if (missing && !wasMissing && (this.detector.unfinishedExcursions || this.state.last))
          this.boundary('current-forecast-unavailable', source, record.receivedAt);
      }
    }
  }

  record(event) {
    const key = JSON.stringify([event.label, event.busName, event.before.anchor]);
    const prior = this.state.episodes[key];
    const connected = prior && event.before.at <= prior.lastEndAt;
    const episodeId = connected ? prior.id : sha(JSON.stringify([
      this.state.namespace, key, event.before.seq, event.before.at ]));
    this.state.episodes[key] = { id: episodeId,
      lastEndAt: Math.max(connected ? prior.lastEndAt : 0, event.returned.at) };
    const part = this.parts.get(episodeId) ?? { version: 1, kind: 'countdown-offer-review',
      episodeId, source: structuredClone(this.state.source), namespace: this.state.namespace,
      route: event.label, bus: event.busName, heldAnchor: event.before.anchor,
      events: [], frames: {}, scope: WATCH_SCOPE, physicalETAErrorEstablished: false };
    part.events.push(event);
    for (const snapshot of [event.before, event.jump, event.returned]) {
      const original = this.state.frames[snapshot.originalBodySHA256];
      assert(original && original.frame.contextSha256 === snapshot.originalContextSHA256,
        'Original event frame is not retained');
      part.frames[snapshot.originalBodySHA256] = structuredClone(original);
    }
    this.parts.set(episodeId, part);
    this.state.totalEvents++;
  }

  findings() {
    return [...this.parts.values()].map(part => ({
      id: sha(JSON.stringify(part)), body: structuredClone(part),
    }));
  }

  snapshot() {
    return { ...structuredClone(this.state), detector: this.detector.snapshot() };
  }
}
