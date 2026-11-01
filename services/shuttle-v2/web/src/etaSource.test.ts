import { describe, expect, it } from 'vitest';
import { attachServerEta, ETA_MAX_AGE_MS, liveEtaAvailable, serverArrivals, serverTrack, serverTravelAvailable, type ServerEtaWire } from './etaSource';
import { computeUpcomingArrivals } from './liveArrivals';
import type { BusData } from './map-data';
import { ROUTE_LISTS } from './routes';
import { computePickupReminder } from './pickupReminder';
import { NO_PINGS_FIRED } from './leaveAlert';

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
    // No `travel` on this wire: the travel slot is the stop index.
    expect(serverTrack(a[0]!, 'Red', 55_000)).toEqual({ index: 2, travel: 2, standing: { stopId: 48, standingSec: 45, approach: false } });
    expect(serverTravelAvailable(a[0]!, 'Red', 55_000)).toBe(false);
    expect(serverArrivals(a, [99], 55_000)).toEqual([]);
  });

  it('does not run a browser estimator for registered live inputs', () => {
    const live = buses();
    attachServerEta(live, wire(), 50_000);
    // No route geometry or segment priors: these are exactly the served rows.
    expect(computeUpcomingArrivals([48], live, {}, {}, {}, 50_000, {}, new Map()))
      .toEqual(serverArrivals(live, [48], 50_000));
  });

  it('distinguishes a supplied travel occurrence from the legacy index fallback', () => {
    const live = buses(), w = wire();
    w.travel = [1];
    expect(attachServerEta(live, w, 50_000)).toBe(true);
    expect(serverTrack(live[0]!, 'Red', 50_000)).toEqual({ index: 2, travel: 1,
      standing: { stopId: 48, standingSec: 40, approach: false } });
    expect(serverTravelAvailable(live[0]!, 'Red', 50_000)).toBe(true);
    expect(serverTravelAvailable(live[0]!, 'Red', 85_000)).toBe(false);
    expect(serverTravelAvailable(live[0]!, 'Pink', 50_000)).toBe(false);
    expect(serverTravelAvailable(buses()[0]!, 'Red', 50_000)).toBe(false);
    const unknown = buses();
    w.travel = [-1];
    expect(attachServerEta(unknown, w, 50_000)).toBe(true);
    expect(serverTrack(unknown[0]!, 'Red', 50_000)?.travel).toBe(-1);
    expect(serverTravelAvailable(unknown[0]!, 'Red', 50_000)).toBe(false);
  });

  it.each([undefined, null, {}, [], [0, 1], [NaN], [1.5], [-2], new Array<number>(1)].map(travel => ({ travel })))
    ('does not treat absent or malformed travel as supplied occurrence proof (%j)', ({ travel }) => {
      const live = buses();
      expect(attachServerEta(live, { ...wire(), travel }, 50_000)).toBe(true);
      expect(serverTrack(live[0]!, 'Red', 50_000)).toEqual({ index: 2, travel: 2,
        standing: { stopId: 48, standingSec: 40, approach: false } });
      expect(serverTravelAvailable(live[0]!, 'Red', 50_000)).toBe(false);
      expect(serverArrivals(live, [48], 50_000)?.[0]?.eta).toBe(110);
    });

  it('advances across fresh snapshots but permits genuine new-rest and new-stop resets', () => {
    const read = (at: number, standingSec: number, stopId = 48) => {
      const live = buses(), w = wire();
      w.at = at; w.servedAt = at + 2_000;
      w.buses = [['12', 'Red', 2, { stopId, standingSec, approach: false }]];
      const receivedAt = at + 9_000_000; // a phone clock need not match the server
      expect(attachServerEta(live, w, receivedAt)).toBe(true);
      return serverTrack(live[0]!, 'Red', receivedAt + 1_000)!.standing!;
    };
    expect(read(1_000_000, 360).standingSec).toBe(363);
    expect(read(1_005_000, 365).standingSec).toBe(368);
    expect(read(1_010_000, 2).standingSec).toBe(5);
    expect(read(1_015_000, 1, 49)).toEqual({ stopId: 49, standingSec: 4, approach: false });
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

  it('carries service counts for the same raw occurrence without aging or replacing hops', () => {
    const live = buses(), w = wire();
    w.serviceStopsAhead = [1, 12];
    expect(attachServerEta(live, w, 50_000)).toBe(true);
    expect(serverArrivals(live, [48], 55_000)?.map(a => [a.stopsAhead, a.serviceStopsAhead]))
      .toEqual([[2, 1], [20, 12]]);
    const legacy = buses();
    expect(attachServerEta(legacy, wire(), 50_000)).toBe(true);
    expect(serverArrivals(legacy, [48], 50_000)?.[0]?.serviceStopsAhead).toBeUndefined();
  });

  it('keeps ETAs available but waits for a stop reminder when optional counts are malformed', () => {
    const live = buses();
    expect(attachServerEta(live, { ...wire(), serviceStopsAhead: [1] }, 50_000)).toBe(true);
    const a = serverArrivals(live, [48], 50_000)![0]!;
    expect(a).toMatchObject({ eta: 110, stopsAhead: 2, serviceStopsAhead: null });
    const input = { busEtaSec: a.eta, stopsAhead: a.stopsAhead, serviceStopsAhead: a.serviceStopsAhead,
      walkToSec: 0, nowMs: 50_000 };
    expect(computePickupReminder(input, NO_PINGS_FIRED, { mode: 'stops', value: 2 })).toBeNull();
    expect(computePickupReminder(input, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBe('heads_up');
  });

  it.each([null, {}, [], [3, 12], [0, 12], [-1, 12], [1.5, 12], [Infinity, 12]].map(serviceStopsAhead => ({ serviceStopsAhead })))
    ('does not trust invalid service metadata (%j)', ({ serviceStopsAhead }) => {
      const live = buses();
      expect(attachServerEta(live, { ...wire(), serviceStopsAhead }, 50_000)).toBe(true);
      expect(serverArrivals(live, [48], 50_000)?.[0]?.serviceStopsAhead).toBeNull();
    });

  it('isolates one invalid count from other valid row-aligned counts', () => {
    const live = buses();
    attachServerEta(live, { ...wire(), serviceStopsAhead: [1, null] }, 50_000);
    expect(serverArrivals(live, [48], 50_000)?.map(a => a.serviceStopsAhead)).toEqual([1, null]);
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
