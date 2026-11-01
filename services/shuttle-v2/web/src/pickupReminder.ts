import {
  computeLeaveAlert, leaveAlertMessage, reminderArrival, reminderArrivalDescription, RAIN_PREFIX,
  type FiredPings, type LeaveAlertInput, type LeavePing,
} from './leaveAlert';
import { serviceStopCount } from './serviceStopCount';

export type ReminderTiming = { mode: 'leave' } | { mode: 'minutes' | 'stops'; value: number };
export const REMINDER_MINUTES = [1, 3, 5, 10, 15] as const;
export const REMINDER_STOPS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_REMINDER_TIMING: ReminderTiming = { mode: 'minutes', value: 5 };

export function reminderTimingLabel(timing: ReminderTiming): string {
  return timing.mode === 'leave' ? 'When it’s time to leave'
    : timing.mode === 'minutes' ? `${timing.value} min before pickup`
    : `${timing.value} stop${timing.value === 1 ? '' : 's'} before pickup`;
}

/** Custom timing fires once. Leave-time mode keeps the original two pings.
 * All modes consume the selected boarding visit's shared live evidence. */
export function computePickupReminder(
  input: LeaveAlertInput, fired: FiredPings, timing: ReminderTiming,
): LeavePing | null {
  if (timing.mode === 'leave') return computeLeaveAlert(input, fired);
  if (fired.headsUp || fired.leaveNow || !Number.isFinite(input.busEtaSec) || input.busEtaSec < 0
    || !Number.isFinite(input.nowMs) || (input.computedAtMs != null && !Number.isFinite(input.computedAtMs))
    || !Number.isInteger(timing.value) || timing.value <= 0) return null;
  if (timing.mode === 'minutes') return reminderArrival(input).sec <= timing.value * 60 ? 'heads_up' : null;
  const stops = serviceStopCount(input);
  return stops !== null && stops <= timing.value
    ? 'heads_up' : null;
}

export function pickupReminderMessage(
  ping: LeavePing, timing: ReminderTiming, routeLabel: string, input: LeaveAlertInput, rain = false,
): string {
  if (timing.mode === 'leave') return leaveAlertMessage(ping, routeLabel, input, rain);
  const prefix = rain ? RAIN_PREFIX : '';
  const stops = serviceStopCount(input);
  if (timing.mode === 'stops' && !input.atPickup && stops !== null && stops > 0) {
    const bus = input.busName ? `${routeLabel} #${input.busName.replace(/^#/, '')}` : routeLabel;
    return `${prefix}${bus} is ${stops} stop${stops === 1 ? '' : 's'} before your pickup`;
  }
  return `${prefix}${reminderArrivalDescription(routeLabel, input)} — your pickup reminder`;
}
