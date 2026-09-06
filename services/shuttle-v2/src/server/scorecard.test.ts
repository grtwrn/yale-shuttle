import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { etDayStartMs } from "./actives.js";
import {
  ALL_HORIZON,
  ALL_ROUTES,
  CENSUS_SURFACE,
  DayScorer,
  FINAL_AFTER_MS,
  HORIZONS,
  JUMP_SEC,
  OURS_SURFACE,
  RETAIN_DAYS,
  SETTLE_MS,
  STRAND_SEC,
  createScorecardJob,
  horizonOf,
  pruneScorecard,
  readScorecard,
  resolveEstimatorVersion,
  writeDay,
  type ScorecardRow,
} from "./scorecard.js";
import { COMPARE_HORIZON_SEC, UPSTREAM_SURFACE } from "./predictions.js";

// A fixed ET day, and its midnight. 2026-09-08 is a Tuesday (EDT, UTC-4).
const DAY = "2026-09-08";
const DAY_START = etDayStartMs(DAY);
const NEXT_DAY = "2026-09-09";
const at = (hh: number, mm: number, ss = 0) => DAY_START + ((hh * 60 + mm) * 60 + ss) * 1000;

let tmpDir: string;
let bundle: DbBundle;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-scorecard-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  bundle.sqlite.exec(
    "INSERT INTO routes (id, name, short_name, color, stops_json, updated_at) VALUES " +
      "(3, 'Red', 'RD', '#f00', '[1,2,3]', 0), (10, 'Purple', 'PRPL', '#a0f', '[1,2]', 0)",
  );
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -- fixture writers ----------------------------------------------------------

interface ArrivalFx {
  bus: string;
  route: number;
  stop: number;
  arrived: number;
  departed?: number | null;
}
function arrival(a: ArrivalFx): void {
  bundle.sqlite
    .prepare(
      `INSERT INTO arrivals (bus_id, bus_name, route_id, stop_id, arrived_at, departed_at, dwell_sec, dow, hour)
       VALUES (1, ?, ?, ?, ?, ?, NULL, 2, 12)`,
    )
    .run(`#${a.bus}`, a.route, a.stop, a.arrived, a.departed === undefined ? a.arrived + 30_000 : a.departed);
}

interface PredFx {
  bus: string;
  route: number;
  stop: number;
  at: number;
  sec: number;
  low?: number;
  high?: number;
  surface?: string;
  build?: string | null;
}
let predId = 0;
function prediction(p: PredFx): void {
  predId += 1;
  bundle.sqlite
    .prepare(
      `INSERT INTO predictions_log
         (bus_id, bus_name, route_id, from_stop_id, to_stop_id, stops_ahead, predicted_sec,
          predicted_low_sec, predicted_high_sec, predicted_at, client_build, surface)
       VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      predId, `#${p.bus}`, p.route, p.stop, p.sec,
      p.low ?? p.sec, p.high ?? p.sec, p.at, p.build === undefined ? "abc123" : p.build,
      p.surface ?? "trip",
    );
}

function census(p: PredFx & { calcAt?: number | null }): void {
  bundle.sqlite
    .prepare(
      `INSERT INTO upstream_etas (sampled_at, calc_at, stop_id, route_id, bus_id, bus_name, eta_min, eta_sec, probe)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0)`,
    )
    .run(p.at, p.calcAt === undefined ? null : p.calcAt, p.stop, p.route, `#${p.bus}`, Math.round(p.sec / 60), p.sec);
}

function scoreWholeDay(): ScorecardRow[] {
  const s = new DayScorer(bundle.sqlite, DAY);
  s.advance(etDayStartMs(NEXT_DAY));
  return s.rows();
}

function cell(rows: ScorecardRow[], routeId: number, horizon: string, surface: string) {
  return rows.find((r) => r.routeId === routeId && r.horizon === horizon && r.surface === surface)?.metrics;
}

// -- the rules ----------------------------------------------------------------

describe("horizonOf", () => {
  it("buckets promised minutes and drops anything past the shared cap", () => {
    expect(horizonOf(0)).toBe("0-2");
    expect(horizonOf(119)).toBe("0-2");
    expect(horizonOf(120)).toBe("2-5");
    expect(horizonOf(299)).toBe("2-5");
    expect(horizonOf(300)).toBe("5-10");
    expect(horizonOf(600)).toBe("10-30");
    expect(horizonOf(COMPARE_HORIZON_SEC)).toBe("10-30");
    expect(horizonOf(COMPARE_HORIZON_SEC + 1)).toBeNull();
    expect(horizonOf(Number.NaN)).toBeNull();
  });
});

describe("DayScorer", () => {
  it("scores known errors with the replay's sign: promise − actual, negative = optimistic", () => {
    // Bus 40 reaches stop 2 at 12:10:00.
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    // Promised 240 s at 12:05 → actual 300 s → error −60 (optimistic).
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 240, low: 200, high: 320 });
    // Promised 400 s at 12:04 → actual 360 s → error +40 (pessimistic).
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 4), sec: 400, low: 380, high: 390 });
    // Promised 100 s at 12:09 → actual 60 → +40, horizon 0-2.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 9), sec: 100 });

    const rows = scoreWholeDay();
    const all = cell(rows, 3, ALL_HORIZON, "trip")!;
    expect(all.n).toBe(3);
    expect(all.paired).toBe(3);
    expect(all.medianSignedSec).toBe(40);
    expect(all.medianAbsSec).toBe(40);
    // Nearest-rank at floor(q·(n−1)), the convention predictions.ts uses:
    // with three values that is the middle one.
    expect(all.p90AbsSec).toBe(40);
    expect(all.within120Pct).toBe(100);
    expect(all.pessimistic120Pct).toBe(0);
    expect(all.optimistic120Pct).toBe(0);
    // Two rows carried a band; the wait of 300 s fell inside [200, 320] but
    // 360 s fell outside [380, 390].
    expect(all.intervalRows).toBe(2);
    expect(all.intervalCoveragePct).toBe(50);
    expect(all.builds).toEqual({ abc123: 3 });

    expect(cell(rows, 3, "2-5", "trip")!.paired).toBe(1);
    expect(cell(rows, 3, "5-10", "trip")!.paired).toBe(1);
    expect(cell(rows, 3, "0-2", "trip")!.paired).toBe(1);
    expect(cell(rows, 3, "10-30", "trip")).toBeUndefined();

    // The pooled rows: all routes, and "ours" beside the surface.
    expect(cell(rows, ALL_ROUTES, ALL_HORIZON, "trip")!.paired).toBe(3);
    expect(cell(rows, 3, ALL_HORIZON, OURS_SURFACE)!.paired).toBe(3);
    expect(cell(rows, ALL_ROUTES, ALL_HORIZON, OURS_SURFACE)!.medianSignedSec).toBe(40);
    // Nothing on a route nobody predicted.
    expect(rows.some((r) => r.routeId === 10)).toBe(false);
  });

  it("a prediction for a bus already standing at the stop is not a forecast", () => {
    // The bus stood at stop 2 from 12:00 to 12:15, and came back a lap later.
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 0), departed: at(12, 15) });
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 40) });
    // 12:05, while standing: under the naive rule this pairs with 12:40 —
    // 2,100 s of "error". It must be counted as standing and never scored.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 30 });
    // 12:20, after it left: a real forecast of the next visit, 1,200 s away.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 20), sec: 1200 });

    const m = cell(scoreWholeDay(), 3, ALL_HORIZON, "trip")!;
    expect(m.n).toBe(2);
    expect(m.standing).toBe(1);
    expect(m.paired).toBe(1);
    expect(m.medianSignedSec).toBe(0);
  });

  it("an unclosed visit older than the lookback does not flag every later row", () => {
    // The detector lost the bus at 08:00 and never closed the visit.
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(8, 0), departed: null });
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 300 });
    const m = cell(scoreWholeDay(), 3, ALL_HORIZON, "trip")!;
    expect(m.standing).toBe(0);
    expect(m.paired).toBe(1);
  });

  it("applies the horizon cap and the match window to every arm alike", () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    // Beyond the cap: counted, not scored, on ours and on upstream.
    prediction({ bus: "40", route: 3, stop: 2, at: at(11, 0), sec: COMPARE_HORIZON_SEC + 60 });
    prediction({ bus: "40", route: 3, stop: 2, at: at(11, 0), sec: COMPARE_HORIZON_SEC + 60, surface: UPSTREAM_SURFACE });
    census({ bus: "40", route: 3, stop: 2, at: at(11, 0), sec: 3600 });
    // Inside the cap but the bus takes 70 min: no arrival in the 45-min window.
    prediction({ bus: "40", route: 3, stop: 2, at: at(11, 0, 30), sec: 1500, surface: "card" });

    const rows = scoreWholeDay();
    expect(cell(rows, 3, ALL_HORIZON, "trip")).toMatchObject({ n: 1, beyondHorizon: 1, paired: 0, medianAbsSec: null });
    expect(cell(rows, 3, ALL_HORIZON, UPSTREAM_SURFACE)).toMatchObject({ n: 1, beyondHorizon: 1, paired: 0 });
    expect(cell(rows, 3, ALL_HORIZON, CENSUS_SURFACE)).toMatchObject({ n: 1, beyondHorizon: 1, paired: 0 });
    expect(cell(rows, 3, ALL_HORIZON, "card")).toMatchObject({ n: 1, missing: 1, paired: 0 });
    // Beyond-cap rows have no horizon bucket at all.
    expect(HORIZONS.every((h) => cell(rows, 3, h, "trip") === undefined)).toBe(true);
  });

  it("scores the census from upstream's own calculation instant and keeps upstream out of 'ours'", () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    // Sampled at 12:05:20, calculated at 12:05:00, promised 300 s: actual 300 → 0.
    census({ bus: "40", route: 3, stop: 2, at: at(12, 5, 20), calcAt: at(12, 5), sec: 300 });
    // The 30-min-capped poller row: 240 s at 12:05 → −60.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 240, surface: UPSTREAM_SURFACE, build: null });
    // A marker row (no bus) is not a prediction.
    bundle.sqlite
      .prepare("INSERT INTO upstream_etas (sampled_at, stop_id, route_id, probe) VALUES (?, 2, 3, 1)")
      .run(at(12, 6));

    const rows = scoreWholeDay();
    expect(cell(rows, 3, ALL_HORIZON, CENSUS_SURFACE)).toMatchObject({ n: 1, paired: 1, medianSignedSec: 0, intervalRows: 0 });
    expect(cell(rows, 3, ALL_HORIZON, UPSTREAM_SURFACE)).toMatchObject({ n: 1, paired: 1, medianSignedSec: -60 });
    expect(cell(rows, 3, ALL_HORIZON, UPSTREAM_SURFACE)!.builds).toBeUndefined();
    expect(cell(rows, 3, ALL_HORIZON, OURS_SURFACE)).toBeUndefined();
  });

  it("counts a strand: the bus arrived while the last number shown was still minutes", () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    // Shown every 15 s until the bus came, still promising 4 min at 12:09:45.
    for (let s = 0; s < 8; s++) {
      prediction({ bus: "40", route: 3, stop: 2, at: at(12, 8) + s * 15_000, sec: STRAND_SEC + 60 });
    }
    // A second stop where the number ran down honestly: 2 min → 15 s.
    arrival({ bus: "40", route: 3, stop: 3, arrived: at(12, 20) });
    for (let s = 0; s < 8; s++) {
      prediction({ bus: "40", route: 3, stop: 3, at: at(12, 18) + s * 15_000, sec: 120 - s * 15 });
    }
    // A rider who looked ten minutes earlier and left is not a wait.
    arrival({ bus: "41", route: 3, stop: 2, arrived: at(13, 0) });
    prediction({ bus: "41", route: 3, stop: 2, at: at(12, 45), sec: 900 });

    const m = cell(scoreWholeDay(), 3, ALL_HORIZON, "trip")!;
    expect(m.waits).toBe(2);
    expect(m.strands).toBe(1);
    // Fifteen consecutive pairs, none of which moved the promised arrival by 3 min.
    expect(m.jumpPairs).toBe(14);
    expect(m.jumps).toBe(0);
  });

  it("counts a jump when the promised arrival instant moves by ≥ 180 s between looks", () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 20) });
    // 12:05 promise 600 s (arrive 12:15); 12:05:15 promise 900 s (arrive 12:20:15): +315 s.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 600 });
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5, 15), sec: 900 });
    // Then it counts down cleanly.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5, 30), sec: 885 });
    // A look six minutes later is a new look, not a pair.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 12), sec: 480 });

    const rows = scoreWholeDay();
    const m = cell(rows, 3, ALL_HORIZON, "trip")!;
    expect(m.jumpPairs).toBe(2);
    expect(m.jumps).toBe(1);
    // The jump is booked to the horizon the rider was looking at (600 s = 10-30).
    expect(cell(rows, 3, "10-30", "trip")!.jumps).toBe(1);
    expect(cell(rows, 3, "5-10", "trip")!.jumps).toBe(0);
    expect(JUMP_SEC).toBe(180);
  });

  it("advanced hour by hour equals scored in one pass", () => {
    // Waits that straddle chunk boundaries, arrivals just after midnight, the lot.
    for (let h = 6; h < 26; h += 1) {
      const t = DAY_START + h * 3_600_000;
      arrival({ bus: "40", route: 3, stop: 2, arrived: t + 10 * 60_000 });
      arrival({ bus: "40", route: 3, stop: 2, arrived: t + 40 * 60_000, departed: t + 41 * 60_000 });
      for (let s = 0; s < 12; s++) {
        prediction({ bus: "40", route: 3, stop: 2, at: t + 5 * 60_000 + s * 15_000, sec: 300 - s * 12 + (s % 3) * 200 });
        prediction({ bus: "40", route: 3, stop: 2, at: t + 58 * 60_000 + s * 15_000, sec: 700 + s * 5, surface: UPSTREAM_SURFACE, build: null });
        census({ bus: "40", route: 3, stop: 2, at: t + 30 * 60_000 + s * 20_000, sec: 600 });
      }
    }
    const whole = scoreWholeDay();
    const stepped = new DayScorer(bundle.sqlite, DAY);
    for (let t = DAY_START; t < etDayStartMs(NEXT_DAY); t += 37 * 60_000) stepped.advance(t);
    stepped.advance(etDayStartMs(NEXT_DAY));
    expect(stepped.complete).toBe(true);
    expect(stepped.rows()).toEqual(whole);
    expect(whole.length).toBeGreaterThan(10);
    // Predictions made on the next ET day are not this day's.
    expect(cell(whole, 3, ALL_HORIZON, "trip")!.n).toBe(18 * 12);
  });
});

// -- persistence --------------------------------------------------------------

describe("scorecard_days", () => {
  const NOW = etDayStartMs(NEXT_DAY) + 12 * 3_600_000;

  it("replaces a day's rows on re-run, and reads back in day order", () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 240 });
    const meta = { scoredThrough: at(13, 0), scoredAt: NOW, final: false, estimatorVersion: "abc" };
    writeDay(bundle.sqlite, DAY, scoreWholeDay(), meta);
    const first = readScorecard(bundle.sqlite, 30, NOW);
    expect(first.days).toEqual([{ day: DAY, scoredThrough: at(13, 0), scoredAt: NOW, final: false, estimatorVersion: "abc" }]);
    const before = first.rows.length;
    expect(before).toBeGreaterThan(0);

    // A second prediction lands; the day is scored again: no duplicates, new numbers.
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 6), sec: 240 });
    writeDay(bundle.sqlite, DAY, scoreWholeDay(), { ...meta, final: true, estimatorVersion: "def" });
    const second = readScorecard(bundle.sqlite, 30, NOW);
    expect(second.rows.length).toBe(before);
    expect(second.days[0]).toMatchObject({ final: true, estimatorVersion: "def" });
    expect(second.rows.find((r) => r.routeId === 3 && r.horizon === ALL_HORIZON && r.surface === "trip")!.metrics.n).toBe(2);
    expect(second.routes.map((r) => r.shortName)).toEqual(["RD", "PRPL"]);
    expect(second.rules.horizonCapSec).toBe(COMPARE_HORIZON_SEC);
    expect(second.rules.errorSign).toContain("negative = optimistic");
  });

  it("windows by days and prunes past the retention", () => {
    const rows: ScorecardRow[] = [{ routeId: 0, horizon: "all", surface: "ours", metrics: scoreWholeDay()[0]?.metrics ?? emptyMetrics() }];
    const meta = { scoredThrough: 0, scoredAt: 0, final: true, estimatorVersion: "v" };
    writeDay(bundle.sqlite, "2025-01-01", rows, meta);
    writeDay(bundle.sqlite, DAY, rows, meta);
    writeDay(bundle.sqlite, NEXT_DAY, rows, meta);
    expect(readScorecard(bundle.sqlite, 1, NOW).days.map((d) => d.day)).toEqual([NEXT_DAY]);
    expect(readScorecard(bundle.sqlite, 2, NOW).days.map((d) => d.day)).toEqual([DAY, NEXT_DAY]);
    expect(pruneScorecard(bundle.sqlite, NOW)).toBe(1);
    expect(readScorecard(bundle.sqlite, 1000, NOW).days.map((d) => d.day)).toEqual([DAY, NEXT_DAY]);
    expect(RETAIN_DAYS).toBe(400);
  });

  function emptyMetrics() {
    return {
      n: 0, beyondHorizon: 0, standing: 0, missing: 0, paired: 0,
      medianSignedSec: null, medianAbsSec: null, p90AbsSec: null,
      within120Pct: null, pessimistic120Pct: null, optimistic120Pct: null,
      intervalRows: 0, intervalCoveragePct: null, waits: 0, strands: 0, jumpPairs: 0, jumps: 0,
    };
  }
});

// -- the job ------------------------------------------------------------------

describe("createScorecardJob", () => {
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };

  it("scores only what has settled, then closes the day on the first tick after 03:30", async () => {
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(12, 10) });
    prediction({ bus: "40", route: 3, stop: 2, at: at(12, 5), sec: 240 });
    arrival({ bus: "40", route: 3, stop: 2, arrived: at(14, 10) });
    prediction({ bus: "40", route: 3, stop: 2, at: at(14, 5), sec: 300 });

    // 13:35: the 12:05 row has settled (12:05 + 47 min), the 14:05 one has not happened.
    let clock = at(13, 35);
    const job = createScorecardJob({
      sqlite: bundle.sqlite, logger: quiet, now: () => clock, estimatorVersion: "v1",
      yieldFn: async () => {},
    });
    let r = await job.tick();
    expect(r.days.map((d) => [d.day, d.final])).toEqual([[DAY, false]]);
    let stored = readScorecard(bundle.sqlite, 5, clock);
    expect(stored.days[0]).toMatchObject({ day: DAY, final: false, scoredThrough: clock - SETTLE_MS });
    expect(stored.rows.find((x) => x.surface === "trip" && x.horizon === ALL_HORIZON && x.routeId === 3)!.metrics.n).toBe(1);

    // 14:35: still not settled (14:05 + 47 min = 14:52). Same count.
    clock = at(14, 35);
    await job.tick();
    stored = readScorecard(bundle.sqlite, 5, clock);
    expect(stored.rows.find((x) => x.surface === "trip" && x.horizon === ALL_HORIZON && x.routeId === 3)!.metrics.n).toBe(1);

    // 15:35: both in, incrementally.
    clock = at(15, 35);
    r = await job.tick();
    expect(r.days[0]!.scanned).toBe(2);
    stored = readScorecard(bundle.sqlite, 5, clock);
    expect(stored.rows.find((x) => x.surface === "trip" && x.horizon === ALL_HORIZON && x.routeId === 3)!.metrics.n).toBe(2);
    expect(stored.days[0]!.final).toBe(false);

    // 02:35 next day: the day is complete but not yet closed.
    clock = etDayStartMs(NEXT_DAY) + 2.5 * 3_600_000;
    r = await job.tick();
    expect(r.days).toEqual([expect.objectContaining({ day: DAY, final: false })]);

    // 03:35: the closing pass, from scratch (scanned = the whole day again).
    clock = etDayStartMs(NEXT_DAY) + FINAL_AFTER_MS + 5 * 60_000;
    r = await job.tick();
    expect(r.days).toEqual([expect.objectContaining({ day: DAY, final: true, scanned: 2 })]);
    stored = readScorecard(bundle.sqlite, 5, clock);
    expect(stored.days[0]).toMatchObject({ day: DAY, final: true, estimatorVersion: "v1" });

    // A closed day is never touched again.
    clock += 3_600_000;
    r = await job.tick();
    expect(r.days).toEqual([]);
  });

  it("backfills every day the logs cover on its first tick, oldest first", async () => {
    const days = ["2026-09-05", "2026-09-06", "2026-09-07"];
    for (const d of days) {
      const t = etDayStartMs(d) + 12 * 3_600_000;
      arrival({ bus: "40", route: 3, stop: 2, arrived: t + 5 * 60_000 });
      prediction({ bus: "40", route: 3, stop: 2, at: t, sec: 300, surface: UPSTREAM_SURFACE, build: null });
    }
    const clock = etDayStartMs("2026-09-08") + 9 * 3_600_000;
    const job = createScorecardJob({ sqlite: bundle.sqlite, logger: quiet, now: () => clock, yieldFn: async () => {} });
    const r = await job.tick();
    expect(r.days.map((d) => [d.day, d.final])).toEqual(days.map((d) => [d, true]));
    // Nothing for the empty day between the data and now.
    expect(readScorecard(bundle.sqlite, 30, clock).days.map((d) => d.day)).toEqual(days);
  });

  it("does nothing on an empty database, and skips an overlapping tick", async () => {
    const job = createScorecardJob({ sqlite: bundle.sqlite, logger: quiet, now: () => at(12, 0), yieldFn: async () => {} });
    expect(await job.tick()).toEqual({ days: [], skipped: false });
    prediction({ bus: "40", route: 3, stop: 2, at: at(6, 0), sec: 300 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = createScorecardJob({ sqlite: bundle.sqlite, logger: quiet, now: () => at(12, 0), yieldFn: () => gate });
    const first = slow.tick();
    expect(await slow.tick()).toEqual({ days: [], skipped: true });
    release();
    expect((await first).skipped).toBe(false);
  });

  it("names the build it scored under", () => {
    const saved = process.env.SHUTTLE_BUILD_SHA;
    try {
      process.env.SHUTTLE_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
      expect(resolveEstimatorVersion()).toBe("0123456789ab");
      process.env.SHUTTLE_BUILD_SHA = "not a sha";
      expect(resolveEstimatorVersion()).toBe("dev");
      delete process.env.SHUTTLE_BUILD_SHA;
      expect(resolveEstimatorVersion()).toBe("dev");
    } finally {
      if (saved === undefined) delete process.env.SHUTTLE_BUILD_SHA;
      else process.env.SHUTTLE_BUILD_SHA = saved;
    }
  });
});
