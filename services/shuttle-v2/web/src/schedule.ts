// Published operating windows and the Eastern-Time clock arithmetic that reads
// them. Extracted from TransitMap.tsx so the timezone handling — the part that
// broke for real riders — is testable without a browser.

import type { BusData } from "./map-data";
import { ROUTE_ID_LABEL } from "./routes";

// Yale shuttle operating windows, keyed by ROUTE_LISTS label.
// days uses JS getDay() (0=Sun..6=Sat). endMin > 1440 means the window
// extends into the next day's early hours — e.g. 25*60 = 1:00 AM.
//
// Originally transcribed from your.yale.edu; reconciled 2026-08-31 against
// 565,739 observed `arrivals` rows spanning 2026-06-02 → 2026-08-31 (13 full
// weeks). Method — deliberately robust, because a single shuttle
// repositioning at 04:00 is not "service starts at 4am":
//   * group arrivals by *service day* (ET day shifted back 4 h, so 00:00–03:59
//     belongs to the previous evening — that is how the night routes really
//     run);
//   * a date counts as a service day for a route only if it saw ≥ 20 arrivals;
//   * an hour counts as in service for a (route, weekday) only if ≥ 2 arrivals
//     landed in it on ≥ 50 % of that route's service days for that weekday;
//   * the window is then [first such hour, last such hour + 1), cross-checked
//     against the median and 10th/90th-percentile first/last arrival minute.
// The hour-occupancy rule is what separates real early service (Pink hour 05:
// 92–100 % of days) from a one-off deadhead (Pink hour 04: 8 %, i.e. 1 day).
//
// Caveat: the sample is a summer term. It is therefore used to WIDEN windows
// freely and to narrow them only where the published start was never once
// observed and the ±90 min SERVICE_GRACE_MS still covers the published time.
export type ScheduleWindow = { days: number[]; startMin: number; endMin: number };

// A route's PUBLISHED timetable as served in `/api/buses` `route_hours`, keyed
// by route id: the server parses the operator's free-text description
// ("7am - 6pm, M - F", src/server/publishedHours.ts) into this shape. `text`
// is that original description. Same clock conventions as ScheduleWindow.
export type PublishedWindow = ScheduleWindow & { text?: string };

// ⚠️ ROUTE_HOURS is the in-service GATE, not what riders are shown.
//
// It decides whether a reported bus is real (`isBusInService`, ±90 min grace)
// and whether a route counts as running for future-date planning. That job
// wants the window WIDE — hiding a bus the rider can see is the worse failure —
// so these values were widened against 13 weeks of observed arrivals and are
// not the operator's timetable (Red below opens 05:40; Yale publishes 7am).
//
// The hours riders READ ("Runs M–F 7a–6p" in the trip panel and the All tab)
// come from `/api/buses` `route_hours`, i.e. the operator's own published
// description parsed server-side, and only fall back to this table when a
// route's description could not be parsed. Do not narrow this table to match
// what is displayed; change the display source instead.
export const ROUTE_HOURS: Record<string, ScheduleWindow[]> = {
  // Observed M–F 06:30–18:30; the published window is wider at both ends, and
  // wider is the safe direction. 1 arrival on 13 Sundays confirms M–F (#30).
  "Red":          [{ days: [1,2,3,4,5],         startMin: 5*60+40, endMin: 19*60 }],
  // Observed M–F 07:00–18:00 almost exactly. Friday's tail reaches 19:05 on
  // the worst day, which the grace covers.
  "Blue Day":     [{ days: [1,2,3,4,5],         startMin: 7*60,    endMin: 18*60 }],
  // Every one of 13 Saturdays and 13 Sundays had full service in the 07:00
  // hour — an hour before the published 08:00 open.
  "Blue Weekend": [{ days: [0,6],               startMin: 7*60,    endMin: 18*60 }],
  // Night routes: observed 18:00–00:15 daily (Sa/Su Blue Night and Fri/Sat
  // Blue West creep back to ~17:40, inside the grace). Nothing at all runs
  // after 00:20, so the 01:00 close is already on the generous side.
  "Blue Night":   [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Blue West":    [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  // Observed M–F 06:35–18:15 — the published window brackets it.
  "Orange Day":   [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Orange Night": [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Orange East":  [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  // Observed M–F ~05:50–18:55. The 18:00 hour is a full service hour (85–100 %
  // of days), not a straggler, so it belongs inside the window.
  "Brown":        [{ days: [1,2,3,4,5],         startMin: 5*60+45, endMin: 19*60 }],
  // Observed M–F 05:25–18:50, with the 05:00 and 18:00 hours both ~100 %
  // occupied. (Not 04:00: that was a single deadhead on 2 of 65 weekdays.)
  "Pink":         [{ days: [1,2,3,4,5],         startMin: 5*60+15, endMin: 19*60 }],
  // Observed daily 05:25 →; weekdays run to ~19:00–19:15 (the 19:00 hour is
  // occupied on 45–85 % of weekdays), weekends to ~18:35.
  "Green":        [{ days: [0,1,2,3,4,5,6],     startMin: 5*60+15, endMin: 19*60+30 }],
  // The only route that runs all day AND all evening: 100 % occupancy every
  // hour 05:00–23:00, all seven days. But it stops dead at ~23:55 — zero
  // arrivals after midnight in 90 days — so the old 01:00 close was a
  // 65-minute ghost window every single night.
  "Purple":       [{ days: [0,1,2,3,4,5,6],     startMin: 5*60+15, endMin: 24*60 }],
  // Observed M–F 08:00–17:45, dead flat across 13 weeks; the 07:00 hour is
  // occupied on ≤ 15 % of days and 06:00 on none. Narrowed to 07:30 rather
  // than 08:00 so that grace still reaches the published 06:00 start.
  "Gold":         [{ days: [1,2,3,4,5],         startMin: 7*60+30, endMin: 18*60 }],
  // Confirmed: both grocery runs start at 07:00, not the published 10:00 —
  // the 07:00 hour is occupied on 100 % of their service days. They alternate
  // weekends (TJ on 7, Hamden on 6 of the 13), and never run on a weekday.
  "Grocery TJ":   [{ days: [0,6],               startMin: 7*60,    endMin: 18*60 }],
  "Grocery Ham":  [{ days: [0,6],               startMin: 7*60,    endMin: 18*60 }],
};

// Approximate headway in minutes — used to estimate wait = headway/2 for
// future-date planning when no live bus is running yet. Educated guesses
// from observed Yale service levels; the main routes are faster than the
// evening / weekend ones.
export const HEADWAY_MIN: Record<string, number> = {
  "Red": 8, "Blue Day": 10, "Blue Weekend": 20, "Blue Night": 20, "Blue West": 20,
  "Orange Day": 10, "Orange Night": 20, "Orange East": 20,
  "Brown": 15, "Pink": 20, "Green": 15, "Purple": 20, "Gold": 20,
  "Grocery TJ": 30, "Grocery Ham": 30,
};

export function fmtScheduleTime(min: number): string {
  // Handles values > 1440 (overnight windows, e.g. 25*60 = 1:00 AM).
  const m = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h >= 12 ? "p" : "a";
  h = h % 12; if (h === 0) h = 12;
  return mm ? `${h}:${String(mm).padStart(2, "0")}${ampm}` : `${h}${ampm}`;
}

export function fmtScheduleDays(days: number[]): string {
  const key = [...days].sort().join(",");
  if (key === "0,1,2,3,4,5,6") return "Daily";
  if (key === "1,2,3,4,5") return "M–F";
  if (key === "0,6") return "Sa/Su";
  const names = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];
  return [...days].sort().map((d) => names[d]).join("/");
}

/** "M–F 7a–6p", "Daily 5:30a–11:45p", "Sa/Su 7a–5p", "Daily 6p–12a". */
export function fmtWindows(wins: ScheduleWindow[]): string {
  return wins.map((w) =>
    `${fmtScheduleDays(w.days)} ${fmtScheduleTime(w.startMin)}–${fmtScheduleTime(w.endMin)}`
  ).join(" · ");
}

/** ROUTE_HOURS rendered as text — the fallback when no published window exists. */
export function fmtSchedule(label: string): string {
  const wins = ROUTE_HOURS[label];
  if (!wins || wins.length === 0) return "";
  return fmtWindows(wins);
}

// ROUTE_HOURS is published Eastern Time, but `getDay()`/`getHours()` read the
// DEVICE's timezone. A phone set to UTC — or any visitor whose phone is still
// on their home zone — mapped ET afternoon into the overnight window, so every
// weekday route was judged out of service: `isBusInService` dropped the buses
// and the app showed "😴 No shuttles running right now" while shuttles were
// visibly running outside. Anchor every schedule comparison to ET instead.
const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const ET_DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Day-of-week (0=Sun) and minutes-past-midnight for `d`, in America/New_York. */
export function etDayAndMinutes(d: Date): { day: number; mins: number } {
  const parts = ET_TIME_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ET_DAY_INDEX[get("weekday")];
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  // Fall back to device-local only if Intl gave us something unusable, which
  // beats throwing on an ancient browser.
  if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { day: d.getDay(), mins: d.getHours() * 60 + d.getMinutes() };
  }
  return { day, mins: (hour % 24) * 60 + minute };
}

/** Is the ET instant `d` inside any of `wins`? False for an empty list. */
export function isWindowActiveAt(wins: readonly ScheduleWindow[], d: Date): boolean {
  const { day, mins } = etDayAndMinutes(d);
  for (const w of wins) {
    if (w.endMin <= 1440) {
      if (w.days.includes(day) && mins >= w.startMin && mins < w.endMin) return true;
    } else {
      // Overnight: same-day portion, then previous-day portion < (end-1440)
      if (w.days.includes(day) && mins >= w.startMin) return true;
      const prev = (day + 6) % 7;
      if (w.days.includes(prev) && mins < (w.endMin - 1440)) return true;
    }
  }
  return false;
}

export function isRouteActiveAt(label: string, d: Date): boolean {
  const wins = ROUTE_HOURS[label];
  if (!wins) return true;                    // unknown → don't filter
  return isWindowActiveAt(wins, d);
}

// A bus reported on a route far outside that route's published operating
// window is a ghost — typically a parked shuttle with its transponder left
// on (report #30: a "Red" bus on screen at 5:40 PM on a Sunday; Red runs
// M–F). Filtered at /api/buses ingest so the map, the trip planner, and the
// arrivals boards all agree it doesn't exist. The grace keeps real buses
// visible while they finish a last loop after close or pre-position before
// open; a route with no known schedule is never filtered. Because this filter
// DELETES buses from the entire app — map, planner and arrival boards — a
// too-narrow window hides a bus the rider can see out of the window, which is
// a far worse failure than showing a parked one. Fail wide.
//
// Kept at 90 min after the 2026-08-31 reconciliation above. Most of the slack
// the grace used to absorb is now inside ROUTE_HOURS itself; what still leans
// on it, measured against 13 weeks of arrivals, is:
//   Blue Day    Friday tail to 19:05  →  65 min past the 18:00 close
//   Blue Night  Sa/Su start ~17:35    →  25 min before the 18:00 open
//   Blue West   Fr/Sa start ~17:45    →  15 min
//   Blue Weekend Sat tail to 18:15    →  15 min
// The worst case is 65 min, so 90 keeps ~25 min of headroom for a term whose
// service runs a little longer than the summer sample. Anything below 70 min
// would start deleting buses that demonstrably run.
export const SERVICE_GRACE_MS = 90 * 60 * 1000;

export function isBusInService(b: BusData, now = Date.now()): boolean {
  const label = ROUTE_ID_LABEL[b.route_id];
  if (!label) return true;
  return (
    isRouteActiveAt(label, new Date(now)) ||
    isRouteActiveAt(label, new Date(now - SERVICE_GRACE_MS)) ||
    isRouteActiveAt(label, new Date(now + SERVICE_GRACE_MS))
  );
}

// Next Date at which this route becomes active, starting from `after`.
// Returns null when the route has no schedule at all (treated as
// always-running). Walks forward up to 7 days since every window
// repeats weekly; anything beyond that doesn't exist in our schedule.
export function nextActiveWindow(label: string, after: Date): Date | null {
  const wins = ROUTE_HOURS[label];
  if (!wins) return null;
  return nextWindowStart(wins, after);
}

/** Next instant strictly after `after` at which one of `wins` opens; null if none within a week. */
export function nextWindowStart(wins: readonly ScheduleWindow[], after: Date): Date | null {
  for (let offset = 0; offset < 7; offset++) {
    const cand = new Date(after.getTime() + offset * 86_400_000);
    const { day: dow, mins } = etDayAndMinutes(cand);
    for (const w of wins) {
      if (!w.days.includes(dow)) continue;
      // Shift from where the ET wall clock currently sits to the window's
      // start minute on that same ET day. (A window whose start straddles a
      // DST changeover lands an hour off; a twice-a-year hour on a "next
      // active" hint isn't worth carrying a full tz library for.)
      const startAt = new Date(cand.getTime() + (w.startMin - mins) * 60_000);
      // Same day: the window must still be in the future.
      if (startAt.getTime() <= after.getTime()) continue;
      return startAt;
    }
  }
  return null;
}
