/**
 * A BUS THAT HAS GONE QUIET IS NOT A BUS THAT IS STILL COMING.
 *
 * The defect (Red, 2026-09-04 13:47 ET). A rider at Division/Prospect was
 * watching #304, due in about eight minutes. At 13:47:51 #304 made its last
 * report and stopped appearing in the feed. Two minutes later the collector
 * deleted it, `/api/buses` lost it, and the card moved — with no word of
 * explanation — to #310, a full loop away at 42 min. The operator: "just
 * jumped from 8 to 42 minutes. do we catch if a bus is going offline? can we?"
 *
 * The instant deletion is wrong. But so is the obvious repair.
 *
 * WHAT THE DATA SAYS, AND WHY THE FIRST READING OF IT WAS WRONG. Six hours of
 * `raw_positions` said every one of nine multi-minute gaps came back, in
 * place, in a median of 4.4 minutes — which reads as "the bus is still
 * standing there, keep counting down". That reading is survivorship: a six
 * hour window can only contain gaps that ENDED inside it. Scored over 90 days
 * of `arrivals` instead, with the never-returned counted (3,136 vanish events,
 * right-censored at 2 h), a bus that goes quiet while its route is still
 * running comes back within 2 min 2.1% of the time, within 5 min 13.4%,
 * within 10 min 32.8%, within 20 min 44.5% — and not within the hour 50.3% of
 * the time. It is a coin flip.
 *
 * #304 ITSELF WAS READ WRONG TWICE, AND BOTH CORRECTIONS ARE THE DESIGN. At
 * 13:58 there was no #304 under any id on any route and it was recorded here
 * as a bus that never came back. It did: at 14:06 — EIGHTEEN minutes after it
 * went quiet — it reappeared under a new `bus_id`, resting in the Science Park
 * Garage lot, about 500 m from where it vanished and off Red's route
 * altogether, and drove to Division/Prospect by 14:15.
 *
 * That does not rescue "it is standing at its stop and still coming". It buries
 * it. The bus was in a garage, off route, for eighteen minutes; a countdown
 * would have been wrong for every second of them, and eighteen minutes is past
 * any grace worth having. What it does confirm is the shape of the fix — the
 * row expires at ten minutes, and #304's return at eighteen is a FRESH
 * SIGHTING, which is the honest sequence:
 *
 *     "#304 was due in 15 · signal lost 2 min ago"   (the row keeps its place)
 *     → the grace ends, the row goes, #310 is what is left
 *     → 18 min later, "#304 in 9 min", a new bus with a new estimate
 *
 * A stale promise must never be resurrected on the far side of that gap; see
 * {@link recallPromise}, which refuses one older than the grace for exactly
 * this reason.
 *
 * So pricing a ghost as a bus standing at its stop and about to leave would
 * replace a silent lie with a confident one. Half the time the rider would be
 * told to wait for a bus that is not coming — and #304 is the half.
 *
 * WHAT IS SHOWN INSTEAD IS THE UNCERTAINTY ITSELF. The row keeps its place and
 * says two true things and no false one:
 *
 *     Red · was due in 15 min · signal lost 3 min ago
 *
 * Both halves are statements about the PAST, so both stay true whatever the
 * bus turns out to be doing. Nothing ticks: the number is the last estimate
 * made while the bus was still reporting, frozen at that value, because a
 * countdown is a claim about the future and there is no longer any evidence
 * for one. It is a memory of a promise, not an estimate.
 *
 * AND THE NEXT CONFIRMED BUS IS SHOWN BESIDE IT, which is the half that makes
 * the row safe. The rider sees "#304 was due in 15 but has gone quiet" AND
 * "#310 in 42", and decides for themselves whether to wait or walk. Today they
 * are shown only the 42 and are left to wonder what happened to the eight.
 * Nothing is withheld by keeping the ghost; something is added.
 *
 * WHEN THE ROW GOES. At the earlier of two bounds, and then it goes with the
 * same honesty as a departure — no fanfare, and the next confirmed bus is
 * what remains, which is exactly what the app shows today:
 *
 *  - **The promise is spent.** A bus that was due in 3 minutes and has been
 *    silent for 4 has nothing left to say; a rider who could still have
 *    caught it would have caught it. `STOP_DWELL_SEC` of slack is allowed on
 *    top, because that is the window in which a bus that arrived unseen would
 *    still be boardable.
 *  - **The grace expires.** {@link GHOST_GRACE_MS}, the knee of the return
 *    curve above: returns arrive at ~3.8 percentage points a minute out to
 *    ten minutes, then 1.7 (10-15), 0.65 (15-20), 0.22 (20-30). Past ten
 *    minutes a longer memory buys a stale row rather than a reunion.
 *
 * A bus due in 40 minutes that goes quiet is therefore held for ten, not
 * forty; a bus due in two is held for three.
 *
 * A RETURNING BUS COMES BACK NEAR, BUT NOT AT, WHERE IT WENT. Of the gaps
 * that end within ten minutes, 96% end within 600 m of the vanishing point and
 * the median is 0 m — but the median hides the shape: #304 came back ~500 m
 * away in a parking lot off its own route, so a reconciliation radius measured
 * in tens of metres would have called it a different vehicle. It is not one.
 * Nothing here has to decide that, because the collector reconciles by TRACK
 * KEY, which is the bus name, and the returning bus simply writes over its own
 * entry wherever it is.
 *
 * ⚠️ A FRESHLY REISSUED ID CARRIES A GARBAGE `last_stop_id`. #304 came back
 * claiming Union Station (N), Red index 0 — seventeen hops from where it
 * actually was. The anchor must come from GPS alone until the feed catches up.
 * That belongs to `anchor.ts` / `anchorGate.ts` and is NOT fixed here; it is
 * written down because the ghost makes it reachable more often (a bus that
 * returns is now a bus a rider may still have on screen), and because the
 * measurement above says every one of the 3,136 reissue gaps returns under a
 * new id — so this is the normal case, not an edge one.
 *
 * WHAT IS NOT BUILT, AND THE MEASUREMENT THAT SAYS IT COULD BE. Where a bus
 * goes quiet predicts whether it returns, hugely: at LEPH / 60 College 70% are
 * back inside ten minutes and at Orange / Edwards (N) 78%, against 0% at
 * Prospect / Sachem (N), 0% at Willow / Whitney and 2% at Union Station (N),
 * on a 33% baseline. A per-stop table could tune the grace. It is deliberately
 * not built: the row makes no claim about the bus returning, so the return
 * rate does not change a word of what is shown — it would only shorten or
 * lengthen how long a true sentence stays on screen, and that is not worth a
 * new calibrated table. The numbers are recorded here so the next reader does
 * not have to re-measure to find that out.
 */

/**
 * How long a bus is remembered after it stops reporting. MIRRORS
 * `GHOST_BUS_TTL_MS` in `src/collector/collector.ts`, which is the bound that
 * actually decides whether the payload still carries the bus at all — this
 * one only decides whether the row is still drawn. `ghost.test.ts` parses the
 * server's constant out of its source so the two cannot drift, the same way
 * `walk.test.ts` pins the walk model.
 */
export const GHOST_GRACE_MS = 10 * 60_000;

/**
 * Slack past the remembered promise before the row goes, in seconds. It is
 * `STOP_DWELL_SEC` (planner.ts) by construction and for its reason: a bus
 * dwells about a minute, so for a minute past its due time a rider arriving at
 * the stop could still have boarded it.
 */
export const PROMISE_SLACK_SEC = 60;

/** How long a ghost promising `wasDueSec` is kept on screen. */
export function ghostGraceMs(wasDueSec: number): number {
  return Math.min(GHOST_GRACE_MS, Math.max(0, wasDueSec + PROMISE_SLACK_SEC) * 1000);
}

/** Is a bus last seen at `offlineSinceMs`, which was due in `wasDueSec`, still worth showing? */
export function ghostStillShown(offlineSinceMs: number, wasDueSec: number, now: number): boolean {
  return now - offlineSinceMs < ghostGraceMs(wasDueSec);
}

/**
 * THE PROMISE MEMORY.
 *
 * `computeUpcomingArrivals` is re-run from scratch every poll and is otherwise
 * pure, so the only way a frozen number survives to the next poll is for
 * something to hold it. This is that something, and it is deliberately built
 * the same way as `hopPricing.ts`'s standing ceiling and the anchor gate's
 * memory: hung off the caller's own `AnchorStore` through a `WeakMap`, so a
 * hypothetical, a replay or a test that passes no store has NO memory and
 * therefore prices byte-identically to a tree without this file in it.
 *
 * A ghost with no remembered promise is not shown at all. That is the honest
 * answer for a page opened after the bus went quiet: we never told this rider
 * anything, so we have no promise to remind them of, and inventing one from a
 * frozen position would be the confident lie again.
 */
export interface Promised {
  /** The ETA, in seconds, exactly as it was last shown. Never recomputed. */
  etaSec: number;
  /** When it was shown, so a caller can bound how old a promise it is holding. */
  atMs: number;
  /** Carried so the ghost row is the row the rider was looking at, in full. */
  stopsAhead: number;
  estimated: boolean;
}
const promises = new WeakMap<object, Map<string, Promised>>();

/** The key a promise is filed under: one vehicle, one stop. */
export function promiseKey(anchorKey: string, stopId: number): string {
  return `${anchorKey}|${stopId}`;
}

/**
 * File this poll's live estimate. Called only for a bus that is REPORTING, so
 * the memory always holds the last thing the rider was actually told.
 *
 * Only the soonest entry is kept. `computeUpcomingArrivals` walks the loop
 * twice and can emit the same vehicle twice for one stop — this lap and the
 * next — and the promise a rider was watching is the first one.
 */
export function rememberPromise(
  store: object | undefined, key: string, promise: Omit<Promised, "atMs">, now: number,
): void {
  if (!store) return;
  let m = promises.get(store);
  if (!m) promises.set(store, (m = new Map()));
  const prev = m.get(key);
  if (prev && prev.atMs === now && prev.etaSec <= promise.etaSec) return;
  m.set(key, { ...promise, atMs: now });
}

/**
 * The last thing this rider was told about this bus at this stop, or null.
 *
 * A PROMISE OLDER THAN THE GRACE IS NOT A PROMISE, and this is where that is
 * enforced rather than left to the caller. Red #304 is the case: it went quiet
 * at 13:47, its row expired, and it came back at 14:06 under a new id — 18
 * minutes, well past any grace. If it had then gone quiet AGAIN before the
 * estimator got round to re-pricing its board stop, the entry from 13:47 would
 * still have been sitting here, and the fresh `offline_since` would have made
 * "was due in 15 min" look newly minted. Checking the promise's own age closes
 * that: the memory is only ever as good as the last time we actually said it.
 *
 * Nothing is swept on a timer. An expired entry can never be returned, and the
 * map is bounded by the fleet times the stops on screen.
 */
export function recallPromise(
  store: object | undefined, key: string, now: number,
): Promised | null {
  if (!store) return null;
  const held = promises.get(store)?.get(key);
  if (!held || now - held.atMs >= GHOST_GRACE_MS) return null;
  return held;
}

/**
 * There is deliberately no `forgetPromise`. A bus that starts reporting again
 * overwrites its own entry on the next poll, and a promise older than the
 * grace can never be shown, so nothing needs clearing — and a clear would be
 * a way for the memory to be emptied at exactly the moment it is wanted.
 */
