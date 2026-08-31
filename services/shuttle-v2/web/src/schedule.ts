// Published operating windows and the Eastern-Time clock arithmetic that reads
// them. Extracted from TransitMap.tsx so the timezone handling — the part that
// broke for real riders — is testable without a browser.

import type { BusData } from "./map-data";
import { ROUTE_ID_LABEL } from "./routes";

// Published Yale shuttle operating windows, keyed by ROUTE_LISTS label.
// days uses JS getDay() (0=Sun..6=Sat). endMin > 1440 means the window
// extends into the next day's early hours — e.g. 25*60 = 1:00 AM.
// Sources: your.yale.edu daytime/nighttime/weekend routes pages.
export type ScheduleWindow = { days: number[]; startMin: number; endMin: number };

export const ROUTE_HOURS: Record<string, ScheduleWindow[]> = {
  "Red":          [{ days: [1,2,3,4,5],         startMin: 5*60+40, endMin: 19*60 }],
  "Blue Day":     [{ days: [1,2,3,4,5],         startMin: 7*60,    endMin: 18*60 }],
  "Blue Weekend": [{ days: [0,6],               startMin: 8*60,    endMin: 18*60 }],
  "Blue Night":   [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Blue West":    [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Orange Day":   [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Orange Night": [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Orange East":  [{ days: [0,1,2,3,4,5,6],     startMin: 18*60,   endMin: 25*60 }],
  "Brown":        [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Pink":         [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  "Green":        [{ days: [0,1,2,3,4,5,6],     startMin: 6*60,    endMin: 18*60 }],
  "Purple":       [{ days: [0,1,2,3,4,5,6],     startMin: 6*60,    endMin: 25*60 }],
  "Gold":         [{ days: [1,2,3,4,5],         startMin: 6*60,    endMin: 18*60 }],
  // Observed running from ~07:00 on weekends, three hours before the
  // published 10:00 — more than SERVICE_GRACE_MS covers, so widen the window.
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

export function fmtSchedule(label: string): string {
  const wins = ROUTE_HOURS[label];
  if (!wins || wins.length === 0) return "";
  return wins.map((w) =>
    `${fmtScheduleDays(w.days)} ${fmtScheduleTime(w.startMin)}–${fmtScheduleTime(w.endMin)}`
  ).join(" · ");
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

export function isRouteActiveAt(label: string, d: Date): boolean {
  const wins = ROUTE_HOURS[label];
  if (!wins) return true;                    // unknown → don't filter
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

// A bus reported on a route far outside that route's published operating
// window is a ghost — typically a parked shuttle with its transponder left
// on (report #30: a "Red" bus on screen at 5:40 PM on a Sunday; Red runs
// M–F). Filtered at /api/buses ingest so the map, the trip planner, and the
// arrivals boards all agree it doesn't exist. The ±45 min grace keeps real
// buses visible while they finish a last loop after close or pre-position
// before open; a route with no known schedule is never filtered.
// Widened from 45 min: comparing ROUTE_HOURS against 8 days of observed
// arrivals showed the published windows run NARROWER than real service at both
// ends (Pink from 04:00 not 06:00, Brown from 05:00, Green until 19:00, the
// night routes from 17:00). Because this filter DELETES buses from the entire
// app — map, planner and arrival boards — a too-narrow window hides a bus the
// rider can see out the window, which is a far worse failure than showing a
// parked one. Fail wide.
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
