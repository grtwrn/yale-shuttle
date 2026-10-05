import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Collector } from "../collector/collector.js";
import type { RawBus, UpstreamClient } from "../collector/upstream.js";
import { openDb, type DbBundle } from "../db/client.js";
import { TransitNetwork, type DwellStats } from "../network/TransitNetwork.js";
import { buildBusesPayload, dwellHourFields } from "../server/v1compat.js";
import { calibrate, standQuantiles } from "./calibrator.js";
import {
  HOUR_STAND_GATE_INTERVAL_MS,
  HOUR_STAND_GATE_MIN_DAYS,
  HOUR_STAND_HALF_WIDTH_MIN,
  HOUR_STAND_LAYOVER_MIN_SEC,
  HOUR_STAND_ROUTE_IDS,
  HOUR_STAND_SHRINK_K,
  HourStandGateCache,
  attachHourStandTables,
  etMinuteOfDay,
  gateHourCell,
  hourWindowTable,
  loadStandVisits,
  servedHourStandCells,
  shippedMedian,
  standVisit,
  tenQuantiles,
  todDistance,
  type HourGateResult,
  type StandVisit,
} from "./hourStand.js";

/**
 * The client's copy of the layover threshold is parsed out of its source, as
 * lapFit.test.ts does for its constants: a server that called a cell a layover
 * on one threshold while the client classed it on another would gate cells the
 * client prices as kerb stops.
 */
const CLIENT_TABLES = fs.readFileSync(path.resolve(__dirname, "../../web/src/eta/tables.ts"), "utf8");

describe("the hour-stand constants are the client's", () => {
  it("LAYOVER_MIN_SEC", () => {
    const m = /export const LAYOVER_MIN_SEC = (\d+);/.exec(CLIENT_TABLES);
    expect(m, "web/src/eta/tables.ts no longer exports LAYOVER_MIN_SEC").not.toBeNull();
    expect(Number(m![1])).toBe(HOUR_STAND_LAYOVER_MIN_SEC);
  });

  it("tenQuantiles is the calibrator's standQuantiles", () => {
    const xs = [0, 0, 12, 40, 55, 70, 95, 340, 390, 455, 570, 755, 1020];
    expect(tenQuantiles(xs)).toEqual(standQuantiles(xs));
  });
});

describe("the ET clock (independent of the process TZ)", () => {
  it("reads the ET minute of the day", () => {
    expect(etMinuteOfDay(Date.parse("2026-10-04T11:23:00Z"))).toBe(7 * 60 + 23);
    expect(etMinuteOfDay(Date.parse("2026-10-04T11:23:30Z"))).toBe(7 * 60 + 23.5);
    expect(etMinuteOfDay(Date.parse("2026-01-10T12:00:00Z"))).toBe(7 * 60); // EST
  });

  it("follows both DST changes", () => {
    // 2026-11-01: 01:30 EDT, then 01:30 EST an hour later.
    expect(etMinuteOfDay(Date.parse("2026-11-01T05:30:00Z"))).toBe(90);
    expect(etMinuteOfDay(Date.parse("2026-11-01T06:30:00Z"))).toBe(90);
    // 2026-03-08: 01:30 EST, then 03:30 EDT.
    expect(etMinuteOfDay(Date.parse("2026-03-08T06:30:00Z"))).toBe(90);
    expect(etMinuteOfDay(Date.parse("2026-03-08T07:30:00Z"))).toBe(210);
  });

  it("dates a visit by its ET day", () => {
    expect(standVisit(Date.parse("2026-10-05T03:30:00Z"), 60).day).toBe("2026-10-04");
  });

  it("measures time of day the short way round midnight", () => {
    expect(todDistance(10, 1430)).toBe(20);
    expect(todDistance(600, 540)).toBe(60);
  });
});

// -- a synthetic layover whose hold follows the clock --------------------------

/** 2026-09-05 00:00 ET (a Saturday). */
const DAY0 = Date.parse("2026-09-05T04:00:00Z");
const DAY_MS = 86_400_000;

/**
 * `days` service days. Each hour 07-17 ET one visit; the morning (before 10)
 * stands `morning` s, the rest `afternoon` s, each jittered deterministically
 * (the pooled median lands on the afternoon's ~180 s: a layover, like 333
 * Cedar's ~220 s). `flat` draws every stand from one mixture instead (no hour
 * signal).
 */
function cell(days: number, opts: { morning?: number; afternoon?: number; flat?: boolean } = {}): StandVisit[] {
  const out: StandVisit[] = [];
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let d = 0; d < days; d++) {
    for (let h = 7; h <= 17; h++) {
      const at = DAY0 + d * DAY_MS + h * 3_600_000 + 25 * 60_000;
      const base = opts.flat ? (rnd() < 0.4 ? 600 : 180) : h < 10 ? (opts.morning ?? 600) : (opts.afternoon ?? 180);
      out.push(standVisit(at, Math.max(0, base + (rnd() - 0.5) * 0.4 * base)));
    }
  }
  return out;
}

describe("the time-of-day table", () => {
  const visits = cell(10);
  const pooled = tenQuantiles(visits.map((v) => v.stand));

  it("is the window's quantiles shrunk toward the pooled table with n / (n + K)", () => {
    const centre = 8 * 60 + 25; // 08:25 ET: the 07:25, 08:25 and 09:25 visits are within the hour
    const win = visits.filter((v) => todDistance(v.tod, centre) <= HOUR_STAND_HALF_WIDTH_MIN);
    expect(win.length).toBe(30);
    const t = hourWindowTable(visits, centre, pooled);
    const w = 30 / (30 + HOUR_STAND_SHRINK_K);
    expect(t.n).toBe(30);
    expect(t.w).toBeCloseTo(w, 12);
    const own = tenQuantiles(win.map((v) => v.stand));
    t.q.forEach((x, i) => expect(x).toBeCloseTo(w * own[i]! + (1 - w) * pooled[i]!, 9));
    // Ascending, and the morning's median is the morning's, not the pooled one.
    for (let i = 1; i < t.q.length; i++) expect(t.q[i]!).toBeGreaterThanOrEqual(t.q[i - 1]!);
    expect(shippedMedian(t.q)).toBeGreaterThan(450);
    expect(shippedMedian(pooled)).toBeLessThan(300);
  });

  it("is the pooled table itself where the window is empty", () => {
    const t = hourWindowTable(visits, 2 * 60, pooled); // 02:00 ET, no service
    expect(t).toEqual({ q: pooled, n: 0, w: 0 });
  });
});

describe("the cell gate", () => {
  it("serves a layover whose hold follows the clock", () => {
    const g = gateHourCell("4:10", cell(10));
    expect(g.pass).toBe(true);
    expect(g.reason).toBe("pass");
    expect(g.hour).toBeLessThan(g.pooled);
    expect(g.upper).toBeLessThan(0);
    // The incident's direction: the pooled table prices the morning hold short.
    expect(g.morningBiasPooled).toBeGreaterThan(300);
    expect(Math.abs(g.morningBiasHour)).toBeLessThan(g.morningBiasPooled / 2);
  });

  it("refuses a layover with no hour signal (not better beyond day-to-day noise)", () => {
    const g = gateHourCell("10:10", cell(12, { flat: true }));
    expect(g.pass).toBe(false);
    expect(g.upper).toBeGreaterThanOrEqual(0);
    expect(g.reason).toMatch(/^upper /);
  });

  it(`needs ${HOUR_STAND_GATE_MIN_DAYS} service days`, () => {
    const g = gateHourCell("4:10", cell(HOUR_STAND_GATE_MIN_DAYS - 1));
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/^days /);
  });

  it("is for layovers only", () => {
    const g = gateHourCell("1:5", cell(10, { morning: 40, afternoon: 20 }));
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/^not a layover/);
  });

  it("needs enough visits", () => {
    const g = gateHourCell("4:10", cell(10).slice(0, 50));
    expect(g.pass).toBe(false);
    expect(g.reason).toMatch(/^visits /);
  });

  it("is deterministic", () => {
    expect(gateHourCell("4:10", cell(10))).toEqual(gateHourCell("4:10", cell(10)));
  });
});

describe("the rollout ledger", () => {
  const pass = { pass: true } as HourGateResult;
  const fail = { pass: false } as HourGateResult;

  it("serves only gate-passing cells on listed routes", () => {
    expect(HOUR_STAND_ROUTE_IDS.has(4)).toBe(true);
    const served = servedHourStandCells(new Map([["4:10", pass], ["4:116", fail], ["10:10", pass]]));
    expect([...served]).toEqual(["4:10"]);
  });

  it("names every listed route with its rider-sim evidence in the source", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "./hourStand.ts"), "utf8");
    const block = /export const HOUR_STAND_ROUTE_IDS[^;]*;/.exec(src)![0];
    const doc = src.slice(0, src.indexOf(block));
    for (const id of HOUR_STAND_ROUTE_IDS) {
      expect(new RegExp(`\\* - \\*\\*${id} \\(`).test(doc), `route ${id} has no evidence comment beside it`).toBe(true);
    }
    expect(/STRAND \d+ fixed \/ \d+\s+\*?\s*introduced/.test(doc)).toBe(true);
  });
});

describe("attaching the table", () => {
  const now = Date.parse("2026-10-04T12:30:00Z"); // 08:30 ET
  const visits = cell(10);
  const pooledQ = tenQuantiles(visits.map((v) => v.stand));
  const entry = (extra: Partial<DwellStats> = {}): DwellStats => ({ mean: 300, stddev: 100, n: 0, q: pooledQ, qn: visits.length, pstop: 0.97, ...extra });

  it("puts this moment's table on an eligible cell and leaves the pooled fields alone", () => {
    const dwells = new Map([["4:10", entry()]]);
    const sink = {} as TransitNetwork;
    expect(attachHourStandTables(dwells, sink, new Map([["4:10", visits]]), now)).toBe(1);
    const d = dwells.get("4:10")!;
    const t = hourWindowTable(visits, etMinuteOfDay(now), pooledQ);
    expect(d.qh).toEqual(t.q);
    expect(d.qhn).toBe(t.n);
    expect({ ...d, qh: undefined, qhn: undefined }).toEqual({ ...entry(), qh: undefined, qhn: undefined });
    expect(dwellHourFields(d)).toEqual({ qh: t.q.map((x) => Math.round(x)), qhn: t.n });
  });

  it("steps aside for a lap fit, a release fit, a missing table, an empty window and a repeated stop", () => {
    const network = TransitNetwork.build(
      [1, 2, 3, 10].map((id) => ({ id, name: `S${id}`, lat: 41.3 + id / 1000, lon: -72.93 })),
      [{ id: 10, name: "Purple", shortName: "P", color: "#808", stops: [10, 1, 2, 1] }],
    );
    const lap = entry({ lapB: -0.001, lapM: 3000, lapN: 300 });
    const release = entry({ release: {} as NonNullable<DwellStats["release"]> });
    const noTable = { mean: 15, stddev: 10, n: 0 } as DwellStats;
    const dwells = new Map<string, DwellStats>([
      ["3:11", lap], ["2:10", release], ["1:10", noTable], ["10:1", entry()], ["10:10", entry()], ["15:10", entry()],
    ]);
    const night = visits.map((v) => standVisit(v.at - 12 * 3_600_000, v.stand)); // 19:25-05:25 ET: nothing near 08:30
    const by = new Map<string, readonly StandVisit[]>([
      ["3:11", visits], ["2:10", visits], ["1:10", visits], ["10:1", visits], ["10:10", visits], ["15:10", night],
    ]);
    expect(attachHourStandTables(dwells, network, by, now)).toBe(1);
    expect(dwells.get("3:11")).toBe(lap);
    expect(dwells.get("2:10")).toBe(release);
    expect(dwells.get("1:10")).toBe(noTable);
    expect(dwells.get("10:1")!.qh).toBeUndefined(); // stop 1 repeats on route 10
    expect(dwells.get("15:10")!.qh).toBeUndefined(); // empty window
    expect(dwells.get("10:10")!.qh).toBeDefined();
  });
});

// -- the SQL half, against a real database ----------------------------------------

describe("hour stands over a real database", () => {
  let tmpDir: string;
  let bundle: DbBundle;
  const now = new Date("2026-09-15T12:30:00Z"); // 08:30 ET

  function addVisit(routeId: number, stopId: number, anchoredAt: number, standSec: number, outcome: "stopped" | "passed" = "stopped") {
    const pinnedAt = anchoredAt + 10_000;
    const departedAt = pinnedAt + standSec * 1000;
    bundle.sqlite
      .prepare(
        `INSERT INTO stop_visits (bus_id, bus_name, anchor_bus_id, route_id, stop_id, stop_index,
           anchored_at, pinned_at, arrived_at, departed_at, stand_sec, inside_sec, outcome, how,
           confidence, first_step_m, steps, far_m, confirm_sec, rest_polls, shuffles, first_moved_at,
           last_at_rest_at, closest_m, dow, hour)
         VALUES (1, 'Bus 1', 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'far', 1, 31, 3, 160, 15, 4, 0, NULL, NULL, 5, 0, 0)`,
      )
      .run(routeId, stopId, anchoredAt, pinnedAt, pinnedAt, departedAt, standSec, standSec, outcome);
  }

  /** The synthetic cell, written as visits that ended before `now`. */
  function seed(routeId: number, stopId: number): StandVisit[] {
    const vs = cell(10).map((v) => standVisit(v.at, Math.round(v.stand)));
    for (const v of vs) addVisit(routeId, stopId, v.at, v.stand);
    return vs;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-hourstand-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads one row per visit, filtered in SQL, nothing whose evidence is still to come", () => {
    seed(4, 10);
    addVisit(4, 116, now.getTime() - 3_600_000, 300);
    addVisit(10, 10, now.getTime() - 3_600_000, 300);
    addVisit(4, 10, now.getTime() - 60_000, 300); // departs after now: the future
    const all = loadStandVisits(bundle.db, 30, now.getTime());
    expect(all.get("4:10")!.length).toBe(110);
    expect(all.get("4:116")!.length).toBe(1);
    expect([...loadStandVisits(bundle.db, 30, now.getTime(), { routes: new Set([4]) }).keys()].sort()).toEqual(["4:10", "4:116"]);
    expect([...loadStandVisits(bundle.db, 30, now.getTime(), { cells: new Set(["4:10"]) }).keys()]).toEqual(["4:10"]);
    expect(loadStandVisits(bundle.db, 30, now.getTime(), { cells: new Set() }).size).toBe(0);
  });

  it("calibrate serves `qh` on a served cell and nothing anywhere else", () => {
    const vs = seed(4, 10);
    const network = TransitNetwork.build(
      [{ id: 10, name: "333 Cedar", lat: 41.303, lon: -72.934 }, { id: 116, name: "Stop & Shop", lat: 41.315, lon: -72.938 }],
      [{ id: 4, name: "Blue Weekend", shortName: "BW", color: "#42A5F5", stops: [10, 116] }],
    );
    const off = calibrate(bundle.db, network, now);
    const pooledEntry = network.getDwellStats(4, 10);
    expect(off.hourStandCount).toBe(0);
    expect(pooledEntry.qh).toBeUndefined();

    const on = calibrate(bundle.db, network, now, new Map(), new Map(), new Set(["4:10"]));
    const served = network.getDwellStats(4, 10);
    expect(on.hourStandCount).toBe(1);
    const t = hourWindowTable(vs, etMinuteOfDay(now.getTime()), served.q!);
    expect(served.qh).toEqual(t.q);
    expect(served.qhn).toBe(20); // 08:25 and 09:25 on ten days; 07:25 is 65 min from 08:30
    // Everything else on the entry is the pooled calibration, unchanged.
    expect({ ...served, qh: undefined, qhn: undefined }).toEqual({ ...pooledEntry, qh: undefined, qhn: undefined });
    // Morning at 333 Cedar: the served table says the long hold the pooled one cannot.
    expect(shippedMedian(served.qh!)).toBeGreaterThan(shippedMedian(served.q!) + 200);
  });

  it("the gate cache serves the ledger's passing cells and refreshes on its own cadence", () => {
    seed(4, 10);
    seed(10, 10); // the same signal on a route NOT on the ledger: gated, not served
    const cache = new HourStandGateCache(bundle.db, 30);
    const first = cache.get(now.getTime());
    expect([...first]).toEqual(["4:10"]);
    expect([...cache.results().keys()]).toEqual(["4:10"]);
    expect(cache.get(now.getTime() + HOUR_STAND_GATE_INTERVAL_MS - 1)).toBe(first);
    expect(cache.get(now.getTime() + HOUR_STAND_GATE_INTERVAL_MS)).not.toBe(first);
  });
});

describe("on the wire", () => {
  let tmpDir: string;
  let bundle: DbBundle;
  let collector: Collector;
  const upstream = {
    buses: async () => [{ id: 1, name: "#44", route: 4, lat: 41.303, lon: -72.934, heading: 0, lastStop: 10 } as RawBus],
    stops: async () => [{ id: 10, name: "333 Cedar", lat: 41.303254, lon: -72.934247 }, { id: 116, name: "Stop & Shop", lat: 41.315041, lon: -72.938202 }],
    routes: async () => [{ id: 4, name: "Blue Weekend", shortName: "BW", color: "#42A5F5", stops: [10, 116] }],
  } as UpstreamClient;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-hourstand-wire-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    collector = await Collector.create(bundle, { upstream, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    await (collector as unknown as { refreshStaticIfNeeded: (f: boolean) => Promise<void> }).refreshStaticIfNeeded(true);
  });
  afterEach(() => {
    collector.stop();
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves `qh`/`qhn` in whole seconds on the served cell's pooled entry only", () => {
    const net = collector.ref.get();
    const q = [30, 40, 55, 75, 111, 326, 393, 450, 566, 748];
    net.setCalibration(new Map(), new Map<string, DwellStats>([
      ["4:10", { mean: 420, stddev: 360, n: 0, q, qn: 102, pstop: 0.969, qh: [191.6, 258.9, 317, 328, 364.4, 495, 602, 631, 703, 777.2], qhn: 16 }],
      ["4:116", { mean: 600, stddev: 300, n: 0, q, qn: 101 }],
    ]));
    const dwells = buildBusesPayload(collector, null).dwells as Record<string, Record<string, Record<string, unknown>>>;
    expect(dwells["4"]!["10"]).toMatchObject({ q, qn: 102, pstop: 0.969, qh: [192, 259, 317, 328, 364, 495, 602, 631, 703, 777], qhn: 16 });
    expect(dwells["4"]!["116"]).not.toHaveProperty("qh");
    expect(dwells["4"]!["116"]).not.toHaveProperty("qhn");
  });
});
