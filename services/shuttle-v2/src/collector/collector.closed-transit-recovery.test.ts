import { readFileSync } from "node:fs";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";
import { Collector } from "./collector.js";
import type { BusObservation } from "./detector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/restart-after-departure-blue-20261017.json", import.meta.url), "utf8")) as {
  restartAt: number; route: Route; stops: Stop[]; observations: BusObservation[];
  recordedVisit: { anchored_at: number; pinned_at: number; departed_at: number; stand_sec: number };
  recordedLeg: { departed_at: number; arrived_at: number; leg_sec: number; drive_sec: number; hold_sec: number };
};
type Inner = { refreshStaticIfNeeded(force: boolean): Promise<void>; runPoll(): Promise<void> };
type EvidenceChange = "missing" | "pin" | "departure" | "outcome" | "conflict" | "duplicate" | "clipped-history";

// Retain the fixture's original production row. Keeping the first approach
// now avoids the two phantom 116/53 visits and the later re-anchor; the real
// pin, resting plateau, departure and next leg must remain exactly the same.
const continuousAnchor = 1792258982413;

async function collect(restartAt?: number | readonly number[], change?: EvidenceChange) {
  const bundle = openDb(":memory:");
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  let latest = fixture.observations[0]!;
  class Stub extends UpstreamClient {
    constructor() { super({ baseUrl: "http://invalid.test" }); }
    override async stops() { return fixture.stops; }
    override async routes() { return [fixture.route]; }
    override async buses(): Promise<RawBus[]> {
      return [{ id: latest.busId, name: latest.busName, route: latest.routeId, lat: latest.lat,
        lon: latest.lon, heading: latest.heading, lastStop: latest.lastStopId } as RawBus];
    }
  }
  let collector: Collector | undefined;
  const recoveries: { at: number; enteredAt: number }[] = [];
  const restartTimes = new Set(typeof restartAt === "number" ? [restartAt] : restartAt ?? []);
  const options = { upstream: new Stub(), logger: {
    info(message: string, detail?: Record<string, unknown>) {
      if (message === "collector.visit_recovered") recoveries.push({ at: latest.collectedAt, enteredAt: Number(detail?.enteredAt) });
    }, warn: vi.fn(), error: vi.fn(),
  } };
  vi.useFakeTimers();
  try {
    vi.setSystemTime(latest.collectedAt);
    collector = await Collector.create(bundle, options);
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    for (const obs of fixture.observations) {
      latest = obs; vi.setSystemTime(obs.collectedAt);
      if (restartTimes.has(obs.collectedAt)) {
        collector.stop();
        const anchor = continuousAnchor;
        if (change === "missing") bundle.sqlite.prepare("DELETE FROM stop_visits WHERE anchored_at=?").run(anchor);
        if (change === "pin") bundle.sqlite.prepare("UPDATE stop_visits SET pinned_at=pinned_at+1 WHERE anchored_at=?").run(anchor);
        if (change === "departure") bundle.sqlite.prepare("UPDATE stop_visits SET departed_at=departed_at+1 WHERE anchored_at=?").run(anchor);
        if (change === "outcome") bundle.sqlite.prepare("UPDATE stop_visits SET outcome='unresolved' WHERE anchored_at=?").run(anchor);
        if (change === "conflict" || change === "duplicate") {
          const { id: _id, ...row } = bundle.sqlite.prepare("SELECT * FROM stop_visits WHERE anchored_at=?").get(anchor) as Record<string, unknown>;
          if (change === "conflict") row.departed_at = Number(row.departed_at) + 1;
          bundle.sqlite.prepare(`INSERT INTO stop_visits (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
        }
        if (change === "clipped-history") bundle.sqlite.prepare("DELETE FROM raw_positions WHERE collected_at<=?").run(anchor);
        collector = await Collector.create(bundle, options);
      }
      await (collector as unknown as Inner).runPoll();
    }
    const withoutId = (rows: unknown[]) => rows.map(row => {
      const { id: _id, ...evidence } = row as Record<string, unknown>;
      return evidence;
    });
    expect(options.logger.error).not.toHaveBeenCalled();
    return {
      visits: withoutId(bundle.sqlite.prepare("SELECT * FROM stop_visits ORDER BY anchored_at").all()),
      legs: withoutId(bundle.sqlite.prepare("SELECT * FROM legs ORDER BY departed_at,arrived_at").all()),
      recoveries,
    };
  } finally {
    collector?.stop(); vi.useRealTimers(); bundle.sqlite.close();
  }
}

describe("restarting after a visit was written but before its next anchor", () => {
  it("keeps the completed Blue visit and the full following leg exactly once", async () => {
    const uninterrupted = await collect();
    expect(uninterrupted.visits.filter(v => v.stop_id === 116)).toEqual([expect.objectContaining({
      anchored_at: continuousAnchor,
      stop_id: 116, pinned_at: fixture.recordedVisit.pinned_at,
      departed_at: fixture.recordedVisit.departed_at, stand_sec: fixture.recordedVisit.stand_sec,
    })]);
    expect(uninterrupted.visits.filter(v => [116, 53].includes(Number(v.stop_id)) && v.pinned_at === null)).toEqual([]);
    expect(uninterrupted.legs.find(v => v.departed_at === fixture.recordedLeg.departed_at)).toMatchObject({
      from_stop_id: 116, to_stop_id: 53, arrived_at: fixture.recordedLeg.arrived_at,
      leg_sec: fixture.recordedLeg.leg_sec, drive_sec: fixture.recordedLeg.drive_sec, hold_sec: fixture.recordedLeg.hold_sec,
    });
    const restarted = await collect(fixture.restartAt);
    expect.soft(restarted.visits).toEqual(uninterrupted.visits);
    expect.soft(restarted.legs).toEqual(uninterrupted.legs);
    expect(restarted.recoveries).toContainEqual({ at: fixture.restartAt, enteredAt: continuousAnchor });
  });

  const laterRestarts = fixture.observations.filter(o => o.collectedAt > fixture.restartAt
    && o.collectedAt < 1792259453400).map(o => o.collectedAt);
  it.each(laterRestarts)("preserves the same departure and holds at the later observed restart %s", async at => {
    const expected = await collect();
    const actual = await collect(at);
    expect(actual.visits).toEqual(expected.visits);
    expect(actual.legs).toEqual(expected.legs);
  });

  it("does not replay a completed visit or shorten its leg across repeated restarts", async () => {
    const expected = await collect();
    const actual = await collect([fixture.restartAt, laterRestarts[1]!]);
    expect(actual.visits).toEqual(expected.visits);
    expect(actual.legs).toEqual(expected.legs);
    expect(actual.recoveries.filter(e => e.enteredAt === continuousAnchor)).toHaveLength(2);
  });

  it("keeps consistent older duplicate rows without inserting another visit", async () => {
    const expected = await collect();
    const actual = await collect(fixture.restartAt, "duplicate");
    expect(actual.visits.filter(v => v.anchored_at === continuousAnchor)).toHaveLength(2);
    expect(actual.visits.filter(v => v.stop_id === 116 && v.pinned_at === null)).toHaveLength(0);
    expect(actual.legs).toEqual(expected.legs);
    expect(actual.recoveries).toContainEqual({ at: fixture.restartAt, enteredAt: continuousAnchor });
  });

  it.each<EvidenceChange>(["missing", "pin", "departure", "outcome", "conflict", "clipped-history"])(
    "refuses closed-transit recovery with %s evidence", async change => {
      const actual = await collect(fixture.restartAt, change);
      expect(actual.recoveries).not.toContainEqual({ at: fixture.restartAt, enteredAt: continuousAnchor });
    },
  );
});
