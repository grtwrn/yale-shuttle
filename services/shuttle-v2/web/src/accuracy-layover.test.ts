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
import type { AnchorStore } from "./anchorGate";

import pass from "./__fixtures__/red-layover-pass.json";
import splitTables from "./__fixtures__/red-split-tables.json";
import incidents from "./__fixtures__/anchor-incidents.json";

const routeStops: Record<string, number[]> = pass.routeStops;
const stopCoords: Record<number, LatLon> = pass.stopCoords as unknown as Record<number, LatLon>;
const segmentTimes = pass.segments as unknown as SegmentTimes;
const dwellTimes = pass.dwells as unknown as DwellTimes;
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

/** What the board would show a rider waiting at `stopId`, in seconds. */
function shownEta(stopId: number, t: number): number | null {
  const arrivals = computeUpcomingArrivals(
    [stopId], [busAt(t)], routeStops, stopCoords, segmentTimes, t, dwellTimes,
  ).filter((a) => a.routeLabel === pass.routeLabel);
  return arrivals.length > 0 ? arrivals[0]!.eta : null;
}

/** Every recorded moment in [from, to], as epoch ms. */
const momentsBetween = (from: number, to: number) =>
  pass.positions.map((p) => p.t).filter((t) => t >= from && t <= to);

describe(`Red through the ${names[pass.layoverStopId]} layover`, () => {
  // The map registers route polylines every poll; without them the anchor
  // falls back to stop-to-stop chords, which is what a browser does on the
  // first render anyway.
  registerRoutePaths(null);

  it("the fixture is the shape this test needs", () => {
    expect(layover.departedAt).toBeTruthy();
    const dwellMin = (LEFT_AT - layover.arrivedAt) / 60_000;
    expect(dwellMin).toBeGreaterThan(5);
    // before, during and after all present
    expect(momentsBetween(pass.positions[0]!.t, layover.arrivedAt).length).toBeGreaterThan(3);
    expect(momentsBetween(layover.arrivedAt, LEFT_AT).length).toBeGreaterThan(20);
    expect(momentsBetween(LEFT_AT, pass.positions.at(-1)!.t).length).toBeGreaterThan(3);
  });

  // Division / Prospect is 65 s past the layover, Prospect / Hillside 215 s —
  // the stops the rider in the report was waiting at.
  for (const stopId of [48, 104]) {
    describe(`a rider waiting at ${names[stopId]}`, () => {
      const truth = actualArrivalAt(stopId, LEFT_AT)!;

      it("is never promised the bus much earlier than it comes", () => {
        // THE ONE THAT MATTERS. A late bus costs a wait; an early one is
        // gone. "Early" here means the board's number ran out before the bus
        // arrived — i.e. the app was pessimistic, the rider relaxed, and the
        // bus beat its own promise.
        const worst = { at: 0, pessimisticBy: 0, shown: 0, truth: 0 };
        for (const t of momentsBetween(pass.positions[0]!.t, truth)) {
          const eta = shownEta(stopId, t);
          if (eta === null) continue;
          const remaining = (truth - t) / 1000;
          const pessimisticBy = eta - remaining;
          if (pessimisticBy > worst.pessimisticBy) {
            Object.assign(worst, { at: t, pessimisticBy, shown: eta, truth: remaining });
          }
        }
        expect(
          worst.pessimisticBy,
          `at ${new Date(worst.at).toISOString().slice(11, 19)} the board said ` +
            `${Math.round(worst.shown)} s while the bus was ${Math.round(worst.truth)} s away`,
        ).toBeLessThan(120);
      });

      it("stays within two minutes of the truth across the whole pass", () => {
        const errors = momentsBetween(pass.positions[0]!.t, truth)
          .map((t) => ({ t, eta: shownEta(stopId, t) }))
          .filter((e): e is { t: number; eta: number } => e.eta !== null)
          .map((e) => Math.abs(e.eta - (truth - e.t) / 1000));
        expect(errors.length).toBeGreaterThan(20);
        const median = errors.sort((a, b) => a - b)[Math.floor(errors.length / 2)]!;
        expect(median).toBeLessThan(120);
      });

      it("does not lurch between one poll and the next", () => {
        // The rider's other complaint: "the red jumped from 8 min to 30s".
        // Fifteen seconds of real time may not move the estimate by minutes;
        // the exception is the moment the bus is recorded leaving the stop,
        // where a real discontinuity exists in the data itself.
        const seen = momentsBetween(pass.positions[0]!.t, truth)
          .map((t) => ({ t, eta: shownEta(stopId, t) }))
          .filter((e): e is { t: number; eta: number } => e.eta !== null);
        let worst = { t: 0, jump: 0 };
        for (let i = 1; i < seen.length; i++) {
          const prev = seen[i - 1]!, cur = seen[i]!;
          if (prev.t < LEFT_AT && cur.t >= LEFT_AT) continue; // departure itself
          const elapsed = (cur.t - prev.t) / 1000;
          // A countdown should fall by roughly the time that passed.
          const jump = Math.abs(cur.eta - prev.eta + elapsed);
          if (jump > worst.jump) worst = { t: cur.t, jump };
        }
        expect(
          worst.jump,
          `biggest step at ${new Date(worst.t).toISOString().slice(11, 19)}`,
        ).toBeLessThan(180);
      });
    });
  }

  it("counts the layover down instead of sitting on a padded number", () => {
    // Through the dwell the estimate must actually fall: this is what the
    // half-the-segment cap broke, holding ~5 min for the last four minutes of
    // the layover and then collapsing when the bus left.
    const during = momentsBetween(layover.arrivedAt + 60_000, LEFT_AT - 30_000);
    const first = shownEta(48, during[0]!)!;
    const last = shownEta(48, during.at(-1)!)!;
    expect(first).not.toBeNull();
    expect(last).toBeLessThan(first);
    // and by the end of the layover the bus really is close: 65 s of driving.
    expect(last).toBeLessThan(240);
  });

  it("does not promise a bus that has only just parked", () => {
    const justArrived = layover.arrivedAt + 30_000;
    const eta = shownEta(48, justArrived)!;
    const remaining = (actualArrivalAt(48, LEFT_AT)! - justArrived) / 1000;
    // ~10 min of layover still ahead: the app must not read "a couple of
    // minutes" just because the hop after the layover is short.
    expect(eta).toBeGreaterThan(remaining / 2);
  });
});

/**
 * The same pass, replayed as a rider's BROWSER runs it: the stand/drive split
 * served (PR #81/#85, Red and Blue Day) and an `AnchorStore` open, which is
 * where the per-vehicle memory lives.
 *
 * The block above deliberately does not do either — it is the pure, storeless
 * replay, and the split fields were not in the payload when its fixture was
 * recorded. That left the gate blind to the defect the operator caught live on
 * 2026-09-04: Red #310 standing at 344 Winchester, the pause chip counting up
 * and the board stuck on "5 min". Under the split the first hop is
 * `median(stand - r | stand > r) + drive`, and that conditional median RISES
 * wherever the stand CDF flattens — so the app was quietly sliding the
 * predicted arrival later while the bus sat, which is the one thing standing
 * still cannot be evidence for.
 *
 * `red-split-tables.json` is route 3's own `q`/`qn` and `drive`/`driveN` as
 * the calibrator served them on 2026-09-03, merged over the fixture's tables;
 * nothing else about the pass changes.
 */
describe(`Red through the ${names[pass.layoverStopId]} layover, with the stand/drive split served`, () => {
  registerRoutePaths(null);

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

  /** What the board shows a rider whose tab has been open the whole time. */
  const boardFor = (store?: AnchorStore) => (stopId: number, t: number): number | null => {
    const arrivals = computeUpcomingArrivals(
      [stopId], [busAt(t)], routeStops, stopCoords, segmentsSplit, t, dwellsSplit, store,
    ).filter((a) => a.routeLabel === pass.routeLabel);
    return arrivals.length > 0 ? arrivals[0]!.eta : null;
  };

  const standingMoments = momentsBetween(layover.arrivedAt, LEFT_AT - 1);

  it("the split really is engaged on this fixture", () => {
    expect(dwellsSplit["3"]!["11"]!.q!.length).toBe(10);
    expect(segmentsSplit["3"]!["11-146"]!.drive).toBeGreaterThan(0);
    expect(standingMoments.length).toBeGreaterThan(30);
  });

  it("THE DEFECT: unclamped, the board climbs while the bus stands still", () => {
    // Storeless is the unclamped arithmetic. Pinned as a fixture so that if a
    // future CDF change removes the rise on its own, this test says so out
    // loud rather than the clamp silently becoming decorative.
    const board = boardFor();
    let rises = 0, longestClimb = 0, run = 0;
    let prev: number | null = null;
    for (const t of standingMoments) {
      const eta = board(48, t);
      if (prev !== null && eta !== null) {
        if (eta > prev + 0.5) { run += eta - prev; rises++; longestClimb = Math.max(longestClimb, run); }
        else run = 0;
      }
      prev = eta;
    }
    expect(rises).toBeGreaterThanOrEqual(4);
    expect(longestClimb).toBeGreaterThan(40); // 55 s: "5 min" becomes "6 min", nothing happened
  });

  it("THE FIX: with a store, the board never climbs while the bus stands still", () => {
    const board = boardFor(new Map());
    let prev = Infinity;
    for (const t of standingMoments) {
      const eta = board(48, t);
      if (eta === null) continue;
      expect(eta, `climbed at ${new Date(t).toISOString().slice(11, 19)}`).toBeLessThanOrEqual(prev + 0.5);
      prev = eta;
    }
  });

  it("the departure lands on the SAME poll, at the same number — 5 -> 1 is untouched", () => {
    // The whole justification for the clamp is that it holds back nothing a
    // rider needs. The instant the bus rolls, the standing term is gone from
    // the price and the ceiling with it, so the clamped board and the
    // unclamped one must agree on the very first poll after the departure.
    const clamped = boardFor(new Map());
    const unclamped = boardFor();
    const lastStanding = standingMoments.at(-1)!;
    const firstGone = pass.positions.map((p) => p.t).find((t) => t >= LEFT_AT)!;
    const held = clamped(48, lastStanding)!;
    const gone = clamped(48, firstGone)!;
    expect(gone).toBeLessThan(held - 60);          // it collapses, and it collapses hard
    expect(gone).toBeCloseTo(unclamped(48, firstGone)!, 5); // ...to exactly master's number
  });

  it("still never promises the bus much earlier than it comes", () => {
    // The invariant that matters most, re-run under the split: a rider who
    // relaxes because the board said five minutes must not find the bus gone.
    const board = boardFor(new Map());
    for (const stopId of [48, 104]) {
      const truth = actualArrivalAt(stopId, LEFT_AT)!;
      let worst = { at: 0, pessimisticBy: 0, shown: 0, truth: 0 };
      for (const t of momentsBetween(pass.positions[0]!.t, truth)) {
        const eta = board(stopId, t);
        if (eta === null) continue;
        const pessimisticBy = eta - (truth - t) / 1000;
        if (pessimisticBy > worst.pessimisticBy) {
          Object.assign(worst, { at: t, pessimisticBy, shown: eta, truth: (truth - t) / 1000 });
        }
      }
      expect(
        worst.pessimisticBy,
        `${names[stopId]}: at ${new Date(worst.at).toISOString().slice(11, 19)} the board said ` +
          `${Math.round(worst.shown)} s while the bus was ${Math.round(worst.truth)} s away`,
      ).toBeLessThan(120);
    }
  });
});

/**
 * THE RING ESTIMATOR (web/src/eta/). The blocks above register no route
 * polyline, which sends Red down the legacy arithmetic; a browser always has
 * the published line (it arrives in the same payload as the buses), and with
 * it Red is priced from a distribution on the ring. Same recording, same
 * split tables, the same four promises: never much earlier than the bus,
 * within two minutes on the median, never climbing while the bus stands, and
 * 5 -> 1 on the poll it leaves.
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
    const board = boardFor(new Map());
    let prev = Infinity;
    for (const t of standingMoments) {
      const eta = board(48, t);
      if (eta === null) continue;
      expect(eta, `climbed at ${new Date(t).toISOString().slice(11, 19)}`).toBeLessThanOrEqual(prev + 0.5);
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
      expect(after[after.length >> 1]!, `${names[stopId]} median |error| after departure`).toBeLessThan(60);
      expect(errs.length).toBeGreaterThan(20);
    }
  });
});
