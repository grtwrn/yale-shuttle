// The trip plan as the two accuracy harnesses read it: eta-accuracy.mjs and
// route-tester.mjs. ONE reader for both, and it is the canary's.
//
// These harnesses carried their own copies of a card parser, and each layout
// change blinded them silently: #123 dropped the word "arrive" on 2026-09-04,
// then #309 replaced the cards with the "Route | Board in (min) | Arrive at"
// table on 2026-09-18. rider-canary.mjs runs often, fails loudly on
// `readings === 0`, and so gets its reader fixed when the page changes; this
// rides on `parseTimingTable` rather than keeping a third grammar to rot.
//
// Each row becomes { route, isWalk, waitSec, nextSec, arriveText, arriveMs,
// totalMin }. `waitSec` is the point the rider is shown ("~5" -> 300 s, "<1"
// -> 30 s, "At stop" -> 0); the band in brackets is not scored. Rows with a
// status instead of a countdown ("Missed", "Unavailable", "Scheduled", the
// Walk row's "—") have `waitSec: null`.
import { parseTimingTable } from "./canary-metrics.mjs";

// A canary bucket ([lo, hi) seconds) back to the seconds the old "in N min"
// parse scored: N whole minutes, 30 s for "<1", 0 for "At stop".
const bucketSec = (b) => (b == null ? null : b[1] <= 10 ? 0 : b[1] <= 60 ? 30 : b[0]);

const etMinutes = (ms) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (g("hour") % 24) * 60 + g("minute") + g("second") / 60;
};
// "9:41p" shown at `atMs` -> epoch ms of that wall-clock time (same ET day, or the next if it wrapped).
function clockToMs(h12, mm, ap, atMs) {
  let h = Number(h12) % 12;
  if (ap.toLowerCase() === "p") h += 12;
  let delta = h * 60 + Number(mm) - etMinutes(atMs);
  if (delta < -30) delta += 1440;            // wrapped past midnight
  return atMs + delta * 60_000;
}
// "~3:59p", "3:43p – 3:52p" or "Oct 2, 7:05a" -> epoch ms. A window counts at
// its midpoint; a date prefix is left to the wrap rule (live runs only).
export function arriveTextToMs(text, atMs) {
  const ends = [...String(text ?? "").matchAll(/(\d{1,2}):(\d{2})([ap])/gi)].map((m) => clockToMs(m[1], m[2], m[3], atMs));
  return ends.length ? (ends[0] + ends[ends.length - 1]) / 2 : null;
}

export function planOptions(text, atMs = Date.now()) {
  return parseTimingTable(text).map((row) => {
    const eta = row.eta;
    const arriveMs = arriveTextToMs(row.arriveText, atMs);
    return {
      route: row.routeLabel,
      isWalk: row.mode === "walk",
      // With a band the canary keeps the point as `median`; without one it is `first`.
      waitSec: eta ? bucketSec(eta.median ?? eta.first) : null,
      nextSec: bucketSec(eta?.second),
      arriveText: row.arriveText,
      arriveMs,
      totalMin: arriveMs == null ? null : Math.round((arriveMs - atMs) / 60_000),
    };
  });
}
