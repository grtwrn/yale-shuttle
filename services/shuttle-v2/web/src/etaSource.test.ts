import { describe, expect, it } from 'vitest';
import { attachServerEta, ETA_MAX_AGE_MS, liveEtaAvailable, serverArrivals, serverTrack, type ServerEtaWire } from './etaSource';
import { computeUpcomingArrivals } from './liveArrivals';
import type { BusData } from './map-data';
import { ROUTE_LISTS } from './routes';

const cfg = ROUTE_LISTS.find(c => c.label === 'Red')!;
const buses = (): BusData[] => [{ bus_id: 123, bus_name: '#12', route_id: cfg.busRouteIds[0]!, lat: 41.3, lon: -72.9, heading: 0, last_stop_id: 48 }];
const wire = (): ServerEtaWire => ({ v: 2, at: 1_000_000, servedAt: 1_010_000,
  buses: [['12', 'Red', 2, { stopId: 48, standingSec: 30, approach: false }]],
  rows: [[0, 48, 120, 90, 180, 2, 0, 60, 70], [0, 48, 1200, 900, 1500, 20, 1, 1100, 800]],
});

describe('authoritative live forecast', () => {
  it('gives fresh sessions the same aged answer and metadata despite phone clock skew', () => {
    const a = buses(), b = buses();
    expect(attachServerEta(a, wire(), 50_000)).toBe(true);
    expect(attachServerEta(b, wire(), 9_050_000)).toBe(true);
    expect(serverArrivals(a, [48], 55_000)).toEqual(serverArrivals(b, [48], 9_055_000));
    expect(serverArrivals(a, [48], 55_000)?.map(r => [r.eta, r.low, r.high, r.departNow, r.lowFloor]))
      .toEqual([[105, 75, 165, 45, 55], [1185, 885, 1485, 1085, 785]]);
    expect(serverTrack(a[0]!, 'Red', 55_000)).toEqual({ index: 2, standing: { stopId: 48, standingSec: 45, approach: false } });
    expect(serverArrivals(a, [99], 55_000)).toEqual([]);
  });

  it('does not run a browser estimator for registered live inputs', () => {
    const live = buses();
    attachServerEta(live, wire(), 50_000);
    // No route geometry or segment priors: these are exactly the served rows.
    expect(computeUpcomingArrivals([48], live, {}, {}, {}, 50_000, {}, new Map()))
      .toEqual(serverArrivals(live, [48], 50_000));
  });

  it('expires arrivals and track metadata together, including already-old responses', () => {
    const live = buses();
    attachServerEta(live, wire(), 50_000);
    expect(liveEtaAvailable(live, 84_999)).toBe(true);
    expect(liveEtaAvailable(live, 85_000)).toBe(false);
    expect(serverArrivals(live, [48], 85_000)).toEqual([]);
    expect(serverTrack(live[0]!, 'Red', 85_000)).toBeNull();
    const old = wire(); old.servedAt = old.at + ETA_MAX_AGE_MS;
    expect(attachServerEta(buses(), old, 50_000)).toBe(false);
  });

  it.each([undefined, null, { ...wire(), v: 1 }, { ...wire(), at: Infinity },
    { ...wire(), rows: [[0, 48, 120, 180, 90, 2, 0, 60, 70]] },
    { ...wire(), rows: [[9, 48, 120, 90, 180, 2, 0, 60, 70]] },
  ])('withholds malformed/missing output without falling back locally (%#)', raw => {
    const live = buses();
    expect(attachServerEta(live, raw, 50_000)).toBe(false);
    expect(computeUpcomingArrivals([48], live, {}, {}, {}, 50_000)).toEqual([]);
    expect(serverTrack(live[0]!, 'Red', 50_000)).toBeNull();
  });

  it('clips conformal lower bounds below zero to now without dropping the forecast', () => {
    const live = buses(), w = wire();
    w.rows = [[0, 48, 120, -90, 180, 2, 0, 60, -100]];
    expect(attachServerEta(live, w, 50_000)).toBe(true);
    expect(serverArrivals(live, [48], 50_000)?.[0]).toMatchObject({ low: 0, lowFloor: 0 });
  });

  it('leaves hypothetical/offline inputs separate from live state', () => {
    const offline = buses();
    expect(serverArrivals(offline, [48], 50_000)).toBeNull();
    expect(serverTrack(offline[0]!, 'Red', 50_000)).toBeUndefined();
  });
});

it('ages row-aligned distributions and isolates malformed chart data from live ETAs', () => {
  const live = buses(), w = wire();
  w.distributions = [Array.from({ length: 50 }, (_, i) => 30 + i * 4), Array.from({ length: 50 }, (_, i) => 1000 + i * 10)];
  attachServerEta(live, JSON.parse(JSON.stringify(w)), 50_000);
  expect(serverArrivals(live, [48], 55_000)?.[0]?.distribution).toEqual(w.distributions[0]!.map(s => s - 15));
  expect(serverArrivals(live, [48], 85_000)).toEqual([]);
  w.distributions[0]![4] = -1;
  expect(attachServerEta(live, w, 50_000)).toBe(true);
  expect(serverArrivals(live, [48], 50_000)?.[0]?.distribution).toBeUndefined();
  expect(serverArrivals(live, [48], 50_000)?.[1]?.distribution).toHaveLength(50);
});
