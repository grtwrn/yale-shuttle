import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { attachServerEta } from './etaSource';
import { registerRoutePaths } from './anchor';
import { applyModelParams, resetModelParams } from './eta/params';
import { destinationArrivalView } from './DestinationArrival';
import { MiniMapKey } from './MiniMapKey';
import { compareDeadline } from './arriveBy';
import { MAX_RIDE_SEC, planTrip, topVisibleOptions } from './planner';
import type { BusData } from './map-data';
import type { LatLon } from './geo';
import type { SegmentTimes, DwellTimes } from './arrivals';

// Literal original public payloads, with complete quantiles and original
// clocks. Endpoints are hypothetical stop coordinates, not a rider trace.
const fixture = JSON.parse(gunzipSync(readFileSync(new URL(
  './__fixtures__/closest-pickup-mode-flip-20261024.json.gz', import.meta.url,
))).toString()) as {
  scenarios: { route: string; fromStop: number; toStop: number; regressionSeqs: number[] }[];
  frames: { seq: number; at: number; json: string; sha256: string }[];
};
type Input = {
  buses: BusData[]; routes: Record<string, number[]>; stop_coords: Record<number, LatLon>;
  segments: SegmentTimes; dwells: DwellTimes; route_paths: Parameters<typeof registerRoutePaths>[0];
  server_eta: unknown; model_params: unknown;
};
function captured(seq: number) {
  const frame = fixture.frames.find(f => f.seq === seq)!;
  expect(createHash('sha256').update(frame.json).digest('hex')).toBe(frame.sha256);
  const input = JSON.parse(frame.json) as Input;
  vi.useFakeTimers(); vi.setSystemTime(frame.at);
  registerRoutePaths(input.route_paths); applyModelParams(input.model_params);
  expect(attachServerEta(input.buses, input.server_eta, frame.at)).toBe(true);
  return { input, now: frame.at };
}
afterEach(() => { vi.useRealTimers(); resetModelParams(); registerRoutePaths(null); });

describe('closest pickup survives missing onward forecasts', () => {
  for (const scenario of fixture.scenarios) {
    it.each(scenario.regressionSeqs)(`${scenario.route} pickup ${scenario.fromStop}, original frame %s`, seq => {
      const { input, now } = captured(seq);
      const options = planTrip(input.stop_coords[scenario.fromStop], input.stop_coords[scenario.toStop],
        input.buses, input.routes, input.stop_coords, input.segments, input.dwells, null, now);
      const choice = options.find(o => o.routeLabel === scenario.route)!;
      expect(choice).toBeDefined();
      expect(choice.boardStopId).toBe(scenario.fromStop);
      expect(topVisibleOptions(options)).toContain(choice);
      if (choice.destinationEtaUnavailable) {
        expect(choice.plannedRideSec).toBeGreaterThan(MAX_RIDE_SEC);
        expect(choice.journeyArrival).toBeUndefined();
        expect(destinationArrivalView(choice, now)).toBeNull();
        expect(compareDeadline([choice], now + 7200_000, 5, now, now, false).shuttle?.status).toBe('unknown');
        expect(choice.etaUnavailable).not.toBe(true);
        expect(choice.busEtaSec).toEqual(expect.any(Number));
      }
      for (const alternative of choice.pickupAlternatives ?? []) {
        if (choice.destinationEtaUnavailable) expect(alternative.pickupPreference).toBe('more-walking');
      }
    });
  }

  it('keeps the original forecast pickup after the raw curb flag clears, without inventing a destination', () => {
    const { input, now } = captured(1198);
    const option = planTrip(input.stop_coords[20], input.stop_coords[116], input.buses, input.routes,
      input.stop_coords, input.segments, input.dwells, null, now).find(o => o.routeLabel === 'Blue Weekend')!;
    expect(option).toMatchObject({ boardStopId: 20, destinationEtaUnavailable: true, busName: '46' });
    expect(input.buses.find(b => b.bus_name === '#46')?.at_stop_id).not.toBe(20);
    expect(option.busEtaSec).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<MiniMapKey rows={[{ option, status: 'Live', pickup: {
      routeLabel: option.routeLabel, busName: option.busName, stopId: option.boardStopId,
      etaSec: option.busEtaSec!, lowSec: option.busLowSec!, highSec: option.busHighSec!, computedAtMs: now,
    } }]} destination="Stop & Shop" />);
    expect(html).toContain('pickup-range');
    expect(html).toContain('Destination arrival unavailable');
    expect(html).toContain('Ride time unavailable');
    expect(html).not.toContain('data-testid="destination-arrival"');
  });

  it('retains a curb pickup without borrowing a destination before its next modeled pickup', () => {
    const { input, now } = captured(1172);
    const option = planTrip(input.stop_coords[41], input.stop_coords[2], input.buses, input.routes,
      input.stop_coords, input.segments, input.dwells, null, now).find(o => o.routeLabel === 'Blue Weekend')!;
    expect(option).toMatchObject({ boardStopId: 41, busEtaSec: 0, destinationEtaUnavailable: true });
    expect(option.journeyArrival).toBeUndefined();
    expect(option.pickupAlternatives?.[0]).toMatchObject({ boardStopId: 42, pickupPreference: 'more-walking' });
  });

  it('keeps the future-plan ride bound', () => {
    const { input, now } = captured(1172);
    const options = planTrip(input.stop_coords[41], input.stop_coords[2], input.buses, input.routes,
      input.stop_coords, input.segments, input.dwells, new Date(now + 120_000), now);
    for (const o of options.flatMap(o => [o, ...(o.pickupAlternatives ?? [])])) {
      if (o.mode === 'shuttle') expect(o.plannedRideSec).toBeLessThanOrEqual(MAX_RIDE_SEC);
      expect(o.destinationEtaUnavailable).not.toBe(true);
    }
  });
});
