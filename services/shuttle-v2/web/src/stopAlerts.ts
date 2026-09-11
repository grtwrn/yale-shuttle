// "Tell me when Red gets to 344 Winchester" — the pure logic behind the 🔔 on
// a route card's stop row.
//
// THE ASK (operator, 2026-09-11): "I want to allow the user to request
// notifications for a line getting to a stop. like user may want notification
// when red gets to 344 win."
//
// PHASE 1 IS CLIENT-ONLY, and the limit is honest rather than hidden: the arm
// lives in this browser, the decision runs on the `/api/buses` poll the page
// already makes, and the ping is the same `Notification` plumbing the leave-now
// reminder uses (leaveAlert.ts). So it fires while the app is open — foreground,
// a backgrounded tab, or an installed PWA whose page is alive (the poll keeps
// running at 30 s while hidden). A page the OS has discarded fires nothing, and
// the UI says so. Phase 2 — real web push, which survives a closed app — needs a
// server-side subscription store and is an operator decision, not a refactor of
// this file.
//
// WHY THE ARM PERSISTS AND THE LEAVE REMINDER'S DOES NOT. leaveAlert.ts
// deliberately keeps its arm in component state: it is pinned to one planned
// trip, and a reload has no trip. A stop alert is pinned to a (line, stop) pair
// that exists independently of anything the rider has planned, so it survives a
// reload — which is exactly what a rider who armed it and then switched apps
// expects. Hence localStorage, and hence an expiry (below).
//
// EVERYTHING HERE IS PURE except `loadStopAlerts` / `saveStopAlerts`, which are
// the two guarded storage touches. No estimator lives here: `decide` is handed
// the SAME arrival the row prints, computed once per poll by the one estimator
// (`computeUpcomingArrivals`), and only decides whether that number crosses a
// line the rider drew.

import { fmtMin } from "./format";
import { isRouteScheduledAt } from "./schedule";

/** localStorage key. Guarded on both sides; blocked storage means the arm simply does not survive a reload. */
export const STOP_ALERTS_KEY = "shuttle.stopAlerts";

/** Lead times offered, in minutes. Three choices, because a chooser with five is a menu. */
export const LEAD_CHOICES = [1, 3, 5] as const;
export const DEFAULT_LEAD_MIN = 3;

/**
 * An ETA at or under this is "it is here". `fmtMin` calls anything under 10 s
 * "now", which is too narrow to catch on the 30 s poll a hidden page makes; 30 s
 * is one poll wide, so an approach that crosses it is seen, and a bus 30 s out
 * is at the kerb by the time the rider has read the words.
 */
export const ARRIVAL_ETA_SEC = 30;

/**
 * An arm dies two hours after it was made. A rider who armed an alert and
 * walked away must not be pinged tomorrow morning by a page that was never
 * closed, and the estimator has nothing useful to say about a bus two hours out.
 */
export const STOP_ALERT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * An alert also dies when its line stops running (`ROUTE_HOURS`) — but not
 * within this long of being armed. The published window is a timetable, and
 * `isBusInService` allows buses ±90 min of it: a rider watching a live bus at
 * 23:05 on a line published to 23:00 has armed something real, and a timetable
 * must not delete it out from under them.
 */
export const CLOSE_GRACE_MS = 10 * 60 * 1000;

/** How many arms are kept. A bound on the list, the strip and the stored blob. */
export const MAX_STOP_ALERTS = 8;

export type StopAlertKind = "lead" | "arrival";

/**
 * Which pings have fired, AND FOR WHICH VEHICLE. The dedupe is per bus on
 * purpose: "Red reaches this stop" is a statement about a vehicle, so when the
 * bus the alert was following disappears from the feed the next Red bus is a
 * fresh promise and gets its own ping. Without the name, a vanished bus either
 * silences the alert for ever or re-pings on every poll.
 */
export type StopAlertFired = { busName: string; lead: boolean; arrival: boolean };

export type StopAlert = {
  /** Primary route id (ROUTE_LISTS `routeIds[0]`) — what the colour and the card key off. */
  routeId: string;
  /** ROUTE_LISTS label ("Red"). The estimator answers by label, and so does the ping. */
  routeLabel: string;
  stopId: number;
  /** Upstream's name, captured at arm time so the strip reads without a stop table. */
  stopName: string;
  leadMin: number;
  createdAt: number;
  fired?: StopAlertFired;
};

const NOT_FIRED = (busName: string): StopAlertFired => ({ busName, lead: false, arrival: false });

/** One arm per (line, stop). The identity used everywhere — strip, row, dedupe. */
export function alertKey(routeLabel: string, stopId: number): string {
  return `${routeLabel}|${stopId}`;
}

export function findStopAlert(
  alerts: readonly StopAlert[], routeLabel: string, stopId: number,
): StopAlert | undefined {
  return alerts.find((a) => a.routeLabel === routeLabel && a.stopId === stopId);
}

export function isStopAlertArmed(alerts: readonly StopAlert[], routeLabel: string, stopId: number): boolean {
  return findStopAlert(alerts, routeLabel, stopId) !== undefined;
}

/**
 * Arm one. A DUPLICATE IS IGNORED — the same array comes back, so a double tap
 * (or a re-render racing a tap) cannot stack two arms on one row and ping twice.
 * Disarming is the row's other tap, not an implicit consequence of arming.
 */
export function armStopAlert(alerts: readonly StopAlert[], alert: StopAlert): StopAlert[] {
  if (isStopAlertArmed(alerts, alert.routeLabel, alert.stopId)) return alerts as StopAlert[];
  // Oldest first out: the strip is bounded, and the arm a rider just made is
  // the one they are looking at.
  return [...alerts, alert].slice(-MAX_STOP_ALERTS);
}

export function disarmStopAlert(
  alerts: readonly StopAlert[], routeLabel: string, stopId: number,
): StopAlert[] {
  return alerts.filter((a) => !(a.routeLabel === routeLabel && a.stopId === stopId));
}

/** Replace one alert in place (the fired-state update), by its own identity. */
export function updateStopAlert(alerts: readonly StopAlert[], next: StopAlert): StopAlert[] {
  return alerts.map((a) =>
    a.routeLabel === next.routeLabel && a.stopId === next.stopId ? next : a);
}

/** Age alone. The schedule half is in `expireStopAlerts`, which needs a date. */
export function isStopAlertExpired(alert: StopAlert, nowMs: number): boolean {
  return nowMs - alert.createdAt >= STOP_ALERT_TTL_MS;
}

/**
 * Drop the alerts that are over: aged out, or on a line that has stopped
 * running (outside `CLOSE_GRACE_MS` of arming). Returns the SAME array when
 * nothing is dropped, so a caller can use it as a state setter without
 * re-rendering on every poll.
 *
 * The schedule predicate is injected so this stays testable without a clock or
 * a timetable; it defaults to the app's own ET-resolving one.
 */
export function expireStopAlerts(
  alerts: readonly StopAlert[],
  nowMs: number,
  isScheduled: (routeLabel: string, d: Date) => boolean = isRouteScheduledAt,
): StopAlert[] {
  const d = new Date(nowMs);
  const kept = alerts.filter((a) => {
    if (isStopAlertExpired(a, nowMs)) return false;
    if (nowMs - a.createdAt < CLOSE_GRACE_MS) return true;
    return isScheduled(a.routeLabel, d);
  });
  return kept.length === alerts.length ? (alerts as StopAlert[]) : kept;
}

/** The fired record that applies to `busName` — a different vehicle starts clean. */
function firedFor(alert: StopAlert, busName: string): StopAlertFired {
  const f = alert.fired;
  return f && f.busName === busName ? f : NOT_FIRED(busName);
}

/**
 * WHICH PING FIRES NOW, or null.
 *
 * `etaSec` / `busName` are the arrival THE ROW PRINTS: the soonest live arrival
 * of this line at this stop out of the one `computeUpcomingArrivals` call the
 * page makes (arrivals.ts). Nothing is re-derived here, so the ping and the
 * number on screen cannot disagree — the mistake the Map tab's own second
 * arithmetic made until 2026-09-04.
 *
 * Rules:
 * - no arrival (`etaSec` null — the line has no live bus, or none that the
 *   estimator will price to this stop) → nothing. The arm KEEPS WAITING; a feed
 *   gap is not an answer.
 * - inside `ARRIVAL_ETA_SEC` → `arrival`, once per vehicle. It fires even if
 *   `lead` never did: a rider who arms while the bus is 20 s out gets the
 *   useful ping, not two in the same second (leaveAlert.ts's rule, same reason).
 * - inside the rider's lead time → `lead`, once per vehicle.
 * - a DIFFERENT vehicle resets both flags, so the next bus is a fresh promise.
 */
export function decide(
  alert: StopAlert,
  etaSec: number | null | undefined,
  busName: string | null | undefined,
  nowMs: number,
): StopAlertKind | null {
  if (isStopAlertExpired(alert, nowMs)) return null;
  if (etaSec == null || !Number.isFinite(etaSec) || !busName) return null;
  const fired = firedFor(alert, busName);
  if (fired.arrival) return null;
  if (etaSec <= ARRIVAL_ETA_SEC) return "arrival";
  if (etaSec <= alert.leadMin * 60) return fired.lead ? null : "lead";
  return null;
}

/**
 * Record a fired ping against the vehicle it was about. `arrival` marks `lead`
 * fired too: once the bus is here, a bounced ETA must never produce a belated
 * "it is 3 min away" (leaveAlert.ts's `markFired`, same rule).
 */
export function markStopAlertFired(alert: StopAlert, kind: StopAlertKind, busName: string): StopAlert {
  const base = firedFor(alert, busName);
  return {
    ...alert,
    fired: kind === "arrival"
      ? { busName, lead: true, arrival: true }
      : { ...base, busName, lead: true },
  };
}

/**
 * "in about 3 min", or plain words under a minute — "in about <1 min" reads as
 * a typo, and the arrival ping owns everything under 30 s anyway.
 */
function aboutText(etaSec: number): string {
  const m = fmtMin(etaSec);
  return m === "now" || m === "<1 min" ? "in less than a minute" : `in about ${m}`;
}

/**
 * The exact rider-facing strings ("min", never "m" — project convention):
 *   lead:    "Red reaches 344 Winchester in about 3 min"
 *   arrival: "Red is at 344 Winchester now"
 *
 * The line leads, because the rider armed this for a line; the stop is the
 * second half, because they are standing at it or walking to it.
 */
export function stopAlertMessage(kind: StopAlertKind, alert: StopAlert, etaSec: number): string {
  return kind === "arrival"
    ? `${alert.routeLabel} is at ${alert.stopName} now`
    : `${alert.routeLabel} reaches ${alert.stopName} ${aboutText(etaSec)}`;
}

/** One notification tag per (line, stop), so two arms never overwrite each other's ping — nor the leave reminder's. */
export function stopAlertTag(alert: StopAlert): string {
  return `stop-alert-${alert.routeLabel}-${alert.stopId}`;
}

/** The fields of an `UpcomingArrival` (arrivals.ts) this module reads — nothing else. */
export type AlertArrival = { eta: number; routeLabel: string; stopId: number; busName: string };

export type StopAlertPing = {
  alert: StopAlert;
  kind: StopAlertKind;
  message: string;
  tag: string;
  busName: string;
  etaSec: number;
};

/**
 * ONE POLL: which pings fire, and the alerts as they stand afterwards.
 *
 * `arrivals` is `computeUpcomingArrivals`' answer over (at least) the armed
 * stops. It is sorted eta-ascending, so the FIRST entry for a (line, stop) is
 * this lap and any later one is the same vehicle coming round again — the rule
 * the route card uses to fill its rows (TransitMap `StopList`, `etaAtStop`), so
 * the entry decided on here is the entry the row prints. Taking the first
 * rather than re-deriving a minimum is deliberate: the day the row's rule
 * changes, the two must still be reading the same line of the same array.
 *
 * An `arrival` ping DISARMS its alert — it is the last thing the alert has to
 * say. A `lead` ping is recorded against the vehicle it was about.
 *
 * Pure, so a recorded pass can be replayed through exactly what the page runs
 * (stopAlerts.replay.test.ts); the page only prices and delivers.
 */
export function stepStopAlerts(
  alerts: readonly StopAlert[],
  arrivals: readonly AlertArrival[],
  nowMs: number,
): { alerts: StopAlert[]; pings: StopAlertPing[] } {
  const soonest = new Map<string, AlertArrival>();
  for (const a of arrivals) {
    const k = alertKey(a.routeLabel, a.stopId);
    if (!soonest.has(k)) soonest.set(k, a);
  }
  let next = alerts as StopAlert[];
  const pings: StopAlertPing[] = [];
  for (const alert of alerts) {
    const a = soonest.get(alertKey(alert.routeLabel, alert.stopId));
    const kind = decide(alert, a?.eta ?? null, a?.busName ?? null, nowMs);
    if (!kind || !a) continue;
    pings.push({
      alert, kind, message: stopAlertMessage(kind, alert, a.eta), tag: stopAlertTag(alert),
      busName: a.busName, etaSec: a.eta,
    });
    next = kind === "arrival"
      ? disarmStopAlert(next, alert.routeLabel, alert.stopId)
      : updateStopAlert(next, markStopAlertFired(alert, kind, a.busName));
  }
  return { alerts: next, pings };
}

/**
 * THE CHOOSER'S ONE LINE: why the browser is about to ask, and the limit of
 * phase 1 — in that order, because the permission prompt is the next thing on
 * screen and a rider who does not know what it is for says no.
 *
 * "default" — the prompt is coming; say what it is for.
 * "granted" — nothing to explain but the limit.
 * "denied" / "unsupported" — no OS notification will show (iOS Safari has no
 *   page-context Notification at all), so say where the ping WILL appear
 *   instead: the in-app line at the top of the app, on every tab.
 */
export function stopAlertPermissionHint(
  state: NotificationPermission | "unsupported",
): string {
  const limit = "Works while this app is open, even in the background.";
  if (state === "granted") return limit;
  if (state === "default") return `Your browser will ask to allow notifications — that is how the ping reaches you. ${limit}`;
  return "Notifications are off for this site, so the alert will show at the top of the app instead.";
}

// ── Storage (the only impure part; never throws) ────────────────────────────

function validLead(n: unknown): number {
  return (LEAD_CHOICES as readonly number[]).includes(n as number) ? (n as number) : DEFAULT_LEAD_MIN;
}

function parseAlert(raw: unknown): StopAlert | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const stopId = typeof o.stopId === "number" && Number.isFinite(o.stopId) ? o.stopId : null;
  const routeLabel = typeof o.routeLabel === "string" && o.routeLabel ? o.routeLabel : null;
  if (stopId === null || routeLabel === null) return null;
  const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;
  const fired = o.fired as StopAlertFired | undefined;
  return {
    routeId: typeof o.routeId === "string" ? o.routeId : "",
    routeLabel,
    stopId,
    stopName: typeof o.stopName === "string" && o.stopName ? o.stopName : `Stop ${stopId}`,
    leadMin: validLead(o.leadMin),
    createdAt,
    ...(fired && typeof fired === "object" && typeof fired.busName === "string"
      ? { fired: { busName: fired.busName, lead: !!fired.lead, arrival: !!fired.arrival } }
      : {}),
  };
}

/**
 * Read the armed alerts. A blocked, empty or corrupt store is an empty list —
 * never a throw: an unguarded storage read in a state initialiser is what
 * blank-screened this app once already ("The operation is insecure").
 *
 * Age is NOT filtered here: `expireStopAlerts` owns that, and it owns the
 * schedule half too, so there is one place that decides an alert is over.
 */
export function loadStopAlerts(): StopAlert[] {
  try {
    const raw = localStorage.getItem(STOP_ALERTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StopAlert[] = [];
    for (const item of parsed) {
      const a = parseAlert(item);
      if (a && !isStopAlertArmed(out, a.routeLabel, a.stopId)) out.push(a);
    }
    return out.slice(-MAX_STOP_ALERTS);
  } catch {
    return [];
  }
}

export function saveStopAlerts(alerts: readonly StopAlert[]): void {
  try {
    localStorage.setItem(STOP_ALERTS_KEY, JSON.stringify(alerts.slice(-MAX_STOP_ALERTS)));
  } catch { /* storage blocked — the arm lives for this page's lifetime only */ }
}
