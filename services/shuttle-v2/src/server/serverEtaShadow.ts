/**
 * THE DUAL RUN — what the server's belief would have said, beside what the
 * browser actually showed.
 *
 * `docs/server-side-eta.md` argues the move from a mechanism: every browser
 * holds its OWN belief, so a rider who just opened the app has a cold one and
 * a rider with a tab open has a warm one, and they see different numbers for
 * the same bus at the same instant. The parity suite proves the two sides run
 * the same code; it cannot say what the WARMTH is worth to a rider, because a
 * captured 40-poll fixture is not a day and a test is not the fleet.
 *
 * So the server records its own answer into `predictions_log` under
 * {@link SERVER_SURFACE}, exactly the way `collector/upstreamEta.ts` records
 * the operator's under `upstream`: same table, same 15 s dedup bucket, same
 * `truthAt` rule, same `arrivals` rows to pair against. Comparing the switch's
 * two arms is then a query, not an argument — and it is a query over the very
 * (bus, stop, instant) triples riders were looking at, not over a sample
 * somebody chose.
 *
 * ## Why a rider's post drives it, and not a timer
 *
 * A shadow row is only worth writing where a rider row exists to compare it
 * against. Pinning the volume to the rider surface's own (~3k rows a day)
 * is also what keeps this out of the disk arithmetic that gave `upstream` its
 * separate 7-day sweep: a census of the allowlisted lines would be ~100 rows
 * per 15 s bucket, ~500k a day, on a volume with ~430 MB free.
 *
 * ## What it is not
 *
 * It is not a rider surface. Nothing under `server` was ever on a screen, and
 * `RIDER_SURFACES_SQL` excludes it for a sharper reason than it excludes
 * `upstream`: pooling a shadow arm into "how accurate are WE" would let a
 * candidate flatter the very measurement it is being judged on.
 *
 * It is not claimable from outside either. `server` is in
 * `PREDICTION_SURFACES` (what the COLUMN may hold) and NOT in
 * `SHOWN_SURFACES` (what a browser may claim it displayed), and
 * `PredictionRecorder.shadow` refuses a shown surface outright.
 */
import { SERVER_SURFACE, type PredictionRecorder, type RecordContext, type ShownReading } from "./predictions.js";
import type { ServerEta } from "./serverEta.js";

/**
 * The oldest belief worth filing as a shadow of this reading.
 *
 * The rider's reading and the server's pass are not the same instant: the
 * client sends an AGE and the server stamps its own pass. Within a poll or two
 * that is a like-for-like comparison; a belief minutes stale is a comparison
 * of two different moments dressed as one, which is the failure mode that
 * makes a head-to-head meaningless. Three collector polls.
 */
export const MAX_SHADOW_SKEW_MS = 15_000;

/**
 * File the server's answer for the (bus, stop) pairs a rider just reported.
 *
 * Never throws: a shadow row is a measurement, and a measurement may not cost
 * a rider their POST. Returns how many rows were accepted, for the tests.
 */
export function recordServerShadow(
  recorder: PredictionRecorder,
  engine: ServerEta,
  readings: readonly ShownReading[],
  ctx: RecordContext,
): number {
  try {
    const now = ctx.now ?? Date.now();
    const shadow: ShownReading[] = [];
    // One row per (bus, stop): the rider may have reported the same pair from
    // two screens, and the server has exactly one answer either way.
    const seen = new Set<string>();
    for (const r of readings) {
      const key = `${r.busName}|${r.stopId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = engine.lookup(r.busName ?? "", r.stopId);
      if (!hit) continue;
      const ageMs = now - hit.at;
      if (!(ageMs >= 0) || ageMs > MAX_SHADOW_SKEW_MS) continue;
      shadow.push({
        busName: r.busName,
        stopId: r.stopId,
        etaSec: hit.eta,
        lowSec: hit.low,
        highSec: hit.high,
        stopsAhead: hit.stopsAhead,
        // Carried through unchanged so the recorder's own validation sees a
        // shape it recognises; `shadow()` overrides which surface is written.
        surface: r.surface,
        // The server's own pass instant, not the rider's. What it said, and
        // when it said it — the dedup bucket is derived from this.
        ageMs,
      });
    }
    if (shadow.length === 0) return 0;
    return recorder.shadow(shadow, SERVER_SURFACE, ctx);
  } catch {
    return 0;
  }
}
