import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { arrivals, rawPositions, segments } from "../db/schema.js";
import type { Route, Stop } from "../schema/api.js";

import { Collector, type Logger } from "./collector.js";
import type { BusState } from "./detector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

// Three stops ~840 m apart on one route, mirroring detector.test.ts.
const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 },
  { id: 3, name: "C", lat: 41.31, lon: -72.91 },
];
const routes: Route[] = [
  { id: 10, name: "Loop", shortName: "L", color: "#000", stops: [1, 2, 3] },
];

// `name` tracks `id` unless the caller overrides it: the collector keys its
// per-vehicle maps on the fleet number, so a fixture whose name never varied
// would silently put every bus in one slot.
function bus(over: Partial<RawBus> = {}): RawBus {
  const id = over.id ?? 7;
  return {
    id,
    name: `#${id}`,
    lat: 41.31,
    lon: -72.93,
    heading: 90,
    route: 10,
    lastStop: 1,
    ...over,
  } as RawBus;
}

/**
 * Upstream stub whose `buses()` resolves only when the test says so, which is
 * what makes overlapping polls reproducible instead of timing-dependent.
 */
class ControllableUpstream extends UpstreamClient {
  readonly pending: Array<{
    resolve: (b: RawBus[]) => void;
    reject: (e: unknown) => void;
  }> = [];
  busCallCount = 0;

  constructor() {
    super({ baseUrl: "http://invalid.test" });
  }

  override async buses(): Promise<RawBus[]> {
    this.busCallCount++;
    return new Promise<RawBus[]>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  override async stops(): Promise<Stop[]> {
    return stops;
  }

  override async routes(): Promise<Route[]> {
    return routes;
  }

  /** Settle the oldest outstanding `buses()` call. */
  /**
   * Resolve once a poll is actually awaiting buses(). A single
   * `await Promise.resolve()` used to stand in for this, which encoded an
   * assumption about how many microtask hops runPoll takes before its fetch —
   * true on a fast machine, flaky on a loaded Pi and on CI runners.
   */
  async untilAwaited(): Promise<void> {
    for (let i = 0; i < 1000 && this.pending.length === 0; i++) {
      await Promise.resolve();
    }
    if (this.pending.length === 0) throw new Error("poll never called buses()");
  }

  deliver(buses: RawBus[]): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending buses() call to deliver");
    next.resolve(buses);
  }
}

interface LogLine {
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

function recordingLogger(sink: LogLine[]): Logger {
  return {
    info: (msg, meta) => sink.push({ level: "info", msg, ...(meta ? { meta } : {}) }),
    warn: (msg, meta) => sink.push({ level: "warn", msg, ...(meta ? { meta } : {}) }),
    error: (msg, meta) => sink.push({ level: "error", msg, ...(meta ? { meta } : {}) }),
  };
}

let tmpDir: string;
let bundle: DbBundle;
let collector: Collector;
let upstream: ControllableUpstream;
let logs: LogLine[];

// Private surfaces the tests drive directly. Exercising the real `runPoll`
// (rather than a reimplementation) is the whole point — the bug being guarded
// against lives in its await boundaries.
type Internals = {
  runPoll: () => Promise<void>;
  refreshStaticIfNeeded: (force: boolean) => Promise<void>;
  states: Map<string, BusState>;
  livePositions: Map<string, unknown>;
  lastPollAttemptAt: number;
};
const inner = (): Internals => collector as unknown as Internals;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-collector-"));
  bundle = openDb(path.join(tmpDir, "test.db"));
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  logs = [];
  upstream = new ControllableUpstream();
  collector = await Collector.create(bundle, {
    upstream,
    logger: recordingLogger(logs),
  });
  await inner().refreshStaticIfNeeded(true);
});

afterEach(() => {
  collector.stop();
  bundle.sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runPoll re-entrancy", () => {
  it("refuses to start a second poll while one is in flight", async () => {
    // The production shape of the bug: the poll timer fires every 5 s but the
    // upstream fetch is allowed 10 s, so ticks 2 and 3 arrive while tick 1 is
    // still awaiting.
    const first = inner().runPoll();
    await Promise.resolve(); // let runPoll reach its await

    const second = inner().runPoll();
    const third = inner().runPoll();
    await Promise.all([second, third]);

    // Only the first call reached upstream.
    expect(upstream.busCallCount).toBe(1);
    expect(collector.pollStats().skipped).toBe(2);

    upstream.deliver([bus()]);
    await first;
    expect(upstream.busCallCount).toBe(1);
  });

  it("makes a skipped tick observable rather than silent", async () => {
    const first = inner().runPoll();
    await Promise.resolve();
    await inner().runPoll();

    const skipLogs = logs.filter((l) => l.msg === "collector.poll_skipped_overlap");
    expect(skipLogs).toHaveLength(1);
    expect(skipLogs[0]!.level).toBe("warn");
    expect(skipLogs[0]!.meta?.skippedTotal).toBe(1);

    upstream.deliver([]);
    await first;
  });

  it("does not refresh the liveness clock on a skipped tick", async () => {
    // A wedged in-flight fetch must let /healthz go stale so Fly restarts us.
    // If a skipped tick bumped `lastPollAttemptAt`, the loop would look
    // healthy forever while stuck behind one hung request.
    const first = inner().runPoll();
    await Promise.resolve();
    inner().lastPollAttemptAt = Date.now() - 120_000;

    await inner().runPoll();
    expect(collector.pollStalenessMs()).toBeGreaterThan(60_000);

    upstream.deliver([]);
    await first;
  });

  it("releases the guard after an upstream failure", async () => {
    const first = inner().runPoll();
    await Promise.resolve();
    upstream.pending.shift()!.reject(new Error("boom"));
    await first;

    // A rejected fetch must not wedge the loop permanently.
    const second = inner().runPoll();
    await Promise.resolve();
    expect(upstream.busCallCount).toBe(2);
    upstream.deliver([]);
    await second;
  });

  it("cannot apply an older observation after a newer one", async () => {
    // The corruption this all exists to prevent. Two polls overlap; the SLOW
    // one started first and carries the OLDER position, but its continuation
    // resumes last. Without ordering protection the stale observation
    // overwrites the fresh anchor and emits a bogus segment.
    //
    // Drive it through the real detector state by running the two polls in
    // the order the event loop would have resumed them.
    const slow = inner().runPoll(); // tick 1, still awaiting
    await upstream.untilAwaited();

    // Tick 2 is skipped by the guard, so there is exactly one writer.
    await inner().runPoll();
    expect(collector.pollStats().skipped).toBe(1);

    upstream.deliver([bus({ lat: 41.31, lon: -72.93 })]);
    await slow;

    const anchorAfterFirst = inner().states.get("#7")!;
    expect(anchorAfterFirst.nearestStopId).toBe(1);

    // Now a genuinely newer poll advancing the bus to stop 2.
    const next = inner().runPoll();
    await upstream.untilAwaited();
    upstream.deliver([bus({ lat: 41.31, lon: -72.92 })]);
    await next;
    expect(inner().states.get("#7")!.nearestStopId).toBe(2);

    // Exactly one forward transition was recorded — no interleaved rewind.
    const rows = bundle.db.select().from(segments).all();
    expect(rows.every((r) => r.fromStopId === 1 && r.toStopId === 2)).toBe(true);
  });
});

describe("upstream payload sanitisation", () => {
  async function poll(buses: RawBus[]): Promise<void> {
    const p = inner().runPoll();
    await Promise.resolve();
    upstream.deliver(buses);
    await p;
  }

  it("drops rows whose coerced numbers are NaN instead of losing the tick", async () => {
    // `numFromString` turns "" into NaN with no refinement, and a NaN busId
    // binds as SQL NULL against a NOT NULL column — the insert throws and
    // every other bus in the payload is lost with it.
    await poll([
      bus({ id: Number.NaN }),
      bus({ id: 8, lat: Number.NaN }),
      bus({ id: 9, lat: 41.31, lon: -72.93 }),
    ]);

    const rows = bundle.db.select().from(rawPositions).all();
    expect(rows.map((r) => r.busId)).toEqual([9]);
    expect(collector.pollStats().droppedObservations).toBe(2);
    expect(logs.some((l) => l.msg === "collector.observations_dropped")).toBe(true);
  });

  it("drops null-island positions from a GPS unit with no fix", async () => {
    await poll([bus({ id: 11, lat: 0, lon: 0 })]);
    expect(bundle.db.select().from(rawPositions).all()).toHaveLength(0);
    expect(collector.getLiveBuses()).toHaveLength(0);
  });

  it("collapses a duplicated bus id to one observation", async () => {
    // Two rows for one bus share a collectedAt, so the detector would see a
    // 0-second transition and record a segment with travelSec 0.
    await poll([
      bus({ id: 12, lat: 41.31, lon: -72.93 }),
      bus({ id: 12, lat: 41.31, lon: -72.92 }),
    ]);
    expect(bundle.db.select().from(rawPositions).all()).toHaveLength(1);
    expect(bundle.db.select().from(segments).all()).toHaveLength(0);
  });

  it("normalises a non-finite heading rather than discarding the position", async () => {
    await poll([bus({ id: 13, heading: Number.NaN, lat: 41.31, lon: -72.93 })]);
    const live = collector.getLiveBuses();
    expect(live).toHaveLength(1);
    expect(live[0]!.heading).toBe(0);
  });
});

describe("state pruning", () => {
  it("ages out stale buses on a tick that carried no observations", async () => {
    // Upstream returns [] overnight. Pruning used to live inside
    // `updateLivePositions`, which those ticks skip — so a bus seen at 6pm
    // stayed in the maps until the next morning's first sighting.
    const p1 = inner().runPoll();
    await Promise.resolve();
    upstream.deliver([bus({ id: 21, lat: 41.31, lon: -72.93 })]);
    await p1;
    expect(inner().livePositions.size).toBe(1);
    expect(inner().states.size).toBe(1);

    // Backdate so the entries are past both TTLs.
    const state = inner().states.get("#21")!;
    state.lastObservedAt = Date.now() - 60 * 60_000;
    (inner().livePositions.get("#21") as { collectedAt: number }).collectedAt =
      Date.now() - 60 * 60_000;

    const p2 = inner().runPoll();
    await Promise.resolve();
    upstream.deliver([]);
    await p2;

    expect(inner().livePositions.size).toBe(0);
    expect(inner().states.size).toBe(0);
  });
});

describe("static refresh", () => {
  it("guards against overlapping refreshes", async () => {
    let calls = 0;
    const slowUpstream = {
      stops: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return stops;
      },
      routes: async () => routes,
      buses: async () => [],
    };
    const c = await Collector.create(bundle, {
      upstream: slowUpstream as unknown as UpstreamClient,
      logger: recordingLogger(logs),
    });
    const priv = c as unknown as Internals;
    const a = priv.refreshStaticIfNeeded(true);
    const b = priv.refreshStaticIfNeeded(true);
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    c.stop();
  });

  it("schedules a retry instead of waiting six hours after a failure", async () => {
    // On a fresh volume the network is built from an empty SQLite, so one
    // flaky response at boot meant six hours of "no routes, no stops, no
    // plans" from a process that still looked healthy.
    const failing = {
      stops: async () => {
        throw new Error("upstream down");
      },
      routes: async () => routes,
      buses: async () => [],
    };
    const c = await Collector.create(bundle, {
      upstream: failing as unknown as UpstreamClient,
      logger: recordingLogger(logs),
    });
    await (c as unknown as Internals).refreshStaticIfNeeded(true);
    const scheduled = logs.filter((l) => l.msg === "collector.static_retry_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.meta?.delayMs).toBe(60_000);
    c.stop();
  });

  it("treats an empty feed as a failure worth retrying", async () => {
    const empty = {
      stops: async () => [],
      routes: async () => [],
      buses: async () => [],
    };
    const c = await Collector.create(bundle, {
      upstream: empty as unknown as UpstreamClient,
      logger: recordingLogger(logs),
    });
    await (c as unknown as Internals).refreshStaticIfNeeded(true);
    expect(logs.some((l) => l.msg === "collector.static_refresh_empty")).toBe(true);
    expect(logs.some((l) => l.msg === "collector.static_retry_scheduled")).toBe(true);
    c.stop();
  });
});

// ---------------------------------------------------------------------------
// Upstream's `bus_id` is reissued per service block — measured on production,
// 1,059 distinct ids for 50 distinct `bus_name`s over 30 days. Both
// per-vehicle maps are therefore keyed on the fleet number.
// ---------------------------------------------------------------------------

describe("vehicle identity across an id reissue", () => {
  async function poll(buses: RawBus[]): Promise<void> {
    const p = inner().runPoll();
    await Promise.resolve();
    upstream.deliver(buses);
    await p;
  }

  it("serves one live entry per vehicle when its id is reissued", async () => {
    // Keyed by bus_id the retired entry lingered for the full 120 s live TTL,
    // so /api/buses served two rows with the same bus_name and the map drew
    // two markers for one bus. Three of the 15 reissues in a 6.6 h production
    // replay had the new id appear inside that window.
    await poll([{ ...bus({ id: 65531 }), name: "#40" } as RawBus]);
    expect(collector.getLiveBuses()).toHaveLength(1);

    await poll([{ ...bus({ id: 65540, lon: -72.929 }), name: "#40" } as RawBus]);

    const live = collector.getLiveBuses();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ busName: "#40", busId: 65540 });
    expect(inner().livePositions.size).toBe(1);
    expect(inner().states.size).toBe(1);
  });

  it("still serves both buses while two ids share one name", async () => {
    // The pathological case: `#43` was reported by ids 65531 and 65533
    // simultaneously for 6.7 h. Those are two physical buses and riders must
    // see both — collapsing them onto the fleet number would hide one.
    await poll([
      { ...bus({ id: 65531, lon: -72.93 }), name: "#43" } as RawBus,
      { ...bus({ id: 65533, lon: -72.91 }), name: "#43" } as RawBus,
    ]);
    const live = collector.getLiveBuses();
    expect(live).toHaveLength(2);
    expect(live.map((b) => b.busId).sort()).toEqual([65531, 65533]);
    expect([...inner().states.keys()].sort()).toEqual(["#43#65531", "#43#65533"]);
    expect(logs.some((l) => l.msg === "collector.bus_name_contended")).toBe(true);
  });

  it("drops the retired half once the two ids stop colliding", async () => {
    await poll([
      { ...bus({ id: 65531, lon: -72.93 }), name: "#43" } as RawBus,
      { ...bus({ id: 65533, lon: -72.91 }), name: "#43" } as RawBus,
    ]);
    expect(collector.getLiveBuses()).toHaveLength(2);

    // 65531 goes out of service. Without the reconcile its entry would sit
    // there for 120 s as a duplicate `#43`.
    await poll([{ ...bus({ id: 65533, lon: -72.91 }), name: "#43" } as RawBus]);
    const live = collector.getLiveBuses();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ busId: 65533 });
    expect([...inner().livePositions.keys()]).toEqual(["#43"]);
  });

  it("keeps a new vehicle's arrival separate from an existing one", async () => {
    await poll([{ ...bus({ id: 65531 }), name: "#40" } as RawBus]);
    await poll([
      { ...bus({ id: 65531 }), name: "#40" } as RawBus,
      { ...bus({ id: 65999, lon: -72.92 }), name: "#317" } as RawBus,
    ]);
    const live = collector.getLiveBuses();
    expect(live.map((b) => b.busName).sort()).toEqual(["#317", "#40"]);
    expect(inner().states.get("#317")?.nearestStopId).toBe(2);
    expect(inner().states.get("#40")?.nearestStopId).toBe(1);
    // No segment: `#317` has only ever been seen once.
    expect(
      bundle.db.select().from(segments).all().filter((r) => r.busName === "#317"),
    ).toHaveLength(0);
  });

  it("patches the dwell onto the arrival row written under the old id", async () => {
    // The arrival was inserted while 65531 was in force; the dwell is emitted
    // under 65540. Matching the patch on the reporting id would update nothing
    // and leave a real visit with no departure time.
    await poll([{ ...bus({ id: 65531 }), name: "#40" } as RawBus]);
    const arrival = bundle.db.select().from(arrivals).all();
    expect(arrival).toHaveLength(1);
    expect(arrival[0]).toMatchObject({ busId: 65531, stopId: 1 });

    // Backdate the visit — both the in-memory anchor and the row it will be
    // patched onto — so the dwell clears MIN_DWELL_SEC while the reissue still
    // reads as continuous (under MAX_HANDOFF_GAP_MS). Then move the bus to
    // stop 2 under its new id.
    const state = inner().states.get("#40")!;
    state.enteredAt -= 45_000;
    state.lastObservedAt -= 45_000;
    bundle.sqlite.prepare("UPDATE arrivals SET arrived_at = arrived_at - 45000").run();
    await poll([{ ...bus({ id: 65540, lon: -72.92 }), name: "#40" } as RawBus]);

    const patched = bundle.db.select().from(arrivals).all().find((r) => r.stopId === 1)!;
    expect(patched.busId).toBe(65531);
    expect(patched.dwellSec).toBeGreaterThan(0);
    expect(patched.departedAt).not.toBeNull();
  });
});
