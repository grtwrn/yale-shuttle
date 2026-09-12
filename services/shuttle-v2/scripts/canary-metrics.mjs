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
 *
 * THE SECOND SUBTLETY, found 2026-09-04: a reading holds up to TWO buses, and
 * comparing them BY POSITION charges a change of cast to the leader. That is
 * the same correction `nextArrLive` took in the app (PR #74), and it is worth
 * 44 of the archive's 77 "catastrophic" jumps. `pairBuses` matches vehicles
 * across a transition as far as the text allows; `scoreSequence` then reports
 * three kinds — drift, dropped, appeared — because they are three defects.
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
 *
 * The standing-bus RANGE is parsed too, as an INTERVAL (`spread: true`):
 *
 *   "🚌 now-7 min"           [0 s, 480 s]
 *   "🚌 in 3-7 min"          [180 s, 480 s]
 *   "🚌 in <1-7, then 19 min" [10 s, 480 s], second bus 19 min
 *
 * It was deliberately UNPARSED until 2026-09-09, on the reasoning that a bus
 * mid-layover has no single number to score and that reading either END of the
 * range would see the switch into and out of it as a lurch of minutes. The
 * first half is true and the second is not: every reading in this file is
 * ALREADY an interval and `conservativeDrift` reports the smallest movement two
 * intervals permit, so a wide interval yields drift 0 rather than a false
 * lurch. Feeding it the true interval is strictly more information and cannot
 * manufacture a jump — while skipping the poll left the canary blind in exactly
 * the regime where the defects live. On the morning of 2026-09-09 it reported
 * three clean Red runs (first-sight miss 0 s / 18 s / 0 s) while the app was
 * billing ~4:45 at 344 Winchester against real stands of 9:16, 2:20 and 2:15
 * and the countdown was flapping between 1:57 and 3:09 poll to poll. None of
 * that is visible if the standing polls are dropped on the floor.
 *
 * `readings` therefore counts more polls than it did before 2026-09-09.
 * `spreadReadings` is how many of them are ranges, so any before/after over
 * `runs.jsonl` can be split at the boundary rather than compared across it.
 *
 * TWO BUSES THAT HAVE BUNCHED print ONE statement and name the cause
 * (`bunching.ts`, the Orange Night case of 2026-09-10):
 *
 *   "🚌 23-36 min · 2 buses"   interval [1380 s, 2220 s], `bunched: true`
 *   "🚌 25 min · 2 buses"      point bucket, `bunched: true`
 *
 * The head loses its "in" there — measured, that is what keeps the widest
 * form inside the span beside the widest route pill (bunching.ts).
 *
 * There is NO SECOND SLOT in that form — deliberately, since slot 2's number
 * was inside slot 1's own interval — so `second` is null and `pairBuses` sees
 * one vehicle where it saw two. That is the app telling the truth about what it
 * knows, not a bus dropping off the row, so the flag is recorded and
 * `scoreSequence` marks the drop it causes `event: "bunched"` — counted like
 * an arrival or a departure, and not a `bus-vanished` failure.
 */
export function parseBusEtaText(line) {
  let t = String(line).replace(/^🚌\s*/u, "").trim();
  // Strip the cause before matching, so every form above parses exactly as it
  // did — the suffix is a marker on the line, not a new grammar for it.
  let bunched = false;
  // `raw` stays the WHOLE line, suffix included: it is what the canary logs and
  // what `--summary` quotes, and a log that silently dropped half the reading
  // is how a layout change goes unnoticed for twelve minutes (#111).
  const full = t;
  const suffix = t.match(/\s*·\s*2 buses$/);
  if (suffix) {
    bunched = true;
    t = t.slice(0, suffix.index).trim();
    // The bunched head drops its "in" for width; put it back so the forms
    // below stay ONE grammar rather than eight regexes and then sixteen.
    if (/^(<1|\d)/.test(t)) t = `in ${t}`;
  }
  const mk = (a, b) => {
    const first = bucketOf(a);
    const second = b == null ? null : bucketOf(b);
    return first ? { first, second, raw: full, spread: false, bunched } : null;
  };
  // A range spans from the low bucket's floor to the high bucket's ceiling.
  const range = (lo, hi, b) => {
    const a = bucketOf(lo), z = bucketOf(hi);
    if (!a || !z || z[1] < a[0]) return null;
    return { first: [a[0], z[1]], second: b == null ? null : bucketOf(b), raw: full, spread: true, bunched };
  };
  // fmtBusBand (etaBand.ts, 2026-09-11): the MEDIAN with its band —
  // "in 5 (2-9) min", "in 5 (2-9), 17 min" (no "then": measured, it does not
  // fit beside the widest pills). The interval is the band's,
  // exactly as the range forms below read it; `median` is the bucket of the
  // number the rider plans on, kept beside it.
  const band = (mid, lo, hi, b) => {
    const r = range(lo, hi, b);
    return r ? { ...r, median: bucketOf(mid) } : null;
  };
  let m = t.match(/^in (\d+) \((now|<1|\d+)-(<1|\d+)\),\s*(?:then )?(<1|\d+)\s*min$/);
  if (m) return band(m[1], m[2], m[3], m[4]);
  m = t.match(/^in (\d+) \((now|<1|\d+)-(<1|\d+)\)\s*min$/);
  if (m) return band(m[1], m[2], m[3], null);
  if (t === "arriving now") return mk("now", null);
  m = t.match(/^now, then (<1|\d+)\s*min$/);
  if (m) return mk("now", m[1]);
  m = t.match(/^in (<1|\d+),\s*(<1|\d+)\s*min$/);
  if (m) return mk(m[1], m[2]);
  m = t.match(/^in (<1|\d+)\s*min$/);
  if (m) return mk(m[1], null);
  // fmtBusRange: "now-7 min", "in 3-7 min", each optionally ", then N min".
  m = t.match(/^now-(<1|\d+),\s*then (<1|\d+)\s*min$/);
  if (m) return range("now", m[1], m[2]);
  m = t.match(/^now-(<1|\d+)\s*min$/);
  if (m) return range("now", m[1], null);
  m = t.match(/^in (<1|\d+)-(<1|\d+),\s*then (<1|\d+)\s*min$/);
  if (m) return range(m[1], m[2], m[3]);
  m = t.match(/^in (<1|\d+)-(<1|\d+)\s*min$/);
  if (m) return range(m[1], m[2], null);
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
  // A countdown cannot go below zero, so the value it SHOULD show after dtSec
  // is max(0, prev - dtSec), not prev - dtSec. Without the clamp, a card
  // sitting on "arriving now" — the [0, 10) bucket — reads as a small reversal
  // on every tick, because the display is at its floor and cannot fall by the
  // fifteen seconds that passed. That produced +5 to +8 s "reversals" on a
  // Red bus standing at the stop on 2026-09-04, which are the floor, not a
  // defect, and they were inflating every reversal count reported so far.
  const lo = Math.max(0, prev[0] - dtSec);
  const hi = Math.max(0, prev[1] - dtSec);
  if (next[1] <= lo) return next[1] - lo;   // provably fell further than possible
  if (next[0] >= hi) return next[0] - hi;   // provably rose
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


  /**
   * FLAPPING: the countdown oscillating between two states rather than
   * counting down. Added 2026-09-09, when the operator watched Red's board
   * read 4:36, 1:57, 3:09, 3:09, 1:57, 2:46 over ninety seconds — two states
   * about 72 s apart, visited alternately. Every consecutive pair there is
   * under `catastrophicSec`, so the jump metric sees nothing; the defect is
   * only visible in the SHAPE of the run.
   *
   * A flap is a maximal run of unexplained drifts whose signs alternate:
   * at least `flapMinMoves` of them, each at least `flapMinSec`, inside
   * `flapWindowSec`. The floor is deliberately below `notableReversalSec` —
   * a rider cannot tell whether to run when the number moves 45 s each way,
   * however small each move is on its own.
   */
  flapMinSec: 45,
  flapMinMoves: 3,
  flapWindowSec: 240,
  /**
   * The widest |drift| still read as ONE vehicle's countdown moving, rather
   * than as one bus leaving the list while another joins it. See
   * `pairBuses` for why a window is needed at all; this is where it is set.
   *
   * Bounded from BELOW by the two jumps this project already calls a single
   * bus lurching — report #32's "6 min then it said 16" (555 s at a 15 s
   * sample) and the operator's "10 min then a few seconds later 1 second"
   * (525 s). A window under those would rename the headline defect as a
   * vehicle swap and stop counting it.
   *
   * 600 s is the smallest round value above both, and that is the ONLY claim
   * made for it. THERE IS NO VALLEY IN THE DATA TO SNAP TO: across the 57
   * archived runs 95.5 % of buses pair inside 60 s and the rest trail off
   * smoothly, and the split moves steadily with the window rather than sitting
   * on a plateau — 300 s / 600 s / 1200 s / 2400 s give 22 / 62 / 93 / 124
   * catastrophic drifts against 113 / 73 / 44 / 22 drops. So the number is a
   * judgement, and the direction it errs in is deliberate: raising it buys
   * drift back by calling vanishings lurches, which is the misreading this
   * whole change exists to stop. Re-derive it from the archive rather than
   * from taste if it ever needs to move.
   */
  pairWindowSec: 600,
  /**
   * A bus that disappears while this close is the one the rider had got up
   * for. Two minutes is the point past which the app's own copy stops
   * counting single minutes worth acting on, and it is the bar the operator
   * named for the severe case.
   */
  droppedSevereSec: 120,
};

/**
 * Pair the buses in two consecutive readings BY VEHICLE, as far as the text
 * allows — which is not very far, and saying so is the point.
 *
 * WHAT IDENTITY IS ACTUALLY AVAILABLE, which is not much and differs by
 * caller. Slot 0 is always the PINNED vehicle — `fmtBusPair(busEtaLive,
 * nextArrLive?.eta)` — and slot 1 is whatever `nextArrivalAfterPinned` found
 * behind it. So naming the pinned bus settles slot 0 completely:
 *
 *   - The rider simulator (`scripts/eta-replay/rider-sim/`) knows it on every
 *     tick and passes it as `busName`. Slot 0 is then paired by IDENTITY —
 *     the same vehicle re-priced a whole lap later is a drift of a lap, not a
 *     bus that left, and no window may override that.
 *   - The live canary does NOT. The countdown line is two ETAs and no names;
 *     the card names a bus only in the details view, which costs a tap in and
 *     out and is sampled a few times a run (`pins`), and in the "You can't
 *     catch #40" warning. The raw feed in each sample (`buses`) knows the
 *     vehicles but not which of them the card chose.
 *
 * With no name, this falls back to NEAREST ETA under a bounded window, and
 * everything downstream is written to be true of that weaker claim rather than
 * of an identity we do not have.
 *
 * WHY IT MATTERS, and what the archive actually says. The old metric compared
 * the two readings POSITIONALLY — slot 0 against slot 0 — so any change in
 * WHICH buses the list holds was billed to the leader as drift. Re-scoring the
 * 57 archived runs, 44 of the 77 "catastrophic" jumps are not one bus moving
 * at all.
 *
 * The mechanism is NOT the obvious one, and the obvious one was the first
 * guess. Two buses swapping order in a sorted list is vanishingly rare: 2 of
 * 2104 two-bus readings are printed out of ETA order, and only 1 of the 77
 * flags is that case ("in 45, 5 min" -> "in 6, 44 min", -2265 s, where both
 * buses had in fact moved about a second). What actually happens is
 * SUBSTITUTION: the leader disappears and everything behind it shifts up a
 * slot, so slot 0 is compared against a different vehicle. 22 of the 77 are
 * exactly that ("in 2, 38 min" -> "in 17, 38 min" — the 38-min bus is
 * untouched, the 2-min bus is gone, a 17-min bus is new), and another 14 are
 * variations on it. Positional comparison was the bug; reordering was not
 * the reason.
 *
 * Both readings hold at most two buses, so every injective partial matching is
 * enumerated (seven of them) rather than reaching for an assignment algorithm.
 * The winner has the most pairs, and among those the least total |drift|; a
 * pairing whose implied drift exceeds `pairWindowSec` is not offered at all,
 * which is what lets a bus genuinely leave the list instead of being forced to
 * "become" the one that replaced it.
 *
 * Returns `{ matched, dropped, appeared }` in terms of the buckets passed in.
 */
export function pairBuses(prev, next, dtSec, thresholds = THRESHOLDS, pin = null) {
  const P = [prev.first, prev.second].filter(Boolean);
  const N = [next.first, next.second].filter(Boolean);
  // What the pinned vehicle's name settles, when a caller knows it. Slot 0 is
  // the pinned bus in both readings, so the same name FORCES that pair (the
  // window does not get a vote — identity is stronger evidence than an ETA
  // being nearby) and a different name FORBIDS it.
  const norm = (s) => (s == null ? null : String(s).replace(/^#/, ""));
  const from = norm(pin?.from), to = norm(pin?.to);
  const known = from !== null && to !== null;
  const forced = known && from === to;
  const forbidden = known && from !== to;
  const cand = [];
  for (let i = 0; i < P.length; i++) {
    for (let j = 0; j < N.length; j++) {
      const slot0 = i === 0 && j === 0;
      if (forbidden && slot0) continue;
      // A forced pin also rules out slot 0 pairing with anything ELSE: that
      // vehicle is where the pin says it is.
      if (forced && (i === 0) !== (j === 0)) continue;
      const drift = conservativeDrift(P[i], N[j], dtSec);
      if (Math.abs(drift) > thresholds.pairWindowSec && !(forced && slot0)) continue;
      cand.push({ i, j, drift });
    }
  }
  let best = { pairs: [], cost: 0 };
  const consider = (pairs) => {
    const cost = pairs.reduce((a, p) => a + Math.abs(p.drift), 0);
    if (pairs.length > best.pairs.length ||
        (pairs.length === best.pairs.length && cost < best.cost)) best = { pairs, cost };
  };
  for (const a of cand) {
    consider([a]);
    for (const b of cand) if (b.i > a.i && b.j !== a.j) consider([a, b]);
  }
  const tookP = new Set(best.pairs.map((p) => p.i));
  const tookN = new Set(best.pairs.map((p) => p.j));
  // "The leader" is the EARLIEST bus, not the first one printed: the app can
  // print them out of order ("in 45, 5 min" is a real reading), because the
  // pinned bus's countdown and the bus-after-it come from two different
  // computations.
  const leaderOf = (list) => list.reduce((b, x, i) => (x[0] < list[b][0] ? i : b), 0);
  return {
    matched: best.pairs.map((p) => ({
      fromBucket: P[p.i], toBucket: N[p.j], fromSlot: p.i, toSlot: p.j, driftSec: p.drift,
      leader: N.length ? p.j === leaderOf(N) : false,
    })),
    dropped: P.map((b, i) => ({ bucket: b, slot: i }))
      .filter((x) => !tookP.has(x.slot))
      .map((x) => ({ ...x, leader: x.slot === leaderOf(P) })),
    // A bus joining BEHIND the survivors is the routine second-slot fill —
    // `nextArrivalAfterPinned` finding a later bus it did not know about a
    // tick ago — so only a newcomer that takes over the head of the list is
    // an event. That is the operator's "a bus enters the list ahead of the
    // leader".
    appeared: N.map((b, j) => ({ bucket: b, slot: j }))
      .filter((x) => !tookN.has(x.slot) && x.slot === leaderOf(N)),
  };
}

/**
 * Split the page's innerText into option cards.
 *
 * The plan list has no test ids and every style is inline, so structure comes
 * from the text itself: a card is anchored on its duration ("23 min") or on
 * "Departed". Within a card the route name is the one chip that is not a
 * walk/bus/hourglass line and not the arrival clock — derived rather than
 * matched against a hard-coded list of the 15 route labels, which would be a
 * fourth copy of ROUTE_LISTS waiting to drift.
 *
 * A card's own lines can sit on EITHER side of that anchor. Since 2026-09-04
 * the route pill leads the card (top-left) with the "🚌 in …" countdown beside
 * it, so both precede the duration; before that they followed it. Both orders
 * parse, deliberately — the canary watches production, which is a deploy
 * behind whatever branch introduces a layout change, and a parser that only
 * knows the new shape reports every card as label-less on the old one.
 */
// "nearby" is the expanded card's marker for a bus holding just short of a
// stop (report #102). It is lower-case and letters-only, so `isLabelish` takes
// it for a route pill — and because `label` prefers a match found BELOW the
// duration, an expanded card would have reported its line as "nearby" rather
// than "Red". Exactly the "Contribute" failure IS_PAGE_CHROME was added for;
// caught here before it shipped rather than after, and fixtured below.
//
// "published stop" and "expected stop" are the berth inset's two map labels
// (2026-09-10): the expanded card now carries a small picture of where the bus
// actually pulls up, and SVG <text> lands in `innerText` like any other text.
// Both are lower-case, letters-and-space only, and sit BELOW the duration —
// i.e. exactly the shape and exactly the place that made "nearby" outrank the
// route pill. The same guard, added with the feature rather than after it.
const NOT_A_ROUTE = new Set([
  "Find next bus", "Clear", "Walk", "Departed", "nearby",
  "published stop", "expected stop",
]);
/**
 * WHERE THE EXPANDED CARD'S STOP LIST BEGINS (2026-09-11).
 *
 * A route pill never appears below this line. 172 upstream stop names do, and a
 * name with no "/" in it is exactly as label-shaped as a route: on the
 * operator's own Prospect / Canner -> School of Public Health capture the
 * parser read the line as "SCL", with "Phelps Gate" next in the queue. Every
 * earlier expanded-card fixture happened to ride between slash-y names
 * ("Winchester / Division"), which is why it went unseen for as long as the
 * expanded view has existed.
 *
 * Same family as "Contribute", "nearby" and the berth inset's map labels — and
 * the reason `NOT_A_ROUTE` cannot be the whole answer here: the stop names come
 * from upstream, so the set is neither fixed nor ours. `IS_PAGE_CHROME` already
 * cuts the footer off the last card for the identical reason; this cuts the
 * stop list off an expanded one.
 *
 * The cut may NOT be "the first few lines of the body": measured against the
 * pre-2026-09-04 capture this file still carries, the pill sat SIX lines into
 * the body (countdown, arrival clock, chevron, walk leg, chevron, pill), and
 * bounding the search picked the overview legend above the card instead — the
 * very mistake the preference for a pill-below exists to avoid.
 */
const IS_STOP_LIST = /^(?:🚌 #\S+ · \d+ stops? away$|⏸ |BOARD|GET OFF)/u;
/** Page furniture below the option list — where the last card stops. */
const IS_PAGE_CHROME = /^(Show \d+ more route|Clear$|Contribute$|💬|🧪|Not affiliated)/;
const isLabelish = (l) =>
  /^[A-Za-z][A-Za-z ]{0,19}$/.test(l) && !NOT_A_ROUTE.has(l) && !/^arrive/i.test(l);
/**
 * The card's arrival clock, in EITHER spelling. The word was dropped on
 * 2026-09-04 — sitting under the duration in a right-aligned column, the
 * number says what it is — but the `arrive …` form is still accepted, because
 * this harness watches PRODUCTION, which is always a deploy behind the branch
 * that changes the layout. Requiring the new spelling alone is precisely the
 * mistake #111 made and #113 fixed, twelve blind minutes later.
 *
 * The bare form is anchored at both ends, which is what keeps it off the map
 * overview's own clock lines: those read "(B) 10:33a" / "🏁 (B) 10:33a" after
 * trimming, so they carry a prefix and cannot match. The page header's
 * "11:22 AM" cannot either — space, and upper case. Verified against captured
 * innerText in the tests, not reasoned about.
 */
/**
 * The card's arrival clock, in all THREE spellings: "arrive 5:13p" until
 * 2026-09-04, a bare "10:33a" after (#123 dropped the word), and "by 2:23p"
 * from 2026-09-12, when the column stopped printing the median instant and
 * started promising the band's upper end instead (etaBand.ts `arriveByClock`;
 * the operator: "just put latest time?"). All three are kept rather than
 * swapped, for the reason below: production is always a deploy behind the
 * branch that changes the layout, and a card printing any of the three is
 * still a card. Note the app prints "by" only where it HAS an alight forecast
 * wide enough to promise against, so the bare form goes on appearing beside
 * it on the same page — this is not a migration, it is a third form.
 *
 * EXPORTED because there are TWO readers of this text and they live in
 * different files. `parseOptions` below is one; `openCard` in
 * rider-canary.mjs — which finds the collapsed row to tap for the pinned
 * vehicle and the board stop — is the other, and it was missed when #123
 * taught this one both spellings. The canary then ran for 25 minutes with no
 * board stop at all: every `distM` null, `pins` empty, and `no-arrival` filed
 * against an app it had no ground truth to judge. That is the SECOND time a
 * layout change blinded a reader that "needed no change" (#111 was the
 * first), so the pattern is exported rather than copied, and the anchored
 * per-line test comes with it.
 */
export const ARRIVAL_CLOCK_RE = /^(?:arrive\s+|by\s+)?\d{1,2}:\d{2}[ap]$/i;
/** Does this block of innerText contain an arrival clock on a line of its own? */
export function hasArrivalClock(text) {
  return String(text ?? "").split("\n").some((l) => ARRIVAL_CLOCK_RE.test(l.trim()));
}
const IS_ARRIVAL_CLOCK = ARRIVAL_CLOCK_RE;
export function parseOptions(bodyText) {
  const lines = String(bodyText).split("\n").map((l) => l.trim()).filter(Boolean);
  const isHeader = (l) => /^\d+\s*min$/.test(l) || l === "Departed";
  const headers = lines.map((l, i) => (isHeader(l) ? i : -1)).filter((i) => i >= 0);
  // Where the card anchored at `h` begins: at most one countdown line and one
  // route pill above it. Anything further up belongs to the map overview or to
  // the card before, so the walk-back is deliberately short.
  const startOf = (h) => {
    let start = h;
    // Either form of the countdown line: the glyph-prefixed one production may
    // still be serving, or the bare one shipped 2026-09-04. Parsing it is the
    // stricter test, so both are accepted rather than swapping one for the other.
    if (h > 0 && !isHeader(lines[h - 1])
        && (lines[h - 1].startsWith("🚌") || parseBusEtaText(lines[h - 1]) !== null)) start = h - 1;
    const p = start - 1;
    if (p >= 0 && !isHeader(lines[p]) && (isLabelish(lines[p]) || lines[p] === "🚶 Walk")) start = p;
    return start;
  };
  const cards = [];
  for (let k = 0; k < headers.length; k++) {
    const h = headers[k];
    const start = Math.max(startOf(h), k > 0 ? headers[k - 1] + 1 : 0);
    const nextStart = k + 1 < headers.length
      ? Math.max(h + 1, startOf(headers[k + 1]))
      : lines.length;
    const pre = lines.slice(start, h);
    // The list ends where the page's own chrome begins. Without this cut the
    // LAST card swallowed the footer, and "Contribute" — a perfectly
    // label-shaped word — became its route name once the pill moved above the
    // duration and stopped being the first label below it.
    const postAll = lines.slice(h + 1, nextStart);
    const chromeAt = postAll.findIndex((l) => IS_PAGE_CHROME.test(l));
    const post = chromeAt >= 0 ? postAll.slice(0, chromeAt) : postAll;
    // Where a route pill may still be looked for: everything above the expanded
    // card's stop list. `body` keeps the whole card — the legs, the ride bar and
    // the stop list are all evidence, and only the LABEL search is narrowed.
    const stopListAt = post.findIndex((l) => IS_STOP_LIST.test(l));
    const postPill = stopListAt >= 0 ? post.slice(0, stopListAt) : post;
    const body = [...pre, ...post];
    // A real card either quotes an arrival clock or is a Departed card. This
    // is what keeps a stray "16 min" in the map overview out of the list.
    const arrive = body.find((l) => IS_ARRIVAL_CLOCK.test(l));
    if (!arrive && lines[h] !== "Departed") continue;
    // The countdown is whatever line parses as one. It carried a 🚌 until
    // 2026-09-04, when the glyph was dropped so "in" could follow the route
    // pill directly; requiring the glyph here left the canary reading zero
    // countdowns for the twelve minutes after that shipped, while `startOf`
    // above had already been taught both forms. parseBusEtaText is the only
    // arbiter, so there is one place to teach and it cannot half-learn again.
    // It cannot collide with the ride bar ("🚌 12 min"), which has no "in".
    const busLine = body.find((l) => parseBusEtaText(l) !== null);
    // Every 🚌 line in the card, parsed or not. The countdown is whichever one
    // `parseBusEtaText` accepts; this is the RECORD of what was on screen when
    // it accepts none. Without it a parser that has not learned a new wording
    // leaves no evidence at all: 770 present-but-unparsed samples in the
    // archive to 2026-09-09 have no text against them, so the standing-range
    // gap could not be back-tested even after the parser learned the form.
    const busLines = body.filter((l) => l.startsWith("🚌"));
    const waitLine = body.find((l) => l.startsWith("⏳"));
    const missed = body.map((l) => l.match(/^🚌 You can't catch #(\S+)/)).find(Boolean);
    const walks = body.filter((l) => /^🚶\s*\d+\s*min$/.test(l))
      .map((l) => Number(l.match(/(\d+)/)[1]));
    // The pill below the duration (old layout) wins over anything walked back
    // above it, so an overview legend sitting right above the first card
    // cannot be mistaken for that card's line.
    //
    // BUT NOT INSIDE THE EXPANDED CARD'S STOP LIST (2026-09-11) — see
    // IS_STOP_LIST. Unbounded, that search read the line as "SCL".
    const label = postPill.find(isLabelish) ?? pre.find(isLabelish) ?? null;
    cards.push({
      busLines,
      routeLabel: body.includes("🚶 Walk") ? "Walk" : label,
      mode: body.includes("🚶 Walk") ? "walk" : "shuttle",
      departed: lines[h] === "Departed",
      totalMin: lines[h] === "Departed" ? null : Number(lines[h].match(/(\d+)/)[1]),
      arriveText: arrive ? arrive.replace(/^(?:arrive|by)\s+/i, "") : null,  // all three spellings collapse to the clock
      eta: busLine ? parseBusEtaText(busLine) : null,
      waitFallback: waitLine ? parseWaitFallback(waitLine) : null,
      missedBus: missed ? missed[1] : null,
      walkToMin: walks[0] ?? 0,
      walkFromMin: walks[1] ?? 0,
    });
  }
  return cards;
}

/**
 * Score one route's whole observed sequence. `samples` are
 * `{ atMs, eta, missedBus, departed, present }` in order.
 *
 * THREE KINDS, because they are three different defects and counting them as
 * one hid that:
 *
 *   drift     the SAME bus's countdown moved further than the clock explains.
 *             The only kind `driftSec` / `reversal` / `notable` /
 *             `catastrophic` apply to, and the only one in `transitions` —
 *             which keeps its old shape so the 57 archived runs, the
 *             `--summary` reader and the eta-jump failure all still read.
 *   dropped   a bus that was in the list is not in the next reading. Carries
 *             the ETA it was last shown at; `severe` when that was inside
 *             `droppedSevereSec`, i.e. the bus the rider had got up for.
 *   appeared  a bus takes over the head of the list without having been in the
 *             reading before.
 *
 * `events` is all three in time order; `transitions`, `drops` and `appearances`
 * are the same events split by kind.
 */
export function scoreSequence(samples, thresholds = THRESHOLDS, { pins = null, boardStopId = null } = {}) {
  const transitions = [], drops = [], appearances = [], events = [];
  let prev = null;
  for (let idx = 0; idx < samples.length; idx++) {
    const s = samples[idx];
    if (!s.present || !s.eta) { prev = null; continue; }
    if (prev) {
      const dt = (s.atMs - prev.atMs) / 1000;
      if (dt > 0 && dt <= thresholds.maxGapSec) {
        const dtSec = Math.round(dt);
        // The app's own announcement that it swapped vehicles. A jump with
        // this set is explained; one without it is not.
        const announced = !!s.missedBus && s.missedBus !== prev.missedBus;
        // Did the bus at the stop leave between these two readings? A flag
        // with a departure behind it is the app being honest, and 92.4 % of
        // catastrophic drops have one — so every event carries the verdict
        // and the counters below split on it. Readings with no `buses` list
        // (the rider simulator's) answer "unknown" and nothing changes.
        // A bus reaching the board stop explains a drop as surely as one
        // leaving it does — see `reachedBoardStop`. Checked on this frame and
        // the one before, because the scrape and the feed poll are a tick apart.
        const arrived = reachedBoardStop(s.buses, boardStopId)
          || reachedBoardStop(prev.buses, boardStopId);
        const event = departureBetween(prev.buses, s.buses);
        const ctx = {
          atMs: s.atMs, dtSec, from: prev.eta.raw, to: s.eta.raw,
          event, eventful: event === "departure",
          liveBuses: Array.isArray(s.buses) ? s.buses.length : null,
        };
        // The pinned vehicle leaving a stand ANYWHERE on the loop — the event
        // `departureBetween` is blind to, and the one the ring-posterior model
        // prices. Looked for on this frame and its neighbours: the canary
        // scrapes the DOM once per 15 s tick and attaches its own most recent
        // feed poll, so the two clocks are a poll apart either way.
        const pinned = pins ? pinnedVehicleAt(pins, s.atMs) : null;
        const standEnd = pinned != null && [idx - 1, idx, idx + 1]
          .some((w) => standEndedFor(samples, w, pinned));
        // `busName` is the PINNED vehicle, i.e. the one in slot 0. Callers that
        // know it (the rider simulator) get identity pairing there; the live
        // canary passes nothing and gets the nearest-ETA fallback.
        const paired = pairBuses(prev.eta, s.eta, dt, thresholds,
          { from: prev.busName ?? null, to: s.busName ?? null });
        for (const m of paired.matched) {
          if (m.driftSec === 0) continue;
          const drift = Math.round(m.driftSec);
          // DROPS ONLY, LEADER ONLY. Both halves are measured, not taste.
          //
          // Drops only: a stand ENDING can only make a bus sooner. Against the
          // 12 catastrophic leader jumps in the archive whose pinned bus was
          // later seen to arrive, drops-only credits 6 and every one of the 6
          // moved the number TOWARDS the observed arrival, while all four that
          // moved it away stayed flagged. Crediting rises too (a stand
          // beginning) pulled one of those four in.
          //
          // Leader only: `pinnedVehicleAt` names the vehicle in slot 0 and
          // nothing names the one in slot 1, and the app does not print it.
          // Crediting the second slot because SOME other bus left a stand was
          // tried and the archive refused it — a non-pinned stand end sits
          // under 32 % of catastrophic secondary drops against 45 % of
          // ordinary ones, i.e. it is likelier where nothing went wrong. The
          // only secondary credit that survives is `creditCardReprice`, which
          // is the same event seen twice rather than a second bus.
          const departed = standEnd && drift < 0 && m.leader;
          const t = {
            kind: "drift", ...ctx,
            event: departed && ctx.event !== "departure" ? "stand-end" : ctx.event,
            eventful: ctx.eventful || departed,
            pinnedBus: pinned,
            driftSec: drift,
            reversal: drift > 0,
            notable: drift >= thresholds.notableReversalSec,
            catastrophic: Math.abs(drift) >= thresholds.catastrophicSec,
            pinAnnouncedChange: announced,
            // Which bus inside the reading moved, now that a reading can hold
            // two and report a drift for each. `fromSlot === 0` is the pinned
            // vehicle, which is what lets a caller with names attribute it.
            leader: m.leader, fromSlot: m.fromSlot, toSlot: m.toSlot,
            fromEtaSec: m.fromBucket[0], toEtaSec: m.toBucket[0],
          };
          transitions.push(t); events.push(t);
        }
        // THE APP FOLDING TWO BUNCHED BUSES INTO ONE STATEMENT IS NOT A BUS
        // VANISHING. When the line reads "in 23-36 min · 2 buses" the second
        // slot is gone from the TEXT because its number was inside the first's
        // interval (bunching.ts, the Orange Night case of 2026-09-10) — the
        // bus is still on the row, named by the suffix. Pairing sees one
        // vehicle where it saw two and would report a `dropped`; without this
        // the canary would file `bus-vanished` against the app being honest,
        // which is the same mistake as reading a real departure as a defect.
        // Counted, like an arrival or a departure, and not a failure.
        const bunched = !!s.eta.bunched && !prev.eta.bunched;
        for (const d of paired.dropped) {
          const e = {
            kind: "dropped", ...ctx,
            event: bunched && ctx.event !== "departure" ? "bunched"
              : arrived && ctx.event !== "departure" ? "arrival" : ctx.event,
            eventful: ctx.eventful || arrived || bunched,
            lastShownEtaSec: d.bucket[0], leader: d.leader,
            severe: d.bucket[0] <= thresholds.droppedSevereSec,
            pinAnnouncedChange: announced,
          };
          drops.push(e); events.push(e);
        }
        for (const a of paired.appeared) {
          const e = {
            kind: "appeared", ...ctx,
            etaSec: a.bucket[0], aheadOfLeader: true, pinAnnouncedChange: announced,
          };
          appearances.push(e); events.push(e);
        }
      }
    }
    prev = s;
  }
  creditCardReprice(transitions);
  const flaps = scoreFlaps(transitions, thresholds);
  for (const f of flaps) events.push(f);
  events.sort((a, b) => a.atMs - b.atMs);
  const abs = transitions.map((t) => Math.abs(t.driftSec)).sort((a, b) => a - b);
  return {
    readings: samples.filter((s) => s.present && s.eta).length,
    // How many of those readings were a standing bus's RANGE. Before
    // 2026-09-09 the range was unparsed and those polls were dropped, so a
    // before/after over `runs.jsonl` must split on this rather than compare
    // `readings` across the boundary.
    spreadReadings: samples.filter((s) => s.present && s.eta?.spread).length,
    flaps,
    flapping: flaps.length,
    transitions,
    reversals: transitions.filter((t) => t.reversal).length,
    notableReversals: transitions.filter((t) => t.notable).length,
    catastrophic: transitions.filter((t) => t.catastrophic).length,
    worstDriftSec: abs.length ? abs[abs.length - 1] : 0,
    p90AbsDriftSec: abs.length ? abs[Math.min(abs.length - 1, Math.floor(0.9 * abs.length))] : 0,
    // Added 2026-09-04 alongside identity pairing. Older records simply lack
    // these; every reader treats a missing count as zero rather than assuming
    // the field is there.
    events,
    drops,
    appearances,
    dropped: drops.length,
    droppedSevere: drops.filter((d) => d.severe).length,
    appeared: appearances.length,
    // Pairing scores BOTH buses a reading shows, where the positional metric
    // only ever scored slot 0, so the drift population is not the same one as
    // before. These two make the comparison honest: `leaderCatastrophic` is
    // the like-for-like number (77 -> 33 across the archive), while
    // `secondaryCatastrophic` counts the bus-after-the-pinned-one lurching —
    // real, visible to riders, and simply never measured until now.
    leaderCatastrophic: transitions.filter((t) => t.catastrophic && t.leader).length,
    secondaryCatastrophic: transitions.filter((t) => t.catastrophic && !t.leader).length,
    // The third axis, and the one that decides whether a run passes: a jump
    // or a vanishing with a DEPARTURE behind it is the app telling the truth
    // about a bus that left. Both totals are reported, because "we flagged 62
    // and 6 of them were real" is the honest sentence.
    catastrophicEventful: transitions.filter((t) => t.catastrophic && t.eventful).length,
    catastrophicEventless: transitions.filter((t) => t.catastrophic && !t.eventful).length,
    droppedSevereEventful: drops.filter((d) => d.severe && d.eventful).length,
    droppedSevereEventless: drops.filter((d) => d.severe && !d.eventful).length,
  };
}

/**
 * Two drifts this close at one poll are the card moving as a unit, not two
 * buses lurching independently. 120 s, because the interval arithmetic that
 * produces `driftSec` reads the same shift differently in the two slots: the
 * Gold pair below is -348 s and -228 s for one "in 8, 42 min" -> "in 1, 37 min".
 */
export const CARD_REPRICE_TOL_SEC = 120;

/**
 * One card-wide re-price is ONE event, and the second number is not a second
 * finding.
 *
 * Pairing scores both buses a reading holds, so when the whole card moves it
 * produces a drift in each slot and the canary files two `eta-jump`s with
 * IDENTICAL text. Three of the sixteen filed in the 24 h to 2026-09-08 are
 * that, and on Gold both were the same vehicle: the line had one bus, so the
 * second number is #310's NEXT LAP — arithmetically the first plus the loop
 * time, and it cannot fail to move when the first does.
 *
 * So a secondary drift at the same poll as a CREDITED leader drift inherits
 * the credit, when it is the same direction and either the line had a single
 * bus or the two moved by the same amount. It never invents a credit: with the
 * leader still flagged, both stay flagged and `unexplainedJumps` reports the
 * duplicate once.
 */
export function creditCardReprice(transitions) {
  const leaders = transitions.filter((t) => t.leader && t.eventful);
  for (const t of transitions) {
    if (t.leader || t.eventful) continue;
    const lead = leaders.find((l) => l.atMs === t.atMs && Math.sign(l.driftSec) === Math.sign(t.driftSec));
    if (!lead) continue;
    const oneBus = t.liveBuses === 1;
    if (!oneBus && Math.abs(lead.driftSec - t.driftSec) > CARD_REPRICE_TOL_SEC) continue;
    t.event = oneBus ? "next-lap" : "card-reprice";
    t.eventful = true;
  }
  return transitions;
}

/**
 * The jumps worth putting in front of a human: catastrophic, unexplained, and
 * counted once.
 *
 * The de-duplication is the same card-wide re-price as above seen from the
 * other side — when the leader is NOT credited, both slots still fire with the
 * same text, and "the bus it is counting down" and "the bus after the pinned
 * one" saying the identical sentence twice is how a finding list teaches its
 * reader to skim.
 */
export function unexplainedJumps(sequence) {
  const out = [];
  for (const t of (sequence?.transitions ?? []).filter((x) => x.catastrophic && !x.eventful)) {
    if (out.some((u) => u.atMs === t.atMs && u.from === t.from && u.to === t.to)) continue;
    out.push(t);
  }
  return out;
}

/** `#40` and `40` are the same vehicle; the feed and the DOM disagree on the hash. */
const norm = (s) => String(s ?? "").replace(/^#/, "");

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
  // anchored on the LEPH / 60 College stop. class "yale" so the app auto-picks
  // it. Every destination is written in the geocoder's OWN response shape,
  // `display_name` and all, because the canary serves it to the app verbatim —
  // and an object missing that field crashes the suggestion list outright
  // (`Cannot read properties of undefined (reading 'split')`, caught live on
  // 2026-09-03 the first time this was passed through as `label`).
  destination: {
    display_name: "School of Public Health (YSPH)",
    lat: 41.303735, lon: -72.932155, type: "college", class: "yale",
  },
};

/**
 * How close a bus must come to the board stop to count as having reached it.
 *
 * RAISED FROM 45 m ON 2026-09-04, from the log rather than from taste. The
 * 11:03 ET run filed `no-arrival` — "watched 8.3 min; no Red bus reached the
 * board stop" — while #304 sat **49 m away with the feed's own `at_stop_id`
 * naming that very stop**. Four metres, on a feed whose fixes carry a ~30 m
 * deadband (see CLAUDE.md) and which repeats a position rather than
 * interpolating half the time.
 *
 * The 45 m bound was truncating its own distribution: across 52 archived runs
 * the 32 detected arrivals land at 12..44 m, with four of them in [40, 45) and
 * nothing above — the shape of a bound cutting a tail, not of a tail ending.
 *
 * 60 m is where the feed's OWN reckoning stops agreeing. Counting every
 * sighting by distance band, at_stop against not-at-stop: [0,30) 42:1,
 * [30,45) 24:2, [45,60) 5:2, [60,80) 6:7, [80,100) 0:10. So up to 60 m a bus
 * near this stop is usually one the operator calls stopped, and past 80 m it
 * never is. 60 m takes the last band that still agrees better than 2:1 and
 * leaves the coin-flip band out.
 *
 * DELIBERATELY NOT SHARED with `eta-accuracy.mjs`, which keeps its own 45 m:
 * its published measurements were taken at that bound and moving it would
 * silently re-base them. This is the canary's number, and the canary is the
 * one that cries wolf.
 */
export const ARRIVAL_M = 60;
/**
 * Past this a bus is no longer at the stop — the radius `rider-canary.mjs`
 * already used to re-arm its arrival flag, reused so a bus cannot "leave" a
 * stop it was never at.
 */
export const NEAR_STOP_M = 120;
/**
 * How far a bus must recede to have provably pulled away. The feed only sends
 * a new coordinate once the bus has moved ~30 m, so anything smaller is inside
 * the deadband and says nothing.
 */
export const DEPARTURE_M = 30;

/**
 * A vehicle is STANDING while the feed keeps reporting it at the same place.
 *
 * The feed repeats a position rather than interpolating — 53.6 % of
 * consecutive samples are byte-identical coordinates, runs of 15 s typically
 * and up to 28 min (docs/bus-speed.md) — so equality is the only way a stand
 * is visible at all in what the canary records. Two consecutive repeats is the
 * floor: one repeat is the ordinary feed cadence and says nothing.
 */
export const STAND_MIN_POLLS = 2;

/** How stale a pin sample may be and still name the vehicle a transition is about. */
export const PIN_TOL_MS = 150_000;

/** Consecutive earlier frames that reported `name` at exactly the distance it holds at `i`. */
export function standPollsBefore(samples, i, name) {
  const want = (j) => (samples[j]?.buses ?? []).find((b) => b && norm(b.name) === norm(name));
  let run = 0;
  for (let j = i; j > 0; j--) {
    const a = want(j), b = want(j - 1);
    if (!a || !b || !Number.isFinite(a.distM) || a.distM !== b.distM) break;
    run++;
  }
  return run;
}

/**
 * Did the vehicle the card is pinned to END a stand between frames i-1 and i?
 *
 * THIS IS THE EVENT THE RING-POSTERIOR MODEL PRICES, and `departureBetween`
 * cannot see it. That one asks only about the BOARD stop, inside 120 m; a bus
 * standing at any other stop on the loop is "none" to it. But the model leaves
 * the remaining stand on the price the moment a standing bus's first fresh fix
 * arrives — P(departure | first fresh fix) = 0.74, measured in
 * docs/eta-ring-posterior.md — so the whole countdown legitimately collapses
 * on that poll wherever the bus was standing.
 *
 * Gold #310, 2026-09-08 20:35 ET, is the shape: 263 m from the board stop and
 * at stop 10, the same distance for ten consecutive frames, the card reading
 * "in 8, 44 min" throughout. On the frame it moved to 237 m the card read
 * "in 1, 37 min" — and the bus reached the stop 1.7 min later. The canary
 * filed that twice as `eta-jump`.
 */
export function standEndedFor(samples, i, name, minPolls = STAND_MIN_POLLS) {
  if (!name || i < 1 || i >= (samples?.length ?? 0)) return false;
  const at = (j) => (samples[j]?.buses ?? []).find((b) => b && norm(b.name) === norm(name));
  const a = at(i - 1), b = at(i);
  if (!a || !b || !Number.isFinite(a.distM) || !Number.isFinite(b.distM)) return false;
  // The feed's own word, when it has one: it was at a stop and no longer is.
  if (a.atStop != null && b.atStop == null && Math.abs(b.distM - a.distM) >= DEPARTURE_M) return true;
  return a.distM !== b.distM && standPollsBefore(samples, i - 1, name) >= minPolls;
}

/**
 * The vehicle the card was pinned to around `atMs`, or null.
 *
 * The pin is read by tapping the card open, so `rider-canary.mjs` samples it
 * on a two-minute heartbeat and again on every jump over 120 s — which is
 * below `catastrophicSec`, so every transition that can fail a run has a pin
 * within seconds of it. There is no per-frame pin to be had: the countdown is
 * rendered only on the COLLAPSED row, so reading the pin every 15 s would
 * blind the scrape it exists to explain.
 */
export function pinnedVehicleAt(pins, atMs, tolMs = PIN_TOL_MS) {
  let best = null, bestD = Infinity;
  for (const p of pins ?? []) {
    if (!p?.busName) continue;
    const d = Math.abs(p.atMs - atMs);
    if (d <= tolMs && d < bestD) { best = p; bestD = d; }
  }
  return best ? norm(best.busName) : null;
}

/**
 * Flapping: the countdown oscillating between two states instead of counting
 * down. A DIFFERENT defect from a jump, and invisible to a rule that inspects
 * consecutive pairs — the operator's 2026-09-09 Red sequence (4:36, 1:57,
 * 3:09, 3:09, 1:57, 2:46) has no single pair over `catastrophicSec`, yet a
 * rider watching it cannot tell whether to run.
 *
 * A flap is a maximal run of drifts on ONE vehicle whose signs alternate, each
 * at least `flapMinSec`, at least `flapMinMoves` of them, inside
 * `flapWindowSec`. Transitions with a real-world event behind them are not
 * members: a departure is information arriving, and — the reason this is safe
 * — an event can only make a bus SOONER, so it can never supply the upward
 * half of an alternation anyway.
 *
 * Scored per vehicle slot, because two buses on one row moving independently
 * is not one number oscillating.
 */
export function scoreFlaps(transitions, thresholds = THRESHOLDS) {
  const out = [];
  const bySlot = new Map();
  for (const t of transitions) {
    if (t.eventful) continue;
    if (Math.abs(t.driftSec) < thresholds.flapMinSec) continue;
    const k = t.leader ? "leader" : `slot${t.fromSlot}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(t);
  }
  for (const [slot, moves] of bySlot) {
    let run = [];
    const flush = () => {
      if (run.length >= thresholds.flapMinMoves) {
        const span = (run[run.length - 1].atMs - run[0].atMs) / 1000;
        if (span <= thresholds.flapWindowSec) {
          out.push({
            kind: "flap", slot, leader: run[0].leader,
            atMs: run[0].atMs, endedAtMs: run[run.length - 1].atMs,
            spanSec: Math.round(span), moves: run.length,
            swingSec: Math.max(...run.map((t) => Math.abs(t.driftSec))),
            pinnedBus: run[0].pinnedBus ?? null,
            shown: [run[0].from, ...run.map((t) => t.to)],
          });
        }
      }
      run = [];
    };
    for (const t of moves) {
      const last = run[run.length - 1];
      const alternates = last && Math.sign(t.driftSec) !== Math.sign(last.driftSec);
      const close = last && (t.atMs - last.atMs) / 1000 <= thresholds.flapWindowSec;
      if (alternates && close) run.push(t);
      else { flush(); run = [t]; }
    }
    flush();
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * A console error the BROWSER emitted about a failed network request, rather
 * than anything the app did.
 *
 * The canary listens to `console` as well as `pageerror`, because a caught-but-
 * logged exception is still a defect. But Chromium also logs "Failed to load
 * resource: net::ERR_..." for any request that does not complete, and on this
 * Pi's link that happens: on 2026-09-10 a Red run failed `page-error` on six
 * copies of ERR_CONNECTION_CLOSED and nothing else. That is the canary's own
 * network, no rider saw it, and the operator already ruled on this exact class
 * for `feed-error` (2026-09-04) — it is counted, not failed.
 *
 * Deliberately narrow: these two shapes are emitted by the browser's network
 * stack and never by application code, so nothing the app can do is excused.
 * An uncaught "Failed to fetch" still arrives as a `pageerror`, which is not
 * a console message and is not exempt.
 */
export function isTransportNoise(text) {
  return /^console: /.test(String(text))
    && /(Failed to load resource|net::ERR_)/.test(String(text));
}

/**
 * Did the bus REACH the board stop on this reading?
 *
 * An arrival is not an upcoming arrival, so a bus that has just pulled in
 * correctly leaves the row — and the canary was calling that a defect. Green,
 * 2026-09-10 17:23: #325 closed 351 -> 323 -> 189 -> 130 m under "in <1, 8
 * min", then appeared at 47 m with `at_stop 25`, the board stop. The card moved
 * to the next bus and announced the swap; the canary filed `bus-vanished` and
 * `eta-jump`, and `departureBetween` could not help because the distance had
 * DECREASED, so it answered "closing".
 *
 * THE FEED'S OWN `at_stop_id` ONLY, never the distance — and the suite is what
 * forced that. `ARRIVAL_M` is how the canary credits an arrival, so crediting a
 * drop the same way looked symmetrical; it is not. A bus CLOSING through 60 m
 * and being dropped is the defect this metric exists to catch, named exactly in
 * "still blames it for a bus that vanished while it was closing" (110 m -> 60 m,
 * which must stay a finding). Distance says where a bus is; only `at_stop`
 * says it got there.
 *
 * Measured over the 400 archived runs on THIS rule: 6 of 38 severe drops that
 * currently fail a run (16%) are a bus reaching the stop. A distance-based
 * version scored 9 of 38, and the extra three were the defect.
 */
export function reachedBoardStop(buses, boardStopId) {
  if (!Array.isArray(buses) || boardStopId == null) return false;
  return buses.some((b) => b && b.atStop != null && b.atStop === boardStopId);
}

/**
 * Did the bus at the stop LEAVE between these two readings?
 *
 * WHY THIS EXISTS. `docs/eta-lurch-classification.md` (#71) measured that
 * **92.4 % of catastrophic drops have a real-world event behind them**: the
 * bus reached the stop, pulled away, and the card honestly moved to the next
 * one. Reporting that as jitter is what made every canary finding need
 * triaging by hand. Checked against the log, three of six flagged jumps were
 * the app behaving perfectly — #301 23 m -> 147 m, #316 86 m -> 284 m, #304
 * 49 m -> 234 m — and the three that were real defects had the leading bus
 * still CLOSING: 225 -> 77, 416 -> 301, 440 -> 375.
 *
 * The discriminator is that simple, and it needs no identity we do not have:
 * take the nearest bus in the earlier reading — the proxy for the one the
 * card is counting down — find it BY NAME in the later one (the feed does
 * carry names; `bus_name` is the identity invariant, `bus_id` is not) and ask
 * which way it moved.
 *
 * THE `NEAR_STOP_M` PRECONDITION IS LOAD-BEARING, and it is the one place
 * this departs from "distM is increasing". A bus receding from 800 m to 900 m
 * is driving the far side of its loop, not leaving our stop, and it must not
 * excuse a jump. Measured over the archive: with no precondition **23 of 64**
 * catastrophic drifts read as "eventful", against 1 at 120 m — the rule would
 * have talked itself out of most of the log. The severe-drop verdict, which
 * is what actually fails a run, is stable from 120 m outward (8 eventful at
 * 120, 250, 500 m and unbounded) and loses 3 genuine departures at 60 m. So
 * 120 m it is, which is also the radius `rider-canary.mjs` already used to
 * decide a bus had left.
 *
 * WHAT THIS DOES NOT CLAIM. #71's 92.4 % covers real-world events of every
 * kind anywhere on the route; this sees one narrow event — a departure from
 * the BOARD stop — and explains 1 of 64 catastrophic drifts and 8 of 15
 * severe drops with it. The severe drops are the ones that fail a run, so
 * that is where it pays; do not read the two numbers as the same measurement.
 *
 *   "departure"  it was at the stop and has pulled away — not a defect
 *   "closing"    it is still coming, so the countdown had no excuse
 *   "none"       nothing was near the stop; there was no arrival to have
 *   "unknown"    the feed dropped it, or the reading carries no bus list
 */
/**
 * Has this line's fleet gone off-air — no vehicles on the road at all?
 *
 * `buses` on each sample is THIS line's own vehicles as the feed reported them
 * that tick, so an empty array is not missing data: it is the operator saying
 * nobody is running. At Red's end of service on 2026-09-04 the canary rode a
 * line with zero buses for twelve minutes and filed `line-missing` ("Red is
 * running (0 live buses)") and `option-vanished` against an app that was
 * correctly declining to offer a route nobody was driving.
 *
 * The LAST reading decides, not the first: a line can go off-air mid-watch,
 * which is the ordinary way an evening ends, and that must retire the run
 * rather than fail it.
 */
export function fleetOffAir(samples) {
  const withBuses = (samples ?? []).filter((s) => Array.isArray(s?.buses));
  if (!withBuses.length) return false;
  return withBuses[withBuses.length - 1].buses.length === 0;
}

/**
 * Did the SCRAPER fail, or did the ride simply end quickly?
 *
 * A run that read no countdown must never pass — the neighbouring watch at
 * ~/eta-live reported "Purple kept its promises" off a ride with zero recorded
 * promises on 2026-09-03, which is a silent scraper failure wearing success's
 * face. Two readings is the minimum that can show a transition at all.
 *
 * BUT A WATCH THAT OPENS ON A BUS AT THE KERB ENDS ON THE ARRIVAL, and one
 * reading is all it ever had a chance to take. Four of the six `no-countdown`
 * findings in the archive are exactly that: 0.4-0.6 min watched, the bus
 * reached the stop, a successful ride filed as a broken instrument. The one
 * genuine case — 2026-09-04 14:47, five frames, ZERO readable countdowns, no
 * arrival — watched 1.6 min, so a floor in minutes would have silenced it
 * alongside the false ones. Arrival is the discriminator; the clock is not.
 */
export function scraperMissedTheCountdown({ readings = 0, anyPresent = false, arrived = false } = {}) {
  return anyPresent && !arrived && readings < 2;
}

/**
 * The verdict for one finished run — the single place that decides whether a
 * watch counts against the app.
 *
 *   "ok"           nothing found
 *   "finding"      at least one failure, and they are all about the APP
 *   "unreachable"  the canary's ground-truth feed refused EVERY poll, so
 *                  there is no truth to judge against. Neither `ok` nor a
 *                  finding — the `--loop` already knows this status and
 *                  sleeps on it.
 *
 * `feed-error` is deliberately NOT among the failures any more (operator,
 * 2026-09-04). It is `/api/buses` timing out on the canary's own network —
 * the same class of thing as a blind parser, and no rider saw it. It appeared
 * on 24 of 60 archived runs, 31 times in all, and was the sole reason two of
 * them were not `ok`. It is counted and reported; it fails nothing. Total
 * loss is the one exception, and it changes the verdict to a third value
 * rather than to a finding.
 */
export function runVerdict({ failures = [], feedPolls = 0, feedErrorCount = 0 } = {}) {
  if (feedPolls > 0 && feedErrorCount >= feedPolls) return "unreachable";
  return failures.length === 0 ? "ok" : "finding";
}

/**
 * Is this bus at the stop the app told the rider to walk to?
 *
 * Two ways, and the feed's own word outranks our metres: `at_stop_id` naming
 * the board stop is the operator's reckoning, and a run filed `no-arrival`
 * with #304 sitting 49 m out under exactly that flag. The distance test is
 * the fallback for a bus the feed has not flagged yet.
 */
export function isAtBoardStop(distM, atStopId, boardStopId) {
  if (boardStopId != null && atStopId != null && atStopId === boardStopId) return true;
  return Number.isFinite(distM) && distM <= ARRIVAL_M;
}

/**
 * How long the canary should keep watching, given the promise on screen.
 *
 * Twice what the app promised plus six minutes of slack, floored at the eight
 * minutes that make a watch worth anything and ceilinged at `watchMaxMin`,
 * which bounds one browser's life on this Pi.
 *
 * IT IS RE-DERIVED ON EVERY READING, not once at first sight. A watch that
 * opens on "now, then 72 min" takes its promise from a bus already at the
 * stop — `first` is the [0, 10) bucket, so `promisedMin` is 0 and the whole
 * watch is the 8 minute floor. When that bus pulls away and the card re-pins
 * to one 19 minutes out, the deadline used to stay where it was: the watch
 * expired with "in 19, 31 min" on screen and filed `no-arrival` against an
 * app that had done nothing wrong (2026-09-04, 12:02 ET). Keying the
 * extension on the READING rather than on the pinned vehicle's name is
 * deliberate — the canary samples the pin every two minutes at best, so it
 * would miss the very change that matters.
 */
export function deadlineForPromise(atMs, promiseHiSec, watchMaxMin, startedAtMs = null) {
  const promisedMin = promiseHiSec / 60;
  const want = Math.max(1, Math.min(8, watchMaxMin), promisedMin * 2 + 6);
  const at = atMs + Math.min(watchMaxMin, want) * 60_000;
  // The hard cap runs from the START of the watch, not from this reading, or
  // a countdown that keeps re-promising would extend the watch for ever.
  return startedAtMs == null ? at : Math.min(at, startedAtMs + watchMaxMin * 60_000);
}

/**
 * The first promise the app made that ELAPSED while the canary was still
 * watching — a bus that was due and did not come.
 *
 * This is what tells `no-arrival` (a defect: the app said a bus would be here
 * by now) apart from `unfinished` (not a defect: the watch's own ceiling cut
 * it short before the bus was ever due). Both look identical from the outside
 * — no bus reached the stop — and conflating them made the canary cry wolf on
 * a working route through a long headway, which is most of Red's evening.
 *
 * Deliberately the FIRST such promise rather than the last: it is the one the
 * rider acted on, and quoting it says what was actually broken.
 */
export function brokenPromise(samples, endedAtMs) {
  for (const s of samples ?? []) {
    if (!s?.present || !s.eta) continue;
    const dueBy = s.atMs + s.eta.first[1] * 1000;
    if (endedAtMs >= dueBy) {
      return { atMs: s.atMs, raw: s.eta.raw, dueByMs: dueBy, overdueSec: Math.round((endedAtMs - dueBy) / 1000) };
    }
  }
  return null;
}

export function departureBetween(prevBuses, nextBuses) {
  const nearest = (list) => (list ?? [])
    .filter((b) => b && Number.isFinite(b.distM))
    .reduce((best, b) => (!best || b.distM < best.distM ? b : best), null);
  const was = nearest(prevBuses);
  if (!was) return "unknown";
  if (was.distM > NEAR_STOP_M) return "none";
  const now = (nextBuses ?? []).find((b) => b && norm(b.name) === norm(was.name));
  if (!now || !Number.isFinite(now.distM)) return "unknown";
  return now.distM - was.distM >= DEPARTURE_M ? "departure" : "closing";
}

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

/**
 * Mirrors OFF_ROUTE_THRESHOLD_M in web/src/anchor.ts — the app's own line
 * between "on its route" and "not". A test pins the two equal.
 */
export const OFF_ROUTE_M = 500;

/** Metres from `p` to the segment a-b, in the same flat approximation web/src/geo.ts uses. */
function distanceToSegmentM(p, a, b) {
  const dx = (b.lon - a.lon) * 84_000, dy = (b.lat - a.lat) * 111_000;
  const px = (p.lon - a.lon) * 84_000, py = (p.lat - a.lat) * 111_000;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
  const ex = px - dx * t, ey = py - dy * t;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Is this bus ON the line it reports, by the app's own test (`isBusOnRoute`,
 * web/src/anchor.ts): within OFF_ROUTE_M of the route's published polyline,
 * or of one of its stops when the payload carries no polyline; a bus with no
 * GPS is never ruled out.
 *
 * A route id is not a position. On Sun 2026-09-06 at 17:42 ET, Blue Night's
 * #57 reported route 13 from Whitney Ave in Hamden — 4 km north of the
 * nearest Blue Night stop, deadheading in for its 18:00 start — and the
 * canary counted it as "1 live bus", rode Peabody -> Congress / Cedar on the
 * strength of it, and filed `line-missing` against an app that had (rightly)
 * excluded the bus from every board and plan because it was not on the
 * route. The in-service gate was not the cause: with its 90 min grace it
 * passed #57 the whole time. The bus stopped 977 m off route at 17:52 and
 * the watch ended before it ever reached the line.
 */
export function busOnRoute(payload, bus, line) {
  if (!Number.isFinite(bus?.lat) || !Number.isFinite(bus?.lon)) return true;
  const path = payload.route_paths?.[String(bus.route_id)];
  if (Array.isArray(path) && path.length >= 2) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = { lat: path[i][0], lon: path[i][1] }, b = { lat: path[i + 1][0], lon: path[i + 1][1] };
      if (distanceToSegmentM(bus, a, b) < OFF_ROUTE_M) return true;
    }
    return false;
  }
  return stopsOfLine(payload, line).some((id) => {
    const c = payload.stop_coords?.[id];
    return c && haversineM(bus, c) < OFF_ROUTE_M;
  });
}

/**
 * The buses the app would show on `line`: reporting one of its route ids AND
 * on its route. "Running" means vehicles on the line's road, never a route id
 * on a bus somewhere else, and never a schedule.
 */
export function liveBusesOf(payload, line) {
  return (payload.buses ?? []).filter((b) =>
    line.busRouteIds.includes(b.route_id) && busOnRoute(payload, b, line));
}

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
          display_name: name(stops[i]), lat: c.lat, lon: c.lon,
          // A stop is auto-picked by the frontend on type "bus_stop", the same
          // as a curated landmark on class "yale".
          type: "bus_stop", class: "shuttle",
        },
      };
    }
  }
  return null;
}
