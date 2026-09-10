/**
 * The dual run's contract: it files the SERVER's answer for the rows a rider
 * was actually shown, under its own surface, and it never files anything a
 * comparison could not honestly use.
 */
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "../../web/src/anchor.js";
import type { DwellTimes, SegmentTimes } from "../../web/src/arrivals.js";
import type { LatLon } from "../../web/src/geo.js";
import type { BusData } from "../../web/src/map-data.js";
import { ROUTE_LISTS } from "../../web/src/routes.js";
import {
  SERVER_SURFACE,
  type PredictionRecorder,
  type PredictionSurface,
  type RecordContext,
  type ShownReading,
} from "./predictions.js";
import { ServerEta, type EtaPayloadView } from "./serverEta.js";
import { MAX_SHADOW_SKEW_MS, recordServerShadow } from "./serverEtaShadow.js";

const CAP = JSON.parse(fs.readFileSync(
  new URL("./__fixtures__/live-frames.json", import.meta.url), "utf8",
)) as {
  static: {
    routes: Record<string, number[]>;
    route_paths: Record<string, [number, number][]>;
    stop_coords: Record<number, LatLon>;
    segments: SegmentTimes;
    dwells: DwellTimes;
  };
  frames: { t: number; buses: BusData[] }[];
};

const ALL_ROUTES = ROUTE_LISTS.map((c) => c.label);
const payloadFor = (i: number): EtaPayloadView => ({
  buses: CAP.frames[i]!.buses,
  routes: CAP.static.routes,
  stop_coords: CAP.static.stop_coords,
  segments: CAP.static.segments,
  dwells: CAP.static.dwells,
  route_paths: CAP.static.route_paths,
});

/** Captures what would have been written, without a database. */
function fakeRecorder() {
  const filed: { readings: ShownReading[]; surface: PredictionSurface }[] = [];
  const rec = {
    sampleRate: () => 1,
    record: () => 0,
    shadow: (readings: readonly ShownReading[], surface: PredictionSurface) => {
      filed.push({ readings: [...readings], surface });
      return readings.length;
    },
    flush: () => {},
    paired: () => ({ summary: {} as never, rows: [] }),
    officialComparison: () => null,
    stop: () => {},
  } as unknown as PredictionRecorder;
  return { rec, filed };
}

const ctxAt = (now: number): RecordContext =>
  ({ buses: [], network: {} as never, clientBuild: null, now } as unknown as RecordContext);

const readingFor = (busName: string, stopId: number): ShownReading => ({
  busName, stopId, etaSec: 1, lowSec: 0, highSec: 2, stopsAhead: 1, ageMs: 0, surface: "trip",
});

describe("the dual run", () => {
  let engine: ServerEta;
  let anyRow: { bus: string; stop: number };

  beforeEach(async () => {
    registerRoutePaths(CAP.static.route_paths);
    engine = new ServerEta({ routes: ALL_ROUTES });
    await engine.step(payloadFor(0), 1, CAP.frames[0]!.t);
    // A (bus, stop) pair the engine really has an answer for. Taken from the
    // engine rather than hardcoded, so a capture refresh cannot silently make
    // every assertion below vacuous.
    const wire = engine.answer(CAP.frames[0]!.buses)!;
    const row = wire.rows[0]!;
    anyRow = { bus: wire.buses[row[0]]![0], stop: row[1] };
  });
  afterEach(() => registerRoutePaths(null));

  it("files the server's number, not the rider's, under the server surface", () => {
    const { rec, filed } = fakeRecorder();
    const shown = readingFor(anyRow.bus, anyRow.stop);
    const n = recordServerShadow(rec, engine, [shown], ctxAt(CAP.frames[0]!.t));
    expect(n).toBe(1);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.surface).toBe(SERVER_SURFACE);
    const got = filed[0]!.readings[0]!;
    expect(got.stopId).toBe(anyRow.stop);
    // The rider's reading said 1 s. The engine's own answer is what is filed —
    // if this ever equals the rider's number the shadow is measuring itself.
    const truth = engine.lookup(anyRow.bus, anyRow.stop)!;
    expect(got.etaSec).toBe(truth.eta);
    expect(got.lowSec).toBe(truth.low);
    expect(got.highSec).toBe(truth.high);
    expect(got.stopsAhead).toBe(truth.stopsAhead);
    // Stamped at the SERVER's pass, not the rider's post: an age the server
    // subtracts from its own clock to land on the instant it really priced.
    expect(got.ageMs).toBe(0);
  });

  it("one row per (bus, stop), however many screens reported it", () => {
    const { rec, filed } = fakeRecorder();
    const a = readingFor(anyRow.bus, anyRow.stop);
    const n = recordServerShadow(
      rec, engine,
      [a, { ...a, surface: "card" }, { ...a, surface: "ride" }],
      ctxAt(CAP.frames[0]!.t),
    );
    expect(n).toBe(1);
    expect(filed[0]!.readings).toHaveLength(1);
  });

  it("files nothing for a pair the engine has no answer for", () => {
    const { rec, filed } = fakeRecorder();
    expect(recordServerShadow(rec, engine, [readingFor("nosuchbus", anyRow.stop)], ctxAt(CAP.frames[0]!.t))).toBe(0);
    expect(filed).toHaveLength(0);
  });

  it("refuses a belief too stale to be the same moment as the reading", () => {
    // The rider's reading and the server's pass are not the same instant. A
    // poll or two apart is like-for-like; minutes apart is two different
    // moments dressed as one, which would make the head-to-head meaningless.
    const { rec } = fakeRecorder();
    const shown = readingFor(anyRow.bus, anyRow.stop);
    const t = CAP.frames[0]!.t;
    expect(recordServerShadow(rec, engine, [shown], ctxAt(t + MAX_SHADOW_SKEW_MS))).toBe(1);
    expect(recordServerShadow(rec, engine, [shown], ctxAt(t + MAX_SHADOW_SKEW_MS + 1))).toBe(0);
    // And never a belief from the future of the reading.
    expect(recordServerShadow(rec, engine, [shown], ctxAt(t - 1))).toBe(0);
  });

  it("a recorder that throws costs the measurement and nothing else", () => {
    const rec = { shadow: () => { throw new Error("boom"); } } as unknown as PredictionRecorder;
    expect(() => recordServerShadow(rec, engine, [readingFor(anyRow.bus, anyRow.stop)], ctxAt(CAP.frames[0]!.t)))
      .not.toThrow();
  });
});
