import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";

import {
  ALERT_COOLDOWN_MS,
  ALERT_MAX_PER_DAY,
  CANARY_MAX_RUNS_PER_POST,
  CANARY_RETAIN_DAYS,
  CATASTROPHIC_SEC,
  IMMINENT_SEC,
  RECOVERY_RUNS,
  alertHeadline,
  canaryReport,
  normalizeCanaryRun,
  recordCanaryRuns,
  vanishingBusJumps,
  type CanaryJump,
  type CanaryRunInput,
} from "./canary.js";

let tmpDir: string;
let bundle: DbBundle;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
});

afterEach(() => {
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const T = Date.parse("2026-09-04T11:37:00Z"); // 07:37 ET, the finding's own hour.

/** The 07:37 Red finding, in the shape the shipper sends. */
const vanishing = (over: Partial<CanaryJump> = {}): CanaryJump => ({
  atMs: T,
  fromSec: 0,
  driftSec: 426,
  from: "now, then 66 min",
  to: "in 7, 25 min",
  announced: false,
  ...over,
});

/** A far-future wobble: real, logged, and deliberately not an interruption. */
const wobble = (): CanaryJump => ({
  atMs: T,
  fromSec: 2700,
  driftSec: 648,
  from: "in 45, 49 min",
  to: "in 33, 48 min",
  announced: false,
});

const run = (over: Partial<CanaryRunInput> = {}): CanaryRunInput => ({
  runKey: `${over.startedAt ?? T}-${over.line ?? "Red"}`,
  startedAt: T,
  line: "Red",
  tripFrom: "Prospect / Canner",
  tripTo: "School of Public Health (YSPH)",
  ok: false,
  arrived: true,
  watchedMin: 12.3,
  readings: 40,
  reversals: 3,
  catastrophic: 1,
  worstDriftSec: 426,
  firstSightMissSec: null,
  failures: [{ kind: "eta-jump", detail: '"now, then 66 min" -> "in 7, 25 min" in 15 s' }],
  jumps: [vanishing()],
  ...over,
});

describe("what earns an interruption", () => {
  it("is a bus promised NOW that then moves far later", () => {
    expect(vanishingBusJumps([vanishing()])).toHaveLength(1);
  });

  it("is not a far-future estimate wobbling, however large the drift", () => {
    // 648 s of drift — well past catastrophic — but the rider was told 45 min,
    // so nobody is standing at a kerb watching a bus fail to arrive.
    expect(wobble().driftSec).toBeGreaterThan(CATASTROPHIC_SEC);
    expect(vanishingBusJumps([wobble()])).toEqual([]);
  });

  it("is not a countdown that got BETTER", () => {
    expect(vanishingBusJumps([vanishing({ driftSec: -426 })])).toEqual([]);
  });

  it("takes the boundary as inclusive on both thresholds", () => {
    expect(vanishingBusJumps([
      vanishing({ fromSec: IMMINENT_SEC, driftSec: CATASTROPHIC_SEC }),
    ])).toHaveLength(1);
    expect(vanishingBusJumps([
      vanishing({ fromSec: IMMINENT_SEC + 1, driftSec: CATASTROPHIC_SEC }),
    ])).toEqual([]);
    expect(vanishingBusJumps([
      vanishing({ fromSec: IMMINENT_SEC, driftSec: CATASTROPHIC_SEC - 1 }),
    ])).toEqual([]);
  });

  it("puts the worst jump first, because the headline quotes one", () => {
    const jumps = vanishingBusJumps([vanishing({ driftSec: 200 }), vanishing({ driftSec: 900 })]);
    expect(jumps[0]!.driftSec).toBe(900);
  });

  it("says the sequence, which is the part that is actionable", () => {
    const line = alertHeadline("Red", vanishing());
    expect(line).toContain('"now, then 66 min"');
    expect(line).toContain('"in 7, 25 min"');
    expect(line).toContain("Red");
  });
});

describe("ingest", () => {
  it("stores a run and escalates the vanishing bus", () => {
    const res = recordCanaryRuns(bundle, [run()], T);
    expect(res.stored).toBe(1);
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]!.line).toBe("Red");
    expect(res.alerts[0]!.jumps[0]!.from).toBe("now, then 66 min");
  });

  it("does not escalate a failing run whose jumps are all far-future", () => {
    const res = recordCanaryRuns(bundle, [run({ jumps: [wobble()] })], T);
    expect(res.stored).toBe(1);
    expect(res.alerts).toEqual([]);
  });

  it("does not escalate a harness fault", () => {
    const res = recordCanaryRuns(bundle, [run({
      jumps: [],
      failures: [{ kind: "feed-error", detail: "The operation was aborted due to timeout" }],
    })], T);
    expect(res.alerts).toEqual([]);
    expect(canaryReport(bundle, 24, T).findings).toHaveLength(1);
  });

  it("is idempotent: re-shipping the same run neither duplicates nor re-alerts", () => {
    recordCanaryRuns(bundle, [run()], T);
    const again = recordCanaryRuns(bundle, [run()], T + 1000);
    expect(again.stored).toBe(0);
    expect(again.duplicate).toBe(1);
    expect(again.alerts).toEqual([]);
    expect(canaryReport(bundle, 24, T + 1000).runs).toBe(1);
  });

  it("drops an unusable row without failing the batch behind it", () => {
    const res = recordCanaryRuns(bundle, [{ line: "Red" }, null, run()], T);
    expect(res.rejected).toBe(2);
    expect(res.stored).toBe(1);
  });

  it("refuses a batch larger than the cap rather than accepting it whole", () => {
    const many = Array.from({ length: CANARY_MAX_RUNS_PER_POST + 10 }, (_, i) =>
      run({ startedAt: T + i * 1000, runKey: `k${i}`, jumps: [] }));
    expect(recordCanaryRuns(bundle, many, T).stored).toBe(CANARY_MAX_RUNS_PER_POST);
  });
});

describe("the cooldown is what keeps this from being turned off", () => {
  it("pushes once per line per cooldown, however many findings land", () => {
    // Blue West produced four qualifying findings in four hours on 2026-09-03.
    // The operator must hear about that line once.
    let alerts = 0;
    for (let i = 0; i < 4; i++) {
      const at = T + i * 60 * 60_000;
      alerts += recordCanaryRuns(bundle, [run({
        line: "Blue West", startedAt: at, runKey: `bw-${i}`,
      })], at).alerts.length;
    }
    expect(alerts).toBe(1);
  });

  it("pushes again once the cooldown has passed and the line is still bad", () => {
    recordCanaryRuns(bundle, [run({ line: "Blue West", runKey: "bw-a" })], T);
    const later = T + ALERT_COOLDOWN_MS + 1000;
    const res = recordCanaryRuns(bundle, [run({
      line: "Blue West", startedAt: later, runKey: "bw-b",
    })], later);
    expect(res.alerts).toHaveLength(1);
    // And it says how bad the interval was, so a repeat reads as "still".
    expect(res.alerts[0]!.failedRunsSinceLastAlert).toBeGreaterThanOrEqual(1);
  });

  it("still alerts a DIFFERENT line inside another line's cooldown", () => {
    recordCanaryRuns(bundle, [run({ line: "Blue West", runKey: "bw" })], T);
    const res = recordCanaryRuns(bundle, [run({
      line: "Purple", startedAt: T + 60_000, runKey: "pu",
    })], T + 60_000);
    expect(res.alerts).toHaveLength(1);
  });

  it("caps the day across every line, and records what it held back", () => {
    let alerts = 0;
    let suppressed = 0;
    for (let i = 0; i < ALERT_MAX_PER_DAY + 3; i++) {
      const at = T + i * 60_000;
      const res = recordCanaryRuns(bundle, [run({
        line: `Line ${i}`, startedAt: at, runKey: `l-${i}`,
      })], at);
      alerts += res.alerts.length;
      suppressed += res.suppressed;
    }
    expect(alerts).toBe(ALERT_MAX_PER_DAY);
    expect(suppressed).toBe(3);
  });

  it("holds nothing back when the app is healthy", () => {
    const res = recordCanaryRuns(bundle, [run({ ok: true, jumps: [], failures: [] })], T);
    expect(res.alerts).toEqual([]);
    expect(res.suppressed).toBe(0);
  });
});

describe("an alert closes itself", () => {
  const clean = (i: number, at: number) =>
    run({ line: "Red", startedAt: at, runKey: `ok-${i}`, ok: true, jumps: [], failures: [] });

  it("after the line has been clean RECOVERY_RUNS times running", () => {
    recordCanaryRuns(bundle, [run()], T);
    let resolved: { line: string }[] = [];
    for (let i = 0; i < RECOVERY_RUNS; i++) {
      const at = T + (i + 1) * 600_000;
      resolved = recordCanaryRuns(bundle, [clean(i, at)], at).resolved;
    }
    expect(resolved.map((r) => r.line)).toEqual(["Red"]);
    expect(canaryReport(bundle, 24, T + 3_600_000).openAlerts).toBe(0);
  });

  it("but not on one clean run", () => {
    recordCanaryRuns(bundle, [run()], T);
    const at = T + 600_000;
    expect(recordCanaryRuns(bundle, [clean(0, at)], at).resolved).toEqual([]);
    expect(canaryReport(bundle, 24, at).openAlerts).toBe(1);
  });

  it("and a fresh finding after recovery is a fresh alert", () => {
    recordCanaryRuns(bundle, [run()], T);
    for (let i = 0; i < RECOVERY_RUNS; i++) {
      const at = T + (i + 1) * 600_000;
      recordCanaryRuns(bundle, [clean(i, at)], at);
    }
    const later = T + ALERT_COOLDOWN_MS + 60_000;
    expect(recordCanaryRuns(bundle, [run({
      startedAt: later, runKey: "red-again",
    })], later).alerts).toHaveLength(1);
  });
});

describe("the panel payload", () => {
  it("answers which lines were watched, how recently, and how many passed", () => {
    recordCanaryRuns(bundle, [
      run({ line: "Red", startedAt: T, runKey: "r1", ok: true, jumps: [], failures: [] }),
      run({ line: "Red", startedAt: T + 60_000, runKey: "r2" }),
      run({ line: "Purple", startedAt: T + 120_000, runKey: "p1", jumps: [wobble()] }),
    ], T + 180_000);
    const rep = canaryReport(bundle, 24, T + 180_000);
    expect(rep.runs).toBe(3);
    expect(rep.passed).toBe(1);
    // Most recently watched line first — the panel reads top-down as "now".
    expect(rep.lines.map((l) => l.line)).toEqual(["Purple", "Red"]);
    const red = rep.lines.find((l) => l.line === "Red")!;
    expect(red).toMatchObject({ runs: 2, passed: 1, lastOk: false });
  });

  it("carries the failing SEQUENCE, not just a count", () => {
    recordCanaryRuns(bundle, [run()], T);
    const f = canaryReport(bundle, 24, T).findings[0]!;
    expect(f.failures[0]!.detail).toContain("now, then 66 min");
    expect(f.alertedAt).not.toBeNull();
  });

  it("counts only inside its own window, so nothing on the panel disagrees", () => {
    const old = T - 3 * 3_600_000;
    recordCanaryRuns(bundle, [run({ startedAt: old, runKey: "old" })], old);
    recordCanaryRuns(bundle, [run({ line: "Pink", startedAt: T, runKey: "new" })], T);
    const rep = canaryReport(bundle, 1, T);
    expect(rep.runs).toBe(1);
    expect(rep.lines.map((l) => l.line)).toEqual(["Pink"]);
    expect(rep.findings).toHaveLength(1);
  });

  it("is empty and quiet before anything has ever been shipped", () => {
    const rep = canaryReport(bundle, 24, T);
    expect(rep).toMatchObject({ runs: 0, passed: 0, lastRunAt: null, openAlerts: 0 });
    expect(rep.lines).toEqual([]);
    expect(rep.findings).toEqual([]);
  });
});

describe("retention", () => {
  it("sweeps runs past the window on the next write", () => {
    const old = T - (CANARY_RETAIN_DAYS + 1) * 86_400_000;
    recordCanaryRuns(bundle, [run({ startedAt: old, runKey: "ancient" })], old);
    recordCanaryRuns(bundle, [run({ startedAt: T, runKey: "today" })], T);
    const n = bundle.sqlite.prepare("SELECT COUNT(*) AS n FROM canary_runs").get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("normalisation", () => {
  it("keeps a run with no key by deriving one from the run's own identity", () => {
    expect(normalizeCanaryRun({ startedAt: T, line: "Red", ok: true, arrived: true })!.runKey)
      .toBe(`${T}-Red`);
  });

  it("refuses a run with no line or no start", () => {
    expect(normalizeCanaryRun({ startedAt: T })).toBeNull();
    expect(normalizeCanaryRun({ line: "Red" })).toBeNull();
    expect(normalizeCanaryRun("nope")).toBeNull();
  });

  it("clamps free text, because the body is machine output we do not control", () => {
    const r = normalizeCanaryRun({
      startedAt: T,
      line: "x".repeat(500),
      failures: Array.from({ length: 50 }, () => ({ kind: "k", detail: "d".repeat(9999) })),
      jumps: Array.from({ length: 50 }, () => vanishing()),
    })!;
    expect(r.line.length).toBeLessThanOrEqual(60);
    expect(r.failures!.length).toBeLessThanOrEqual(8);
    expect(r.failures![0]!.detail.length).toBeLessThanOrEqual(300);
    expect(r.jumps!.length).toBeLessThanOrEqual(8);
  });

  it("treats a jump with no stated imminence as not imminent", () => {
    // A malformed jump must never be able to manufacture an interruption.
    const r = normalizeCanaryRun({
      startedAt: T, line: "Red",
      jumps: [{ driftSec: 900, from: "a", to: "b" }],
    })!;
    expect(vanishingBusJumps(r.jumps!)).toEqual([]);
  });
});
