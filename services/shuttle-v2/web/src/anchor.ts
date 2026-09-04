// Locating a bus on its route's stop sequence, and rejecting buses that aren't
// on the route at all. Extracted from TransitMap.tsx: this is the single most
// bug-prone piece of maths in the app (reports #27, #32, #37, #38 all landed
// here) and it deserves to be tested directly.

import { distanceToSegmentM, haversineMeters, traceStopLegs } from "./geo";
import type { LatLon } from "./geo";

// Drop buses whose GPS sits far from the route.
// TransLoc keeps reporting a bus when it's parked at a depot or
// deadheading between shifts — at the Hamden yard we see Red bus #122
// show up ~2 km north of the route, creating phantom arrivals and
// stranded pins on the minimap. 500 m is generous enough to tolerate
// routes that briefly drift off the stop-list geometry (shortcut
// turns, etc.) while rejecting anything that's genuinely off-route.
export const OFF_ROUTE_THRESHOLD_M = 500;

// "Far from the route" is measured against the route's road polyline when
// we have one, and only falls back to "far from every stop" when we don't.
// The stop test alone is wrong for routes with long stopless legs: Purple's
// Building 900 → LEPH hop is 6.7 km and Green's 81 → 26 is 8.2 km with no
// stop in between, so a bus honestly on the highway sat > 500 m from every
// stop for 50–60 % of its lap and vanished from the boards and planner
// (while the map, which does not filter, still drew it). Measured against
// the served `route_paths`: 51 % of Green's and 50 % of Purple's polyline
// fails the stop test; 0 % fails the polyline test by construction.
//
// The polylines arrive in the same `/api/buses` payload as the buses, so
// the shell registers them here once per poll rather than threading a new
// argument through every caller of `isBusOnRoute`.
let routePathsById: Record<string, readonly (readonly [number, number])[]> = {};

export function registerRoutePaths(
  paths: Record<string, readonly (readonly [number, number])[]> | null | undefined,
): void {
  routePathsById = paths ?? {};
}

function distanceToPathM(bus: LatLon, path: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = { lat: path[i]![0], lon: path[i]![1] };
    const b = { lat: path[i + 1]![0], lon: path[i + 1]![1] };
    const d = distanceToSegmentM(bus, a, b);
    if (d < best) {
      best = d;
      if (best < OFF_ROUTE_THRESHOLD_M) break; // good enough — on route
    }
  }
  return best;
}

export function isBusOnRoute(
  bus: LatLon & { route_id?: number | string },
  stops: number[],
  stopCoords: Record<number, LatLon>,
): boolean {
  if (!bus.lat || !bus.lon) return true; // no GPS → don't filter
  const path = bus.route_id !== undefined ? routePathsById[String(bus.route_id)] : undefined;
  if (path && path.length >= 2) {
    return distanceToPathM(bus, path) < OFF_ROUTE_THRESHOLD_M;
  }
  let bestM2 = Infinity;
  for (const sid of stops) {
    const sc = stopCoords[sid];
    if (!sc) continue;
    const dlat = (bus.lat - sc.lat) * 111_000;
    const dlon = (bus.lon - sc.lon) * 84_000;
    const m2 = dlat * dlat + dlon * dlon;
    if (m2 < bestM2) bestM2 = m2;
    if (bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M) return true;
  }
  return bestM2 < OFF_ROUTE_THRESHOLD_M * OFF_ROUTE_THRESHOLD_M;
}

// Locate a bus on a route's stop sequence. First-principles algorithm:
//
//   1. Find all legs stops[i] → stops[i+1] within GPS_THRESHOLD_M of
//      the bus's actual GPS — these are plausible candidates. A leg is
//      the ROAD between the two stops (the published polyline), not the
//      chord; see ANCHOR_FEED_LEAD_HOPS' neighbour below for why.
//   2. If the feed provides last_stop_id and it's on the route, DROP any
//      candidate more than ANCHOR_FEED_LEAD_HOPS ahead of it — that is
//      what keeps a route which revisits a vicinity (Red passes 130
//      Prospect on both the inbound and outbound legs) off the wrong
//      side of its own fold. Among the survivors the bus's own GPS
//      decides, with forward order breaking a tie the GPS cannot call.
//   3. If no leg is within threshold (bus is genuinely off-route or on
//      a part of the route the stop list doesn't model), fall back to
//      the globally-nearest leg.
//
// Returns the starting-stop index of the segment. The downstream step
// loop treats this as "bus is currently on segment i → i+1" which is
// the correct mental model for both dwelling-at-stop and mid-segment
// cases.
export const ANCHOR_GPS_THRESHOLD_M = 150;

/**
 * How far AHEAD of the feed's `last_stop_id` a candidate leg may be and still
 * be believed. Beyond it the candidate is DROPPED; among the survivors the
 * bus's own GPS decides.
 *
 * WHY IT IS AN EXCLUSION AND NOT A PREFERENCE (report #95). The old rule sorted
 * every in-range candidate by forward distance from `last_stop_id` and used GPS
 * only to break ties, so among adjacent candidates it always took the EARLIEST
 * — however far away the bus actually was from it. That is fine while the feed
 * is fresh and catastrophic when it is not, and it is often not: on Red #316,
 * 2026-09-04, upstream froze `last_stop_id` at Whitney / Audubon for **seven
 * minutes, 2.6 km and five stops**. With `lastIdx` stuck that far back the sort
 * degenerates to "take the earliest leg in range", which is the one furthest
 * behind:
 *
 *   11:38:26  130 Prospect (N) -> Winchester / Sachem   32 m (fwd 2)  LOST to
 *             Trumbull / Hillhouse -> 130 Prospect (N) 145 m (fwd 1)
 *   11:41:27  Canal / Munson -> 344 Winchester          46 m (fwd 4)  LOST to
 *             Winchester / Sachem -> Canal / Munson    136 m (fwd 3)
 *             — though `stop_visits` has the bus standing AT Canal / Munson
 *               11:40:02-11:41:17 and already gone.
 *
 * `at_stop_id` was silently doing the job the sort should have done (it fires
 * within ~75 m of a stop and may advance the anchor by one), so between stops
 * the anchor simply sat a stop back for the whole hop. When the flag finally
 * caught up at 11:42:01 the anchor jumped Canal / Munson -> 344 Winchester and
 * the rider's countdown went **10 min to 5 min in one poll**. The bus reached
 * Division / Prospect 322 s later: the 5 was right, and the hop that vanished
 * was 344 Winchester's layover (median stand 4:31). One stop of lag on Red is
 * worth five minutes.
 *
 * WHY IT STAYS. Withholding `last_stop_id` entirely was measured and is worse
 * (jumps over five minutes 16,128 -> 24,986, see `anchorGate.ts`), and the
 * exclusion is why: at 11:36:46 the nearest leg to #316 was SCL -> 130 Prospect
 * (S) at 128 m, TEN stops ahead on the far side of Red's fold. Choosing it
 * would have skipped the whole Winchester loop. Forward distance is the only
 * thing that rules that out, so it must keep ruling it out.
 *
 * FIVE, from the sweep (`scripts/eta-replay/anchor-sweep.ts`, 54,920 scored
 * positions over 2026-09-03's 6.5 h of `raw_positions`, scored against the
 * detector's own anchor). Anchor-behind-the-detector, all routes / Red:
 *
 *   master (sort)   17.71% / 9.10%
 *   window 3        10.06% / 0.58%      window 6   9.32% / 0.75%
 *   window 4         9.68% / 0.63%      window 8   9.25% / 0.96%
 *   window 5        10.21% / 0.42%      window 10  9.87% / 0.72%
 *
 * The curve is flat from 3 to 8 and every value beats the sort by 8 points, so
 * this is not a tuned optimum and should not be re-tuned as one. 5 is chosen
 * because it is the smallest window that covers the freeze that was actually
 * observed — five stops — while staying well under Red's fold separation of
 * ten. Below 3 a longer freeze starts excluding the truth; above 8 the fold
 * comes back.
 */
export const ANCHOR_FEED_LEAD_HOPS = 5;

/**
 * How much nearer one candidate leg must be than another before GPS is allowed
 * to overrule forward order. Inside this band the legs are treated as
 * indistinguishable and `last_stop_id` breaks the tie, exactly as it always
 * did.
 *
 * THE BAND IS THE WHOLE SAFETY OF THE RULE ABOVE, and it has two measured
 * bounds that leave one narrow range.
 *
 * FROM BELOW — the folds. Two anti-parallel legs of an out-and-back sit within
 * tens of metres of each other, and choosing between them by distance does not
 * cost a stop, it costs a LAP. `scripts/eta-replay/branch-lock.ts` counts
 * exactly that (the anchor a quarter of the loop out of position), replaying
 * the whole 2026-09-03 capture through the production sequence:
 *
 *   band        Green    Purple   Blue Day   Orange Day
 *   master      11.1%     22.2%       0.3%         0.5%
 *   30 m        13.7%     27.8%       1.2%         0.0%
 *   60 m        12.7%     26.0%       0.3%         0.0%
 *   80 m        11.1%     22.2%       0.3%         0.0%
 *
 * At 80 m the two out-and-backs are back exactly where master had them and
 * Orange Day's improvement is kept. **Anything smaller trades the folds for
 * the incident**, which is not a trade to make: `docs/rider-sim.md` prices a
 * lap on Green and Purple at more than anything the incident costs.
 *
 * FROM ABOVE — the incidents. Red #316's two disputed polls are 32 m against
 * 145 m and 46 m against 136 m, so the band must stay under 90 m or the second
 * one goes back to the feed's stale answer. 80 is the largest round value that
 * clears it.
 *
 * It also settles the jitter that has its own shipped test. The two legs
 * meeting AT a stop are both ~0 m from a bus standing there, so with no band
 * the choice between "has reached this stop" and "is still approaching it" is
 * float noise: displacing a bus perpendicular to the road by up to 30 m at
 * every stop on the network (`scripts/eta-replay/jitter-probe.ts`, 274 stops)
 * changes the anchor at 96.7% of them with no band, 10.6% at 15 m, 0.7% at
 * 30 m and 0.0% from 60 m up. Each flip adds or removes that stop's whole
 * dwell, which is report #32's "6 min then 16 min".
 */
export const ANCHOR_NEARER_M = 80;

// --- what a leg IS: the road, not the chord ---------------------------------
//
// Step 1 above measured the bus against the straight line between two stops,
// and a straight line between two stops is not where a bus drives. Blue West's
// Canal / Munson → Mansfield / Division is a 573 m hop whose road bows more
// than 200 m off its own chord, so a bus honestly ON that leg is 121–211 m
// from the chord and drops out of the candidate set entirely. Blue West #126,
// 2026-09-03 21:37 ET (PR #122's handover trace, in UTC):
//
//   poll      chord d[7]   chord d[8]   candidates   anchor   shown
//   01:37:40    121 m        230 m         [7]          7      in 1, 40 min
//   01:37:45    186 m        143 m         [8]          8      in 38, 77 min
//   01:37:50    211 m        109 m         [8]          8
//   01:38:00    149 m         96 m        [7, 8]        7
//   01:38:25      0 m         16 m        [7, 8]        7      at the kerb
//
// Leg 8 is the RETURN down the same road. For three polls it was the only
// candidate, so the fold's direction filter had nothing to compare it against,
// `gateAnchor` took the +1 hop on one 30 m deadband step, and a bus 33 s from
// the kerb was re-priced a lap away. The "in 1" was right; the 37 min was the
// excursion. Whenever leg 7 WAS a candidate it won outright — the selection
// rule never mattered here, the window did.
//
// This is the same mistake as the straight diagonals on the map, and it has
// the same fix: `traceStopLegs` projects each stop onto the published polyline
// and returns the piece of road between them. Measuring to that piece is
// measuring to where the bus can actually be.
//
// Degrades exactly to the old behaviour where it must: a route with no
// registered path (a unit test, an older payload), a stop with no coordinate,
// or a leg the trace could not supply all fall back to the chord — which is
// what `traceStopLegs` itself returns for a bridged leg.
//
// COST. Measuring to a road rather than a chord means walking the polyline, so
// a leg costs its own vertex count instead of one segment. A bounding box per
// leg, computed once with the geometry, skips every leg the bus cannot be near
// — which is all but two or three of them — and holds a whole-route anchor to
// 6.8 us against the chord's 2.3 (2,000 laps of all 15 routes on this Pi,
// `scripts/eta-replay/anchor-bench.ts`). Without the box the same call is
// 13 us, and the browser makes several hundred of them every five seconds.
interface LegGeom {
  line: readonly (readonly [number, number])[];
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}
//
// CACHED ACROSS POLLS, and that is the point. `registerRoutePaths` is called
// with a freshly parsed object on every `/api/buses` response, so invalidating
// on identity would rebuild all fifteen routes every five seconds: 9.9 ms of
// main-thread work on this Pi against 0.15 ms warm, and a phone is slower
// still. The published geometry does not change between polls, so an entry is
// kept until the polyline's CONTENT differs.
interface CacheEntry { builtFrom: readonly (readonly [number, number])[]; legs: LegGeom[] | null }
const legGeomCache = new Map<string, CacheEntry>();

function samePolyline(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

function legGeometry(
  routeId: string | number | undefined,
  stops: number[],
  stopCoords: Record<number, LatLon>,
): LegGeom[] | null {
  if (routeId === undefined) return null;
  const path = routePathsById[String(routeId)];
  if (!path || path.length < 2) return null;
  const key = `${routeId}|${stops.join(",")}`;
  const hit = legGeomCache.get(key);
  if (hit && samePolyline(hit.builtFrom, path)) {
    hit.builtFrom = path; // skip the element-wise compare next poll
    return hit.legs;
  }
  let out: LegGeom[] | null = null;
  const ring: LatLon[] = [];
  for (const sid of stops) {
    const c = stopCoords[sid];
    if (!c) { ring.length = 0; break; }
    ring.push(c);
  }
  if (ring.length === stops.length && ring.length >= 2) {
    // Close the ring: leg i is stops[i] → stops[i+1 mod N], the wrap included.
    ring.push(ring[0]!);
    const legs = traceStopLegs(path as [number, number][], ring);
    if (legs.length === stops.length) out = legs.map((l) => boxOf(l.slice));
  }
  legGeomCache.set(key, { builtFrom: path, legs: out });
  return out;
}

function boxOf(line: readonly (readonly [number, number])[]): LegGeom {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of line) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { line, minLat, maxLat, minLon, maxLon };
}

/**
 * Metres from a point to a leg's bounding box — zero inside it, and always a
 * LOWER bound on the distance to the leg itself, so a box beyond the threshold
 * proves the leg is too.
 */
function boxLowerBoundM(p: LatLon, g: LegGeom): number {
  const dLat = p.lat < g.minLat ? g.minLat - p.lat : p.lat > g.maxLat ? p.lat - g.maxLat : 0;
  const dLon = p.lon < g.minLon ? g.minLon - p.lon : p.lon > g.maxLon ? p.lon - g.maxLon : 0;
  return Math.hypot(dLat * 111_000, dLon * 84_000);
}

/** Distance from a point to a leg's road, in metres. */
function distanceToPolylineM(p: LatLon, g: LegGeom): number {
  const line = g.line;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = { lat: line[i]![0], lon: line[i]![1] };
    const b = { lat: line[i + 1]![0], lon: line[i + 1]![1] };
    const d = distanceToSegmentM(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

// --- which way is it going? -------------------------------------------------
//
// Steps 1–2 above are the whole algorithm on a plain loop, and they are not
// enough on an out-and-back. Green and Purple run out to West Campus and back
// along the same road, so the SAME coordinates belong to two legs at once —
// the outbound chord and the inbound chord, anti-parallel, both well inside
// GPS_THRESHOLD_M. A point-valued anchor must choose, and choosing wrong is
// not a small error: it puts the bus a full lap out of position. Measured on
// 2026-09-03's capture, the anchor is shown a lap wrong at 118 of 380 Purple
// departures and 104 of 383 Green ones. `last_stop_id` cannot break the tie —
// it lags at every arrival and was observed frozen at Orange / Willow for an
// entire 5 km I-95 run — and neither can distance: on that run the bus was
// 135 m from the outbound chord and 139 m from the inbound one.
//
// But a MOVING bus says which branch it is on, with no filter, no belief and
// no state beyond the last fix it actually moved to: across two distinct
// fixes, progress along the outbound chord rises and progress along the
// inbound chord falls. So when two candidate legs point opposite ways, the
// direction of travel decides between them and nothing else has to.
//
// A STATIONARY bus on a shared segment with no history is genuinely
// undecidable — the information is not in the feed — so this deliberately
// does nothing there rather than guess. `anchorGate.ts` holds the previous
// branch, which is the right answer in the absence of evidence.
//
// HOW MUCH OF THE PROBLEM THIS IS. Over the 2026-09-03 capture, counting the
// polls where two candidate legs within GPS_THRESHOLD_M run anti-parallel:
//
//   route   ambiguous polls   bus moving   within 100 m of a stop   direction decides
//   Green      55.2%             57.8%            58.8%                  76.8%
//   Purple     44.9%             42.0%            68.2%                  57.2%
//   Red        27.5%             42.9%            82.6%                  70.5%
//
// So the two folds are not one problem. Green's ambiguity is largely open
// road — the I-95 run, where the bus is moving and direction settles it three
// times in four. Purple's sits at station loops (333 Cedar, Buildings
// 400/600/800/900), where the bus is frozen on 58% of the ambiguous polls and
// direction can settle barely half. **Purple's remainder is the half this
// cannot fix**, and it is the half `docs/eta-estimator-design.md` says needs a
// distribution rather than a point. That is why the rider numbers below move
// Green further than Purple, and it is not a tuning failure.

/**
 * The feed publishes a new coordinate only once a bus has moved ~30 m (2 of
 * 33,118 distinct fixes moved less, whether 5 s or 20 s elapsed). So 30 m is
 * the smallest displacement that proves any movement at all — below it there
 * is no direction to read, only noise.
 */
export const ANCHOR_DIRECTION_MIN_M = 30;

/**
 * How much of a heading disagreement counts. cos ≥ +0.6 is "the bus is
 * travelling this leg's way" (within ~53°); cos ≤ −0.6 is "this leg runs
 * against the bus", more than 127° from the step. Everything between is
 * uninformative — a leg at right angles to the step says nothing, a leg
 * mid-turn even less — and is left alone.
 *
 * **0.6 is measured, and looser is worse.** Swept on the rider simulator
 * (8,327 paired waits, 2026-09-03 capture), strand share Green / Purple /
 * Red-holdout: master 32.3 / 29.5 / 18.0%, **0.6 → 27.4 / 27.1 / 18.2**,
 * 0.15 → 27.2 / 27.7 / 20.3, 0.0 → 24.3 / 30.2 / 20.7. Loosening keeps
 * helping Green and starts hurting Purple and Red, and it is clear why: on
 * Red 82.6% of the polls with two anti-parallel candidate legs are within
 * 100 m of a stop, where the "step" between two fixes is a bus shuffling at a
 * kerb rather than a bus travelling. At 127° only a genuine reversal passes,
 * which is the fold and nothing else.
 *
 * (A branch-lock count against the detector's own anchor prefers 0.0 on every
 * route — `scripts/eta-replay/branch-lock.ts`. It is the wrong instrument to
 * decide this on: it scores an index, and the rider reads a countdown.)
 */
export const ANCHOR_DIRECTION_COS = 0.6;

/**
 * The previous DISTINCT fix this bus reported — the other end of the step
 * whose direction is read. `anchorGate.ts` remembers it (`noteFix`); a caller
 * with no memory passes nothing and gets exactly the old behaviour.
 */
export type TravelHint = LatLon | null | undefined;

/**
 * Is the bus driving this leg's way? +1 with it, -1 against it, 0 no opinion —
 * the step is too short to be a step, the leg is broadside to it, or one of
 * the two has no length.
 *
 * NOT YET MEASURED AGAINST THE ROAD. The heading compared here is still the
 * CHORD's, stop to stop, while the candidate window above now measures to the
 * published line. On a straight leg they are the same bearing; on a bowed one
 * they are not, and the fold pairs this exists for (Green and Purple's West
 * Campus spurs, Blue West's Prospect return) are long and straight, which is
 * why it was left alone rather than changed on a guess. If someone takes it
 * up: the leg's own polyline is one call away (`legGeometry`), and the
 * instrument is the rider simulator, not a branch-lock index count.
 *
 * Exported for `scripts/eta-replay/branch-lock.ts`, which counts how often the
 * anchor lands a lap out of position; nothing in the app calls it directly.
 */
export function legAgreement(
  legIdx: number,
  bus: LatLon,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  travelFrom: TravelHint,
): 1 | 0 | -1 {
  const N = stops.length;
  if (!travelFrom || legIdx < 0 || legIdx >= N) return 0;
  if (haversineMeters(bus, travelFrom) < ANCHOR_DIRECTION_MIN_M) return 0;
  const a = stopCoords[stops[legIdx]!];
  const b = stopCoords[stops[(legIdx + 1) % N]!];
  if (!a || !b) return 0;
  const c = headingCos(travelFrom, bus, a, b);
  if (c === null) return 0;
  return c >= ANCHOR_DIRECTION_COS ? 1 : c <= -ANCHOR_DIRECTION_COS ? -1 : 0;
}

/** cos of the angle between a→b and prev→now, or null if either has no length. */
function headingCos(prev: LatLon, now: LatLon, a: LatLon, b: LatLon): number | null {
  // Local flat-earth frame: longitude degrees shrink by cos(lat), latitude
  // degrees do not, so both components are proportional to metres and the
  // ratio below is a true cosine.
  const scale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const lx = (b.lon - a.lon) * scale, ly = b.lat - a.lat;
  const dx = (now.lon - prev.lon) * scale, dy = now.lat - prev.lat;
  const ln = Math.hypot(lx, ly), dn = Math.hypot(dx, dy);
  if (ln < 1e-12 || dn < 1e-12) return null;
  return (lx * dx + ly * dy) / (ln * dn);
}

/**
 * ⚠️ MEASURED AND REJECTED, 2026-09-04. Everything below works and is not
 * shipped. Read this before writing it again.
 *
 * The hypothesis was that #128's two halves trade by route because Purple's
 * out-and-back puts two candidates on one road facing opposite ways, where
 * distance is a coin flip and forward order is right, while Red's disputes sit
 * on distinct geometry where the GPS should win. The test below identifies
 * folds correctly — it fires on Green 32.3% and Purple 31.4% of polls and on
 * Orange Day 0.00% and Blue Day 0.32% (`opposed-share.ts`) — so the premise is
 * true about WHERE THE FOLDS ARE.
 *
 * It is false about where Purple's cost is. Paired against the shipped state
 * over 29,013 waits (`rider-sim/pair-by-route.mjs`), riders FIXED/INTRODUCED:
 *
 *   route     strand    jump>=180   dropped
 *   Purple      9/9        9/14       9/7      <- unmoved, which is the point
 *   Pink       0/33       28/12      86/0      <- 33 newly stranded
 *   Green       0/3        7/12       1/8
 *   Red         0/2        1/7        0/0
 *   ALL        9/47       45/45      97/15     <- net +38 strands
 *
 * Forward-ranking exactly the opposed polls moves Purple by nothing, so its
 * regression is NOT concentrated on same-road-opposite-direction polls; the
 * window-only arm recovers Purple by ranking forward EVERYWHERE (82/28 strand
 * against this rule's 60/69). And Pink fires the same test at 18.1%, where
 * forward order is the wrong answer and costs 33 strands.
 *
 * So the next attempt must not be another way of asking "is this a fold". What
 * is still unexplained is which polls carry Purple's cost; find those first.
 *
 * ---
 *
 * Do these two candidate legs run along the SAME PIECE OF ROAD in opposite
 * directions?
 *
 * This is the question that decides whether GPS or the feed gets to rank them,
 * and it is a geometric one. On an out-and-back the two candidates are the same
 * tarmac facing opposite ways: a bus on it is genuinely equidistant from both,
 * the metres between them are noise, and choosing by distance is a coin flip
 * that costs a LAP. Everywhere else the disputed candidates lie on different
 * geometry — different streets, or the two sides of a corner — and there the
 * bus's own position is the better evidence and `last_stop_id` may be minutes
 * stale.
 *
 * Measured at the bus, not over the whole leg: a long leg turns, so its overall
 * bearing says nothing about the metre the bus is standing on. `legBearingAt`
 * takes the direction of the polyline segment nearest the bus (the chord's,
 * where no line is registered), and two legs count as one road when those point
 * more than 127 deg apart — {@link ANCHOR_DIRECTION_COS}, the same threshold
 * the fold's direction filter uses and for the same reason.
 */
function legBearingAt(
  p: LatLon,
  legIdx: number,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  legs: LegGeom[] | null,
): { x: number; y: number } | null {
  const scale = Math.cos((p.lat * Math.PI) / 180);
  const leg = legs?.[legIdx];
  let a: LatLon | undefined;
  let b: LatLon | undefined;
  if (leg && leg.line.length >= 2) {
    // the vertex pair whose segment the bus is nearest
    let best = Infinity;
    for (let i = 0; i + 1 < leg.line.length; i++) {
      const u = { lat: leg.line[i]![0], lon: leg.line[i]![1] };
      const v = { lat: leg.line[i + 1]![0], lon: leg.line[i + 1]![1] };
      const d = distanceToSegmentM(p, u, v);
      if (d < best) { best = d; a = u; b = v; }
    }
  } else {
    const N = stops.length;
    a = stopCoords[stops[legIdx]!];
    b = stopCoords[stops[(legIdx + 1) % N]!];
  }
  if (!a || !b) return null;
  const x = (b.lon - a.lon) * scale, y = b.lat - a.lat;
  const n = Math.hypot(x, y);
  return n < 1e-12 ? null : { x: x / n, y: y / n };
}

/** True when any two of these legs are the same road running opposite ways. */
function anyOpposed(
  p: LatLon,
  idxs: readonly number[],
  stops: number[],
  stopCoords: Record<number, LatLon>,
  legs: LegGeom[] | null,
): boolean {
  const dirs = idxs.map((i) => legBearingAt(p, i, stops, stopCoords, legs));
  for (let i = 0; i < dirs.length; i++) {
    const u = dirs[i];
    if (!u) continue;
    for (let j = i + 1; j < dirs.length; j++) {
      const v = dirs[j];
      if (!v) continue;
      if (u.x * v.x + u.y * v.y <= -ANCHOR_DIRECTION_COS) return true;
    }
  }
  return false;
}

export type AnchorBus = {
  lat: number;
  lon: number;
  last_stop_id?: number | undefined;
  at_stop_id?: number | undefined;
  /** Which route's published line to measure legs against, when one is registered. */
  route_id?: number | string | undefined;
};

export function findRouteAnchor(
  bus: AnchorBus,
  stops: number[],
  stopCoords: Record<number, LatLon>,
  /** Where the bus was at its previous distinct fix, if the caller remembers. */
  travelFrom?: TravelHint,
): number {
  const N = stops.length;
  if (N === 0) return -1;

  // No GPS — fall back to feed's last_stop_id (or 0 if not on route).
  if (!bus.lat || !bus.lon) {
    const idx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;
    return idx >= 0 ? idx : 0;
  }

  // Distance to each leg — to the ROAD between the two stops where the
  // published line supplies it, and to the chord where it does not.
  const legs = legGeometry(bus.route_id, stops, stopCoords);
  const dists: number[] = new Array(N);
  // `dists` holds an exact distance for every leg the bus could be near and a
  // lower bound for the rest — enough to decide candidacy and to rank the
  // candidates, which is all step 2 asks of it. The no-candidate fallback
  // re-measures, because there ranking the far ones is the whole question.
  let deferred = false;
  for (let i = 0; i < N; i++) {
    const leg = legs?.[i];
    if (leg && leg.line.length >= 2) {
      const lower = boxLowerBoundM(bus, leg);
      if (lower >= ANCHOR_GPS_THRESHOLD_M) { dists[i] = lower; deferred = true; continue; }
      dists[i] = distanceToPolylineM(bus, leg);
      continue;
    }
    const a = stopCoords[stops[i]];
    const b = stopCoords[stops[(i + 1) % N]];
    if (!a || !b) { dists[i] = Infinity; continue; }
    dists[i] = distanceToSegmentM(bus, a, b);
  }
  const exactDist = (i: number): number => {
    const leg = legs?.[i];
    return leg && leg.line.length >= 2 ? distanceToPolylineM(bus, leg) : dists[i]!;
  };

  const lastIdx = bus.last_stop_id != null ? stops.indexOf(bus.last_stop_id) : -1;

  // Candidates within threshold, sorted by forward distance from
  // last_stop_id (if available) so a route that revisits a vicinity
  // twice picks the right leg. Distance tiebreaker for ties.
  let candidates: number[] = [];
  for (let i = 0; i < N; i++) {
    if (dists[i] < ANCHOR_GPS_THRESHOLD_M) candidates.push(i);
  }

  // Two candidates that run opposite ways are the fold. Drop the ones the bus
  // is demonstrably NOT travelling, but only when the step is long enough to
  // be a step at all and only when some other candidate agrees with it — a
  // move that contradicts every candidate is evidence about the candidates,
  // not a reason to have none.
  if (candidates.length > 1 && travelFrom) {
    const here = { lat: bus.lat, lon: bus.lon };
    const agree = candidates.map((i) => legAgreement(i, here, stops, stopCoords, travelFrom));
    if (agree.some((a) => a > 0)) {
      const kept = candidates.filter((_, k) => agree[k]! >= 0);
      if (kept.length > 0) candidates = kept;
    }
  }

  if (candidates.length > 0) {
    // `last_stop_id` EXCLUDES; it does not rank. See ANCHOR_FEED_LEAD_HOPS.
    if (lastIdx >= 0) {
      const kept = candidates.filter(
        (i) => ((i - lastIdx + N) % N) <= ANCHOR_FEED_LEAD_HOPS,
      );
      if (kept.length > 0) candidates = kept;
    }
    // Then the bus's own GPS decides — but not everywhere, and the exception is
    // geometric.
    //
    // ON A FOLD the survivors are the same tarmac facing opposite ways. A bus
    // on it is equidistant from both by construction, the metres between them
    // are noise, and picking the nearer is a coin flip that costs a LAP rather
    // than a stop. There the feed's forward order is the better evidence even
    // when the GPS looks decisive, so it ranks the whole candidate set — which
    // is what master did everywhere, and what Purple wants.
    //
    // EVERYWHERE ELSE the disputed candidates lie on different geometry, the
    // GPS is the better evidence, and `last_stop_id` may be minutes stale —
    // Red's #316 disputes are consecutive legs of Prospect Street at 32 m
    // against 145 m, and the bus is plainly on one of them. There the band
    // decides: GPS wins when it separates them by more than ANCHOR_NEARER_M,
    // and inside that the legs are indistinguishable and forward order breaks
    // the tie, as it always did.
    const here = { lat: bus.lat, lon: bus.lon };
    const byForward = (a: number, b: number) => {
      const fa = (a - lastIdx + N) % N;
      const fb = (b - lastIdx + N) % N;
      if (fa !== fb) return fa - fb;
      return dists[a] - dists[b];
    };
    if (
      lastIdx >= 0 && candidates.length > 1 &&
      anyOpposed(here, candidates, stops, stopCoords, legs)
    ) {
      candidates.sort(byForward);
      return refineWithAtStop(candidates[0]!);
    }
    let nearest = Infinity;
    for (const i of candidates) if (dists[i] < nearest) nearest = dists[i];
    const tied = candidates.filter((i) => dists[i] <= nearest + ANCHOR_NEARER_M);
    if (lastIdx >= 0) tied.sort(byForward);
    else tied.sort((a, b) => dists[a] - dists[b]);
    return refineWithAtStop(tied[0]!);
  }

  // Nothing within threshold — bus is off-route-ish. Just pick
  // globally-nearest so downstream code still has a valid anchor.
  let bestIdx = 0;
  let bestD = deferred ? exactDist(0) : dists[0]!;
  for (let i = 1; i < N; i++) {
    const d = deferred ? exactDist(i) : dists[i]!;
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return refineWithAtStop(bestIdx);

  // at_stop_id REFINES the GPS anchor; it must never contradict it. It used to
  // short-circuit the whole scan, which is how a bus appeared to travel
  // backwards: many routes pass two stops that sit almost on top of each other
  // but are far apart in sequence — Broadway/York and Elm/York are 23 m apart
  // yet 2 stops apart on Blue Weekend, and Orange/Pearl (N)/(S) are 35 m apart
  // yet 9 stops apart on Green. A few metres of GPS noise picked the wrong one
  // and threw the anchor a third of a loop (reports #37, #38; the same swing
  // drove the "6 min then 16 min" ETA in #32).
  //
  // So accept it only when the bus is really there AND it is the GPS anchor or
  // exactly one stop ahead — which still preserves report #27's fix, where the
  // segment scan lags one stop behind at a shared segment endpoint.
  function refineWithAtStop(gpsIdx: number): number {
    if (bus.at_stop_id == null) return gpsIdx;
    const ai = stops.indexOf(bus.at_stop_id);
    if (ai < 0) return gpsIdx;
    const sc = stopCoords[stops[ai]];
    if (!sc) return gpsIdx;
    const dlat = (bus.lat - sc.lat) * 111_000;
    const dlon = (bus.lon - sc.lon) * 84_000;
    const near = dlat * dlat + dlon * dlon < ANCHOR_GPS_THRESHOLD_M * ANCHOR_GPS_THRESHOLD_M;
    return near && (ai - gpsIdx + N) % N <= 1 ? ai : gpsIdx;
  }
}
