// ── Walking model ──────────────────────────────────────────────────────────
//
// One number decides every walk estimate the rider sees: the walk legs of a
// planned trip, the "walk N min" direct option, and the 60-minute cutoff that
// decides whether the walk option is offered at all. It therefore has to agree
// with the SERVER planner, because both answer the same question about the same
// trip and the rider can see both.
//
// The server (src/network/TransitNetwork.ts) is the reference:
//
//     WALK_M_PER_S = 1.1;  seconds = crowFliesMeters / WALK_M_PER_S
//
// i.e. an EFFECTIVE rate applied to straight-line distance, absorbing the
// street detour rather than applying it separately. The client used to run its own model — 1.3 m/s over a
// 1.2× street detour, an effective 1.083 m/s — which is 29% slower for the same
// two points. That disagreement is not cosmetic: report #35 was a 4.3 km trip
// the server called a 53-minute walk and the client called 66 minutes, which is
// past the one-hour cutoff, so the client suppressed the walk option and showed
// "No trip options found" for a trip that had a perfectly good answer.
//
// The client now pins the same effective rate. The detour factor stays in the
// model rather than being quietly folded away, because the drawn walk path and
// the "how far is that really" reasoning both depend on it: crow-flies
// understates real walking, measured against OSRM foot routes across six
// representative campus pairs at ratios 1.05–1.38, mean ~1.22.
//
// The first pass at this reconciled the client UP to the server's old 1.4,
// which made both ends agree at a pace nobody walks: 1.4 m/s over crow-flies
// with a 1.22 detour is ~1.68 m/s (≈6 km/h) on real pavement. The server has
// since been corrected to 1.1 — an unhurried 1.3 m/s ground pace divided by
// that measured 1.22 detour — and the client follows it here. Estimates are now
// both consistent AND honest. Change the server first, never one side alone.

/**
 * Effective walking rate over CROW-FLIES distance, m/s.
 * MUST stay equal to `WALK_M_PER_S` in `src/network/TransitNetwork.ts`.
 */
export const WALK_EFFECTIVE_M_S = 1.1;

/** Street-network detour multiplier over crow-flies distance. */
export const WALK_DETOUR = 1.2;

/**
 * Implied pace over the ground actually walked, m/s. Derived, not tuned —
 * it is whatever the two constants above require.
 */
export const WALK_SPEED_M_S = WALK_EFFECTIVE_M_S * WALK_DETOUR;

/** Seconds to walk `m` metres of crow-flies distance. */
export const walkSecFromMeters = (m: number) => (m * WALK_DETOUR) / WALK_SPEED_M_S;

/**
 * Drop the standalone walk-only option once the direct walk exceeds an hour —
 * nobody plans a 60+ min walk across New Haven. Mirrors the server's
 * WALK_ONLY_MAX_SEC. `planTrip` overrides this when walking is the ONLY option
 * it has (report #35): suppressing clutter is fine, suppressing the last option
 * is not.
 */
export const WALK_ONLY_MAX_SEC = 3600;

/**
 * Maximum walk leg (origin → board stop, or alight stop → destination).
 * Mirrors the server's MAX_WALK_M. The `walkDoesntDominate` check in planTrip
 * stops the generous ceiling from producing silly detours.
 */
export const MAX_WALK_M = 1500;
