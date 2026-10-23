import { describe, expect, it } from 'vitest';
import recorded from './__fixtures__/purple-union-on-demand-2026-10-23.json';
import { pickupRequestFor } from './pickupService';
import { applyPickupServicePolicy, planTrip, type TripOption } from './planner';
import { attachServerEta } from './etaSource';
import { liveReminderInput } from './leaveAlert';
import { rawPickupSelection } from './livePickupSelection';
import type { BusData } from './map-data';

const NOON = Date.parse('2026-10-23T16:00:00Z');
const option = (extra: Partial<TripOption> = {}): TripOption => ({ mode: 'shuttle', routeLabel: 'Purple', color: '#800080',
  boardStopId: 122, alightStopId: 22, walkToSec: 0, waitSec: 30, rideSec: 1200, walkFromSec: 0,
  totalSec: 1230, directWalkSec: 6600, busName: '330', busEtaSec: 30, busLowSec: 0, busHighSec: 60,
  ...extra });

describe('published Purple Union Station request service', () => {
  it('changes at noon Eastern, including the daylight saving offset', () => {
    for (const noon of [NOON, Date.parse('2026-11-02T17:00:00Z')]) {
      expect(pickupRequestFor('Purple', 122, new Date(noon - 1))).toBeUndefined();
      expect(pickupRequestFor('Purple', 122, new Date(noon))).toMatchObject({ kind: 'call-dispatch' });
    }
  });
  it('applies to Union Station, preserving other lines and Purple stops', () => {
    expect(pickupRequestFor('Purple', 121, new Date(NOON))).toBeDefined();
    for (const [label, stop] of [['Red', 122], ['Gold', 121], ['Blue Day', 122], ['Purple', 1], ['Purple', 127]] as const)
      expect(pickupRequestFor(label, stop, new Date(NOON))).toBeUndefined();
    expect(pickupRequestFor('Purple', 122, new Date(NaN))).toBeUndefined();
  });
  it('retains stop geometry while removing unrequested pickup and destination forecasts', () => {
    const result = applyPickupServicePolicy(option(), new Date(NOON));
    expect(result).toMatchObject({ boardStopId: 122, alightStopId: 22, etaUnavailable: true,
      pickupRequest: { kind: 'call-dispatch' } });
    expect(result.busEtaSec).toBeUndefined();
    expect(result.busLowSec).toBeUndefined();
    expect(result.journeyArrival).toBeUndefined();
    expect(result.livePickupSelection).toBeUndefined();
  });
  it('accounts for a walk or forecast that places pickup after noon', () => {
    expect(applyPickupServicePolicy(option({ walkToSec: 120 }), new Date(NOON - 60_000)).pickupRequest).toBeDefined();
    expect(applyPickupServicePolicy(option({ busEtaSec: 120 }), new Date(NOON - 60_000)).pickupRequest).toBeDefined();
    expect(applyPickupServicePolicy(option(), new Date(NOON - 60_000)).pickupRequest).toBeUndefined();
  });
  it('clears request metadata when the same pickup is refreshed for morning service', () => {
    const requested = applyPickupServicePolicy(option(), new Date(NOON));
    const refreshed = applyPickupServicePolicy({ ...requested, etaUnavailable: false, busEtaSec: 30 }, new Date(NOON - 3600_000));
    expect(refreshed.pickupRequest).toBeUndefined();
    expect(refreshed.etaUnavailable).toBe(false);
  });
  it('retains the actual incident pickup plus a scheduled alternative', () => {
    const feed = structuredClone(recorded), now = feed.server_eta.servedAt;
    const buses = feed.buses as unknown as BusData[];
    expect(attachServerEta(buses, feed.server_eta, now)).toBe(true);
    const options = planTrip(feed.stop_coords['122'], feed.stop_coords['22'], buses, feed.routes,
      feed.stop_coords, feed.segments, feed.dwells, null, now);
    const purple = options.find(o => o.routeLabel === 'Purple')!;
    expect(purple).toBeDefined();
    expect(purple).toMatchObject({ boardStopId: 122, etaUnavailable: true, pickupPreference: 'closest-stop',
      pickupRequest: { kind: 'call-dispatch' } });
    expect(purple.pickupAlternatives?.some(o => o.boardStopId === 1 && !o.etaUnavailable && !o.pickupRequest)).toBe(true);
  });
  it('rechecks the published rule on reminder ticks after noon without requiring a React refresh', () => {
    const before = NOON - 10_000;
    const buses: BusData[] = [{ bus_id: 330, bus_name: '#330', route_id: 10, lat: 41.297929,
      lon: -72.926912, heading: 0, last_stop_id: 122 }];
    expect(attachServerEta(buses, { v: 2, at: before, servedAt: before, buses: [['330', 'Purple', 0, null]],
      rows: [[0, 122, 0, 0, 0, 0, 0, 0, 0]] }, before)).toBe(true);
    const old = { ...option(), livePickupSelection: rawPickupSelection('330', 122, before) };
    const context = { buses, busUpdateFailed: false, nowMs: before };
    expect(liveReminderInput([old], 'Purple', context)).not.toBeNull();
    expect(liveReminderInput([old], 'Purple', { ...context, nowMs: NOON + 1000 })).toBeNull();
  });
});
