import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import { openDb } from "../db/client.js";
import { stepManyWithVisits, type VisitEvent, type VisitState } from "./departure.js";
import { type BusObservation, type BusState, type TrackPlan, MAX_HANDOFF_GAP_MS, planTracks, trackKeyFor } from "./detector.js";
import { recoverOpenVisit, type OpenArrival } from "./visitRecovery.js";
import { Collector } from "./collector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";
import type { Stop, Route } from "../schema/api.js";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/restart-fresh-winchester.json", import.meta.url), "utf8")) as {
  restartAt: number; stopId: number; stops: Stop[]; route: Route;
  observations: BusObservation[]; arrivals: OpenArrival[];
};
const network = TransitNetwork.build(fixture.stops, [fixture.route]);
const current = fixture.observations.find(o => o.collectedAt === fixture.restartAt)!;
const history = fixture.observations.filter(o => o.collectedAt < fixture.restartAt);
function replay(observations: BusObservation[]) {
  const states = new Map<string, BusState>(), visits = new Map<string, VisitState>();
  const events: VisitEvent[] = [];
  for (const obs of observations) events.push(...stepManyWithVisits(network, states, visits, [obs]).visits);
  return { states, visits, events };
}

describe("recovering the complete visit on a fresh restart fix", () => {
  it("reconstructs the exact pre-restart reducers, including an open shuffle candidate", () => {
    const expected = replay(history);
    const got = recoverOpenVisit(network, current, history, fixture.arrivals);
    expect(got).not.toBeNull();
    expect(got!.detector).toEqual(expected.states.get(current.busName));
    expect(got!.visit).toEqual(expected.visits.get(current.busName));
    expect(got!.visit.pass!.candidate).not.toBeNull();
    const states = new Map([[current.busName, got!.detector]]);
    const visits = new Map([[current.busName, got!.visit]]);
    const completed: VisitEvent[] = [];
    for (const obs of fixture.observations.filter(o => o.collectedAt >= fixture.restartAt)) {
      completed.push(...stepManyWithVisits(network, states, visits, [obs]).visits);
    }
    const reference = replay(fixture.observations).events;
    const atStop = (e: VisitEvent) => e.kind === "visit" && e.stopId === fixture.stopId;
    expect(completed.filter(atStop)).toEqual(reference.filter(atStop));
    expect(completed.find(atStop)).toMatchObject({ standSec: 439.48, shuffles: 3 });
  });

  it("does not join a closed visit, a different route, or a reissued identity", () => {
    expect(recoverOpenVisit(network, current, history, [{ ...fixture.arrivals[0]!, departedAt: current.collectedAt - 1000 }])).toBeNull();
    expect(recoverOpenVisit(network, { ...current, routeId: 1 }, history, fixture.arrivals)).toBeNull();
    expect(recoverOpenVisit(network, { ...current, busId: current.busId + 1 }, history, fixture.arrivals)).toBeNull();
    expect(recoverOpenVisit(network, { ...current, busName: "#different" }, history, fixture.arrivals)).toBeNull();
  });

  it("refuses stale, unordered, future, and unmatched histories", () => {
    expect(recoverOpenVisit(network, { ...current, collectedAt: history.at(-1)!.collectedAt + MAX_HANDOFF_GAP_MS + 1 }, history, fixture.arrivals)).toBeNull();
    expect(recoverOpenVisit(network, current, [...history].reverse(), fixture.arrivals)).toBeNull();
    expect(recoverOpenVisit(network, current, [...history, current], fixture.arrivals)).toBeNull();
    expect(recoverOpenVisit(network, current, history, [{ ...fixture.arrivals[0]!, arrivedAt: fixture.arrivals[0]!.arrivedAt - 1 }])).toBeNull();
    // A missing middle section after arrival cannot preserve the old episode.
    const gapped = history.filter(o => o.collectedAt < fixture.arrivals[0]!.arrivedAt + 20000
      || o.collectedAt > fixture.arrivals[0]!.arrivedAt + MAX_HANDOFF_GAP_MS + 60000);
    expect(recoverOpenVisit(network, current, gapped, fixture.arrivals)).toBeNull();
  });

  it("preserves a genuine departure immediately following a restart", () => {
    // Try every observed restart inside the stop after the audited restart.
    // This includes the fresh fixes that become the actual departure.
    const reference = replay(fixture.observations).events.filter(e => e.kind === "visit" && e.stopId === 11);
    let recoveredCount = 0;
    for (const obs of fixture.observations.filter(o => o.collectedAt >= fixture.restartAt)) {
      const before = fixture.observations.filter(o => o.collectedAt < obs.collectedAt);
      const restored = recoverOpenVisit(network, obs, before, fixture.arrivals);
      if (!restored) continue;
      recoveredCount++;
      const states = new Map([[obs.busName, restored.detector]]), visits = new Map([[obs.busName, restored.visit]]);
      const events: VisitEvent[] = [];
      for (const next of fixture.observations.filter(o => o.collectedAt >= obs.collectedAt)) events.push(...stepManyWithVisits(network, states, visits, [next]).visits);
      expect(events.filter(e => e.kind === "visit" && e.stopId === 11)).toEqual(reference);
    }
    expect(recoveredCount).toBeGreaterThan(5);
  });

  it("keeps existing state when a contended name becomes unique and skips ambiguous cold tracks", () => {
    const expected = replay(history);
    const detector = expected.states.get(current.busName)!;
    const visit = expected.visits.get(current.busName)!;
    const oldKey = trackKeyFor(current.busName, current.busId, true);
    const query = vi.fn(() => { throw new Error("A live or ambiguous track must not query recovery history"); });
    const inner = Object.assign(Object.create(Collector.prototype), {
      states: new Map([[oldKey, detector]]), visitStates: new Map([[oldKey, visit]]),
      recentBusArrivalsStmt: { all: query }, logger: { warn: vi.fn() },
    }) as { states: Map<string, BusState>; visitStates: Map<string, VisitState>;
      recoverOpenVisits(obs: BusObservation[], plan: TrackPlan): void };
    inner.recoverOpenVisits([current], planTracks([current]));
    expect(query).not.toHaveBeenCalled();
    expect(inner.states.get(current.busName)).toBe(detector);
    expect(inner.visitStates.get(current.busName)).toBe(visit);
    expect(inner.states.has(oldKey)).toBe(false);
    inner.states.clear(); inner.visitStates.clear();
    const ambiguous = [current, { ...current, busId: current.busId + 1 }];
    inner.recoverOpenVisits(ambiguous, planTracks(ambiguous));
    expect(query).not.toHaveBeenCalled();
  });

  it("wires recovery into a real restarted collector without re-inserting historic events", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shuttle-visit-recovery-"));
    const bundle = openDb(path.join(dir, "test.db"));
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
    type Inner = { runPoll(): Promise<void>; refreshStaticIfNeeded(force: boolean): Promise<void> };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(latest.collectedAt);
      collector = await Collector.create(bundle, { upstream: new Stub() });
      await (collector as unknown as Inner).refreshStaticIfNeeded(true);
      for (const obs of fixture.observations) {
        latest = obs; vi.setSystemTime(obs.collectedAt);
        if (obs.collectedAt === fixture.restartAt) {
          collector.stop();
          collector = await Collector.create(bundle, { upstream: new Stub() });
        }
        await (collector as unknown as Inner).runPoll();
      }
      const visits = bundle.sqlite.prepare("SELECT stand_sec, shuffles FROM stop_visits WHERE stop_id=11").all();
      expect(visits).toEqual([{ stand_sec: 439.48, shuffles: 3 }]);
      expect(bundle.sqlite.prepare("SELECT COUNT(*) AS n FROM arrivals WHERE stop_id=11").get()).toEqual({ n: 1 });
    } finally {
      collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
