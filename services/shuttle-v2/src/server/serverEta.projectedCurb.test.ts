import { createHash } from 'node:crypto';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { ServerEta } from './serverEta';
import recorded from '../../web/src/__fixtures__/green-west-haven-near-curb-20261024.json';

const hash = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
function decode(part: { body: string; gzipSHA256: string; decodedSHA256: string }) {
  const compressed = Buffer.from(part.body, 'base64');
  expect(hash(compressed)).toBe(part.gzipSHA256);
  const raw = gunzipSync(compressed); expect(hash(raw)).toBe(part.decodedSHA256);
  return raw;
}

it('keeps the West Haven approach current across the projected marker and the first curb rest', () => {
  const history = decode(recorded.runtime), saved = deserialize(history);
  const frames = JSON.parse(decode(recorded.frames).toString());
  expect(frames.map((f: { seq: number }) => f.seq)).toEqual([555, 556, 557, 558]);
  const engine = new ServerEta({ routes: saved.served, onServedForecasts: () => {} });
  expect(engine.restoreEvaluation(history, 'runtime', recorded.runtime.at, 120000)).toBe(true);
  const originalPoints: number[] = [], points: number[] = [];
  for (const frame of frames) {
    expect(hash(frame.json)).toBe(frame.sha256); expect(hash(frame.contextJson)).toBe(frame.contextSha256);
    const payload = JSON.parse(frame.json), original = payload.server_eta;
    expect(engine.useEvaluationContext(JSON.parse(frame.contextJson))).toBe(true);
    delete payload.server_eta;
    const wire = engine.contribute(payload, frame.at, frame.at, true)!;
    expect(engine.stats().failures).toBe(0);
    const rowsFor = (w: typeof wire, name: string) => w.rows.flatMap((row, i) => {
      const bus = w.buses[row[0]]!;
      return bus[0] === name ? [{ row: row.slice(1), distribution: w.distributions![i] }] : [];
    });
    const current = rowsFor(wire, '332').filter(r => r.row[0] === 127);
    originalPoints.push(Math.min(...rowsFor(original, '332').filter(r => r.row[0] === 127).map(r => r.row[1]!)));
    points.push(Math.min(...current.map(r => r.row[1]!)));
    for (const { row, distribution } of current) {
      expect(row[2]).toBeLessThanOrEqual(row[1]!); expect(row[3]).toBeGreaterThanOrEqual(row[1]!);
      expect(distribution).toHaveLength(50); expect(distribution).toEqual([...distribution!].sort((a, b) => a - b));
    }
    // The outgoing alternatives remain represented; the approaching quote
    // does not turn an uncertain posterior into a certain zero arrival.
    if (frame.seq < 558) expect(current[0]!.distribution!.some(v => v > 3600)).toBe(true);
    for (const bus of original.buses) if (bus[0] !== '332') expect(rowsFor(wire, bus[0])).toEqual(rowsFor(original, bus[0]));
  }
  expect(originalPoints).toEqual(recorded.originalPointSeconds);
  expect(points).toEqual([2, 2, 2, 0]);
});
