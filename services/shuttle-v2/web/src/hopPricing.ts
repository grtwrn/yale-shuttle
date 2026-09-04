/**
 * Pricing the FIRST hop from a stand/drive split instead of a credit.
 *
 * A calibrated segment is arrival-to-arrival: it contains every second the
 * bus stood at A (40% of hop seconds, 72% of within-hop variance) as well as
 * the drive to B. Two things went wrong when that one number was the only
 * thing on offer (docs/eta-estimator-design.md):
 *
 *  - The stall credit `segAvg - min(elapsed, med)` is right until the median
 *    layover and then OPTIMISTIC: -29 s at r = 240, -43 at 300, -71 at 420,
 *    -101 at 600. A bus that has sat past its median is promised at the floor
 *    while the data says it has two more minutes. That is the "steady but
 *    wrong" number on the Red canary.
 *  - The instant `at_stop_id` clears, the hop switches to distance proration,
 *    which spreads seconds that were piled at metre zero along the metres:
 *    344 Winchester -> Winchester/Division, 557 s over 112 m, bills 0.33 x 557
 *    = 184 s for <= 37 m of road. Over 569 clean layover departures the
 *    promise to the next stop goes +16 s at the departure instant, +115 s at
 *    +30 s, +151 s at +45-60 s. The number RISES as the bus leaves.
 *
 * The fix is arithmetic, not a filter:
 *
 *   at the stop, r seconds in:   median(stand - r | stand > r) + drive
 *   en route, fraction t done:   drive x (1 - t)          (stand is never prorated)
 *
 * Measured on 30 days of arrivals (fit 23 / eval 7), the conditional median
 * scores 127 s MAE / +7 s bias at layover stops against the credit's 135 / +6,
 * and its bias is flat in r (+7, +6, +5, +4, +11, +12, +7, -3, +2, +20) where
 * the credit's changes sign. Dropping the elapsed term altogether costs
 * 203 / +141, so the clock earns its keep; only its form was the defect.
 *
 * INPUTS. `q` is a small ascending vector of quantiles of the standing time at
 * this stop (seconds from `at_stop_since` to the last poll at the stop), and
 * `drive` the seconds from that poll to arrival at the next stop, both served
 * by the calibrator from the departure derivation. `r` is measured on the same
 * clock (`now - at_stop_since`). Thin stops are shrunk toward a pooled shape
 * before serving; this module only reads what it is given.
 */

/**
 * Median of (S - r | S > r) for a standing time S whose distribution is given
 * by ascending quantiles `q` at levels (i + 0.5) / n.
 *
 * The quantiles are read as knots of a piecewise-linear CDF, not as a point
 * sample: the conditional median of a point sample steps UP each time r
 * crosses a sample value (the survivors' median moves to the next point), so
 * a rider would watch the number climb while the bus sat still. Inverting the
 * interpolated CDF keeps it continuous in r.
 *
 * Past the last quantile the CDF is closed linearly one inter-quantile gap
 * later, so a bus that has out-sat every recorded layover is not promised
 * "leaving now" — the measured remaining past r = 600 s is still ~2 min — and
 * the promise decays to zero instead of stepping there.
 *
 * ⚠️ CONTINUOUS IS NOT DECREASING, and this function is only the former. The
 * interpolation removed the DISCONTINUITIES; the curve still rises wherever
 * the CDF flattens (on Red stop 11, +42 s across r = 107..168 and +14.8 s
 * across r = 456..473). That residue is the inspection paradox, not a defect
 * in the arithmetic, and it is clamped where it is SHOWN — see
 * `flooredStandSec`. Do not "fix" it here by monotonising the CDF: the rise is
 * the correct conditional median, and the estimator's measured bias depends on
 * it (dropping the elapsed term altogether costs 203 s MAE / +141 s bias).
 */
export function remainingStandSec(q: readonly number[], r: number): number {
  const n = q.length;
  if (n === 0) return 0;
  const rr = Math.max(0, r);
  const last = q[n - 1]!;
  const gap = Math.max(30, n >= 2 ? last - q[n - 2]! : last / 2);
  const xs: number[] = [], ps: number[] = [];
  if (q[0]! > 0) { xs.push(0); ps.push(0); }
  for (let i = 0; i < n; i++) { xs.push(q[i]!); ps.push((i + 0.5) / n); }
  xs.push(last + gap); ps.push(1);
  const F = (x: number): number => {
    if (x <= xs[0]!) return ps[0]!;
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]!) {
        const w = xs[i]! - xs[i - 1]!;
        return w <= 0 ? ps[i]! : ps[i - 1]! + (ps[i]! - ps[i - 1]!) * (x - xs[i - 1]!) / w;
      }
    }
    return 1;
  };
  const Finv = (p: number): number => {
    for (let i = 1; i < xs.length; i++) {
      if (p <= ps[i]!) {
        const w = ps[i]! - ps[i - 1]!;
        return w <= 0 ? xs[i]! : xs[i - 1]! + (xs[i]! - xs[i - 1]!) * (p - ps[i - 1]!) / w;
      }
    }
    return xs[xs.length - 1]!;
  };
  const Fr = F(rr);
  if (Fr >= 1) return 0;
  return Math.max(0, Finv((Fr + 1) / 2) - rr);
}

/**
 * Where the non-increasing ceiling on the standing term is carried, when the
 * caller has a store to carry it on. Omit it and the price is the raw
 * conditional median exactly as before (see `flooredStandSec`).
 */
export interface StandFloorCtx { store: object | undefined; key: string; stopId: number; now: number }

/** Seconds still to bill on the first hop. */
export function priceFirstHop(
  stand: { q: readonly number[] } | undefined,
  driveSec: number,
  /** Seconds standing at the from-stop, or null when the bus is en route. */
  standingForSec: number | null,
  /** Fraction of the A->B chord already covered when en route (0..1). */
  progress: number,
  floor?: StandFloorCtx,
): number {
  const drive = Math.max(0, driveSec);
  if (standingForSec !== null) {
    const rest = !stand
      ? 0
      : floor
        ? flooredStandSec(floor.store, floor.key, floor.stopId, stand.q, standingForSec, floor.now)
        : remainingStandSec(stand.q, standingForSec);
    return rest + drive;
  }
  // En route: the standing term is GONE from the price, so the ceiling that
  // held it flat is gone too. This is the line that keeps 5 -> 1 on an early
  // departure — the clamp never survives the departure it would have delayed.
  if (floor) forgetStandFloor(floor.store, floor.key);
  const t = Math.max(0, Math.min(1, progress));
  return drive * (1 - t);
}

/**
 * Standing memory. `at_stop_id` is a PUBLICATION signal — the collector emits
 * it within 75 m of the stop — not the answer to "is this bus standing". A
 * parked bus that shuffles to 85 m loses the flag for a poll and gets it back;
 * the stop-pinned clock (`stationarySince`, PR #67) survives that shuffle, and
 * so must the pricing, or the countdown flashes to the drive and back.
 *
 * Kept per caller-owned `AnchorStore` so hypothetical and replayed calls have
 * their own memory and pure calls (no store) have none — the same rule the
 * anchor gate follows.
 */
export const STANDING_HOLD_M = 125; // mirrors STATIONARY_RADIUS_M (detector.ts, PR #67)
const STANDING_MEMO_STALE_MS = 120_000;

/**
 * THE LAYOVER TAKEN SHORT OF THE MARKER.
 *
 * `at_stop_id` is published only within 75 m of a stop, so a bus that takes
 * its rest just SHORT of the layover marker publishes nothing: the client sees
 * a bus with a position between two stops and prices it as DRIVING, with the
 * whole layover still ahead of it. The operator watched this happen, live, on
 * 2026-09-04 — Red #310, 13:28 ET:
 *
 *   13:27:38  comes to rest short of 344 Winchester, last_stop_id 27
 *             (Canal / Munson), heading 299. The operator read 140 m off the
 *             map; the detector's own clock settles a poll earlier, at 147 m,
 *             and 147 is the number the fixture and the tests use.
 *   13:27-13:34  79 identical fixes — 7 min 5 s at rest, going nowhere
 *   13:34:48  rolls the 147 m in
 *   13:34:58  reaches the marker
 *   13:36:53  leaves — the detector logged a stand of 115 s
 *
 * The card read `#310 · 11 min` with 344's chip at `⏸ ~6 min`: driving toward
 * 344, and then a six-minute stand once it gets there. It was not driving. It
 * was doing the stand, in the wrong place, and when it finally rolled in the
 * promised six minutes evaporated and the number fell several minutes at once.
 * A 5 → 1 with no event behind it, which is exactly the lurch #119 exists to
 * prevent — the ceiling could not help, because the standing term was never
 * charged in the first place.
 *
 * So: a bus at rest in the approach zone of a layover stop IS STANDING AT THAT
 * STOP. Elapsed runs from when it stopped, the remainder is conditional on it,
 * and #119's ceiling applies — the same arithmetic as a bus resting on the
 * marker, because it is the same wait.
 *
 * ## The gates, and why each one is there
 *
 * Measured over 90,170 production polls across all 15 routes, 04:40–13:40 ET
 * on 2026-09-04 (`stop_visits` for the stand tables, the detector's own
 * stationary clock replayed over `raw_positions`). Long rests (≥ 3 min) are
 * 203 in that window; 19 of them are off-marker at all. Adding the three gates
 * below, the rule fires on ONE episode in nine hours — #310 above — and on
 * nothing else, at every zone radius from 150 m to 300 m. It is deliberately
 * a scalpel: the failure is rare, it is expensive when it happens, and a rule
 * that fired on ordinary traffic would be far worse than the bug.
 *
 *  - **the NEXT stop in sequence**, never the nearest. A bus resting near a
 *    stop it has already served is not waiting for it, and on this network
 *    stops 30 m apart can be nine apart in the loop (Orange / Pearl (N)/(S)).
 *    This single constraint is what takes the rule from six episodes to one.
 *  - **a real rest**, not a red light. `stationary_since` off a stop measures
 *    time since the bus last moved more than 125 m from where it settled, so a
 *    bus in motion resets it every few polls. The threshold is where the
 *    population separates, and it separates sharply — episodes in the same
 *    nine hours, at every zone radius:
 *
 *        rest >=  45 s   23 episodes   Purple and Gold pausing on approach
 *        rest >=  60 s   16 episodes
 *        rest >=  90 s    4 episodes
 *        rest >= 120 s    1 episode    <- #310, and nothing else
 *        rest >= 150 s    1 episode
 *        rest >= 180 s    1 episode
 *
 *    Below 120 s the rule starts catching buses that pause 45–105 s a hundred
 *    metres short of a layover stop and then take the layover normally —
 *    crediting those would cancel a rest still to come, which is the direction
 *    that makes a rider miss the bus. {@link APPROACH_REST_MIN_SEC} sits in
 *    the middle of the flat region, not at its edge. #310's rest was 7 min 5 s.
 *  - **a layover stop**, judged by the same table the price comes from: its
 *    typical hold must reach {@link APPROACH_LAYOVER_MIN_SEC}, and the table
 *    must clear `standAdequate`. Crediting a rest to a stop with no real
 *    layover would cancel a hop the bus still has to drive, which is the
 *    direction that makes a rider miss the bus.
 *
 * ## The engagement step is not a new jump
 *
 * The rule switching on moves the number, and the move is large: -225 s on
 * #310, -215 s on #304. That is worth stating plainly rather than burying,
 * because it looks exactly like the lurch this whole area exists to prevent.
 *
 * Measured over both recordings, in the window from the start of the rest to
 * the last poll at the marker, EACH ARM HAS EXACTLY ONE JUMP >= 180 s:
 *
 *     #310   master  -182 s at 13:34:58 (reaching the marker)
 *            fixed   -225 s at 13:30:13 (the rule engaging, 4.75 min earlier)
 *     #304   master  -183 s at 14:11:03 (reaching the marker)
 *            fixed   -215 s at 14:08:48 (the rule engaging, 2.25 min earlier)
 *
 * So the fix does not ADD a jump. It moves the one jump earlier and pays ~40 s
 * more magnitude for it, and what it buys is the five minutes in between: on
 * master those are a number that is 300 s wrong and frozen, and after the fix
 * they track the truth. The step also has information behind it — the bus has
 * demonstrably been standing for 150 s — where master's has none a rider can
 * see, since a bus rolling the last 140 m onto its marker is not news.
 *
 * Engaging EARLIER to shrink the step is the obvious idea and it is
 * measurably unsafe: see the sweep above, where 45 s admits 23 episodes.
 *
 * ## One visit, one stand
 *
 * When the bus finally rolls in, the detector re-pins its clock to the stop
 * and `at_stop_since` starts fresh — #310's restarted at 13:34:58, after
 * 7 minutes of waiting. Left alone that would hand the rider the whole
 * layover a second time, the countdown JUMPING UP at the exact moment the bus
 * arrives. So the memo keeps the EARLIER start across the roll-in: an approach
 * rest and the marker touch that follows it are one wait, and the clock runs
 * from when the bus actually stopped.
 */
export const APPROACH_ZONE_M = 200;
export const APPROACH_REST_MIN_SEC = 150;
export const APPROACH_LAYOVER_MIN_SEC = 120;

/**
 * The next stop in sequence, offered to {@link standingAt} as a candidate for
 * an approach-zone rest. `typicalStandSec` is the stop's unconditional hold —
 * `remainingStandSec(q, 0)` — so the layover test reads the very table the
 * price will come from.
 */
export interface ApproachCandidate {
  stopId: number;
  typicalStandSec: number;
}

interface StandingMemo { stopId: number; since: number; seenAt: number; approach?: boolean }
const memos = new WeakMap<object, Map<string, StandingMemo>>();

export function standingAt(
  store: object,
  key: string,
  bus: {
    lat?: number | undefined; lon?: number | undefined;
    at_stop_id?: number | null | undefined; at_stop_since?: string | null | undefined;
    stationary_since?: string | null | undefined;
  },
  now: number,
  stopCoords: Record<number, { lat: number; lon: number }>,
  holdM: number,
  /** The next stop in sequence, when it is a candidate for an approach rest. */
  approach?: ApproachCandidate | undefined,
): { stopId: number; standingSec: number } | null {
  let m = memos.get(store);
  if (!m) memos.set(store, (m = new Map()));
  if (bus.at_stop_id && bus.at_stop_since) {
    const since = new Date(bus.at_stop_since + "Z").getTime();
    if (Number.isFinite(since)) {
      // One visit, one stand: if we were already crediting an approach rest to
      // THIS stop, the wait started when the bus stopped short of it, not when
      // it finally rolled onto the marker. Without this the countdown jumps up
      // at the arrival — the same lurch, just moved a few minutes later.
      const prev = m.get(key);
      const start = prev && prev.approach && prev.stopId === bus.at_stop_id && prev.since < since
        ? prev.since
        : since;
      m.set(key, { stopId: bus.at_stop_id, since: start, seenAt: now, approach: prev?.approach && prev.stopId === bus.at_stop_id });
      return { stopId: bus.at_stop_id, standingSec: Math.max(0, (now - start) / 1000) };
    }
  }
  const restingAt = approachRest(bus, now, stopCoords, approach);
  if (restingAt) {
    const prev = m.get(key);
    const start = prev && prev.stopId === restingAt.stopId && prev.since < restingAt.since
      ? prev.since
      : restingAt.since;
    m.set(key, { stopId: restingAt.stopId, since: start, seenAt: now, approach: true });
    return { stopId: restingAt.stopId, standingSec: Math.max(0, (now - start) / 1000) };
  }
  const memo = m.get(key);
  if (!memo) return null;
  const sc = stopCoords[memo.stopId];
  const near = sc && bus.lat && bus.lon ? haversineM(bus.lat, bus.lon, sc.lat, sc.lon) <= holdM : false;
  if (now - memo.seenAt > STANDING_MEMO_STALE_MS || !near) { m.delete(key); return null; }
  memo.seenAt = now;
  return { stopId: memo.stopId, standingSec: Math.max(0, (now - memo.since) / 1000) };
}

/**
 * Is this bus at rest in the approach zone of `approach`? Returns the instant
 * the rest began, on the same clock `at_stop_since` uses.
 *
 * Every gate is documented above {@link APPROACH_ZONE_M}; this is only the
 * arithmetic. It is a pure read of the payload, so a client whose server has
 * not yet shipped `stationary_since` simply never takes this path.
 */
function approachRest(
  bus: { lat?: number | undefined; lon?: number | undefined; stationary_since?: string | null | undefined },
  now: number,
  stopCoords: Record<number, { lat: number; lon: number }>,
  approach: ApproachCandidate | undefined,
): { stopId: number; since: number } | null {
  if (!approach || !bus.stationary_since) return null;
  if (!(approach.typicalStandSec >= APPROACH_LAYOVER_MIN_SEC)) return null;
  const since = new Date(bus.stationary_since + "Z").getTime();
  if (!Number.isFinite(since)) return null;
  if ((now - since) / 1000 < APPROACH_REST_MIN_SEC) return null;
  const sc = stopCoords[approach.stopId];
  if (!sc || !bus.lat || !bus.lon) return null;
  if (haversineM(bus.lat, bus.lon, sc.lat, sc.lon) > APPROACH_ZONE_M) return null;
  return { stopId: approach.stopId, since };
}

/**
 * THE STANDING REMAINDER MAY NOT GROW WHILE THE BUS STANDS STILL.
 *
 * `remainingStandSec` is continuous in `r` — PR #99 replaced the point-sample
 * median with the interpolated CDF and the STEPS went away — but continuous is
 * not the same as decreasing, and it is not decreasing. On Red's 344 Winchester
 * table (`q = [83,129,145,191,288,333,437,473,543,674]`, qn = 34) the raw
 * remainder RISES over two stretches of the hold, 107 s -> 168 s (+42 s, at up
 * to +2.25 s per elapsed second) and 456 s -> 473 s (+14.8 s): a rider watching
 * "5 min" sees the predicted arrival slide a minute later while the bus has not
 * moved. That is what the operator caught live on #310 — "stop arrival is
 * staying at 5 min even though dwell is counting up".
 *
 * The rise is not an artifact of thin data or of the interpolation; it is the
 * inspection paradox. The conditional median of the remaining hold genuinely
 * grows wherever the CDF flattens, because a bus still standing at five minutes
 * is drawn from the longer-hold population. The arithmetic is right. What is
 * wrong is SHOWING it, and the distinction that justifies the clamp is:
 *
 *   A bus standing still produces NO EVENT. The estimate rising is an artifact
 *   of conditioning on elapsed time, not news arriving.
 *
 * So this is emphatically NOT the slew/rate limiter the operator rejected on
 * 2026-09-03 ("I don't want a slew limiter. it can go 5->1 if it leaves early.
 * but if it is jitter we need a fix"). A rate limiter damps REAL CORRECTIONS
 * and delays information a rider needs. This clamps only the one term that has
 * no new information in it — and the instant the bus departs, `standingSec`
 * goes null, the standing term is gone from the price entirely, and the number
 * collapses honestly. 5 -> 1 on an early departure is untouched, because the
 * ceiling is never consulted off the standing path and is dropped on departure.
 *
 * The PLATEAU that remains is deliberate and is not a defect: where the raw
 * curve wants to climb, the shown number holds flat instead. A held number is
 * honest about a bus that is not going anywhere; a climbing one is not.
 *
 * Kept per caller-owned `AnchorStore`, beside `standingAt`'s memory and the
 * anchor gate's, so a storeless caller — a hypothetical, a replay, a test —
 * prices byte-identically to before this existed.
 *
 * Reset on: a different stop, a restarted hold clock (the bus left and came
 * back, or `at_stop_since` was re-pinned), a stale entry, or `forgetStandFloor`
 * when the bus is no longer standing. The `key` carries the vehicle, so a
 * different pinned bus never inherits a ceiling either.
 */
interface StandFloor { stopId: number; best: number; standingSec: number; seenAt: number }
const floors = new WeakMap<object, Map<string, StandFloor>>();

/** Tolerance on the hold clock, in seconds: below this a dip is float noise, not a new hold. */
const STAND_CLOCK_RESET_SEC = 1;

export function flooredStandSec(
  store: object | undefined,
  key: string,
  stopId: number,
  q: readonly number[],
  standingSec: number,
  now: number,
): number {
  const raw = remainingStandSec(q, standingSec);
  if (!store) return raw;
  let m = floors.get(store);
  if (!m) floors.set(store, (m = new Map()));
  const prev = m.get(key);
  const carried = prev
    && prev.stopId === stopId
    && standingSec >= prev.standingSec - STAND_CLOCK_RESET_SEC
    && now - prev.seenAt <= STANDING_MEMO_STALE_MS;
  const best = carried ? Math.min(prev!.best, raw) : raw;
  m.set(key, { stopId, best, standingSec, seenAt: now });
  return best;
}

/** Drop the ceiling — the bus is not standing any more, so the next hold starts clean. */
export function forgetStandFloor(store: object | undefined, key: string): void {
  if (!store) return;
  floors.get(store)?.delete(key);
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Sample adequacy. One day of archive cannot populate every cell: the first
 * paired run had Building 750 with no stand table at all and Green tables
 * with n = 1, and the split MISPRICED the West Campus fold (Purple jumps
 * 62 -> 73%) while fixing Red. A thin cell is withheld, not blended — the hop
 * then prices exactly as master does — and switches itself on as the
 * recorder fills it.
 *
 * Thresholds from what the arithmetic needs, not from taste. A 10-quantile
 * stand table wants at least two samples behind each quantile, and the
 * conditional median at r near the median reads only the upper half, so 20
 * leaves 10 behind it. Drive is a low-variance mean (5% of within-hop
 * variance, sd ~20-30 s), so 10 samples put its standard error under ~10 s.
 * Red's 344 Winchester hop (n = 24/25 after one day) clears both; the n = 1
 * tables do not.
 *
 * `qn` / `driveN` are the sample counts behind the table; when the payload
 * carries neither, the entry's own `n` is used.
 */
export const MIN_STAND_SAMPLES = 20;
export const MIN_DRIVE_SAMPLES = 10;

export function standAdequate(d: { q?: number[] | undefined; qn?: number | undefined; n: number } | undefined): d is { q: number[]; qn?: number; n: number } {
  if (!d || !d.q || d.q.length < 3) return false;
  for (let i = 1; i < d.q.length; i++) if (!(d.q[i]! >= d.q[i - 1]!)) return false;
  return (d.qn ?? d.n) >= MIN_STAND_SAMPLES;
}

export function driveAdequate(s: { drive?: number | undefined; driveN?: number | undefined; n: number } | undefined): s is { drive: number; driveN?: number; n: number } {
  if (!s || s.drive === undefined || !(s.drive >= 0)) return false;
  return (s.driveN ?? s.n) >= MIN_DRIVE_SAMPLES;
}
