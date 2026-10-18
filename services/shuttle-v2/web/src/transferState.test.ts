import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTransferHandoff, loadTransferSelection, makeOnwardTransfer, parseOnwardTransfer,
  parseTransferPath, parseTransferRidePath, saveTransferHandoff, saveTransferSelection, TRANSFER_MAX_AGE_MS } from './transferState';
import { loadBoardedRide, saveBoardedRide, type BoardedRide } from './boardedRide';
import { RIDE_MAX_AGE_MS } from './rideEnd';
import { ROUTE_LISTS } from './routes';
import type { TransferPath } from './transferPaths';
const now = Date.UTC(2026, 9, 19, 16);
const red = ROUTE_LISTS.find(c => c.label === 'Red')!, orange = ROUTE_LISTS.find(c => c.label === 'Orange Day')!;
const path: TransferPath = { key: 'untrusted',
  first: { routeLabel: red.label, color: red.color, routeId: red.routeIds[0]!, boardStopId: 11, alightStopId: 113, stops: [11, 146, 49, 48, 104, 113], plannedRideSec: 700 },
  second: { routeLabel: orange.label, color: orange.color, routeId: orange.routeIds[0]!, boardStopId: 34, alightStopId: 95, stops: [34, 101, 134, 132, 29, 28, 82, 95], plannedRideSec: 500 },
  walkToSec: 0, transferWalkSec: 35, walkFromSec: 36, directWalkSec: 1300 };
const destination = { lat: 41.32, lon: -72.91, text: 'Final destination' };
const onward = () => makeOnwardTransfer(path, destination, now, '58');
const ride = (): BoardedRide => ({ routeLabel: red.label, color: red.color, busName: '317', boardStopId: 11,
  alightStopId: 113, startedAt: now, toLat: 41.31, toLon: -72.92, toText: 'Second pickup', onward: onward() });
function store() { const m = new Map<string, string>(); return { getItem: (key: string) => m.get(key) ?? null,
  setItem: (key: string, value: string) => { m.set(key, value); }, removeItem: (key: string) => { m.delete(key); } }; }
beforeEach(() => { vi.stubGlobal('localStorage', store()); vi.stubGlobal('sessionStorage', store()); });
afterEach(() => vi.unstubAllGlobals());
describe('transfer persistence and recovery', () => {
  it('rebuilds canonical identity/color and drops extra saved forecast and reminder fields', () => {
    const saved = { ...path, first: { ...path.first, color: 'evil', eta: 123 }, timing: { eta: 5 }, reminder: { armed: true } };
    const parsed = parseTransferPath(saved)!;
    expect(parsed.key).toBe(JSON.stringify(['Red', path.first.stops, 'Orange Day', path.second.stops]));
    expect(parsed.first.color).toBe(red.color); expect(parsed).not.toHaveProperty('timing');
    expect(parsed).not.toHaveProperty('reminder'); expect(parsed.first).not.toHaveProperty('eta');
    expect(saved.first.color).toBe('evil');
  });
  it.each([
    { routeLabel: 'Unknown' }, { routeId: '999999' }, { boardStopId: 0 }, { alightStopId: 11 },
    { stops: [11, 0, 113] }, { stops: [11, 113.5] }, { stops: [11, 12] }, { stops: [113, 11] },
    { plannedRideSec: Infinity }, { plannedRideSec: 1501 }, { stops: Array(101).fill(11) },
  ])('rejects malformed persisted ride paths: %j', change => {
    expect(parseTransferRidePath({ ...path.first, ...change })).toBeNull();
  });
  it('rejects a same-route change or nonfinite walking time', () => {
    expect(parseTransferPath({ ...path, second: path.first })).toBeNull();
    expect(parseTransferPath({ ...path, transferWalkSec: NaN })).toBeNull();
    expect(parseTransferPath({ ...path, walkFromSec: -1 })).toBeNull();
  });
  it('preserves both bus identities and destination without persisting a forecast', () => {
    saveTransferSelection({ query: 'trip', path, firstBusName: '317', secondBusName: '58' });
    expect(loadTransferSelection('trip')).toMatchObject({ firstBusName: '317', secondBusName: '58' });
    expect(loadTransferSelection('other')).toBeNull();
    saveTransferHandoff({ onward: onward(), stoppedAtMs: now, reason: 'bus-gone', ready: false });
    expect(loadTransferHandoff(now)).toEqual({ onward: onward(), stoppedAtMs: now, reason: 'bus-gone', ready: false });
    expect(JSON.stringify(loadTransferHandoff(now))).not.toMatch(/forecast|reminder|etaSec/);
    saveTransferSelection(null); saveTransferHandoff(null);
    expect(loadTransferSelection('trip')).toBeNull(); expect(loadTransferHandoff(now)).toBeNull();
  });
  it.each([
    { plannedAtMs: now + 5001 }, { plannedAtMs: now - TRANSFER_MAX_AGE_MS }, { plannedAtMs: NaN },
    { firstRouteLabel: orange.label }, { destination: { ...destination, lat: 91 } },
    { destination: { ...destination, lon: Infinity } }, { destination: { ...destination, text: ' ' } },
  ])('discards expired or invalid onward metadata: %j', change => {
    expect(parseOnwardTransfer({ ...onward(), ...change }, now)).toBeNull();
  });
  it('restores a first ride with its onward destination, and an ordinary ride without one', () => {
    saveBoardedRide(ride()); expect(loadBoardedRide(now)).toEqual(ride());
    const ordinary = { ...ride(), onward: undefined }; saveBoardedRide(ordinary);
    expect(loadBoardedRide(now)).toEqual(ordinary);
    expect(loadBoardedRide(NaN)).toBeNull();
  });
  it('keeps a valid ride when its onward metadata refers to a different exit or first route', () => {
    for (const change of [{ exitStopId: 34 }, { firstRouteLabel: 'Blue Day' }]) {
      saveBoardedRide({ ...ride(), onward: { ...onward(), ...change } });
      expect(loadBoardedRide(now)).toMatchObject({ routeLabel: 'Red', alightStopId: 113 });
      expect(loadBoardedRide(now)).not.toHaveProperty('onward');
    }
  });
  it('prefers the completed first-ride transition after a crash between writes', () => {
    saveBoardedRide(ride());
    saveTransferHandoff({ onward: onward(), stoppedAtMs: now + 10_000, ready: true });
    expect(loadBoardedRide(now + 10_000)).toBeNull();
    expect(loadTransferHandoff(now + 10_000)?.onward.destination).toEqual(destination);
  });
  it('lets a newly boarded second ride win if an older handoff remains after a crash', () => {
    saveTransferHandoff({ onward: onward(), stoppedAtMs: now + 10_000, ready: true });
    const second = { ...ride(), routeLabel: orange.label, color: orange.color, startedAt: now + 20_000, onward: undefined };
    saveBoardedRide(second); expect(loadBoardedRide(now + 20_000)).toEqual(second);
  });
  it('recovers the onward trip when the first ride expires while the page is closed, without claiming arrival', () => {
    saveBoardedRide(ride());
    expect(loadBoardedRide(now + RIDE_MAX_AGE_MS)).toBeNull();
    expect(loadTransferHandoff(now + RIDE_MAX_AGE_MS)).toEqual({ onward: onward(), stoppedAtMs: now + RIDE_MAX_AGE_MS, reason: 'age', ready: false });
    expect(loadTransferHandoff(now + RIDE_MAX_AGE_MS - 1)).toBeNull();
    expect(loadTransferHandoff(now + TRANSFER_MAX_AGE_MS)).toBeNull();
  });
  it('does not turn malformed expired ride data into a transfer', () => {
    saveBoardedRide({ ...ride(), alightStopId: 123 });
    expect(loadTransferHandoff(now + RIDE_MAX_AGE_MS)).toBeNull();
    localStorage.setItem('shuttle-boarded-ride', '{broken'); expect(loadBoardedRide(now)).toBeNull();
    localStorage.setItem('shuttle-transfer-handoff', '{broken'); expect(loadTransferHandoff(now)).toBeNull();
  });
  it('keeps all tracking operations usable when storage is denied', () => {
    const denied = { getItem() { throw Error('Denied'); }, setItem() { throw Error('Denied'); }, removeItem() { throw Error('Denied'); } };
    vi.stubGlobal('localStorage', denied); vi.stubGlobal('sessionStorage', denied);
    expect(() => { saveBoardedRide(ride()); saveTransferHandoff({ onward: onward(), stoppedAtMs: now }); saveTransferSelection({ query: 'trip', path });
      saveBoardedRide(null); saveTransferHandoff(null); saveTransferSelection(null); }).not.toThrow();
    expect(loadBoardedRide(now)).toBeNull(); expect(loadTransferHandoff(now)).toBeNull(); expect(loadTransferSelection('trip')).toBeNull();
  });
});
