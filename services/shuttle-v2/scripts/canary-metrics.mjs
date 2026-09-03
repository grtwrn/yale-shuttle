/**
 * The measurement half of the rider canary — pure functions, no browser, no
 * network, so the arithmetic that decides "the app told a rider something
 * absurd" is unit-tested rather than eyeballed in a log.
 *
 * WHY THIS EXISTS. Every ETA measurement this project has made
 * (`eta-accuracy.mjs`, `eta-replay/`) scores a prediction against the truth in
 * AGGREGATE: median error, share within two minutes. None of them look at the
 * SEQUENCE one rider sees. The operator's complaint is entirely about the
 * sequence — "i'm not worried about a few seconds. i'm worried about saying a
 * bus is 10min away and then a few seconds later dropping to 1 second" — and a
 * run of predictions can be individually excellent and still read as broken if
 * it arrives in that order. Reports #64 ("4:06 ... then 3:55") and #32 ("6 min
 * then it said 16") are the same complaint from riders.
 *
 * THE ONE SUBTLETY: the app displays BUCKETS, not seconds. `fmtMin` renders
 * "now" (<10 s), "<1 min" (<60 s) and "N min" (floor), so a reading of "8 min"
 * only says the true value was somewhere in [480, 540). Comparing bucket
 * midpoints would manufacture jumps that never happened. Everything here works
 * on INTERVALS and reports the SMALLEST change consistent with the two
 * readings, so a reported jump is a jump the app provably made.
 */

/** Seconds; the display bucket a rendered token stands for, as [lo, hi). */
export function bucketOf(token) {
  if (token === "now") return [0, 10];
  if (token === "<1") return [10, 60];
  const n = Number(token);
  if (!Number.isFinite(n) || n < 0) return null;
  return [n * 60, n * 60 + 60];
}

/**
 * The "🚌 …" countdown line, as `fmtBusPair` renders it (web/src/format.ts):
 *
 *   "🚌 arriving now"        first <10 s, no second bus known
 *   "🚌 now, then 16 min"    first <10 s, second bus at 16 min
 *   "🚌 in 8, 16 min"        first 8 min, second 16 min
 *   "🚌 in <1, 16 min"       first <60 s, second 16 min
 *   "🚌 in 8 min"            first only
 *
 * Anything else beginning with 🚌 is one of the card's SENTENCES ("You can't
 * catch #40 …", "The bus is at your stop …") and returns null, so a warning is
 * never mistaken for a countdown.
 */
export function parseBusEtaText(line) {
  const t = String(line).replace(/^🚌\s*/u, "").trim();
  const mk = (a, b, raw) => {
    const first = bucketOf(a);
    const second = b == null ? null : bucketOf(b);
    return first ? { first, second, raw } : null;
  };
  if (t === "arriving now") return mk("now", null, t);
  let m = t.match(/^now, then (<1|\d+)\s*min$/);
  if (m) return mk("now", m[1], t);
  m = t.match(/^in (<1|\d+),\s*(<1|\d+)\s*min$/);
  if (m) return mk(m[1], m[2], t);
  m = t.match(/^in (<1|\d+)\s*min$/);
  if (m) return mk(m[1], null, t);
  return null;
}

/** "⏳ wait 7 min for #40" — shown INSTEAD of a countdown when no live bus pinned. */
export function parseWaitFallback(line) {
  const m = String(line).match(/^⏳\s*wait\s+(\d+)\s*min\s+for\s+(?:#(\S+)|next shuttle)$/);
  if (!m) return null;
  return { waitMin: Number(m[1]), busName: m[2] ?? null };
}

/**
 * How far the countdown moved beyond what the passage of time explains,
 * in seconds, using the SMALLEST movement the two bucket readings permit.
 *
 *   0   the reading is consistent with a healthy countdown ticking down
 *   >0  it provably went UP by that much more than it should have
 *   <0  it provably went DOWN by that much more than it should have
 *
 * A healthy tick loses exactly `dtSec`. Both readings are intervals, so the
 * true change lies in [nextLo - prevHi, nextHi - prevLo]; if -dtSec is inside
 * that range the observation explains itself and the drift is zero.
 */
export function conservativeDrift(prev, next, dtSec) {
  const cLo = next[0] - prev[1];
  const cHi = next[1] - prev[0];
  const expected = -dtSec;
  if (expected < cLo) return cLo + dtSec;
  if (expected > cHi) return cHi + dtSec;
  return 0;
}

/**
 * Thresholds. Set from what riders have actually complained about and from
 * what the display can even represent — not from taste. Override per run with
 * CANARY_CATASTROPHIC_SEC / CANARY_FIRST_SIGHT_MISS_SEC.
 */
export const THRESHOLDS = {
  /**
   * A drift of +15 s is the smallest a one-minute step UP can produce at a
   * 15 s sample (see the test). So any positive drift is a real reversal —
   * the countdown went backwards — and this is the bar for calling one
   * NOTABLE: a whole displayed minute gained on top of the elapsed time,
   * which is what report #64 and #32 describe.
   */
  notableReversalSec: 60,
  /**
   * THE headline, and deliberately NOT a number of my own: 180 s is the bound
   * `web/src/accuracy-layover.test.ts` already puts on a lurch between polls,
   * derived there from a recorded Red pass. The canary applies the same bar in
   * the field so a jump the gate would fail is a jump the log names.
   *
   * With ONE difference, which is the whole point of watching live: that test
   * skips the moment the bus is recorded leaving the stop, on the grounds that
   * "a real discontinuity exists in the data itself". True — and the rider
   * gets no such exemption. The first canary run caught 225 s at exactly that
   * moment (Red #304, 344 Winchester, 2026-09-03), inside the gate's blind
   * spot and past its bound. Direction-agnostic: 1 min -> 10 min strands a
   * rider as badly as 10 min -> now.
   */
  catastrophicSec: 180,
  /**
   * How wrong the FIRST prediction may be about the eventual arrival before
   * the run counts as a miss. The live harness measured median |error| 1.26
   * min with 71 % inside 2 min, so 5 min is far out in that distribution
   * while still being a number a rider would notice. Re-derive it from
   * `--summary` once ~50 runs have accumulated rather than defending it from
   * first principles.
   */
  firstSightMissSec: 300,
  /**
   * Re-read the pinned vehicle when a transition moves at least this much.
   * Deliberately BELOW catastrophicSec: the first live run produced a −225 s
   * drop ("in 7 min" → "in 2 min" in 15 s), which is under the failure bar and
   * is exactly the kind of event whose cause is worth capturing. Attribution
   * is cheap; a failure is a claim.
   */
  pinSampleSec: 120,
  /** A UI reading older than this is not comparable to the next one. */
  maxGapSec: 120,
};

/**
 * Split the page's innerText into option cards.
 *
 * The plan list has no test ids and every style is inline, so structure comes
 * from the text itself: a card starts at its duration ("23 min") or at
 * "Departed", and runs to the next such header. Within a card the route name
 * is the one chip that is not a walk/bus/hourglass line and not the arrival
 * clock — derived rather than matched against a hard-coded list of the 15
 * route labels, which would be a fourth copy of ROUTE_LISTS waiting to drift.
 */
const NOT_A_ROUTE = new Set(["Find next bus", "Clear", "Walk", "Departed"]);
export function parseOptions(bodyText) {
  const lines = String(bodyText).split("\n").map((l) => l.trim()).filter(Boolean);
  const isHeader = (l) => /^\d+\s*min$/.test(l) || l === "Departed";
  const cards = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isHeader(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end])) end++;
    const body = lines.slice(i + 1, end);
    // A real card either quotes an arrival clock or is a Departed card. This
    // is what keeps a stray "16 min" in the map overview out of the list.
    const arrive = body.find((l) => /^arrive\s+\d{1,2}:\d{2}[ap]$/i.test(l));
    if (!arrive && lines[i] !== "Departed") { i = end - 1; continue; }
    const busLine = body.find((l) => l.startsWith("🚌") && parseBusEtaText(l));
    const waitLine = body.find((l) => l.startsWith("⏳"));
    const missed = body.map((l) => l.match(/^🚌 You can't catch #(\S+)/)).find(Boolean);
    const walks = body.filter((l) => /^🚶\s*\d+\s*min$/.test(l))
      .map((l) => Number(l.match(/(\d+)/)[1]));
    const label = body.find((l) =>
      /^[A-Za-z][A-Za-z ]{0,19}$/.test(l) && !NOT_A_ROUTE.has(l) && !/^arrive/i.test(l));
    cards.push({
      routeLabel: body.includes("🚶 Walk") ? "Walk" : (label ?? null),
      mode: body.includes("🚶 Walk") ? "walk" : "shuttle",
      departed: lines[i] === "Departed",
      totalMin: lines[i] === "Departed" ? null : Number(lines[i].match(/(\d+)/)[1]),
      arriveText: arrive ? arrive.replace(/^arrive\s+/i, "") : null,
      eta: busLine ? parseBusEtaText(busLine) : null,
      waitFallback: waitLine ? parseWaitFallback(waitLine) : null,
      missedBus: missed ? missed[1] : null,
      walkToMin: walks[0] ?? 0,
      walkFromMin: walks[1] ?? 0,
    });
    i = end - 1;
  }
  return cards;
}

/**
 * Score one route's whole observed sequence. `samples` are
 * `{ atMs, eta, missedBus, departed, present }` in order.
 */
export function scoreSequence(samples, thresholds = THRESHOLDS) {
  const transitions = [];
  let prev = null;
  for (const s of samples) {
    if (!s.present || !s.eta) { prev = null; continue; }
    if (prev) {
      const dt = (s.atMs - prev.atMs) / 1000;
      if (dt > 0 && dt <= thresholds.maxGapSec) {
        const drift = conservativeDrift(prev.eta.first, s.eta.first, dt);
        if (drift !== 0) {
          transitions.push({
            atMs: s.atMs, dtSec: Math.round(dt), driftSec: Math.round(drift),
            from: prev.eta.raw, to: s.eta.raw,
            reversal: drift > 0,
            notable: drift >= thresholds.notableReversalSec,
            catastrophic: Math.abs(drift) >= thresholds.catastrophicSec,
            // The app's own announcement that it swapped vehicles. A jump with
            // this set is explained; one without it is not.
            pinAnnouncedChange: !!s.missedBus && s.missedBus !== prev.missedBus,
          });
        }
      }
    }
    prev = s;
  }
  const drifts = transitions.map((t) => t.driftSec);
  const abs = drifts.map(Math.abs).sort((a, b) => a - b);
  return {
    readings: samples.filter((s) => s.present && s.eta).length,
    transitions,
    reversals: transitions.filter((t) => t.reversal).length,
    notableReversals: transitions.filter((t) => t.notable).length,
    catastrophic: transitions.filter((t) => t.catastrophic).length,
    worstDriftSec: abs.length ? abs[abs.length - 1] : 0,
    p90AbsDriftSec: abs.length ? abs[Math.min(abs.length - 1, Math.floor(0.9 * abs.length))] : 0,
  };
}

/** Great-circle metres — the canary's ground truth never shares math with the app. */
export function haversineM(a, b) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The lines the canary rides, and the upstream route ids that carry them.
 *
 * ALL FIFTEEN, because on 2026-09-03 the operator retired the other standing
 * watch ("remove the cron. the canary agent can do it all") and this harness
 * inherited its whole job — that one rotated lines, so this one must too.
 * Order is the rotation order; Red and Blue Day lead it because they are the
 * pair the operator named.
 *
 * `web/src/routes.ts` is the single source of truth for this mapping and a
 * harness cannot import a .ts module, so this is a copy — and
 * `canary-metrics.test.mjs` parses ROUTE_LISTS out of that file and fails if
 * the two disagree, the same trick `walk.test.ts` uses to pin the client's
 * walk model to the server's.
 */
export const CANARY_LINES = [
  { label: "Red", busRouteIds: [3] },
  { label: "Blue Day", busRouteIds: [1] },
  { label: "Blue Weekend", busRouteIds: [4] },
  { label: "Blue Night", busRouteIds: [13] },
  { label: "Blue West", busRouteIds: [16] },
  { label: "Orange Day", busRouteIds: [2] },
  { label: "Orange Night", busRouteIds: [14] },
  { label: "Orange East", busRouteIds: [17] },
  { label: "Brown", busRouteIds: [19] },
  { label: "Pink", busRouteIds: [8] },
  { label: "Green", busRouteIds: [9] },
  { label: "Purple", busRouteIds: [10] },
  { label: "Gold", busRouteIds: [15] },
  { label: "Grocery TJ", busRouteIds: [6] },
  { label: "Grocery Ham", busRouteIds: [18] },
];

/**
 * The trip the operator named: "canner/prospect to public health building".
 * Both ends are coordinates rather than stop ids because the app plans from a
 * GPS fix and picks its own board stop — which is NOT always the nearest one
 * (Blue Day walks the rider 8 min down Whitney to skip eight stops), so the
 * canary reads the board stop back out of the app instead of assuming it.
 */
export const CANONICAL_TRIP = {
  origin: { label: "Prospect / Canner", lat: 41.325351, lon: -72.922891 },
  // The curated landmark, verbatim from src/server/landmarks.ts (OSM W239527110),
  // anchored on the LEPH / 60 College stop. class "yale" so the app auto-picks it.
  destination: {
    label: "School of Public Health (YSPH)",
    lat: 41.303735, lon: -72.932155, type: "college", class: "yale",
  },
};

/** Mirrors MAX_WALK_M in web/src/walk.ts — past it the planner offers no ride. */
export const MAX_WALK_M = 1500;
/**
 * How close a line must come to BOTH ends of the operator's trip before the
 * canary rides it on that trip rather than on one of its own.
 *
 * NOT MAX_WALK_M. 1500 m is the absolute limit past which no ride can be
 * planned at all, and at that radius fourteen of the fifteen lines "serve"
 * this trip — including Pink, whose nearest stop to the origin is 2.5 km away
 * once you measure it, and Blue Night at 1075 m, where the app is right to
 * bury the option and the canary would call that a missing line. 700 m is
 * ~8.5 min on the app's own walk model, which is exactly the walk the planner
 * itself chose for Blue Day's board stop on this trip — so it is a walk the
 * app demonstrably considers reasonable. Measured against live stop
 * coordinates on 2026-09-03; the split it produces is in the test.
 */
export const CANONICAL_MAX_WALK_M = 700;
/** Below this the planner would rightly answer "walk", so it is not a ride. */
export const MIN_RIDE_M = 500;

/** Every stop id on a line, in sequence, from the /api/buses `routes` map. */
export function stopsOfLine(payload, line) {
  return Object.entries(payload.routes ?? {})
    .filter(([rid]) => line.busRouteIds.includes(Number(rid)))
    .flatMap(([, s]) => s.map(Number));
}

/**
 * The trip this line gets ridden on.
 *
 * The operator's own trip whenever the line reaches BOTH ends of it — that is
 * Red and Blue Day, the pair they named, and any other line that qualifies.
 * Otherwise a trip derived from the line's own published stops, because a
 * rotation across fifteen lines cannot be fifteen hand-typed stop pairs
 * quietly rotting against upstream: `CLAUDE.md` is explicit that stop lists
 * come from TransLoc and are not hand-edited.
 *
 * Derived = board at the line's first stop, ride roughly a quarter of the loop
 * (short enough to stay well inside the planner's MAX_RIDE_SEC of 25 min,
 * long enough that walking does not dominate), stepping forward until the two
 * ends are at least MIN_RIDE_M apart. Returns null when the line has no usable
 * pair, which is a line the canary skips rather than fails.
 */
export function tripForLine(payload, line) {
  const stops = stopsOfLine(payload, line);
  const coord = (id) => payload.stop_coords?.[id] ?? null;
  const name = (id) => payload.stop_names?.[id] ?? `stop ${id}`;
  if (!stops.length) return null;
  const nearestTo = (pt) => stops.reduce((best, id) => {
    const c = coord(id);
    if (!c) return best;
    const d = haversineM(pt, c);
    return d < best ? d : best;
  }, Infinity);
  if (nearestTo(CANONICAL_TRIP.origin) <= CANONICAL_MAX_WALK_M &&
      nearestTo(CANONICAL_TRIP.destination) <= CANONICAL_MAX_WALK_M) {
    return { kind: "canonical", ...CANONICAL_TRIP };
  }
  const board = coord(stops[0]);
  if (!board) return null;
  for (let i = Math.max(1, Math.round(stops.length / 4)); i < stops.length; i++) {
    const c = coord(stops[i]);
    if (c && haversineM(board, c) >= MIN_RIDE_M) {
      return {
        kind: "derived",
        origin: { label: name(stops[0]), lat: board.lat, lon: board.lon },
        destination: {
          label: name(stops[i]), lat: c.lat, lon: c.lon,
          // A stop is auto-picked by the frontend on type "bus_stop", the same
          // as a curated landmark on class "yale".
          type: "bus_stop", class: "shuttle",
        },
      };
    }
  }
  return null;
}
