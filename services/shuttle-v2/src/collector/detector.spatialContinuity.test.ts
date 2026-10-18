import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db/client.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import type { Route, Stop } from "../schema/api.js";
import { stepManyWithVisits, type VisitState } from "./departure.js";
import type { BusState, BusObservation } from "./detector.js";
import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";
import fixture from "./__fixtures__/same-provider-jump-20261016.json";

function replay(extraGapMs = 0) {
  const net = TransitNetwork.build(structuredClone(fixture.stops) as Stop[], [structuredClone(fixture.route) as Route]);
  const states = new Map<string, BusState>([["#44", structuredClone(fixture.before.state) as BusState]]);
  const visits = new Map<string, VisitState>([["#44", structuredClone(fixture.before.visit) as VisitState]]);
  const snapshots = new Map<number, VisitState>();
  const events = fixture.polls.flatMap(p => {
    const obs = { ...p.observation, collectedAt: p.at + (p.seq >= 1841 ? extraGapMs : 0) } as BusObservation;
    const result = stepManyWithVisits(net, states, visits, [obs]);
    snapshots.set(p.seq, structuredClone(visits.get("#44")!));
    return result.visits;
  });
  return { states, visits, events, snapshots };
}

describe("same-provider observation continuity", () => {
  it("does not derive a leg across the recorded 699m jump in 4.821 seconds", () => {
    const before = fixture.polls.find(p => p.seq === 1840)!.observation;
    const after = fixture.polls.find(p => p.seq === 1841)!.observation;
    expect(before.busId).toBe(after.busId);
    expect(after.collectedAt - before.collectedAt).toBe(4821);
    expect(distanceMeters(before, after)).toBeCloseTo(699.4033125001412, 6);
    const result = replay();
    expect(result.events.filter(e => e.kind === "leg" && e.departedAt === fixture.badLeg.departedAt)).toEqual([]);
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "visit", stopId: 138,
      outcome: "unresolved", departedAt: null, how: null, confidence: null }));
    expect(result.snapshots.get(1845)!.pass).toMatchObject({ stopId: 118,
      pinnedAt: fixture.badLeg.toPinnedAt, arrivedAt: fixture.badLeg.arrivedAt });
  });

  it("keeps a supported journey over the same distance when enough time elapsed", () => {
    const extraGap = 60000;
    const result = replay(extraGap);
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "leg", fromStopId: 138,
      toStopId: 118, reached: true, arrivedAt: fixture.badLeg.arrivedAt + extraGap,
      legSec: fixture.badLeg.legSec + extraGap / 1000 }));
    expect(result.events.filter(e => e.kind === "visit" && e.stopId === 138 && e.outcome === "unresolved")).toEqual([]);
  });

  it("persists an unresolved old stand and a separate later stop without a spanning leg", async () => {
    const bundle = openDb(":memory:");
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
    let latest = fixture.polls[0]!.observation, collector: Collector | undefined;
    class Playback extends UpstreamClient {
      constructor() { super({ baseUrl: "http://invalid.test" }); }
      override async stops() { return structuredClone(fixture.stops) as Stop[]; }
      override async routes() { return [structuredClone(fixture.route) as Route]; }
      override async buses(): Promise<RawBus[]> {
        return [{ id: latest.busId, name: latest.busName, route: latest.routeId,
          lat: latest.lat, lon: latest.lon, heading: latest.heading, lastStop: latest.lastStopId } as RawBus];
      }
    }
    const errors = vi.fn();
    type Inner = { runPoll(): Promise<void>; refreshStaticIfNeeded(force: boolean): Promise<void> };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(latest.collectedAt);
      collector = await Collector.create(bundle, { upstream: new Playback(), upstreamEta: false,
        etaSampler: false, logger: { info() {}, warn() {}, error: errors } });
      await (collector as unknown as Inner).refreshStaticIfNeeded(true);
      for (const poll of fixture.polls) {
        latest = poll.observation; vi.setSystemTime(poll.at);
        await (collector as unknown as Inner).runPoll();
      }
      expect(errors).not.toHaveBeenCalled();
      expect(bundle.sqlite.prepare("SELECT * FROM legs WHERE from_stop_id=138 AND to_stop_id=118").all()).toEqual([]);
      expect(bundle.sqlite.prepare("SELECT * FROM stop_visits WHERE stop_id=138").all()).toContainEqual(
        expect.objectContaining({ outcome: "unresolved", departed_at: null, how: null, confidence: null }));
      expect(bundle.sqlite.prepare("SELECT * FROM stop_visits WHERE stop_id=118").all()).toContainEqual(
        expect.objectContaining({ pinned_at: fixture.badLeg.toPinnedAt, arrived_at: fixture.badLeg.arrivedAt }));
      expect(bundle.sqlite.prepare("SELECT count(*) n FROM raw_positions").get()).toEqual({ n: fixture.polls.length });
    } finally { collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); }
  });
});
