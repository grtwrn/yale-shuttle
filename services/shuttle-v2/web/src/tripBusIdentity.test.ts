import { describe, expect, it } from 'vitest';
import { forecastPickupSelection, rawPickupSelection } from './livePickupSelection';
import { tripBusIdentity } from './tripBusIdentity';

const journeyArrival = { busName: '309', pointMs: 1000, lowMs: 900, highMs: 1200, catchRisk: false, estimated: false };
describe('trip bus attribution', () => {
  it('keeps the visible approaching bus distinct from the bus used for the journey', () => {
    expect(tripBusIdentity({ busName: '#307', journeyArrival })).toEqual({ pickup: '307', ride: '309', different: true, laterVisit: false, separateWait: true });
  });
  it('normalizes the same vehicle without creating a second boarding action', () => {
    expect(tripBusIdentity({ busName: '#309', journeyArrival })).toEqual({ pickup: '309', ride: '309', different: false, laterVisit: false, separateWait: false });
  });
  it.each([{ etaUnavailable: true }, { departed: true }])('does not present an unusable journey as the selected ride: %j', flags => {
    expect(tripBusIdentity({ busName: '307', journeyArrival, ...flags })).toEqual({ pickup: '307', ride: '307', different: false, laterVisit: false, separateWait: false });
  });
  it('keeps missing and future journey identities unknown', () => {
    expect(tripBusIdentity({ busName: '307', journeyArrival: { ...journeyArrival, busName: '' } }))
      .toMatchObject({ pickup: '307', ride: '307', different: false });
    expect(tripBusIdentity({ busName: '307' })).toEqual({ pickup: '307', ride: '307', different: false, laterVisit: false, separateWait: false });
    expect(tripBusIdentity({ busName: '' })).toEqual({ pickup: '', ride: '', different: false, laterVisit: false, separateWait: false });
  });
});

const pickup = { busName: '307', stopId: 48, stopsAhead: 1, eta: 20, low: 0, high: 60 };
const selected = (busName: string, stopsAhead: number) => forecastPickupSelection({
  match: pickup, boardable: { ...pickup, busName, stopsAhead, eta: 1200 }, departed: false,
}, 1000);
describe('destination-independent pickup identity', () => {
  it('retains the selected bus without destination timing', () => {
    expect(tripBusIdentity({ busName: '#307', livePickupSelection: selected('309', 1) }))
      .toEqual({ pickup: '307', ride: '309', different: true, laterVisit: false, separateWait: true });
  });
  it('uses the later pickup wait with a single physical vehicle action', () => {
    expect(tripBusIdentity({ busName: '#307', livePickupSelection: selected('#307', 30) }))
      .toEqual({ pickup: '307', ride: '307', different: false, laterVisit: true, separateWait: true });
  });
  it.each([{ departed: true }, { etaUnavailable: true }])('clears unusable metadata: %j', flags => {
    expect(tripBusIdentity({ busName: '307', livePickupSelection: selected('309', 1), ...flags }))
      .toMatchObject({ ride: '307', different: false, laterVisit: false, separateWait: false });
  });
  it('keeps raw-current separate from a later forecast', () => {
    expect(tripBusIdentity({ busName: '307', livePickupSelection: rawPickupSelection('#307', 48, 1000) }))
      .toMatchObject({ ride: '307', different: false, laterVisit: false, separateWait: false });
  });
});
