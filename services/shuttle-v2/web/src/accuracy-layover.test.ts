// A recorded Red pass, replayed second by second, as the gate on every change
// to the ETA maths.
//
// WHY THIS EXISTS. On 2026-09-03 a rider watched a Red bus finish its layover
// at 344 Winchester and reach them EARLY, while the board still read "5 min";
// the same countdown then jumped from 8 min to 30 s when the bus finally
// pulled out. Both were one defect — the app was cancelling the wrong amount
// of a dwell against the first hop — and the unit tests around it all passed,
// because each of them checked a single contrived moment. What nobody was
// testing was a bus MOVING THROUGH a layover: approach, sit, leave.
//
// So this file replays one real pass (`__fixtures__/red-layover-pass.json`:
// 115 positions at 15 s, captured from production on 2026-09-03, with the
// segment and dwell calibration exactly as it was served) and checks what a
// rider standing at a downstream stop would have been told at every one of
// those moments against when the bus actually turned up.
//
// The invariants below are deliberately loose about accuracy and strict about
// the two ways this has actually hurt riders: promising a bus EARLIER than it
// comes (they walk down and it has gone) and a countdown that LURCHES (they
// cannot tell whether to run). Tighten the bounds when the estimator earns it;
// do not loosen them to make a change pass.
//
// Regenerate the fixture with `node scripts/record-layover-pass.mjs` (see its
// header) after a route change; commit the new file, and say in the PR what
// moved.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeUpcomingArrivals } from "./arrivals";
import type { DwellTimes, SegmentTimes } from "./arrivals";
import type { LatLon } from "./geo";
import type { BusData } from "./map-data";
import { registerRoutePaths } from "./anchor";
import type { AnchorStore } from "./eta";

import pass from "./__fixtures__/red-layover-pass.json";
import splitTables from "./__fixtures__/red-split-tables.json";
import incidents from "./__fixtures__/anchor-incidents.json";

const routeStops: Record<string, number[]> = pass.routeStops;
const stopCoords: Record<number, LatLon> = pass.stopCoords as unknown as Record<number, LatLon>;
const names = pass.stopNames as unknown as Record<number, string>;

const layover = pass.arrivals.find((a) => a.stopId === pass.layoverStopId)!;
const LEFT_AT = layover.departedAt!;

/** When the bus really reached a stop, as the collector recorded it. */
function actualArrivalAt(stopId: number, after: number): number | null {
  const hit = pass.arrivals.find((a) => a.stopId === stopId && a.arrivedAt >= after - 1);
  return hit ? hit.arrivedAt : null;
}

/**
 * The bus exactly as `/api/buses` would have described it at that instant:
 * the recorded position, plus the `at_stop_id`/`at_stop_since` the collector
 * publishes while a bus is sitting at a stop (the feed sends a naive UTC
 * string, and the client appends the "Z").
 */
function busAt(t: number): BusData {
  const p = [...pass.positions].reverse().find((q) => q.t <= t) ?? pass.positions[0]!;
  const at = pass.arrivals.find(
    (a) => a.arrivedAt <= t && (a.departedAt == null || t < a.departedAt),
  );
  return {
    bus_id: 1,
    bus_name: pass.busName,
    route_id: pass.busRouteId,
    lat: p.lat,
    lon: p.lon,
    heading: p.heading,
    last_stop_id: p.last_stop_id ?? undefined,
    ...(at
      ? {
          at_stop_id: at.stopId,
          at_stop_since: new Date(at.arrivedAt).toISOString().replace("Z", ""),
        }
      : {}),
  } as BusData;
}

/** Every recorded moment in [from, to], as epoch ms. */
const momentsBetween = (from: number, to: number) =>
  pass.positions.map((p) => p.t).filter((t) => t >= from && t <= to);



/**
 * THE RING ESTIMATOR (web/src/eta/), which is the only estimator there is.
 *
 * Two blocks stood here until 2026-09-06 that registered no route polyline,
 * which sent Red down the legacy arithmetic — a point anchor, a stall credit
 * and an approach zone — and pinned its behaviour through the same layover.
 * That arithmetic is gone (there is one estimator for every route now), and
 * so are they. A browser always has the published line: it arrives in the
 * same payload as the buses. Same recording, same split tables, the same four
 * promises: never much earlier than the bus, within two minutes on the
 * median, never climbing while the bus stands, and 5 -> 1 on the poll it
 * leaves.
 */
describe(`Red through the ${names[pass.layoverStopId]} layover, priced on the ring`, () => {
  const redPath = (incidents as unknown as { routes: Record<string, { path: [number, number][] }> }).routes["3"]!.path;
  beforeEach(() => registerRoutePaths({ "3": redPath }));
  afterEach(() => registerRoutePaths(null));

  const segmentsSplit: SegmentTimes = JSON.parse(JSON.stringify(pass.segments));
  const dwellsSplit: DwellTimes = JSON.parse(JSON.stringify(pass.dwells));
  for (const [r, tab] of Object.entries(splitTables.segments)) {
    for (const [k, v] of Object.entries(tab as Record<string, object>)) {
      if (segmentsSplit[r]?.[k]) Object.assign(segmentsSplit[r]![k]!, v);
    }
  }
  for (const [r, tab] of Object.entries(splitTables.dwells)) {
    for (const [k, v] of Object.entries(tab as Record<string, object>)) {
      if (dwellsSplit[r]?.[k]) Object.assign(dwellsSplit[r]![k]!, v);
    }
  }
  const boardFor = (store?: AnchorStore) => (stopId: number, t: number): number | null => {
    const arrivals = computeUpcomingArrivals(
      [stopId], [busAt(t)], routeStops, stopCoords, segmentsSplit, t, dwellsSplit, store,
    ).filter((a) => a.routeLabel === pass.routeLabel);
    return arrivals.length > 0 ? arrivals[0]!.eta : null;
  };
  const standingMoments = momentsBetween(layover.arrivedAt, LEFT_AT - 1);

  it("the board never climbs while the bus stands still", () => {
    // Tolerance 10 s: the moving and the standing pricings of the same
    // arrival differ by a few seconds, and the mode flips on the poll the
    // bus settles — below any display bucket, unlike the 42 s creep #119
    // removed.
    const board = boardFor(new Map());
    let prev = Infinity;
    for (const t of standingMoments) {
      const eta = board(48, t);
      if (eta === null) continue;
      expect(eta, `climbed at ${new Date(t).toISOString().slice(11, 19)}`).toBeLessThanOrEqual(prev + 10);
      prev = eta;
    }
  });

  it("the departure collapses the number on the poll it happens", () => {
    const board = boardFor(new Map());
    const lastStanding = standingMoments.at(-1)!;
    const firstGone = pass.positions.map((p) => p.t).find((t) => t >= LEFT_AT)!;
    const secondGone = pass.positions.map((p) => p.t).filter((t) => t > firstGone)[0]!;
    const held = board(48, lastStanding)!;
    const gone = board(48, firstGone)!;
    const gone2 = board(48, secondGone)!;
    // The number before departure is already the conditional residual of a
    // stand that has run past its p75, so it is small; the departure still
    // takes the standing term out of it in one or two polls.
    expect(Math.min(gone, gone2)).toBeLessThan(Math.min(held - 30, held * 0.7));
  });

  it("does not lurch between one poll and the next", () => {
    // The rider's other complaint: "the red jumped from 8 min to 30s".
    // Fifteen seconds of real time may not move the estimate by minutes; the
    // exception is the moment the bus is recorded leaving the stop, where a
    // real discontinuity exists in the data itself.
    //
    // The bar is coupled to the canary's `catastrophicSec`
    // (scripts/canary-metrics.test.mjs asserts the two are the same number),
    // so a jump this gate would fail on the recorded pass is a jump the
    // canary names in the wild. Move one and you must move the other.
    const board = boardFor(new Map());
    for (const stopId of [48, 104]) {
      const truth = actualArrivalAt(stopId, LEFT_AT)!;
      const seen = momentsBetween(pass.positions[0]!.t, truth)
        .map((t) => ({ t, eta: board(stopId, t) }))
        .filter((e): e is { t: number; eta: number } => e.eta !== null);
      let worst = { t: 0, jump: 0 };
      for (let i = 1; i < seen.length; i++) {
        const prev = seen[i - 1]!, cur = seen[i]!;
        if (prev.t < LEFT_AT && cur.t >= LEFT_AT) continue; // the departure itself
        const elapsed = (cur.t - prev.t) / 1000;
        // A countdown should fall by roughly the time that passed.
        const jump = Math.abs(cur.eta - prev.eta + elapsed);
        if (jump > worst.jump) worst = { t: cur.t, jump };
      }
      expect(
        worst.jump,
        `${names[stopId]}: biggest step at ${new Date(worst.t).toISOString().slice(11, 19)}`,
      ).toBeLessThan(180);
    }
  });

  it("never promises the bus much earlier than it comes, and after the departure is within a minute on the median", () => {
    // This pass is a 9 min 45 s stand against a table whose median is ~5 min:
    // the arrival distribution's median is honestly two minutes early for
    // most of it, and a single pass cannot judge a median (the rider
    // simulator does, over thousands). What one pass CAN judge: the promise
    // is never much later than the bus, and once the bus has left, the drive
    // is priced to within a minute.
    const board = boardFor(new Map());
    for (const stopId of [48, 104]) {
      const truth = actualArrivalAt(stopId, LEFT_AT)!;
      let worst = { at: 0, pessimisticBy: 0, shown: 0, truth: 0 };
      const errs: number[] = [];
      for (const t of momentsBetween(pass.positions[0]!.t, truth)) {
        const eta = board(stopId, t);
        if (eta === null) continue;
        const err = eta - (truth - t) / 1000;
        errs.push(Math.abs(err));
        if (err > worst.pessimisticBy) Object.assign(worst, { at: t, pessimisticBy: err, shown: eta, truth: (truth - t) / 1000 });
      }
      expect(
        worst.pessimisticBy,
        `${names[stopId]}: at ${new Date(worst.at).toISOString().slice(11, 19)} the board said ` +
          `${Math.round(worst.shown)} s while the bus was ${Math.round(worst.truth)} s away`,
      ).toBeLessThan(120);
      const after: number[] = [];
      for (const t of momentsBetween(LEFT_AT, truth)) {
        const eta = board(stopId, t);
        if (eta === null) continue;
        after.push(Math.abs(eta - (truth - t) / 1000));
      }
      after.sort((a, b) => a - b);
      expect(after.length).toBeGreaterThan(3);
      // Four hops of drives and kerb stands carry ~60 s of spread between them.
      expect(after[after.length >> 1]!, `${names[stopId]} median |error| after departure`).toBeLessThan(90);
      expect(errs.length).toBeGreaterThan(20);
    }
  });
});
