import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeLapFits, etDay, gateCell, LAP_BAND_HI, LAP_BAND_LO, LAP_F_MAX, LAP_F_MIN, LAP_MIN_N, LAP_SERVED_ROUTE_IDS, LAP_SHRINK_K, type GateResult, type LapArrival } from "./lapFit.js";

/**
 * The client's copy of these constants is parsed out of its source rather
 * than imported, for the reason `walk.test.ts` gives: the backend's stricter
 * tsconfig does not type-check `web/src`, and a numeric constant that drifts
 * between the two halves is exactly the failure this file exists to stop —
 * the server would fit inside one band and the client price inside another.
 */
const CLIENT = fs.readFileSync(path.resolve(__dirname, "../../web/src/eta/lap.ts"), "utf8");
function clientConst(name: string): number {
  const m = new RegExp(`export const ${name} = ([-0-9.]+);`).exec(CLIENT);
  if (!m) throw new Error(`web/src/eta/lap.ts no longer exports ${name}`);
  return Number(m[1]);
}

describe("the lap fit's constants are the client's", () => {
  it.each([
    ["LAP_SHRINK_K", LAP_SHRINK_K],
    ["LAP_BAND_LO", LAP_BAND_LO],
    ["LAP_BAND_HI", LAP_BAND_HI],
    ["LAP_MIN_N", LAP_MIN_N],
    ["LAP_F_MIN", LAP_F_MIN],
    ["LAP_F_MAX", LAP_F_MAX],
  ])("%s", (name, server) => {
    expect(clientConst(name)).toBe(server);
  });
});

// -- a synthetic cell whose truth is known -------------------------------------

const DAY = 24 * 3600_000;
/** 2026-09-01 08:00 ET. */
const T0 = Date.parse("2026-09-01T12:00:00Z");
const LOOP = 3600;
const LOOP_SEC = LOOP;

/**
 * A cell where the stand really is `600 - 0.5 x (lap - 3600)`, run for `days`
 * service days with three buses, plus the two kinds of gap the band exists to
 * refuse: the overnight one, and a bus that goes off the line for two laps.
 */
function corpus(days: number, slope: number): LapArrival[] {
  const out: LapArrival[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let d = 0; d < days; d++) {
    for (const bus of ["#1", "#2", "#3"]) {
      let t = T0 + d * DAY + Number(bus.slice(1)) * 900_000;
      for (let lapIdx = 0; lapIdx < 10; lapIdx++) {
        const lap = LOOP + (rnd() - 0.5) * 1200;
        const stand = Math.max(30, 600 + slope * (lap - LOOP) + (rnd() - 0.5) * 120);
        const arrived = t + lap * 1000;
        out.push({ busName: bus, routeId: 3, stopId: 11, arrivedAt: arrived, departedAt: arrived + stand * 1000 });
        t = arrived + stand * 1000;
        // Once a day this bus goes off the line for two laps: the gap is not a
        // lap, and the stand that follows is an ordinary one.
        if (lapIdx === 5) t += 2 * LOOP * 1000;
      }
    }
  }
  return out;
}

describe("computeLapFits", () => {
  it("recovers a known slope, and the reference lap", () => {
    // lap is in SECONDS in the corpus, stand in seconds; the fit is per second.
    const rows = corpus(20, -0.5);
    const fits = computeLapFits(rows);
    const f = fits.get("3:11");
    expect(f).toBeDefined();
    // `b` is a fraction of the cell's own median stand per second of lap.
    // Truth here is -0.5 s per 1000 ms of lap = -0.5 s/s, on a ~600 s median.
    // `b` is a fraction of the cell's median stand per second of lap, so
    // b x median recovers the seconds-per-second slope the corpus was built on.
    expect(f!.b * 600).toBeCloseTo(-0.5, 1);
    // The reference lap is the loop, not the loop plus the stand.
    expect(f!.m).toBeGreaterThan(3200);
    expect(f!.m).toBeLessThan(4000);
    expect(f!.n).toBeGreaterThanOrEqual(LAP_MIN_N);
  });

  it("refuses a cell with no signal by shrinking it toward nothing", () => {
    const flat = computeLapFits(corpus(20, 0));
    const real = computeLapFits(corpus(20, -0.5));
    const bFlat = Math.abs(flat.get("3:11")?.b ?? 0);
    const bReal = Math.abs(real.get("3:11")?.b ?? 0);
    expect(bFlat * 600).toBeLessThan(0.05);
    expect(bReal).toBeGreaterThan(bFlat * 5);
  });

  it("refuses a cell with too few laps, and one whose stand is too short", () => {
    expect(computeLapFits(corpus(1, -0.5)).size).toBe(0);
    const short = corpus(20, 0).map((r) => ({ ...r, departedAt: r.arrivedAt + 20_000 }));
    expect(computeLapFits(short).size).toBe(0);
  });

  it("does not fit on a gap that is not a lap", () => {
    // Every off-line gap in the corpus is 3 loops long and followed by an
    // ORDINARY stand. Included in the fit they would read as "a very late bus
    // stands 600 s", flattening the slope toward zero.
    const rows = corpus(20, -0.5);
    const f = computeLapFits(rows).get("3:11")!;
    const P = LOOP;
    let inBand = 0, outOfBand = 0;
    const byBus = new Map<string, LapArrival[]>();
    for (const r of rows) {
      const l = byBus.get(r.busName) ?? [];
      l.push(r);
      byBus.set(r.busName, l);
    }
    for (const l of byBus.values()) {
      l.sort((a, b) => a.arrivedAt - b.arrivedAt);
      for (let i = 1; i < l.length; i++) {
        const lap = (l[i]!.arrivedAt - l[i - 1]!.departedAt) / 1000;
        if (lap >= LAP_BAND_LO * P && lap <= LAP_BAND_HI * P) inBand++; else outOfBand++;
      }
    }
    expect(outOfBand).toBeGreaterThan(50);
    expect(f.b * 600).toBeCloseTo(-0.5, 1);
    expect(inBand).toBeGreaterThan(400);
  });

  it("reads days in ET, so a service day is one cluster", () => {
    // 03:30 UTC is the previous ET day; the cluster-robust SE depends on it.
    expect(etDay(Date.parse("2026-09-05T03:30:00Z"))).toBe("2026-09-04");
    expect(etDay(Date.parse("2026-09-05T13:30:00Z"))).toBe("2026-09-05");
  });
});

describe("the serving gate", () => {
  /** The corpus, reduced to what `gateCell` scores. */
  function samples(days: number, slope: number) {
    const rows = corpus(days, slope);
    const byBus = new Map<string, LapArrival[]>();
    for (const r of rows) {
      const l = byBus.get(r.busName) ?? [];
      l.push(r);
      byBus.set(r.busName, l);
    }
    const out: { lap: number; stand: number; day: string }[] = [];
    for (const l of byBus.values()) {
      l.sort((a, b) => a.arrivedAt - b.arrivedAt);
      for (let i = 1; i < l.length; i++) {
        const lap = (l[i]!.arrivedAt - l[i - 1]!.departedAt) / 1000;
        if (lap < LAP_BAND_LO * LOOP_SEC || lap > LAP_BAND_HI * LOOP_SEC) continue;
        out.push({ lap, stand: (l[i]!.departedAt - l[i]!.arrivedAt) / 1000, day: etDay(l[i]!.arrivedAt) });
      }
    }
    return out;
  }

  it("passes a cell where the covariate really beats the pooled median", () => {
    const g = gateCell("3:11", samples(20, -0.5), 1, 600);
    expect(g.pass).toBe(true);
    expect(g.lap).toBeLessThan(g.pooled);
    expect(g.upper).toBeLessThan(0);
    expect(g.days).toBeGreaterThanOrEqual(10);
  });

  it("REFUSES a flat cell — the whole point, and the split tables' Pink lesson", () => {
    const g = gateCell("3:11", samples(20, 0), 1, 600);
    expect(g.pass).toBe(false);
    // It is not that the fit is catastrophic; it is that it is not better.
    expect(g.lap).toBeGreaterThan(g.pooled - 5);
  });

  it("refuses a cell with too few service days to cross-validate", () => {
    expect(gateCell("3:11", samples(6, -0.5), 1, 600).pass).toBe(false);
  });

  it("is deterministic — the calibrator reruns it every six hours", () => {
    const s = samples(20, -0.5);
    const a = gateCell("3:11", s, 1, 600), b = gateCell("3:11", s, 1, 600);
    expect(a).toEqual(b);
    // ...and keyed on the cell, so two cells do not share a resample.
    expect(gateCell("9:22", s, 1, 600).upper).not.toBe(a.upper);
  });

  it("keeps a gated-out cell out of the served map entirely", () => {
    const gates = new Map<string, GateResult>();
    const flat = computeLapFits(corpus(20, 0), gates);
    expect(flat.size).toBe(0);
    expect(gates.get("3:11")?.pass).toBe(false);
    const real = computeLapFits(corpus(20, -0.5), gates);
    expect(real.has("3:11")).toBe(true);
    expect(gates.get("3:11")?.pass).toBe(true);
  });
});

describe("the rollout gate", () => {
  /** The same corpus on a route that has NOT been watched. */
  const onRoute = (id: number) => corpus(20, -0.5).map((r) => ({ ...r, routeId: id }));

  it("serves a good cell on a watched route and withholds the identical cell on an unwatched one", () => {
    expect(LAP_SERVED_ROUTE_IDS.has(3)).toBe(true);
    const red = computeLapFits(onRoute(3));
    expect(red.has("3:11")).toBe(true);
    const pink = computeLapFits(onRoute(8));
    expect(pink.size).toBe(0);
  });

  it("still records the withheld cell's gate result — that is how a route earns its place", () => {
    const gates = new Map<string, GateResult>();
    computeLapFits(onRoute(8), gates);
    expect(gates.get("8:11")?.pass).toBe(true);
    expect(gates.get("8:11")!.lap).toBeLessThan(gates.get("8:11")!.pooled);
  });

  it("is applied AFTER the cell gate, never instead of it", () => {
    // A flat cell on a WATCHED route is still refused.
    expect(computeLapFits(corpus(20, 0).map((r) => ({ ...r, routeId: 3 }))).size).toBe(0);
  });

  it("names every served route with its evidence in the source", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "./lapFit.ts"), "utf8");
    const block = /export const LAP_SERVED_ROUTE_IDS[^;]*;/.exec(src)![0];
    for (const id of LAP_SERVED_ROUTE_IDS) {
      // Every id must appear in the doc comment above the constant with a
      // paired rider-sim line beside it (the SPLIT_SERVED_ROUTE_IDS rule).
      const doc = src.slice(0, src.indexOf(block));
      const line = new RegExp(`\\* - \\*\\*${id} \\(`).test(doc);
      expect(line, `route ${id} has no evidence comment beside it`).toBe(true);
    }
    expect(/STRAND \d+ fixed \/ \d+ introduced/.test(src)).toBe(true);
  });
});
