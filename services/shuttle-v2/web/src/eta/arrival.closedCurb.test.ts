import {afterEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {computeUpcomingArrivals} from '../arrivals';
import {registerRoutePaths} from '../anchor';
import {applyModelParams, resetModelParams} from './params';
import type {ModelEntry} from './index';
import captured from '../__fixtures__/blue-west-road-pause-20261025.json';

afterEach(() => { resetModelParams(); registerRoutePaths(undefined); });

function entryFromJSON(value: unknown): ModelEntry {
  return JSON.parse(JSON.stringify(value), (_key, item) => {
    if (item?.$type === 'Map') return new Map(item.entries);
    if (item?.$type === 'Float64Array') return Float64Array.from(item.values);
    if (item?.$type === 'Int32Array') return Int32Array.from(item.values);
    if (item?.$type === 'Uint8Array') return Uint8Array.from(item.values);
    return item;
  });
}

describe('ordinary curb rest attribution after departure', () => {
  for (const sample of captured.cases) {
    it(`keeps Blue West's stop ${sample.stopId} on its return after the recorded road pause`, () => {
      expect(createHash('sha256').update(sample.frame.json).digest('hex')).toBe(sample.frame.sha256);
      const body = JSON.parse(sample.frame.json);
      const bus = body.buses.find((b: {bus_name: string}) => b.bus_name === '#330');
      expect(bus).toBeDefined();
      expect(bus.at_stop_id).toBeUndefined();
      expect(bus.stationary).toBe(false);
      expect(applyModelParams(body.model_params)).toBe(true);
      registerRoutePaths(body.route_paths);
      const store = new Map([[sample.key, entryFromJSON(sample.entry)]]);
      const rows = computeUpcomingArrivals([sample.stopId, sample.nextStopId], [bus], body.routes,
        body.stop_coords, body.segments, sample.frame.at, body.dwells, store, true);
      const own = rows.filter(row => row.routeLabel === 'Blue West' && row.busName === '330');
      const current = own.filter(row => row.stopId === sample.stopId).sort((a,b) => a.stopsAhead-b.stopsAhead);
      const next = own.filter(row => row.stopId === sample.nextStopId).sort((a,b) => a.stopsAhead-b.stopsAhead)[0]!;
      // The repeated coordinate is already beyond this curb. An ordinary
      // road pause inside the old rest radius must not become arrival zero.
      expect(current).toHaveLength(2);
      expect(current[0]!.stopsAhead).toBe(body.routes['16'].length);
      expect(current[0]!.eta).toBeGreaterThan(0);
      expect(current[1]!.stopsAhead).toBeGreaterThan(current[0]!.stopsAhead);
      // Both returns are new traversals. A ceiling saved for the old curb
      // visit must not compress the following circuit into the first one.
      const uncappedEntry = entryFromJSON(sample.entry);
      delete uncappedEntry.floors;
      const uncapped = computeUpcomingArrivals([sample.stopId, sample.nextStopId], [bus], body.routes,
        body.stop_coords, body.segments, sample.frame.at, body.dwells,
        new Map([[sample.key, uncappedEntry]]), true)
        .filter(row => row.routeLabel === 'Blue West' && row.busName === '330' && row.stopId === sample.stopId)
        .sort((a,b) => a.stopsAhead-b.stopsAhead);
      expect(current).toEqual(uncapped);
      // Retain the approaching next curb and both complete distributions.
      expect(next.stopsAhead).toBe(1);
      expect(next.eta).toBeGreaterThan(0);
      for (const row of own) {
        expect(row.distribution).toHaveLength(50);
        expect(row.distribution).toEqual([...row.distribution!].sort((a,b) => a-b));
        expect(row.low).toBeLessThanOrEqual(row.eta);
        expect(row.high).toBeGreaterThanOrEqual(row.eta);
      }
    });
  }
});
