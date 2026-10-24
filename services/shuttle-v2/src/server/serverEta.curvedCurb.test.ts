import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { ServerEta } from './serverEta';
import recorded from '../../web/src/__fixtures__/green-west-haven-curved-curb-20261024.json';

const hash = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
function decode(part: { body: string; gzipSHA256: string; decodedSHA256: string }) {
  const compressed = Buffer.from(part.body, 'base64');
  expect(hash(compressed)).toBe(part.gzipSHA256);
  const raw = gunzipSync(compressed);
  expect(hash(raw)).toBe(part.decodedSHA256);
  return raw;
}

it('keeps Green308 current as its final GPS chord curves around the West Haven curb', () => {
  const history = decode(recorded.runtime), saved = deserialize(history);
  const frames = JSON.parse(decode(recorded.frames).toString());
  expect(frames.map((f: { seq: number }) => f.seq)).toEqual([888, 889, 890, 891]);
  const engine = new ServerEta({ routes: saved.served, onServedForecasts: () => {} });
  expect(engine.restoreEvaluation(history, 'runtime', recorded.runtime.at, 120000)).toBe(true);
  const originalPoints: number[] = [], points: number[] = [], hops: number[] = [];
  for (const frame of frames) {
    expect(hash(frame.json)).toBe(frame.sha256);
    expect(hash(frame.contextJson)).toBe(frame.contextSha256);
    const payload = JSON.parse(frame.json), original = payload.server_eta;
    expect(engine.useEvaluationContext(JSON.parse(frame.contextJson))).toBe(true);
    delete payload.server_eta;
    const wire = engine.contribute(payload, frame.at, frame.at, true)!;
    expect(engine.stats().failures).toBe(0);
    const rowsFor = (w: typeof wire, name: string) => w.rows.flatMap((row, i) =>
      w.buses[row[0]]![0] === name ? [{ row: row.slice(1), distribution: w.distributions![i] }] : []);
    const current = rowsFor(wire, '308').filter(r => r.row[0] === 127);
    originalPoints.push(Math.min(...rowsFor(original, '308').filter(r => r.row[0] === 127).map(r => r.row[1]!)));
    points.push(Math.min(...current.map(r => r.row[1]!)));
    hops.push(current[0]!.row[4]!);
    // Keep the original outgoing alternatives and uncertainty. The repair
    // follows the incoming visit; it does not manufacture an arrived zero.
    if (frame.seq < 891) {
      expect(points.at(-1)).toBeGreaterThan(0);
      expect(points.at(-1)).toBeLessThan(10);
      expect(current[0]!.distribution!.some(v => v > 3000)).toBe(true);
    }
    for (const { row, distribution } of current) {
      expect(row[2]).toBeLessThanOrEqual(row[1]!);
      expect(row[3]).toBeGreaterThanOrEqual(row[1]!);
      expect(distribution).toHaveLength(50);
      expect(distribution).toEqual([...distribution!].sort((a, b) => a - b));
    }
    for (const bus of original.buses) if (bus[0] !== '308') expect(rowsFor(wire, bus[0])).toEqual(rowsFor(original, bus[0]));
  }
  expect(originalPoints).toEqual([2, 1167, 1157, 0]);
  expect(hops).toEqual([1, 1, 1, 0]);
  expect(points.at(-1)).toBe(0);
});

it('preserves the consecutive-fix approach evidence across an engine checkpoint', () => {
  const history = decode(recorded.runtime), saved = deserialize(history);
  const frames = JSON.parse(decode(recorded.frames).toString());
  const continuous = new ServerEta({ routes: saved.served, onServedForecasts: () => {} });
  expect(continuous.restoreEvaluation(history, 'runtime', recorded.runtime.at, 120000)).toBe(true);
  const step = (engine: ServerEta, frame: { json: string; contextJson: string; at: number }) => {
    const payload = JSON.parse(frame.json); delete payload.server_eta;
    expect(engine.useEvaluationContext(JSON.parse(frame.contextJson))).toBe(true);
    return engine.contribute(payload, frame.at, frame.at, true)!;
  };
  step(continuous, frames[0]);
  const checkpoint = continuous.captureEvaluation('runtime')!;
  const restored = new ServerEta({ routes: saved.served, onServedForecasts: () => {} });
  expect(restored.restoreEvaluation(checkpoint.bytes, 'runtime', frames[0].at, 120000)).toBe(true);
  for (const frame of frames.slice(1)) {
    const actual = step(restored, frame);
    expect(actual).toEqual(step(continuous, frame));
    const index = actual.buses.findIndex(b => b[0] === '308' && b[1] === 'Green');
    const first = actual.rows.find(row => row[0] === index && row[1] === 127)!;
    expect(first[2]).toBeLessThan(10);
    expect(first[5]).toBe(frame.seq < 891 ? 1 : 0);
  }
});
