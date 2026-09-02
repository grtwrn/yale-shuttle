// ── Cycling model ──────────────────────────────────────────────────────────
//
// Report #60: "Add bike option with toggle of whether I use bike or not."
// Riders who own a bike want to know when pedalling beats standing at a stop.
// The bike option is OFF by default and only appears once the rider says they
// have one — most riders don't, and a bike row they can't use is clutter.
//
// The model deliberately mirrors `walk.ts` in shape so the two are comparable
// at a glance: an EFFECTIVE rate applied to CROW-FLIES distance, with the
// street detour folded in rather than applied separately. That matters here
// because the bike option is ranked against the walk option and the shuttle
// options, and all three must be measuring the same geometry — a bike time
// computed over the street network next to a walk time computed over the crow
// flies would flatter the bike by ~20% for free.
//
// BIKE_SPEED_M_S is a ground pace over the pavement actually ridden, not a
// sprint: 4.2 m/s is 15 km/h, which is the usual figure for casual urban
// cycling once traffic lights, crossings and dismounts are averaged in.
// Divided by the same 1.2 detour walk.ts measured against OSRM foot routes,
// that is an effective 3.5 m/s over the straight line — about 3.2x the
// walking estimate, which is the right order for short campus trips where the
// bike's advantage is eaten by stopping and locking up.
//
// There is no server counterpart to keep in step: the backend planner
// (`/api/plan`) has no bike mode, and this option never affects shuttle
// timings. If a bike mode is ever added there, do what walk.ts does — make
// the server the reference and pin this file to it.

import { WALK_DETOUR } from "./walk";

/** Ground pace over the pavement actually ridden, m/s (≈15 km/h). */
export const BIKE_SPEED_M_S = 4.2;

/**
 * Effective cycling rate over CROW-FLIES distance, m/s. Derived from the
 * ground pace and the shared street-detour factor — not tuned separately, so
 * a change to either input moves walking and cycling together.
 */
export const BIKE_EFFECTIVE_M_S = BIKE_SPEED_M_S / WALK_DETOUR;

/** Seconds to ride `m` metres of crow-flies distance. */
export const bikeSecFromMeters = (m: number) => m / BIKE_EFFECTIVE_M_S;

/**
 * Below this the bike is not worth offering: unlocking, riding and locking up
 * again costs more than the couple of minutes saved, and the row would just
 * push a real answer down the list. 400 m is under 7 minutes of walking.
 */
export const BIKE_MIN_M = 400;

/**
 * The upper bound, mirroring WALK_ONLY_MAX_SEC. An hour of cycling is ~12.6 km
 * — far outside the shuttle's New Haven footprint — so past this the rider is
 * planning a different kind of journey than this app answers.
 */
export const BIKE_ONLY_MAX_SEC = 3600;

/**
 * Is a bike option worth showing for a trip of `m` crow-flies metres?
 * Distance only: whether the RIDER has a bike is a separate question, answered
 * by the toggle (`bikePref.ts`).
 */
export function bikeWorthOffering(m: number): boolean {
  if (m < BIKE_MIN_M) return false;
  return bikeSecFromMeters(m) <= BIKE_ONLY_MAX_SEC;
}
