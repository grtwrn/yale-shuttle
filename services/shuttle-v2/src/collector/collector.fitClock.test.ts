import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";

import { Collector, type Logger } from "./collector.js";
import { BLUE_DAY } from "./__fixtures__/report100-cedar-stand.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

/**
 * The calibration log reports the WHOLE stall, including the lap fit.
 *
 * `CalibrationStats.durationMs` times `calibrate()` and cannot see
 * `lapFitsCache.get()`, which is evaluated in the argument list, on the same
 * event loop that serves `/api/buses`. On 2026-09-10 that get held the loop for
 * **21,190 ms** at boot and every six hours while `collector.calibrated`
 * reported `durationMs: 996` — so the stall hid for a day, and the write-up
 * (NEXT-STEPS 2026-09-10 §9) called it out as "the instrument, not the
 * estimator".
 *
 * These tests are the instrument's own regression: a slow fit must appear in
 * the log line. Without `lapFitMs` / `loopHeldMs` the second one fails while
 * the loop is demonstrably held.
 */
describe("collector.calibrated names the lap fit's own cost", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  const byId = new Map(allStops.map((s) => [s.id, s]));
  const stops = BLUE_DAY.map((id) => byId.get(id)!);
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];

  class StubUpstream extends UpstreamClient {
    constructor() { super({ baseUrl: "http://invalid.test" }); }
    override async buses(): Promise<RawBus[]> { return []; }
    override async stops(): Promise<Stop[]> { return stops; }
    override async routes(): Promise<Route[]> { return routes; }
  }

  let tmpDir: string;
  let bundle: DbBundle;
  let collector: Collector;
  let lines: Array<{ msg: string; meta: Record<string, unknown> }>;
  const logger: Logger = {
    info: (msg, meta) => { lines.push({ msg, meta: meta ?? {} }); },
    warn: () => {},
    error: () => {},
  };

  const calibrated = () => lines.filter((l) => l.msg === "collector.calibrated").map((l) => l.meta);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-fitclock-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    lines = [];
    collector = await Collector.create(bundle, { upstream: new StubUpstream(), logger });
    await collector.start();
  });

  afterEach(() => {
    collector.stop();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("carries the fit's duration and the total hold beside lapFitCount", () => {
    const meta = calibrated();
    expect(meta.length).toBeGreaterThan(0);
    const m = meta[meta.length - 1]!;
    // The stats the calibrator already reported, unchanged.
    expect(m).toHaveProperty("lapFitCount");
    expect(m).toHaveProperty("durationMs");
    // ...plus the half `durationMs` structurally cannot see.
    expect(typeof m.lapFitMs).toBe("number");
    expect(typeof m.loopHeldMs).toBe("number");
    expect(m.loopHeldMs).toBe((m.durationMs as number) + (m.lapFitMs as number));
    expect(m.loopHeldMs as number).toBeGreaterThanOrEqual(m.durationMs as number);
  });

  it("shows a slow fit that durationMs alone would hide", () => {
    // The 2026-09-10 shape, at 1/100 of the cost: the fit holds the loop and
    // `calibrate()` itself is fast. `durationMs` is blind to this by
    // construction — it starts after the argument has been evaluated.
    const HOLD_MS = 120;
    (collector as unknown as { lapFitsCache: { get(): ReadonlyMap<string, unknown> } }).lapFitsCache = {
      get() {
        const until = Date.now() + HOLD_MS;
        while (Date.now() < until) { /* busy-wait: the point is that the loop cannot run */ }
        return new Map();
      },
    };
    lines = [];
    (collector as unknown as { runCalibrate(): void }).runCalibrate();

    const m = calibrated();
    expect(m).toHaveLength(1);
    expect(m[0]!.lapFitMs as number).toBeGreaterThanOrEqual(HOLD_MS - 5);
    expect(m[0]!.loopHeldMs as number).toBeGreaterThanOrEqual(HOLD_MS - 5);
    // The whole defect, pinned: the old line would have reported only this.
    expect(m[0]!.durationMs as number).toBeLessThan(HOLD_MS);
  });

  it("still logs, and still calibrates, when the fit cannot be read", () => {
    // `LapFitCache.get` swallows its own errors, but a throwing stub proves the
    // timing wrapper added no new way for calibration to fail.
    (collector as unknown as { lapFitsCache: { get(): ReadonlyMap<string, unknown> } }).lapFitsCache = {
      get() { throw new Error("disk"); },
    };
    lines = [];
    (collector as unknown as { runCalibrate(): void }).runCalibrate();
    expect(calibrated()).toHaveLength(0);
    expect(() => (collector as unknown as { runCalibrate(): void }).runCalibrate()).not.toThrow();
  });
});
