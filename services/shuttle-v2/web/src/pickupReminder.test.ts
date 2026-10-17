import { describe, expect, it } from 'vitest';
import { computePickupReminder, pickupReminderMessage, reminderTimingLabel } from './pickupReminder';
import { computeLeaveAlert, markFired, NO_PINGS_FIRED, type LeaveAlertInput } from './leaveAlert';

const now = 1791816582411;
const input = (over: Partial<LeaveAlertInput> = {}): LeaveAlertInput => ({
  busEtaSec: 600, busLowSec: 480, busHighSec: 840, busName: '307', stopsAhead: 6,
  walkToSec: 180, computedAtMs: now, nowMs: now, ...over,
});

describe('chosen pickup reminder timing', () => {
  it('uses chosen minutes before pickup rather than minutes before walking', () => {
    const s = input();
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe('heads_up');
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBeNull();
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'minutes', value: 10 })).toBe('heads_up');
  });
  it('counts down on the selected boarding window clock', () => {
    const s = input({ busLowSec: 360, busHighSec: 800 });
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBeNull();
    expect(computePickupReminder({ ...s, nowMs: now + 1000 }, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBe('heads_up');
  });
  it('uses the point countdown when bounds are unavailable', () => {
    const s = input({ busLowSec: undefined, busHighSec: undefined, busEtaSec: 301 });
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBeNull();
    expect(computePickupReminder({ ...s, nowMs: now + 1000 }, NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBe('heads_up');
  });
  it('waits for chosen stops even when the walking reminder would already fire', () => {
    const s = input({ busEtaSec: 60, busLowSec: 30, busHighSec: 90, stopsAhead: 3 });
    expect(computeLeaveAlert(s, NO_PINGS_FIRED)).toBe('leave_now');
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'stops', value: 2 })).toBeNull();
    expect(computePickupReminder({ ...s, stopsAhead: 2 }, NO_PINGS_FIRED, { mode: 'stops', value: 2 })).toBe('heads_up');
  });
  it.each([undefined, NaN, -1, 1.5])('does not guess a missing or invalid stop count (%s)', stopsAhead => {
    expect(computePickupReminder(input({ stopsAhead }), NO_PINGS_FIRED, { mode: 'stops', value: 2 })).toBeNull();
  });
  it.each([NaN, Infinity, -1])('does not notify from an invalid ETA (%s)', busEtaSec => {
    expect(computePickupReminder(input({ busEtaSec }), NO_PINGS_FIRED, { mode: 'stops', value: 5 })).toBeNull();
    expect(computePickupReminder(input({ busEtaSec }), NO_PINGS_FIRED, { mode: 'minutes', value: 5 })).toBeNull();
  });
  it('lets a rider already at the stop request a custom reminder', () => {
    const s = input({ walkToSec: 0, stopsAhead: 2 });
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'stops', value: 2 })).toBe('heads_up');
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'minutes', value: 10 })).toBe('heads_up');
    expect(computePickupReminder(s, NO_PINGS_FIRED, { mode: 'leave' })).toBeNull();
  });
  it('fires once when a poll skips over the threshold or an ETA bounces', () => {
    const timing = { mode: 'stops' as const, value: 3 };
    const s = input({ stopsAhead: 1 });
    const ping = computePickupReminder(s, NO_PINGS_FIRED, timing)!;
    expect(ping).toBe('heads_up');
    const fired = markFired(NO_PINGS_FIRED, ping);
    expect(computePickupReminder(s, fired, timing)).toBeNull();
    expect(computePickupReminder(input({ stopsAhead: 0, atPickup: true }), fired, timing)).toBeNull();
  });
  it('preserves the automatic leave-time mode including its final ping', () => {
    const first = input({ busEtaSec: 480, busLowSec: undefined, busHighSec: undefined });
    const timing = { mode: 'leave' as const };
    expect(computePickupReminder(first, NO_PINGS_FIRED, timing)).toBe('heads_up');
    expect(computePickupReminder({ ...first, busEtaSec: 180 }, markFired(NO_PINGS_FIRED, 'heads_up'), timing)).toBe('leave_now');
  });
  it('names the actual bus, later visit and chosen kind in rider-facing messages', () => {
    expect(pickupReminderMessage('heads_up', { mode: 'stops', value: 3 }, 'Red', input({ stopsAhead: 2 })))
      .toBe('Red #307 is 2 stops before your pickup');
    expect(pickupReminderMessage('heads_up', { mode: 'minutes', value: 5 }, 'Red', input({ laterVisit: true })))
      .toBe('Red #307 could return in 8–14 min — your pickup reminder');
    expect(pickupReminderMessage('heads_up', { mode: 'stops', value: 2 }, 'Red', input({ atPickup: true, stopsAhead: 0 }), true))
      .toBe('🌧 Rain likely — Red #307 is at your stop — your pickup reminder');
    expect(reminderTimingLabel({ mode: 'stops', value: 1 })).toBe('1 stop before pickup');
    expect(reminderTimingLabel({ mode: 'minutes', value: 3 })).toBe('3 min before pickup');
  });
});
