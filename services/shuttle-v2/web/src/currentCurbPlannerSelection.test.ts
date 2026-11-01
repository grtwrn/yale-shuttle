import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { registerRoutePaths } from './anchor';
import { attachServerEta } from './etaSource';
import { applyModelParams, resetModelParams } from './eta/params';
import { planTrip } from './planner';
import type { BusData } from './map-data';
import type { LatLon } from './geo';
import type { SegmentTimes, DwellTimes } from './arrivals';

type Input = {
  buses: BusData[]; routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  segments: SegmentTimes; dwells: DwellTimes; route_paths: Parameters<typeof registerRoutePaths>[0];
  server_eta: unknown; model_params: unknown;
};

afterEach(() => { vi.useRealTimers(); resetModelParams(); registerRoutePaths(null); });

it('retains Orange Night pickup9/get-off10 when the current curb row is omitted', () => {
  // The existing browser fixture and its endpoints/clocks remain unchanged.
  // A display-only current-pickup join must not introduce new initial-alight
  // timing that displaces this trip in the planner's journey-time shortlist.
  const fixture = JSON.parse(readFileSync(new URL(
    './__fixtures__/orange-night-curb-following-20261024.json', import.meta.url,
  ), 'utf8')) as { frames: { seq: number; at: number; sha256: string; jsonGzipBase64: string }[] };
  const frame = fixture.frames.find(f => f.seq === 318)!;
  const raw = gunzipSync(Buffer.from(frame.jsonGzipBase64, 'base64'));
  const originalSHA = 'a0e23749cd1bd7457111595246c528b55295fa468e209f981a15a07a3519716e';
  expect(frame.sha256).toBe(originalSHA);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(originalSHA);
  const input = JSON.parse(raw.toString()) as Input;
  const now = frame.at + 2050;
  vi.useFakeTimers(); vi.setSystemTime(now);
  registerRoutePaths(input.route_paths); applyModelParams(input.model_params);
  // Match the browser's first receipt at +1250ms, then its +800ms render.
  expect(attachServerEta(input.buses, input.server_eta, frame.at + 1250)).toBe(true);
  const options = planTrip(input.stop_coords[9]!, input.stop_coords[10]!, input.buses,
    input.routes, input.stop_coords, input.segments, input.dwells, null, now);
  expect(options.find(o => o.routeLabel === 'Orange Night')).toMatchObject({
    boardStopId: 9, alightStopId: 10, busName: '46', busEtaSec: 0,
  });
});
