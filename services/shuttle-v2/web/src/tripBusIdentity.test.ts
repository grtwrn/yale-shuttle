import { describe, expect, it } from 'vitest';
import { tripBusIdentity } from './tripBusIdentity';

const journeyArrival = { busName: '309', pointMs: 1000, lowMs: 900, highMs: 1200, catchRisk: false, estimated: false };
describe('trip bus attribution', () => {
  it('keeps the visible approaching bus distinct from the bus used for the journey', () => {
    expect(tripBusIdentity({ busName: '#307', journeyArrival })).toEqual({ pickup: '307', ride: '309', different: true });
  });
  it('normalizes the same vehicle without creating a second boarding action', () => {
    expect(tripBusIdentity({ busName: '#309', journeyArrival })).toEqual({ pickup: '309', ride: '309', different: false });
  });
  it.each([{ etaUnavailable: true }, { departed: true }])('does not present an unusable journey as the selected ride: %j', flags => {
    expect(tripBusIdentity({ busName: '307', journeyArrival, ...flags })).toEqual({ pickup: '307', ride: '307', different: false });
  });
  it('keeps missing and future journey identities unknown', () => {
    expect(tripBusIdentity({ busName: '307' })).toEqual({ pickup: '307', ride: '307', different: false });
    expect(tripBusIdentity({ busName: '' })).toEqual({ pickup: '', ride: '', different: false });
  });
});
