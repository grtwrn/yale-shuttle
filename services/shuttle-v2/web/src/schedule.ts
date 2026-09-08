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

// Per-line calendar facts that the hours alone cannot express. Yale publishes
// the weekend grocery service as an ALTERNATING schedule — "Alternating
// Schedule - Weekend Grocery Shuttle Service - Saturday and Sunday 7:00 AM
// until 5:00 PM" (https://your.yale.edu/media/3084/download?inline=) and the
// "2026 Grocery Shuttle Calendar" PDF
// (https://your.yale.edu/sites/default/files/2026-01/2026_Grocery_Shuttle_Calendar.pdf,
// linked from your.yale.edu → Using the Shuttle → Weekend routes): Schedule #1
// Trader Joe's on Jan 3–4 and every second weekend after; Schedule #2 Hamden
// (Plaza, Aldi, Walmart, Shop Rite) on the others; Dec 24–31 struck through.
// The operator's route description carries none of this — both lines read
// "7am - 5pm, Sat - Sun" — so the cards used to say "should be running now —
// no bus reporting yet" every other weekend (operator, Sun 2026-09-06 10:28,
// planning to Trader Joe's on a Hamden weekend). The `arrivals` table agrees
// with the published calendar on every weekend 2026-06-13 → 2026-09-06 (13 of
// 13: never both lines, never the same one twice running).
//
// Evidence order at run time (`serviceStateAt`): upstream's own `active` flag
// for the route (routes_routes.php, served as `route_active`) first; then the
// partner's bus being out; then this calendar. NONE of it touches the
// in-service gate (`isBusInService`): a bus reporting on the "wrong" weekend
// is still a bus, and hiding one the rider can see is the worse failure.
export interface AlternationRule {
  /** An ET calendar date (YYYY-MM-DD) on which the line ran. */
  anchorDay: string;
  /** Length of the cycle in days; the line is on for the first 7 of them. */
  periodDays: number;
  /** The ROUTE_LISTS label of the line that runs the other weeks. */
  partner: string;
}
export interface DateSpan { from: string; to: string; why: string }
export interface RouteCalendar {
  alternation?: AlternationRule;
  /** Published no-service spans, ET dates inclusive. */
  closures?: DateSpan[];
  /** One plain line the route's cards carry, from the published sheet. */
  note?: string;
  /** Where the facts above come from, for the cards' small print. */
  source?: string;
}
const GROCERY_NOTE = "FlexiStop: ask the driver to drop you anywhere along the route · no service on holidays and recess";
const GROCERY_SOURCE = "Yale\u2019s 2026 grocery shuttle calendar";
const GROCERY_CLOSURES: DateSpan[] = [{ from: "2026-12-24", to: "2026-12-31", why: "winter recess" }];
export const ROUTE_CALENDAR: Record<string, RouteCalendar> = {
  "Grocery TJ":  { alternation: { anchorDay: "2026-01-03", periodDays: 14, partner: "Grocery Ham" }, closures: GROCERY_CLOSURES, note: GROCERY_NOTE, source: GROCERY_SOURCE },
  "Grocery Ham": { alternation: { anchorDay: "2026-01-10", periodDays: 14, partner: "Grocery TJ" }, closures: GROCERY_CLOSURES, note: GROCERY_NOTE, source: GROCERY_SOURCE },
};

/** Days of an alternation cycle the line is on: one week from the anchor. */
const ON_SPAN_DAYS = 7;

/**
 * Upstream's `active` flag is read as "not running today" only once the
 * line's window has been open this long. How promptly the operator flips the
 * flag at the start of a service block is not measured, and "should be
 * running now — no bus reporting yet" is the right thing to say at 07:02 on
 * a school morning; "not running today" at 07:02 would be a guess.
 */
export const ACTIVE_FLAG_SETTLE_MIN = 20;

const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

/**
 * The ET calendar day of `d` as a day count (days since 1970-01-01 on the ET
 * calendar). Same discipline as `etDayAndMinutes`: the device clock is never
 * consulted, so a phone on Tokyo time does not flip the weekend a day early.
 */
export function etDayNumber(d: Date): number {
  const parts = ET_DATE_FMT.formatToParts(d);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "", 10);
  const y = get("year"), m = get("month"), day = get("day");
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  }
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
}

function isoDayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Whether the ET date of `d` falls in the rule's on-week. */
export function isOnWeekAt(rule: AlternationRule, d: Date): boolean {
  const since = etDayNumber(d) - isoDayNumber(rule.anchorDay);
  const p = Math.max(1, Math.round(rule.periodDays));
  return ((since % p) + p) % p < ON_SPAN_DAYS;
}

/** Whether the ET date of `d` lies inside one of the calendar's closures. */
export function isClosedOn(cal: RouteCalendar | undefined, d: Date): boolean {
  if (!cal?.closures?.length) return false;
  const n = etDayNumber(d);
  return cal.closures.some((c) => n >= isoDayNumber(c.from) && n <= isoDayNumber(c.to));
}

/** The calendar says the line runs on the ET date of `d` (alternation and closures; hours aside). */
export function calendarAllows(cal: RouteCalendar | undefined, d: Date): boolean {
  if (!cal) return true;
  if (isClosedOn(cal, d)) return false;
  return !cal.alternation || isOnWeekAt(cal.alternation, d);
}

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

/**
 * The hour of the day (0..23) in America/New_York.
 *
 * The ONLY way the client may name an hour. The collector writes
 * `stop_visits.hour` in ET (TZ=America/New_York in the Dockerfile), so a
 * diurnal table is indexed in ET on the server; a phone left on another
 * timezone reading `Date#getHours()` would index someone else's day — the
 * same class of bug as the "No shuttles running" one this module exists to
 * prevent. Intl resolves DST for us, so the boundary needs no arithmetic
 * here: 01:30 EDT and 01:30 EST both answer 1.
 */
export function etHourOf(d: Date): number {
  return Math.floor(etDayAndMinutes(d).mins / 60);
}

/**
 * Is the ET instant `d` inside any of `wins`? False for an empty list. With a
 * calendar, only on days it allows — judged on the ET date the window
 * STARTED (an overnight window's small hours belong to the evening before).
 */
export function isWindowActiveAt(wins: readonly ScheduleWindow[], d: Date, cal?: RouteCalendar): boolean {
  const { day, mins } = etDayAndMinutes(d);
  const onToday = calendarAllows(cal, d);
  for (const w of wins) {
    if (w.endMin <= 1440) {
      if (onToday && w.days.includes(day) && mins >= w.startMin && mins < w.endMin) return true;
    } else {
      // Overnight: same-day portion, then previous-day portion < (end-1440)
      if (onToday && w.days.includes(day) && mins >= w.startMin) return true;
      const prev = (day + 6) % 7;
      const onYesterday = calendarAllows(cal, new Date(d.getTime() - 86_400_000));
      if (onYesterday && w.days.includes(prev) && mins < (w.endMin - 1440)) return true;
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

/**
 * Next instant strictly after `after` at which one of `wins` opens; null if
 * none within a week — or, with a calendar, within a week plus one cycle plus
 * the longest closure, since the whole of the next week may be the partner's
 * and a recess may sit on top of it.
 */
export function nextWindowStart(wins: readonly ScheduleWindow[], after: Date, cal?: RouteCalendar): Date | null {
  let horizon = 7;
  if (cal?.alternation) horizon += Math.max(1, Math.round(cal.alternation.periodDays));
  for (const c of cal?.closures ?? []) horizon += Math.max(0, isoDayNumber(c.to) - isoDayNumber(c.from) + 1);
  for (let offset = 0; offset < horizon; offset++) {
    const cand = new Date(after.getTime() + offset * 86_400_000);
    const { day: dow, mins } = etDayAndMinutes(cand);
    if (!calendarAllows(cal, cand)) continue;
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

/**
 * What the app may SAY about a line at `at`, from its windows and its
 * calendar (`ROUTE_CALENDAR`). This is the display-side question; the
 * in-service gate (`isBusInService`) deliberately answers from hours alone.
 *
 *  open   the line runs at `at`
 *  off    the HOURS say open at `at`, yet the line is not out: `partner` is
 *         the line running instead when this one alternates ("not this
 *         weekend"), null otherwise ("not running today")
 *  next   the line's next start on a day the calendar allows; null when the
 *         windows are unknown or nothing opens within the horizon
 *
 * `live` is the evidence from the feed at `now`, and bears on `at` only if
 * `at` falls on the same ET day — a partner out today says nothing about next
 * Saturday. In order of authority:
 *   1. `active`, upstream's own flag for the route: false (once the window
 *      has been open ACTIVE_FLAG_SETTLE_MIN) is off today; true is on today,
 *      whatever the calendar arithmetic says.
 *   2. `labels`, the lines with a bus reporting: the partner out means this
 *      line is off today (the published schedule is mutually exclusive).
 *   3. the calendar.
 */
export interface ServiceState {
  open: boolean;
  off: { partner: string | null } | null;
  next: Date | null;
}

export interface LiveEvidence {
  labels: ReadonlySet<string>;
  now: Date;
  /** Upstream's `active` flag for this route, when the payload carried one. */
  active?: boolean | undefined;
}

/** Minutes the containing window of `wins` has been open at `d`; -1 when none is. */
function openForMin(wins: readonly ScheduleWindow[], d: Date): number {
  const { day, mins } = etDayAndMinutes(d);
  let best = -1;
  for (const w of wins) {
    if (w.days.includes(day) && mins >= w.startMin && (w.endMin > 1440 || mins < w.endMin)) best = Math.max(best, mins - w.startMin);
    if (w.endMin > 1440 && w.days.includes((day + 6) % 7) && mins < w.endMin - 1440) best = Math.max(best, mins + 1440 - w.startMin);
  }
  return best;
}

export function serviceStateAt(
  wins: readonly ScheduleWindow[] | undefined,
  label: string,
  at: Date,
  live?: LiveEvidence,
): ServiceState {
  if (!wins) return { open: true, off: null, next: null };
  const cal = ROUTE_CALENDAR[label];
  const hoursOpen = isWindowActiveAt(wins, at);
  const today = !!live && etDayNumber(live.now) === etDayNumber(at);
  const partner = cal?.alternation?.partner ?? null;
  let open: boolean;
  let overridden = false;
  if (today && live!.active === true) {
    open = hoursOpen;
    overridden = !calendarAllows(cal, at);
  } else if (today && live!.active === false && hoursOpen && openForMin(wins, at) >= ACTIVE_FLAG_SETTLE_MIN) {
    open = false;
    overridden = calendarAllows(cal, at);
  } else if (today && partner && live!.labels.has(partner)) {
    open = false;
    overridden = calendarAllows(cal, at);
  } else {
    open = hoursOpen && calendarAllows(cal, at);
  }
  const off = !open && hoursOpen ? { partner } : null;
  // The line's next start on a day the calendar allows. When live evidence
  // overrode a calendar "on" day, the cycle has shifted and the honest next is
  // the first opening after the days the windows cover (the rest of this
  // weekend, or tomorrow for a daily line), cycle ignored.
  let next = nextWindowStart(wins, at, cal);
  if (off && overridden) {
    let t = new Date(at.getTime() + 86_400_000);
    if (partner) {
      // The rest of this weekend is the partner's too.
      for (let i = 0; i < 6; i++) {
        const { day } = etDayAndMinutes(t);
        if (!wins.some((w) => w.days.includes(day))) break;
        t = new Date(t.getTime() + 86_400_000);
      }
    }
    const { mins } = etDayAndMinutes(t);
    const midnight = new Date(t.getTime() - mins * 60_000);
    next = nextWindowStart(wins, midnight, cal?.closures ? { closures: cal.closures } : undefined) ?? next;
  }
  return { open, off, next };
}

/**
 * `isRouteActiveAt` for the planner's calendar questions ("may a plan for
 * Saturday ride this line?"): ROUTE_HOURS AND the calendar. Never the gate.
 */
export function isRouteScheduledAt(label: string, d: Date): boolean {
  const wins = ROUTE_HOURS[label];
  if (!wins) return true;
  return isWindowActiveAt(wins, d, ROUTE_CALENDAR[label]);
}
