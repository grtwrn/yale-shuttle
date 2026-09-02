/**
 * The operator publishes each route's timetable as free text in the route
 * `description` of routes_routes.php — "7am - 6pm, M - F", "5:30am - 11:45pm,
 * Daily", "6pm - 12am, Daily". This turns that text into a machine-readable
 * window so riders are shown the PUBLISHED hours.
 *
 * Why not just show ROUTE_HOURS (web/src/schedule.ts)? That table is the
 * in-service GATE: it was deliberately widened against observed arrivals so a
 * real bus is never hidden, which is the right bias for a filter and the wrong
 * one for a timetable — it told riders Red "Runs M–F 5:40a–7p" while Yale
 * publishes 7am–6pm. The gate keeps ROUTE_HOURS; the display gets this.
 *
 * Conservative by design: anything not understood with confidence yields null
 * (the client then falls back to ROUTE_HOURS text), and nothing here throws —
 * the description is upstream free text and this runs inside the /api/buses
 * payload build.
 */

export interface PublishedWindow {
  /** JS getDay() convention: 0 = Sunday … 6 = Saturday. Sorted ascending. */
  days: number[];
  /** Minutes after local (ET) midnight. */
  startMin: number;
  /**
   * Minutes after the START day's midnight, so a window that crosses midnight
   * has endMin > 1440 (an end of "12am" is 24*60). Any literal end at or before
   * the start is read as crossing midnight.
   */
  endMin: number;
  /** The original description, trimmed. */
  text: string;
}

const MINUTES_PER_DAY = 24 * 60;

// "7am", "7:30am", "12 pm", "7 a.m." — the meridiem is REQUIRED on both ends:
// "7 - 6" could be either 7am–6pm or 7pm–6am, and guessing is how a rider gets
// told the wrong hours. Separators: hyphen, en dash, em dash, or "to".
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?`;
// (A trailing `\b` would reject "6 p.m.," — after the dot there is no word
// boundary — so the end is guarded with a lookahead instead.)
const TIME_RANGE_RE = new RegExp(String.raw`\b${TIME}\s*(?:[-–—]|to)\s*${TIME}(?![a-z\d])`, "gi");

const DAY_TOKENS: Record<string, number> = {
  su: 0, sun: 0, sunday: 0,
  m: 1, mo: 1, mon: 1, monday: 1,
  t: 2, tu: 2, tue: 2, tues: 2, tuesday: 2,
  w: 3, we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  f: 5, fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};
const DAY_GROUPS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  everyday: [0, 1, 2, 3, 4, 5, 6],
  "every day": [0, 1, 2, 3, 4, 5, 6],
  "7 days": [0, 1, 2, 3, 4, 5, 6],
  "7 days a week": [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};
const RANGE_WORDS = new Set(["-", "–", "—", "to", "thru", "through"]);
const LIST_WORDS = new Set([",", "/", "&", "and", "+"]);

function toMinutes(h: string, m: string | undefined, meridiem: string): number | null {
  const hour = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const h24 = (hour % 12) + (meridiem === "p" ? 12 : 0);
  return h24 * 60 + minute;
}

/** Parse the day-of-week portion ("M - F", "Sat - Sun", "Daily", "Sa/Su"). */
function parseDays(text: string): number[] | null {
  const lowered = text.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
  if (lowered.length === 0) return null;
  const group = DAY_GROUPS[lowered];
  if (group) return [...group];

  // Tokenise: words, and the punctuation that means something.
  const tokens = lowered.match(/[a-z]+|\d+|[-–—,/&+]/g);
  if (!tokens || tokens.join("").length !== lowered.replace(/\s/g, "").length) return null;

  const out = new Set<number>();
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const grp = DAY_GROUPS[tok];
    if (grp) {
      for (const d of grp) out.add(d);
      i += 1;
    } else {
      const start = DAY_TOKENS[tok];
      if (start === undefined) return null;
      i += 1;
      if (i < tokens.length && RANGE_WORDS.has(tokens[i]!)) {
        const endTok = tokens[i + 1];
        const end = endTok === undefined ? undefined : DAY_TOKENS[endTok];
        if (end === undefined) return null;
        // Inclusive, wrapping the week: "Sat - Sun" is [6, 0].
        for (let d = start; ; d = (d + 1) % 7) {
          out.add(d);
          if (d === end) break;
        }
        i += 2;
      } else {
        out.add(start);
      }
    }
    // Between items: an optional list separator (or nothing, for "M W F").
    if (i < tokens.length && LIST_WORDS.has(tokens[i]!)) i += 1;
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b);
}

export function parsePublishedHours(
  description: string | null | undefined,
): PublishedWindow | null {
  try {
    if (typeof description !== "string") return null;
    const text = description.trim();
    if (text.length === 0) return null;

    TIME_RANGE_RE.lastIndex = 0;
    const matches = [...text.matchAll(TIME_RANGE_RE)];
    // Exactly one time range: two ("7am - 10am, 3pm - 6pm") is a split shift
    // this shape cannot express, so say nothing rather than half of it.
    if (matches.length !== 1) return null;
    const m = matches[0]!;
    const startMin = toMinutes(m[1]!, m[2], m[3]!.toLowerCase());
    const rawEnd = toMinutes(m[4]!, m[5], m[6]!.toLowerCase());
    if (startMin === null || rawEnd === null) return null;
    const endMin = rawEnd <= startMin ? rawEnd + MINUTES_PER_DAY : rawEnd;

    // Whatever is left is the days. Strip the comma that separates the two
    // halves; parseDays rejects anything else it does not recognise.
    const rest = (text.slice(0, m.index) + " " + text.slice(m.index! + m[0].length))
      .replace(/^\s*,|,\s*$/g, "")
      .trim();
    const days = parseDays(rest);
    if (!days) return null;

    return { days, startMin, endMin, text };
  } catch {
    return null;
  }
}
