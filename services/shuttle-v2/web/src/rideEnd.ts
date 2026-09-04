// When a live ride ends by itself.
//
// A ride the rider forgot to end keeps the GPS in high-accuracy mode, so it
// burns battery until the tab is closed (user request, 2026-07-17). Three
// triggers retire one: an age cap, the pinned bus vanishing from the feed, and
// the rider being far from that bus for several consecutive checks.
//
// The third one ended a ride that was still happening. Report #96 (2026-09-04):
// "I was riding a bus, submitted feedback and then lost my live ride."
//
// The mechanism is that the two things the rule compares are not measured at
// the same time. `/api/buses` keeps polling while the page is hidden (every
// 30 s), but the geolocation watch is deliberately torn down the moment
// `document.hidden` goes true, so the rider's position FREEZES while the bus's
// keeps arriving. Composing feedback is exactly the minute that happens in —
// the textarea takes tens of seconds, and 📎 Attach screenshot hands the page
// to the OS photo picker outright. A shuttle covers 300 m in under a minute,
// so the frozen fix produced three strikes in a row against a bus the rider
// was sitting on, the ride was cleared (and with it its localStorage copy),
// and the rider came back from a successful submission to the tabbed view.
//
// So the rule now states what it always meant: a strike is evidence only when
// BOTH positions are current. No fresh fix, or a hidden page, is not evidence
// that the rider left the bus — it is an absence of evidence, and the ride
// stays. Keeping a finished ride a few minutes too long costs battery; ending
// a live one costs the rider the thing they are using the app for.
//
// This lives outside TransitMap.tsx so the decision can be tested; the
// component owns the refs and the setter, and nothing else.

/** No shuttle trip takes two hours. */
export const RIDE_MAX_AGE_MS = 2 * 3600_000;
/** The pinned bus gone from the feed this long: service ended under the ride. */
export const BUS_ABSENT_MS = 10 * 60_000;
/** Farther than this from your own bus and you are not on it. */
export const OFF_BUS_M = 300;
/** Consecutive off-bus checks before the ride is retired. */
export const OFF_BUS_STRIKES = 3;
/**
 * How old the rider's fix may be and still count as a strike.
 *
 * The precise watch caches for 5 s and the poll that drives this runs every
 * 5 s while visible, so a live rider's fix is seconds old; a minute is
 * generous. The rescue one-shot will hand back a fix up to 120 s old
 * (`RESCUE_OPTIONS`), which is precisely the stale coordinate this excludes.
 */
export const FIX_MAX_AGE_MS = 60_000;

export interface RideEndInput {
  now: number;
  /** When the ride was boarded, epoch ms. */
  startedAt?: number;
  /** The pinned bus in THIS poll, or null when the feed did not carry it. */
  bus: { lat?: number; lon?: number } | null;
  /** When the pinned bus was last seen in the feed, epoch ms. */
  busLastSeenMs: number;
  /** The rider's last known position, or null if there has never been one. */
  user: { lat: number; lon: number } | null;
  /** Age of that fix in ms; null when there is no live fix at all. */
  fixAgeMs: number | null;
  /** `document.hidden` — while true the geolocation watch is not running. */
  hidden: boolean;
  /** Consecutive off-bus checks so far. */
  streak: number;
  /** Metres between rider and bus; null when either position is missing. */
  distanceM: number | null;
}

export type RideEndReason = "age" | "bus-gone" | "off-bus";

export interface RideEndDecision {
  /** Retire the ride. */
  end: boolean;
  reason: RideEndReason | null;
  /** The streak to carry into the next check. */
  streak: number;
  /** The "bus last seen" clock to carry into the next check. */
  busLastSeenMs: number;
}

/**
 * One check. Pure: the caller supplies the clocks and the distance, and gets
 * back the verdict plus the two counters to store.
 */
export function rideEndDecision(i: RideEndInput): RideEndDecision {
  const keep = (streak: number, busLastSeenMs: number): RideEndDecision =>
    ({ end: false, reason: null, streak, busLastSeenMs });

  if (typeof i.startedAt === "number" && i.now - i.startedAt > RIDE_MAX_AGE_MS) {
    return { end: true, reason: "age", streak: 0, busLastSeenMs: i.busLastSeenMs };
  }

  if (!i.bus) {
    if (i.now - i.busLastSeenMs > BUS_ABSENT_MS) {
      return { end: true, reason: "bus-gone", streak: 0, busLastSeenMs: i.busLastSeenMs };
    }
    // A poll the bus is missing from says nothing about where the rider is, so
    // it must not carry strikes forward: the old rule returned early and left
    // them standing, which let a feed gap and one bad fix add up to an ending.
    return keep(0, i.busLastSeenMs);
  }

  const seen = i.now;

  // No evidence, in three flavours, all treated the same: the streak resets,
  // because the next strike should have to make its whole case again.
  if (i.hidden) return keep(0, seen);
  if (!i.user || i.distanceM == null || !Number.isFinite(i.distanceM)) return keep(0, seen);
  if (i.fixAgeMs == null || !Number.isFinite(i.fixAgeMs) || i.fixAgeMs > FIX_MAX_AGE_MS) {
    return keep(0, seen);
  }

  const streak = i.distanceM > OFF_BUS_M ? i.streak + 1 : 0;
  if (streak >= OFF_BUS_STRIKES) {
    return { end: true, reason: "off-bus", streak: 0, busLastSeenMs: seen };
  }
  return keep(streak, seen);
}
