import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db/client.js";
import type { Route, Stop } from "../schema/api.js";
import { Collector } from "./collector.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import { distanceMeters } from "../network/geo.js";
import { AT_STOP_PIN_M, step, type BusObservation, type BusState } from "./detector.js";
import { UpstreamClient, type RawBus } from "./upstream.js";
import fixture from "./__fixtures__/global-detour-reanchors-20261018.json";

type Capture = typeof fixture.cases[number];

function expectCallTiming(capture: Capture, call: Capture["earlyCall"], visits: Record<string, unknown>[]) {
  const observations = capture.polls.flatMap(p => p.observations);
  const index = observations.findIndex(o => o.collectedAt === call.arrived_at);
  expect(index).toBeGreaterThanOrEqual(0);
  const rest = observations[index]!, next = observations[index + 1]!;
  const stop = capture.stops.find(s => s.id === call.stop_id)!;
  expect([rest.lat, rest.lon]).toEqual([next.lat, next.lon]);
  if (distanceMeters(rest, stop) <= AT_STOP_PIN_M) {
    expect(visits).toContainEqual(expect.objectContaining({ stop_id: call.stop_id,
      pinned_at: call.pinned_at, arrived_at: call.arrived_at,
      departed_at: call.departed_at, stand_sec: call.stand_sec }));
    return;
  }
  // Keep the captured source rows intact. Purple's early LEPH repeat was
  // 110.8 m away; Blue Night's later College/Wall repeat was 122.6 m away.
  // Neither window contains an inside-radius plateau. Their current collector
  // clocks must use the observed closest approach, while retaining the visit.
  const window = observations.filter(o => o.collectedAt >= call.pinned_at! && o.collectedAt <= call.departed_at!);
  expect(window.some((o, i) => i > 0 && o.lat === window[i - 1]!.lat && o.lon === window[i - 1]!.lon
    && distanceMeters(o, stop) <= AT_STOP_PIN_M)).toBe(false);
  const closest = window.reduce((a, b) => distanceMeters(a, stop) <= distanceMeters(b, stop) ? a : b);
  expect(distanceMeters(closest, stop)).toBeLessThanOrEqual(AT_STOP_PIN_M);
  expect(visits).toContainEqual(expect.objectContaining({ stop_id: call.stop_id,
    pinned_at: call.pinned_at, arrived_at: closest.collectedAt,
    departed_at: closest.collectedAt, stand_sec: 0, outcome: "passed" }));
}

async function collect(capture: Capture, restartAt?: number) {
  const bundle = openDb(":memory:"); migrate(bundle.db, { migrationsFolder: "./drizzle" });
  let latest: readonly BusObservation[] = [], collector: Collector | undefined;
  class Stub extends UpstreamClient {
    constructor() { super({ baseUrl: "http://invalid.test" }); }
    override async stops() { return capture.stops as Stop[]; }
    override async routes() { return [capture.route as Route]; }
    override async buses(): Promise<RawBus[]> {
      return latest.map(o => ({ id: o.busId, name: o.busName, route: o.routeId, lat: o.lat,
        lon: o.lon, heading: o.heading, lastStop: o.lastStopId } as RawBus));
    }
  }
  const errors = vi.fn(), options = { upstream: new Stub(), upstreamEta: false, etaSampler: false,
    logger: { info() {}, warn() {}, error: errors } };
  type Inner = { refreshStaticIfNeeded(force: boolean): Promise<void>; runPoll(): Promise<void> };
  const positions: Array<{ at: number; buses: ReturnType<Collector["getLiveBuses"]> }> = [];
  vi.useFakeTimers();
  try {
    vi.setSystemTime(capture.polls[0]!.at); collector = await Collector.create(bundle, options);
    await (collector as unknown as Inner).refreshStaticIfNeeded(true);
    for (const poll of capture.polls) {
      latest = poll.observations; vi.setSystemTime(poll.at);
      if (poll.at === restartAt) { collector.stop(); collector = await Collector.create(bundle, options); }
      await (collector as unknown as Inner).runPoll(); positions.push({ at: poll.at, buses: collector.getLiveBuses() });
    }
    expect(errors).not.toHaveBeenCalled();
    return { positions, arrivals: bundle.sqlite.prepare("SELECT * FROM arrivals ORDER BY id").all() as Record<string, unknown>[],
      visits: bundle.sqlite.prepare("SELECT * FROM stop_visits ORDER BY id").all() as Record<string, unknown>[],
      legs: bundle.sqlite.prepare("SELECT * FROM legs ORDER BY id").all(),
      segments: bundle.sqlite.prepare("SELECT * FROM segments ORDER BY id").all() };
  } finally { collector?.stop(); vi.useRealTimers(); bundle.sqlite.close(); }
}

describe("a nearby global marker before its intervening published journey", () => {
  it.each(fixture.cases)("preserves supported journeys and the recorded target escape in $name", async capture => {
    const result = await collect(capture);
    const target = capture.earlyCall.stop_id;
    const early = result.arrivals.filter(r => r.stop_id === target && r.arrived_at === capture.sourceFrame.at);
    // Purple's recorded fix leaves its current published leg and follows the
    // target's served road. This is an unresolved service/topology case, so
    // preserve the global escape rather than treating proximity as a ghost.
    if (capture.route.id === 10) expect(early).toHaveLength(1);
    else expect(early).toEqual([]);
    if (capture.laterCall) {
      const encounters = result.arrivals.filter(r => r.stop_id === target && Number(r.arrived_at) >= capture.fromCall.anchored_at);
      expect(encounters).toHaveLength(capture.route.id === 10 ? 2 : 1);
      // The continuous return can anchor LEPH earlier on its long incoming
      // leg. Keep both encounters and pins; first-rest clocks must also obey
      // the existing radius. These source records are not physical door truth.
      if (capture.route.id === 10) {
        expect(result.visits).toContainEqual(expect.objectContaining({
          stop_id: target, anchored_at: capture.earlyCall.anchored_at, pinned_at: capture.earlyCall.pinned_at,
        }));
        expectCallTiming(capture, capture.earlyCall, result.visits);
      }
      expectCallTiming(capture, capture.laterCall, result.visits);
    } else {
      // The later movement becomes ambiguous between published legs. Keep
      // that model re-anchor as an unpinned source record. Its existing
      // "passed" label does not establish a served call or known timing.
      const unresolved = result.visits.filter(r => r.stop_id === target && Number(r.anchored_at) >= capture.fromCall.anchored_at);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatchObject({ pinned_at: null, arrived_at: null, departed_at: null, stand_sec: 0, outcome: "passed" });
    }
  });
});

function atEarlyFix(capture = fixture.cases.find(c => c.route.id === 13)!) {
  const net = TransitNetwork.build(structuredClone(capture.stops) as Stop[], [structuredClone(capture.route) as Route]);
  let state: BusState | null = null;
  for (const poll of capture.polls) for (const obs of poll.observations) {
    if (obs.collectedAt === capture.sourceFrame.at) return { net, state: state!, obs };
    state = step(net, state, obs).state;
  }
  throw Error("Missing frozen early fix");
}

describe("global detour continuity boundaries", () => {
  it("retains a supported model choice at a repeated fix without mutating the input state", () => {
    const { net, state, obs } = atEarlyFix(), original = structuredClone(state);
    const held = step(net, state, obs).state!;
    expect(state).toEqual(original);
    expect(held.nearestStopId).toBe(67);
    expect(held.detourGeometrySHA256).toMatch(/^[a-f0-9]{64}$/);
    const repeated = step(net, held, { ...obs, collectedAt: obs.collectedAt + 5000 }).state!;
    expect(repeated.nearestStopId).toBe(67);
    expect(repeated.enteredAt).toBe(held.enteredAt);
    expect(repeated.detourGeometrySHA256).toBe(held.detourGeometrySHA256);
  });

  it.each(["path", "marker", "order"])("invalidates a held choice after an in-place %s change", change => {
    const { net, state, obs } = atEarlyFix(), held = step(net, state, obs).state!;
    const route = net.routes.get(obs.routeId)!;
    if (change === "path") route.path![0]![0] += 0.00001;
    if (change === "marker") net.stops.get(96)!.lat += 0.00001;
    if (change === "order") route.stops[0] = route.stops[1]!;
    const after = step(net, held, { ...obs, collectedAt: obs.collectedAt + 5000 });
    expect(after.state?.nearestStopId).toBe(53);
    expect(after.state?.detourGeometrySHA256).toBeUndefined();
  });

  it("invalidates a held choice on a moving fix after geometry changes", () => {
    const capture = fixture.cases.find(c => c.route.id === 13)!;
    const { net, state, obs } = atEarlyFix(capture), held = step(net, state, obs).state!;
    const next = capture.polls.flatMap(p => p.observations).find(o => o.collectedAt > obs.collectedAt && (o.lat !== obs.lat || o.lon !== obs.lon))!;
    net.stops.get(96)!.lat += 0.00001;
    const after = step(net, held, next);
    expect(after.state?.nearestStopId).toBe(53);
    expect(after.state?.detourGeometrySHA256).toBeUndefined();
  });

  it.each(["missing path", "missing stop", "nonfinite marker", "offset path", "degenerate path"])("keeps the global escape with %s", unknown => {
    const { net, state, obs } = atEarlyFix(), route = net.routes.get(obs.routeId)!;
    if (unknown === "missing path") delete route.path;
    if (unknown === "missing stop") (net.stops as Map<number, Stop>).delete(96);
    if (unknown === "nonfinite marker") net.stops.get(96)!.lat = NaN;
    if (unknown === "offset path") route.path = route.path!.map(p => [p[0] + 0.1, p[1]]);
    if (unknown === "degenerate path") route.path = [[obs.lat, obs.lon], [obs.lat, obs.lon]];
    expect(step(net, state, obs).state?.nearestStopId).toBe(53);
  });

  it.each([60001, 601000])("does not constrain an observation after a %dms gap", gap => {
    const { net, state, obs } = atEarlyFix();
    expect(step(net, state, { ...obs, collectedAt: state.lastObservedAt + gap }).state?.nearestStopId).toBe(53);
  });

  it("does not seed a cold start with a journey it did not observe", () => {
    const { net, obs } = atEarlyFix();
    expect(step(net, null, obs).state?.nearestStopId).toBe(53);
  });

  it("allows an off-path movement toward a target's served road", () => {
    const capture = fixture.cases.find(c => c.route.id === 10)!;
    const { net, state, obs } = atEarlyFix(capture);
    expect(step(net, state, obs).state?.nearestStopId).toBe(72);
  });

  it("preserves the approach across a continuous provider ID reissue", () => {
    const { net, state, obs } = atEarlyFix();
    expect(step(net, state, { ...obs, busId: obs.busId + 1 }).state?.nearestStopId).toBe(67);
  });

  it("does not inherit a held approach across a discontinuous provider ID reissue", () => {
    const { net, state, obs } = atEarlyFix(), held = step(net, state, obs).state!;
    const after = step(net, held, { ...obs, busId: obs.busId + 1, collectedAt: obs.collectedAt + 60001 });
    expect(after.state?.nearestStopId).toBe(53);
    expect(after.state?.detourGeometrySHA256).toBeUndefined();
  });

  it.each(fixture.cases)("preserves all source rows and live clocks through held/curb restarts in $name", async capture => {
    const expected = await collect(capture);
    const choices = new Set([capture.sourceFrame.at, capture.laterCall?.pinned_at].filter((n): n is number => n != null));
    for (const at of choices) expect(await collect(capture, at)).toEqual(expected);
  });
});
