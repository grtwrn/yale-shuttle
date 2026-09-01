// Leave-time reminders — the pure timing/message logic plus a thin
// notification-delivery layer. In-page only: the armed reminder lives in
// component state and dies with the page (a page that is gone cannot fire a
// timer, so persisting the arm would be a lie to the rider).
//
// Timing model: "time to leave" is the moment the bus's live ETA at the
// board stop drops to the rider's walk time plus a small safety buffer.
// Two pings per armed reminder, each at most once:
//
//   heads_up  (T−5) — five minutes before it's time to leave
//   leave_now (T−0) — time to leave right now
//
// All state is caller-owned (which pings already fired); computeLeaveAlert is
// pure so every rule here is unit-testable without React or timers.

import { fmtMin, fmtWalk, remainingSec } from "./format";

/** Safety margin added to the walk time — leave a little before you must. */
export const LEAVE_BUFFER_SEC = 30;
/** How far ahead of leave-time the heads-up ping fires. */
export const HEADS_UP_LEAD_SEC = 5 * 60;
/**
 * Below this walk time the rider is effectively AT the stop — they can see
 * the bus, so a ping is noise. Never fire anything.
 */
export const AT_STOP_WALK_SEC = 60;

export type LeaveAlertInput = {
  /** Bus's ETA at the board stop, seconds remaining as of `computedAtMs`. */
  busEtaSec: number;
  /** When busEtaSec was computed (ms epoch); undefined = treat as fresh. */
  computedAtMs?: number;
  /** Rider's walk to the board stop, seconds. */
  walkToSec: number;
  /** Current time (ms epoch). */
  nowMs: number;
};

export type FiredPings = { headsUp: boolean; leaveNow: boolean };
export type LeavePing = "heads_up" | "leave_now";

export const NO_PINGS_FIRED: FiredPings = { headsUp: false, leaveNow: false };

/**
 * Seconds until it's time to leave: the live ETA (counted down from when it
 * was computed) minus walk time minus the safety buffer. ≤ 0 means leave now
 * (or you're already late).
 */
export function secUntilLeave(s: LeaveAlertInput): number {
  return remainingSec(s.busEtaSec, s.computedAtMs, s.nowMs) - s.walkToSec - LEAVE_BUFFER_SEC;
}

/**
 * Which ping (if any) to fire right now. Rules:
 * - walk < 60 s → never anything (rider is at the stop, can see the bus).
 * - Inside T−0 (secUntilLeave ≤ 0): fire leave_now once. If the rider armed
 *   this late, heads_up is skipped entirely — never both back-to-back.
 * - Inside T−5 (0 < secUntilLeave ≤ 5 min): fire heads_up once, unless
 *   leave_now already fired (ETA bounced back up — no going backwards).
 * - Fired pings stay fired (caller records them via markFired); an ETA that
 *   jumps up and re-enters a window never repeats a ping.
 */
export function computeLeaveAlert(s: LeaveAlertInput, fired: FiredPings): LeavePing | null {
  if (s.walkToSec < AT_STOP_WALK_SEC) return null;
  const until = secUntilLeave(s);
  if (until <= 0) return fired.leaveNow ? null : "leave_now";
  if (until <= HEADS_UP_LEAD_SEC) {
    return fired.headsUp || fired.leaveNow ? null : "heads_up";
  }
  return null;
}

/**
 * Record a fired ping. leave_now also marks heads_up as fired: once it's
 * time to leave, a later ETA bounce must never produce a belated heads-up.
 */
export function markFired(fired: FiredPings, ping: LeavePing): FiredPings {
  return ping === "leave_now"
    ? { headsUp: true, leaveNow: true }
    : { ...fired, headsUp: true };
}

/**
 * The exact rider-facing strings ("min" spelling per project convention):
 *   heads_up:  "Blue Day in 8 min — leave in 5 min"
 *   leave_now: "Time to leave — Blue Day in 3 min, 3 min walk"
 */
export function leaveAlertMessage(ping: LeavePing, routeLabel: string, s: LeaveAlertInput): string {
  const remaining = remainingSec(s.busEtaSec, s.computedAtMs, s.nowMs);
  if (ping === "heads_up") {
    const until = Math.max(0, secUntilLeave(s));
    return `${routeLabel} in ${fmtMin(remaining)} — leave in ${fmtMin(until)}`;
  }
  return `Time to leave — ${routeLabel} in ${fmtMin(remaining)}, ${fmtWalk(s.walkToSec)} walk`;
}

/**
 * The live option an armed reminder should follow, or null → quietly disarm.
 * Null when the option is gone from the plan, flagged departed, or carries no
 * live bus ETA (walk options, future-mode plans, route stopped running).
 */
export function findReminderOption<
  T extends { mode: string; routeLabel: string; departed?: boolean; busEtaSec?: number },
>(options: readonly T[] | null | undefined, routeLabel: string): (T & { busEtaSec: number }) | null {
  const o = options?.find((x) => x.mode === "shuttle" && x.routeLabel === routeLabel);
  if (!o || o.departed || o.busEtaSec == null) return null;
  return o as T & { busEtaSec: number };
}

// ── Delivery (side-effectful, all non-throwing) ────────────────────────────
//
// Preferred channel: a system notification. On Android the PWA's service
// worker registration can show one even with the tab backgrounded; iOS
// Safari exposes no Notification constructor in the page context at all, so
// there (and wherever permission is denied) the caller falls back to the
// in-app banner + vibration. Nothing here may ever throw into the app.

export function notificationsAvailable(): boolean {
  try {
    return typeof window !== "undefined" && typeof Notification !== "undefined" && "Notification" in window;
  } catch {
    return false;
  }
}

/**
 * Ask for notification permission. Call ONLY from a user gesture (the arm
 * tap) — never on load. Resolves true iff notifications may be shown.
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (!notificationsAvailable()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Show `message` as a system notification. Prefers the service worker
 * registration's showNotification (survives backgrounding on Android),
 * falling back to `new Notification`. Resolves true iff a system
 * notification was shown; false → caller should show the in-app banner.
 */
export async function deliverPing(message: string): Promise<boolean> {
  try {
    if (!notificationsAvailable() || Notification.permission !== "granted") return false;
    const opts = { body: message, tag: "leave-reminder" };
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification("Yale Shuttle", opts);
        return true;
      }
    } catch { /* fall through to page-context Notification */ }
    try {
      new Notification("Yale Shuttle", opts);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** Attention buzz for the in-app fallback. No-op where unsupported (iOS). */
export function vibrateAlert(): void {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported */ }
}
