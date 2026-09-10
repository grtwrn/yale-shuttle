/**
 * THE deliverable of the server-side move: the server's answer and the
 * client's are the SAME answer.
 *
 * Read this file first. Everything else in the change is plumbing; this is
 * what makes the eventual switch — the client dropping its own estimator and
 * reading the served field — a safe one rather than a hopeful one.
 *
 * The instrument is a real production poll sequence: 40 consecutive
 * `/api/buses` responses from yale-shuttle.fly.dev, ~5.1 s apart, 14–15 live
 * buses across the network, with one bus leaving the live list and coming back
 * (`__fixtures__/live-frames.json`). Both arms are stepped frame by frame,
 * INTERLEAVED, so the estimator's module-level caches (the ring cache, the
 * table cache, the registered polylines) are shared between them exactly as
 * they would be by two callers in one process.
 *
 * The two arms:
 *
 *  - CLIENT — a bare `AnchorStore` and a direct `computeUpcomingArrivals`
 *    call per frame, which is literally what `TransitMap` does with
 *    `liveAnchorStore` on each poll.
 *  - SERVER — `ServerEta.contribute(payload, version, now)`.
 *
 * TOLERANCE: 0.5 s on `eta`, `low` and `high` — the served wire rounds
 * seconds to integers and nothing else. `stopsAhead`, `estimated`, the bus
 * name, the route label and the stop id must match EXACTLY, and so must the
 * number of rows: a (bus, stop) pair legitimately appears twice (this lap and
 * the next, which is what lets a single-bus line answer "next in 54 min"), and
 * dropping one of those would be a real difference in what a rider can be told.
 *
 * WHY THIS IS NOT A TAUTOLOGY. The server does not reimplement the estimator —
 * it imports `computeUpcomingArrivals` from `web/src/arrivals.ts` verbatim, and
 * that is the point: the two sides CANNOT disagree unless someone forks the
 * module or marshals the inputs differently, which is precisely the failure
 * this test exists to catch. The third case below is what stops the comparison
 * being vacuous: a COLD store at frame 40 does not agree with a warm one, so
 * the arms are genuinely comparing stateful beliefs and not two stateless
 * evaluations of the same arithmetic.
 */
import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerRoutePaths } from "../../web/src/anchor.js";
import { computeUpcomingArrivals, type DwellTimes, type SegmentTimes, type UpcomingArrival } from "../../web/src/arrivals.js";
import type { AnchorStore } from "../../web/src/eta/index.js";
import type { LatLon } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";
import { ROUTE_LISTS } from "../../web/src/routes.js";
import { ServerEta, SLICE_BUDGET_MS, type EtaPayloadView, type ServerEtaWire } from "./serverEta.js";

// Read rather than `import ... from`: `resolveJsonModule` would have tsc infer
// a literal type for a quarter-megabyte of captured JSON on every typecheck.
const capture: unknown = JSON.parse(
  fs.readFileSync(new URL("./__fixtures__/live-frames.json", import.meta.url), "utf8"),
);

const CAP = capture as {
  capturedAt: string;
  static: {
    routes: Record<string, number[]>;
    route_paths: Record<string, [number, number][]>;
    stop_coords: Record<number, LatLon>;
    segments: SegmentTimes;
    dwells: DwellTimes;
  };
  frames: { t: number; buses: BusData[] }[];
};

/** Every label, so the allowlist narrows nothing here. It is exercised separately. */
const ALL_ROUTES = ROUTE_LISTS.map((c) => c.label);

/** Every stop on every route — what the server targets, so the client must too. */
const ALL_STOPS = [...new Set(Object.values(CAP.static.routes).flat())];

function payloadFor(frame: { buses: BusData[] }): EtaPayloadView {
  return {
    buses: frame.buses,
    routes: CAP.static.routes,
    stop_coords: CAP.static.stop_coords,
    segments: CAP.static.segments,
    dwells: CAP.static.dwells,
    route_paths: CAP.static.route_paths,
  };
}

/** `[label, busName, stopId] -> [eta, low, high, stopsAhead, estimated]`, in order. */
type Key = string;
function clientRows(arrivals: UpcomingArrival[]): Map<Key, number[][]> {
  const out = new Map<Key, number[][]>();
  for (const a of arrivals) {
    const k = `${a.routeLabel}|${a.busName}|${a.stopId}`;
    const list = out.get(k) ?? [];
    list.push([a.eta, a.low, a.high, a.stopsAhead, a.estimated ? 1 : 0]);
    out.set(k, list);
  }
  return out;
}
function serverRows(wire: ServerEtaWire | null): Map<Key, number[][]> {
  const out = new Map<Key, number[][]>();
  if (!wire) return out;
  for (const r of wire.rows) {
    const [name, label] = wire.buses[r[0]]!;
    const k = `${label}|${name}|${r[1]}`;
    const list = out.get(k) ?? [];
    list.push([r[2], r[3], r[4], r[5], r[6]]);
    out.set(k, list);
  }
  return out;
}

beforeAll(() => registerRoutePaths(CAP.static.route_paths));
afterAll(() => registerRoutePaths(null));

describe("the server's belief and the client's give the same answer", () => {
  it("the capture is a real network under load, not a slice", () => {
    expect(CAP.frames.length).toBe(40);
    expect(Object.keys(CAP.static.routes).length).toBe(15);
    // Enough buses that this exercises more than one line, and a bus that
    // comes and goes so eviction and re-appearance are both covered.
    const counts = CAP.frames.map((f) => f.buses.length);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(10);
    expect(new Set(counts).size).toBeGreaterThan(1);
    // ~5 s apart, i.e. the collector's own cadence.
    for (let i = 1; i < CAP.frames.length; i++) {
      const dt = CAP.frames[i]!.t - CAP.frames[i - 1]!.t;
      expect(dt, `frame ${i}`).toBeGreaterThan(4_000);
      expect(dt, `frame ${i}`).toBeLessThan(8_000);
    }
  });

  it("matches row for row over 40 consecutive polls, to 0.5 s", async () => {
    const clientStore: AnchorStore = new Map();
    const server = new ServerEta({ routes: ALL_ROUTES });

    let comparedRows = 0;
    let comparedFrames = 0;
    for (const [i, frame] of CAP.frames.entries()) {
      // The client's poll: one call over every stop, its own store.
      const client = clientRows(computeUpcomingArrivals(
        ALL_STOPS, frame.buses, CAP.static.routes, CAP.static.stop_coords,
        CAP.static.segments, frame.t, CAP.static.dwells, clientStore,
      ));
      // The server's poll: a new collector data version per frame. The step is
      // CHUNKED — it drains the same generator across `setImmediate` turns —
      // so awaiting it is what makes this a comparison of two drivers over one
      // implementation rather than of two implementations.
      await server.step(payloadFor(frame), i, frame.t);
      const srv = serverRows(server.answer(frame.buses));

      expect([...srv.keys()].sort(), `frame ${i} keys`).toEqual([...client.keys()].sort());
      for (const [k, want] of client) {
        const got = srv.get(k)!;
        expect(got.length, `frame ${i} ${k} row count`).toBe(want.length);
        want.forEach((w, j) => {
          const g = got[j]!;
          expect(g[0]!, `frame ${i} ${k} eta`).toBeCloseTo(w[0]!, 0);
          expect(g[1]!, `frame ${i} ${k} low`).toBeCloseTo(w[1]!, 0);
          expect(g[2]!, `frame ${i} ${k} high`).toBeCloseTo(w[2]!, 0);
          expect(g[3]!, `frame ${i} ${k} stopsAhead`).toBe(w[3]!);
          expect(g[4]!, `frame ${i} ${k} estimated`).toBe(w[4]!);
          comparedRows++;
        });
      }
      if (client.size > 0) comparedFrames++;
    }

    // A green run on an empty comparison would prove nothing.
    expect(comparedFrames).toBeGreaterThan(30);
    expect(comparedRows).toBeGreaterThan(5_000);
    // 80 passes over the whole network, half of them yielding to the event
    // loop every few milliseconds. The default 5 s is not enough on a Pi.
  }, 120_000);

  it("a cold belief disagrees with a warm one — so the comparison above is about STATE", () => {
    // The whole argument for the move: a browser opened at frame 40 has a
    // different posterior from one that has been tracking since frame 1, and
    // the numbers it shows differ. If this ever stops being true the estimator
    // has become stateless and the parity test above has become a tautology.
    const warm: AnchorStore = new Map();
    CAP.frames.forEach((f) => {
      computeUpcomingArrivals(
        ALL_STOPS, f.buses, CAP.static.routes, CAP.static.stop_coords,
        CAP.static.segments, f.t, CAP.static.dwells, warm,
      );
    });
    const last = CAP.frames.at(-1)!;
    const warmRows = clientRows(computeUpcomingArrivals(
      ALL_STOPS, last.buses, CAP.static.routes, CAP.static.stop_coords,
      CAP.static.segments, last.t, CAP.static.dwells, warm,
    ));
    const coldRows = clientRows(computeUpcomingArrivals(
      ALL_STOPS, last.buses, CAP.static.routes, CAP.static.stop_coords,
      CAP.static.segments, last.t, CAP.static.dwells, new Map(),
    ));

    let differing = 0, both = 0;
    for (const [k, w] of warmRows) {
      const c = coldRows.get(k);
      if (!c || c.length !== w.length) { differing++; continue; }
      w.forEach((row, j) => {
        both++;
        if (Math.abs(row[0]! - c[j]![0]!) > 1) differing++;
      });
    }
    expect(both).toBeGreaterThan(100);
    expect(differing, "cold and warm beliefs answered identically").toBeGreaterThan(0);
  });

  it("a second call at the same collector version steps nothing", async () => {
    // Constraint 2 in serverEta.ts. The /api/buses cache also rebuilds on a
    // one-second wall clock during an upstream outage; stepping the filter
    // again on the same fix would hand it a repeat observation upstream never
    // sent, which this model reads as evidence the bus is standing.
    const server = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!, f1 = CAP.frames[1]!;
    await server.step(payloadFor(f0), 7, f0.t);
    const a = serverRows(server.answer(f0.buses));
    await server.step(payloadFor(f0), 7, f0.t + 900);
    expect(serverRows(server.answer(f0.buses))).toEqual(a);
    expect(server.stats().steps).toBe(1);
    // A new version does step, and the answer moves.
    await server.step(payloadFor(f1), 8, f1.t);
    expect(server.stats().steps).toBe(2);
    expect(serverRows(server.answer(f1.buses))).not.toEqual(a);
  });

  it("one step per observation SURVIVES the chunking — a poll mid-pass is queued, never interleaved", async () => {
    // The chunked pass spans several event-loop turns, which is exactly the
    // window in which a second `step` can land. Two passes advancing the same
    // beliefs over different fixes would corrupt every belief in the store, so
    // a pass runs to completion and the newer version waits behind it.
    const server = new ServerEta({ routes: ALL_ROUTES });
    const f0 = CAP.frames[0]!, f1 = CAP.frames[1]!, f2 = CAP.frames[2]!;
    // Fire three versions without awaiting: v9 starts, v10 and v11 land during
    // its pass. v11 is the newest and is the one that runs next.
    const a = server.step(payloadFor(f0), 9, f0.t);
    const b = server.step(payloadFor(f1), 10, f1.t);
    const c = server.step(payloadFor(f2), 11, f2.t);
    await Promise.all([a, b, c]);
    // Two passes, not three: the middle version was superseded before it ran.
    // Never four, and never one — the freshest fix is always stepped.
    expect(server.stats().steps).toBe(2);

    // And the same version arriving twice mid-pass steps once, full stop.
    const solo = new ServerEta({ routes: ALL_ROUTES });
    await Promise.all([
      solo.step(payloadFor(f0), 3, f0.t),
      solo.step(payloadFor(f0), 3, f0.t),
      solo.step(payloadFor(f0), 3, f0.t),
    ]);
    expect(solo.stats().steps).toBe(1);
  });

  it("no single synchronous slice runs long enough to block a request", async () => {
    // The whole point of chunking. 35 ms per poll of CPU is 0.7% of a core; 35
    // ms in ONE stretch is 35 ms of head-of-line blocking on the loop that
    // serves /api/buses at ~40 req/s. `scripts/server-eta-bench.ts` is the
    // measurement; this is the guard that keeps a future change from quietly
    // making the pass indivisible again.
    //
    // The bound is deliberately loose (5x the budget): a CI box under load
    // measures wall clock, and the failure this catches is a slice of tens of
    // milliseconds, not one of nine.
    const server = new ServerEta({ routes: ALL_ROUTES });
    const slices: number[] = [];
    // Frame 0 builds every ring and stand table from scratch — a one-time cost
    // per process that no chunking of the per-bus loop can divide below one
    // ring — so the steady-state polls are what is measured.
    await server.step(payloadFor(CAP.frames[0]!), 100, CAP.frames[0]!.t);
    for (let i = 1; i < 6; i++) {
      const f = CAP.frames[i]!;
      await server.step(payloadFor(f), 100 + i, f.t, (_wall, cpu) => slices.push(cpu));
    }
    expect(slices.length).toBeGreaterThan(20);
    expect(Math.max(...slices)).toBeLessThan(SLICE_BUDGET_MS * 5);
  });
});
