import { describe, expect, it } from 'vitest';
import { transferPickup } from './transferPickup';
import { attachServerEta, type ServerEtaWire } from './etaSource';
import type { TransferRidePath } from './transferPaths';
import type { BusData } from './map-data';
const now = Date.UTC(2026, 9, 19, 16);
const path: TransferRidePath = { routeLabel: 'Red', color: '#c00', routeId: '3', boardStopId: 11, alightStopId: 113,
  stops: [11, 48, 113], plannedRideSec: 300 };
function live() {
  const buses: BusData[] = [{ bus_id: 1, bus_name: '#317', route_id: 3, lat: 41.32, lon: -72.92, heading: 180, last_stop_id: 1, observed_at: now }];
  const wire: ServerEtaWire = { v: 2, at: now, servedAt: now, buses: [['317', 'Red', 0, null]],
    rows: [[0, 11, 200, 100, 300, 2, 0, 200, 0], [0, 48, 300, 200, 400, 3, 0, 300, 0], [0, 113, 400, 300, 500, 4, 0, 400, 0]] };
  return { buses, wire };
}
describe('current transfer-leg pickup', () => {
  it('uses only fresh served visits and expires on the existing45second boundary', () => {
    const { buses, wire } = live();
    expect(transferPickup(path, buses, 0, now, true).selection).toBeUndefined();
    attachServerEta(buses, wire, now);
    expect(transferPickup(path, buses, 0, now, true).selection?.countdown).toMatchObject({ source: 'forecast', busName: '317', etaSec: 200, lowSec: 100, highSec: 300 });
    expect(transferPickup(path, buses, 0, now + 44_999, true).selection).toBeDefined();
    expect(transferPickup(path, buses, 0, now + 45_000, true).selection).toBeUndefined();
    expect(transferPickup(path, buses, 0, now, false).selection).toBeUndefined();
  });
  it('keeps boarding/reminders when the destination estimate disappears, without inventing an arrival', () => {
    const { buses, wire } = live(); wire.rows = wire.rows.filter(r => r[1] !== 113); attachServerEta(buses, wire, now);
    const pickup = transferPickup(path, buses, 0, now, true);
    expect(pickup.boardingBusName).toBe('317'); expect(pickup.option).toBeDefined(); expect(pickup.destination).toBeUndefined();
  });
  it('retains no current-leg timing after a successful empty publication', () => {
    const { buses, wire } = live(); attachServerEta(buses, wire, now);
    attachServerEta(buses, { ...wire, rows: [] }, now);
    expect(transferPickup(path, buses, 0, now, true).selection).toBeUndefined();
  });
  it('uses a fresh raw at-stop observation when forecasts are missing, and withholds it during a failed poll', () => {
    const { buses, wire } = live(); buses[0]!.at_stop_id = 11;
    expect(transferPickup(path, buses, 0, now, true).selection).toBeUndefined();
    attachServerEta(buses, { ...wire, rows: [] }, now);
    const pickup = transferPickup(path, buses, 0, now, true);
    expect(pickup.selection?.countdown).toEqual({ source: 'raw-at-stop', busName: '317', stopId: 11 });
    expect(pickup.destination).toBeUndefined(); expect(pickup.option?.busEtaSec).toBe(0);
    expect(transferPickup(path, buses, 0, now, false).selection).toBeUndefined();
    expect(transferPickup(path, buses, 0, now + 120_000, true).selection).toBeUndefined();
  });
  it('does not borrow a later same-bus lap as a raw-current pickup or an earlier destination', () => {
    const { buses, wire } = live(); buses[0]!.at_stop_id = 11;
    wire.rows = [[0, 11, 600, 500, 700, 5, 0, 600, 0], [0, 48, 700, 600, 800, 6, 0, 700, 0], [0, 113, 800, 700, 900, 7, 0, 800, 0]];
    attachServerEta(buses, wire, now);
    expect(transferPickup(path, buses, 0, now, true).selection?.countdown.source).toBe('forecast');
    expect(transferPickup(path, buses, 0, now, true).destination?.pointMs).toBe(now + 800_000);
  });
  it('keeps approaching and boardable buses distinct when the rider cannot walk to the early bus', () => {
    const { buses, wire } = live();
    buses.push({ ...buses[0]!, bus_id: 2, bus_name: '318' }); wire.buses.push(['318', 'Red', 0, null]);
    wire.rows = [[0, 11, 10, 5, 20, 1, 0, 10, 0], [0, 48, 110, 80, 150, 2, 0, 110, 0], [0, 113, 210, 180, 250, 3, 0, 210, 0],
      [1, 11, 600, 500, 700, 5, 0, 600, 0], [1, 48, 700, 600, 800, 6, 0, 700, 0], [1, 113, 800, 700, 900, 7, 0, 800, 0]];
    attachServerEta(buses, wire, now);
    const p = transferPickup(path, buses, 100, now, true, '317');
    expect(p.busName).toBe('317'); expect(p.boardingBusName).toBe('318');
    expect(p.selection?.relation).toBe('different-bus'); expect(p.destination?.pointMs).toBe(now + 800_000);
  });
  it('marks an unreachable pickup departed from its walking requirement while retaining the raw source row', () => {
    const { buses, wire } = live(); wire.rows = wire.rows.filter(r => r[1] !== 113); attachServerEta(buses, wire, now);
    const p = transferPickup(path, buses, 1000, now, true, '317');
    expect(p.departed).toBe(true); expect(p.selection).toBeUndefined(); expect(p.option).toBeUndefined();
    expect(p.source.pickups).toHaveLength(1);
  });
});
