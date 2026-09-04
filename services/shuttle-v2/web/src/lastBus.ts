// Last-bus warning — the pure "should the rider be told this may be the last
// one?" rule. Extracted so the decision is unit-tested against a frozen ET
// clock, like the rest of schedule.ts.
//
// The gap it closes (operator, 2026-09-03, 18:15 ET on a Thursday): Red had
// ONE bus live, 15 min past its published 6pm close, and the planner offered
// it for a Union Station trip with exactly the confidence it shows at noon.
// "What if it doesn't do another lap?" — nothing in the app could say. The
// failure is asymmetric: wrongly cautious costs a rider a moment's doubt;
// wrongly confident strands them downtown at night with no ride back.
//
// Two clocks exist on purpose and this module must not collapse them:
//   * ROUTE_HOURS (schedule.ts) is the in-service GATE, widened against 13
//     weeks of observed arrivals so a bus the rider can see is never hidden.
//     Red's gate runs to 19:00; the buses this warning is about are exactly
//     the ones that gate lets through.
//   * `route_hours` (/api/buses) is the operator's PUBLISHED timetable — Red
//     "7am - 6pm, M - F". It is what riders are told and the only close the
//     operator has actually committed to, so it is the close this warning
//     quotes. The observed tail (Red usually runs to ~18:30) is a bonus, not
//     a promise, and quoting it would be the over-promise this exists to
//     avoid. ROUTE_HOURS stands in only when the timetable is unparsed —
//     the same precedence as `routeHoursCaption`, so the warning can never
//     name a close the card's own "Runs …" line disagrees with.
//
// What it says, and what it refuses to say. We know the published close, the
// headway, and how many buses are live on the line. We do NOT know the
// operator's true last departure, so nothing here prints "last bus at 6:42".
// The verdict is "could be the last" once the bus AFTER the offered one
// (offered ETA + one headway) would be due past the close, "maybe the last
// loop" once the close has passed, and the count line reports what is on the
// road. The return leg is a fixed caution rather than a computed trip: the
// app cannot know whether, when, or by which line the rider comes back, and
// a guess printed as a fact is worse than the current silence.
//
// It WARNS; it never withholds. The option stays exactly where the planner
// put it (CLAUDE.md: hiding a bus the rider can see is the worse failure).

import {
  etDayAndMinutes, fmtScheduleDays, HEADWAY_MIN, ROUTE_HOURS, SERVICE_GRACE_MS,
} from "./schedule";
import type { PublishedWindow, ScheduleWindow } from "./schedule";

export type LastBusKind = "closing" | "after-close" | "off-day";

export type LastBusVerdict = {
  kind: LastBusKind;
  /** The published close, ET minute-of-day (0..1439) — what the headline quotes. */
  closeMin: number;
  /** Buses live on the line when the verdict was made. */
  liveCount: number;
  /** Line 1, bold: what the timetable says. */
  headline: string;
  /** Line 2: what is on the road, and the return caution. */
  detail: string;
};

/** Headway assumed for a line HEADWAY_MIN does not list. */
export const DEFAULT_HEADWAY_MIN = 15;

/**
 * "6pm", "6:30pm", "12am", "1am" (for 25*60 — overnight closes are stored
 * past 1440). Spelled `6pm`, not the app's usual `6p`: beside a route name
 * and a warning glyph a bare letter is one abbreviation too many (the same
 * call the weather line made).
 */
export function fmtHourAmPm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  return mm ? `${h}:${String(mm).padStart(2, "0")}${ampm}` : `${h}${ampm}`;
}

/**
 * How long after yesterday's close it still counts as "after-close" rather
 * than "before today's open": the in-service gate's grace, because that is
 * exactly how long a bus on yesterday's service can still be on screen.
 */
export const PREVIOUS_CLOSE_HORIZON_MIN = SERVICE_GRACE_MS / 60_000;

export type WindowPosition =
  /** Inside a window; `closeMin` is its close in minutes from TODAY's ET midnight (may exceed 1440). */
  | { kind: "open"; closeMin: number }
  /** A window closed earlier today; `closeMin` is when. */
  | { kind: "after-close"; closeMin: number }
  /** Today is a service day but the window has not opened yet. */
  | { kind: "before-open" }
  /** The timetable has no service today at all. */
  | { kind: "off-day" };

/**
 * Where the ET instant `now` sits relative to `wins` today. Same clock
 * conventions as `isWindowActiveAt` — a window with endMin > 1440 runs past
 * midnight, and its tail belongs to the PREVIOUS service day — resolved
 * through `etDayAndMinutes`, never `getDay()`/`getHours()`.
 *
 * Precedence when several windows disagree: open > after-close >
 * before-open > off-day. A Blue Night bus at 02:00 is "after the 1am close",
 * not "before tonight's 6pm open" — the story the rider needs is the one
 * about the service that just ended.
 */
export function windowPosition(wins: readonly ScheduleWindow[], now: Date): WindowPosition {
  const { day, mins } = etDayAndMinutes(now);
  const prev = (day + 6) % 7;
  let afterClose: number | null = null;
  let beforeOpen = false;
  for (const w of wins) {
    const overnight = w.endMin > 1440;
    if (w.days.includes(prev)) {
      // Yesterday's service, on today's clock: a 1am tail closes at 60, a
      // window that ends at midnight closes at 0, Red's 6pm at -360.
      const tail = w.endMin - 1440;
      if (overnight && mins < tail) return { kind: "open", closeMin: tail };
      // That close is still the story only while a bus could still be out
      // on it — the gate's own grace. Past that, "before today's open" is
      // the truer position (Red at 06:30 is not "after yesterday's 6pm").
      if (mins - tail <= PREVIOUS_CLOSE_HORIZON_MIN) {
        afterClose = afterClose === null ? tail : Math.max(afterClose, tail);
      }
    }
    if (w.days.includes(day)) {
      if (mins < w.startMin) { beforeOpen = true; continue; }
      if (overnight || mins < w.endMin) return { kind: "open", closeMin: w.endMin };
      afterClose = afterClose === null ? w.endMin : Math.max(afterClose, w.endMin);
    }
  }
  if (afterClose !== null) return { kind: "after-close", closeMin: afterClose };
  if (beforeOpen) return { kind: "before-open" };
  return { kind: "off-day" };
}

/**
 * The windows this warning judges against — the published timetable when the
 * payload carries one, ROUTE_HOURS otherwise, nothing when neither knows the
 * line. Exported so a test can pin the precedence to `routeHoursCaption`'s.
 */
export function windowsFor(label: string, published: PublishedWindow | undefined): ScheduleWindow[] | null {
  if (published) return [published];
  const wins = ROUTE_HOURS[label];
  return wins && wins.length ? wins : null;
}

export type LastBusInput = {
  /** ROUTE_LISTS label ("Red"). */
  label: string;
  /** The line's entry in `/api/buses` `route_hours`, if any. */
  published?: PublishedWindow;
  now: Date;
  /**
   * Seconds until the offered bus reaches the board stop, as the card counts
   * it down. Null when no live bus is pinned — judged as "now", the cautious
   * end.
   */
  busEtaSec: number | null;
  /** Buses live on this line (on-route, ghost-filtered), as the card counts them. */
  liveCount: number;
  /**
   * A plan for a chosen future departure has no live bus to be the last of;
   * the schedule already gates those ("Next: …"). Nothing to say.
   */
  future?: boolean;
};

export function lastBusVerdict(input: LastBusInput): LastBusVerdict | null {
  if (input.future) return null;
  const wins = windowsFor(input.label, input.published);
  if (!wins) return null;
  const pos = windowPosition(wins, input.now);
  const liveCount = Math.max(0, Math.floor(input.liveCount));
  if (pos.kind === "before-open") return null;
  if (pos.kind === "off-day") {
    // Every published day is a service day, so "runs M–F" is the whole
    // timetable's days, not one window's. Multi-window lines (none today)
    // would list the union.
    const days = [...new Set(wins.flatMap((w) => w.days))];
    return {
      kind: "off-day", closeMin: 0, liveCount,
      headline: `⚠️ Not scheduled today — runs ${fmtScheduleDays(days)}`,
      detail: detailLine("after-close", liveCount),
    };
  }
  const closeMin = ((pos.closeMin % 1440) + 1440) % 1440;
  if (pos.kind === "after-close") {
    return {
      kind: "after-close", closeMin, liveCount,
      headline: `⚠️ Hours ended ${fmtHourAmPm(closeMin)} — maybe the last loop`,
      detail: detailLine("after-close", liveCount),
    };
  }
  // Open. The bus after the offered one is due about one headway later; if
  // that lands past the close, the offered one could be the last.
  const { mins } = etDayAndMinutes(input.now);
  const headway = HEADWAY_MIN[input.label] ?? DEFAULT_HEADWAY_MIN;
  const arrivalMin = mins + Math.max(0, input.busEtaSec ?? 0) / 60;
  if (arrivalMin + headway < pos.closeMin) return null;
  return {
    kind: "closing", closeMin, liveCount,
    headline: `⚠️ Could be the last bus — hours end ${fmtHourAmPm(closeMin)}`,
    detail: detailLine("closing", liveCount),
  };
}

/**
 * Line 2. The count answers "will there be another?" as far as it can be
 * answered — a second vehicle on the road is real information, one is the
 * dangerous case — and the return caution is fixed wording (see the header
 * for why it is not a computed trip). Zero live buses is possible when the
 * planner's bus fails the on-route check; the count is then simply omitted
 * rather than claiming "only 1".
 */
export function detailLine(kind: "closing" | "after-close", liveCount: number): string {
  const back = "don't count on a ride back";
  if (liveCount <= 0) return "Don't count on a ride back";
  if (liveCount === 1) {
    return kind === "after-close" ? `Only 1 bus still out · ${back}` : `Only 1 bus is out · ${back}`;
  }
  return `${liveCount} buses${kind === "after-close" ? " still" : " are"} out · ${back}`;
}
