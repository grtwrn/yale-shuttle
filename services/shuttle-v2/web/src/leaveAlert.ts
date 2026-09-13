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
//
// WHICH WALK. The ping is timed, gated and worded on the walk the CARD shows
// (`displayWalkToSec`, optionLegs.ts): the live recompute's where it set one,
// the plan's own otherwise. Report #108's fix moved the card onto the live walk
// and left this module reading the planned one — so on the operator's own card
// (planned 17 min, priced 46) "time to leave" was timed 29 minutes of ETA late
// and printed "17 min walk" beside a card reading 46 min. It fails in the
// direction that strands a rider, and it is the "two answers, one screen"
// failure this codebase exists to end. ONE resolution, shared with the card:
// a second copy of `liveWalkToSec ?? walkToSec` is precisely how the two
// surfaces drifted apart in the first place.

import { fmtMin, fmtWalk, remainingSec } from "./format";
import { displayWalkToSec } from "./optionLegs";
import type { WalkShown } from "./optionLegs";
import { STOP_DWELL_SEC } from "./planner";

/** Safety margin added to the walk time — leave a little before you must. */
export const LEAVE_BUFFER_SEC = 30;
/** How far ahead of leave-time the heads-up ping fires. */
export const HEADS_UP_LEAD_SEC = 5 * 60;
/**
 * Below this walk time the rider is effectively AT the stop — they can see
 * the bus, so a ping is noise. Never fire anything.
 *
 * Judged on the DISPLAYED walk, which is what makes it true of where the rider
 * IS rather than where they searched from: a rider now inside `AT_PLACE_M` has
 * a live walk of 0 and no walk chip on the card, and is silent here even though
 * the plan still holds the five-minute walk it was built with. The converse is
 * the same rule — a rider who searched AT the stop (`walkToSec` 0, held
 * constant by planner.ts so card order cannot flicker) and has since walked off
 * gets the reminder they now need.
 */
export const AT_STOP_WALK_SEC = 60;

/**
 * `WalkShown` is the card's own pair — the plan's `walkToSec` and the live
 * recompute's `liveWalkToSec` — and every rule below reads it through
 * `displayWalkToSec`, so a caller cannot hand the ping one walk and the card
 * another.
 */
export type LeaveAlertInput = WalkShown & {
  /** Bus's ETA at the board stop, seconds remaining as of `computedAtMs`. */
  busEtaSec: number;
  /** When busEtaSec was computed (ms epoch); undefined = treat as fresh. */
  computedAtMs?: number;
  /** Current time (ms epoch). */
  nowMs: number;
};

export type FiredPings = { headsUp: boolean; leaveNow: boolean };
export type LeavePing = "heads_up" | "leave_now";

export const NO_PINGS_FIRED: FiredPings = { headsUp: false, leaveNow: false };

/**
 * Seconds until it's time to leave: the live ETA (counted down from when it
 * was computed) minus the DISPLAYED walk minus the safety buffer. ≤ 0 means
 * leave now (or you're already late).
 */
export function secUntilLeave(s: LeaveAlertInput): number {
  return remainingSec(s.busEtaSec, s.computedAtMs, s.nowMs) - displayWalkToSec(s) - LEAVE_BUFFER_SEC;
}

/**
 * CAN THE RIDER STILL MAKE THIS BUS? The planner's own reachability test —
 * `canCatch` inside `pickLiveArrival` — imported rather than restated, because
 * a second copy of the walk-versus-ETA rule is exactly how the card and the
 * ping drifted apart in the first place. The walk may exceed the bus's
 * remaining ETA by at most `STOP_DWELL_SEC`, since a bus waits that long at
 * the kerb.
 *
 * WHY THE TERMINAL PING NEEDS IT. `leave_now` is the LAST ping: the caller
 * disarms the reminder on it (`if (ping === "leave_now") setReminder(null)`),
 * so a single bad tick does not merely mis-time a notification — it spends a
 * reminder the rider cannot get back, and the app goes silent for the rest of
 * the trip. While the ping was keyed to the PLANNED walk that tick could not
 * exist, because `planTrip` holds that number constant. Keyed to the LIVE walk
 * it can, and two measured ways:
 *
 *  - ONE WILD GPS FIX. Nothing filters a fix on the way in: `geoWatch.ts`
 *    hands every position to `onFix`, `coords.accuracy` is read nowhere in
 *    `web/src`, and the rescue one-shot accepts a network-accuracy fix up to
 *    two minutes old. With `heads_up` already fired at a live walk of 300 s and
 *    the bus 700 s out (`secUntilLeave` +370, silent), one poll reading a walk
 *    of 1090 s flips it to −420 and fires.
 *  - A BUS THE RIDER CANNOT REACH. The reminder counts down `match` — the bus
 *    the row FOLLOWS — which the "two questions, two buses" rule deliberately
 *    keeps on a vehicle that may be out of reach while the card's total is
 *    priced on `boardable`. Executed, not read off the contract: a pinned bus
 *    2400 s out whose only other entry is its own next lap at 4200 s returns
 *    `match` 2400 / `boardable` 4200, `departed` false. At a live walk of
 *    2760 s that is `secUntilLeave` −390 — so `leave_now` fires on the ARMING
 *    tick and disarms at once, for a bus 6 min past catching.
 *
 * ONE RULE COVERS BOTH, because it tests the ping's own PROMISE rather than
 * guessing at its cause: "time to leave" claims the rider will make it, and
 * both failures are cases where that sentence is false. So the gate cannot
 * silence an honest ping — the set it suppresses is exactly
 * `walk > remaining + STOP_DWELL_SEC`, and an honest `leave_now` fires when the
 * bus is `walk + LEAVE_BUFFER_SEC` away, comfortably inside it. An honest
 * LURCH still pings instantly, which is the direction that matters: a real
 * departure or re-anchor collapses the BUS's ETA and leaves the walk alone, so
 * the promise stays true and the ping is not delayed by a single tick.
 *
 * WHAT IT DOES NOT CATCH, stated rather than hidden. A blunder landing the
 * walk inside `[remaining − LEAVE_BUFFER_SEC, remaining + STOP_DWELL_SEC]` —
 * a 90 s band, 99 m of crow-flies distance at every ETA — still fires, and
 * fires a self-consistent ping ("in 11 min, 12 min walk"). Its cost is a rider
 * who leaves early and waits at the stop, not one who is stranded, which is
 * the asymmetry `rideEnd.ts` already argues for. Bounding the walk's GROWTH
 * per tick would close that band, and it is deliberately NOT built: the fix
 * noise this app is built around (`AT_PLACE_M`, "30–100 m off") is 73–91 s of
 * walk, so the bound needs that much slack against the 6 s the walk model
 * physically allows over a 5 s poll — 12–15× the physics — and nothing in this
 * repo measures fix error, so that constant could not be validated. A guard
 * that delays `leave_now` strands the rider; this one provably cannot.
 */
export function canStillCatch(s: LeaveAlertInput): boolean {
  return displayWalkToSec(s) <= remainingSec(s.busEtaSec, s.computedAtMs, s.nowMs) + STOP_DWELL_SEC;
}

/**
 * Which ping (if any) to fire right now. Rules:
 * - displayed walk < 60 s → never anything (rider is at the stop, can see
 *   the bus).
 * - Inside T−0 (secUntilLeave ≤ 0): fire leave_now once. If the rider armed
 *   this late, heads_up is skipped entirely — never both back-to-back.
 * - Inside T−5 (0 < secUntilLeave ≤ 5 min): fire heads_up once, unless
 *   leave_now already fired (ETA bounced back up — no going backwards).
 * - Fired pings stay fired (caller records them via markFired); an ETA that
 *   jumps up and re-enters a window never repeats a ping.
 */
export function computeLeaveAlert(s: LeaveAlertInput, fired: FiredPings): LeavePing | null {
  if (displayWalkToSec(s) < AT_STOP_WALK_SEC) return null;
  const until = secUntilLeave(s);
  if (until <= 0) {
    if (fired.leaveNow) return null;
    // The terminal, self-disarming ping — never fire it for a bus the rider
    // can no longer make. See `canStillCatch`.
    return canStillCatch(s) ? "leave_now" : null;
  }
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

/** Prefix added to a ping when rain is likely — grab a jacket on the way out. */
export const RAIN_PREFIX = "🌧 Rain likely — ";

/**
 * The exact rider-facing strings ("min" spelling per project convention):
 *   heads_up:  "Blue Day in 8 min — leave in 5 min"
 *   leave_now: "Time to leave — Blue Day in 3 min, 3 min walk"
 *
 * `rainLikely` prefixes "🌧 Rain likely — ". The ping is the last thing a
 * rider reads before walking out the door, so it is the one moment where the
 * forecast can still change what they take with them.
 */
export function leaveAlertMessage(
  ping: LeavePing,
  routeLabel: string,
  s: LeaveAlertInput,
  rainLikely = false,
): string {
  const remaining = remainingSec(s.busEtaSec, s.computedAtMs, s.nowMs);
  const prefix = rainLikely ? RAIN_PREFIX : "";
  if (ping === "heads_up") {
    const until = Math.max(0, secUntilLeave(s));
    return `${prefix}${routeLabel} in ${fmtMin(remaining)} — leave in ${fmtMin(until)}`;
  }
  return `${prefix}Time to leave — ${routeLabel} in ${fmtMin(remaining)}, ${fmtWalk(displayWalkToSec(s))} walk`;
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
 * Where notification permission stands, without asking — for wording a control
 * before the tap that asks. Never throws; "unsupported" covers iOS Safari's
 * page context, which has no Notification constructor at all.
 */
export function notifyPermissionState(): NotificationPermission | "unsupported" {
  try {
    return notificationsAvailable() ? Notification.permission : "unsupported";
  } catch {
    return "unsupported";
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
 *
 * `tag` REPLACES any earlier notification carrying the same tag. That is what
 * the leave reminder wants — one arm, at most two pings, the later superseding
 * the earlier — and it is what a stop alert must NOT share with it: two armed
 * stop alerts and a leave reminder under one tag means the rider sees whichever
 * fired last and nothing else. So a caller with its own identity passes its own
 * tag (stopAlerts.ts `stopAlertTag`), and the default keeps the reminder
 * byte-identical to what it was.
 *
 * TAPPING IT FOCUSES THE APP. The page-context notification does that itself
 * here; the service-worker one is handled by `notificationclick` in sw.js,
 * which is the only place that can do it once the tab is backgrounded. A ping
 * that opens nothing is a dead end on a phone — the rider has to go and find
 * the app by hand, which is the moment the bus goes past.
 */
export async function deliverPing(message: string, tag = "leave-reminder"): Promise<boolean> {
  try {
    if (!notificationsAvailable() || Notification.permission !== "granted") return false;
    const opts = { body: message, tag };
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification("Yale Shuttle Tracker", opts);
        return true;
      }
    } catch { /* fall through to page-context Notification */ }
    try {
      const n = new Notification("Yale Shuttle Tracker", opts);
      try {
        n.onclick = () => {
          try { window.focus(); n.close(); } catch { /* nothing to focus */ }
        };
      } catch { /* onclick unsettable — the notification still showed */ }
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
