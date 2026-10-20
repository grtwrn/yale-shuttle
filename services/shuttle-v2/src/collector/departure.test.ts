import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";
import greenFirstRest from "./__fixtures__/green-first-rest-2026-10-18.json";

import {
  CONFIDENCE_BY_HOW,
  DEPART_FAR_M,
  DEPARTURE_PRIOR_BY_STEPS,
  HOLD_MIN_SEC,
  POLL_JITTER_MS,
  STILL_MIN_MS,
  pruneVisits,
  stepManyWithVisits,
  stepVisit,
  type LegEvent,
  type StopVisitEvent,
  type VisitState,
} from "./departure.js";
import {
  AT_STOP_PIN_M,
  MAX_OBSERVATION_GAP_MS,
  MIN_DWELL_SEC,
  STATIONARY_RADIUS_M,
  planTracks,
  stepMany,
  step,
  type BusObservation,
  type BusState,
  type DetectorEvent,
} from "./detector.js";

// A straight road running east. Metres east of the origin map to longitude.
const LAT = 41.31;
const LON0 = -72.93;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const east = (m: number): { lat: number; lon: number } => ({ lat: LAT, lon: LON0 + m / M_PER_DEG_LON });

// Stops A (0 m), B (840 m), C (1680 m); route 1 visits them in order. Route 2
// adds a twin A' 100 m past A, so a bus can be re-pinned at the next stop
// before it is 150 m from the one it left.
const A: Stop = { id: 1, name: "A", ...east(0) };
const B: Stop = { id: 2, name: "B", ...east(840) };
const C: Stop = { id: 3, name: "C", ...east(1680) };
const A2: Stop = { id: 4, name: "A'", ...east(100) };
const routes: Route[] = [
  { id: 1, name: "Line", shortName: "L", color: "#000", stops: [1, 2, 3] },
  { id: 2, name: "Twin", shortName: "T", color: "#000", stops: [1, 4, 2] },
  // Out-and-back: B is visited twice, at index 1 and index 3.
  { id: 3, name: "Back", shortName: "K", color: "#000", stops: [1, 2, 3, 2] },
];
const net = TransitNetwork.build([A, B, C, A2], routes);

const T0 = 1_700_000_000_000;
const POLL = 5_000;

/** A bus track: one observation per poll, positions in metres east. */
function track(metres: number[], opts: { routeId?: number; busId?: number; busName?: string; startAt?: number; poll?: number } = {}): BusObservation[] {
  const { routeId = 1, busId = 42, busName = "#42", startAt = T0, poll = POLL } = opts;
  return metres.map((m, i) => ({
    busId,
    busName,
    routeId,
    ...east(m),
    heading: 90,
    lastStopId: null,
    collectedAt: startAt + i * poll,
  }));
}

function run(observations: BusObservation[]) {
  const states = new Map<string, BusState>();
  const visits = new Map<string, VisitState>();
  const events: DetectorEvent[] = [];
  const out: StopVisitEvent[] = [];
  const legs: LegEvent[] = [];
  const resolved: ReturnType<typeof stepManyWithVisits>["resolved"] = [];
  for (const obs of observations) {
    const r = stepManyWithVisits(net, states, visits, [obs]);
    events.push(...r.events);
    for (const v of r.visits) (v.kind === "visit" ? out : legs).push(v as never);
    resolved.push(...r.resolved);
  }
  return { states, visits, events, out, legs, resolved };
}

const rep = (m: number, n: number) => Array<number>(n).fill(m);

describe("constants", () => {
  it("confirms on distance above the detector's clock radius and below the twin pair", () => {
    expect(DEPART_FAR_M).toBeGreaterThan(STATIONARY_RADIUS_M);
    expect(DEPART_FAR_M).toBeLessThan(160);
  });
  it("uses the detector's own dwell floor for stillness, minus one poll of jitter", () => {
    expect(HOLD_MIN_SEC).toBe(MIN_DWELL_SEC);
    expect(STILL_MIN_MS).toBe(MIN_DWELL_SEC * 1000 - POLL_JITTER_MS);
  });
  it("pins the measured prior as a non-decreasing probability", () => {
    expect(DEPARTURE_PRIOR_BY_STEPS[0]).toBe(0);
    for (let i = 1; i < DEPARTURE_PRIOR_BY_STEPS.length; i++) {
      expect(DEPARTURE_PRIOR_BY_STEPS[i]!).toBeGreaterThanOrEqual(DEPARTURE_PRIOR_BY_STEPS[i - 1]!);
      expect(DEPARTURE_PRIOR_BY_STEPS[i]!).toBeLessThanOrEqual(1);
    }
    expect(CONFIDENCE_BY_HOW.far).toBe(1);
    expect(CONFIDENCE_BY_HOW.next).toBe(1);
    expect(CONFIDENCE_BY_HOW.clock).toBeLessThan(1);
  });
});

describe("a plain visit: arrive, rest, leave", () => {
  // Roll in (70 m, 40 m out), settle 10 m from A for 12 polls, pull out.
  const obs = track([-200, -120, -70, -40, 10, ...rep(10, 12), 40, 70, 110, 160, 220, 300]);
  const r = run(obs);
  const v = r.out[0]!;

  it("emits exactly one visit, stopped, confirmed by distance", () => {
    expect(r.out).toHaveLength(1);
    expect(v.outcome).toBe("stopped");
    expect(v.how).toBe("far");
    expect(v.confidence).toBe(1);
    expect(v.stopId).toBe(1);
    expect(v.stopIndex).toBe(0);
  });
  it("dates the arrival from the first resting fix, not the pin", () => {
    // Pinned on the 70 m fix (index 2), at rest from the 10 m fix (index 4).
    expect(v.pinnedAt).toBe(T0 + 2 * POLL);
    expect(v.arrivedAt).toBe(T0 + 4 * POLL);
  });
  it("dates the departure from the last plateau poll — backdated, not the confirming poll", () => {
    // The 10 m fix repeats on polls 5..16; the first fresh fix is poll 17.
    expect(v.departedAt).toBe(T0 + 16 * POLL);
    expect(v.standSec).toBe(60);
    expect(v.restPolls).toBe(12);
    expect(v.shuffles).toBe(0);
    expect(v.firstMovedAt).toBe(T0 + 17 * POLL);
  });
  it("records the evidence", () => {
    expect(v.firstStepM).toBeCloseTo(30, 0);
    expect(v.steps).toBe(4); // 40, 70, 110, 160 — confirmed on the fourth
    expect(v.farM).toBeGreaterThanOrEqual(DEPART_FAR_M);
    expect(v.confirmSec).toBe(15);
    // at_stop clears after the 70 m fix (poll 18); pinned since poll 2.
    expect(v.insideSec).toBe(80);
  });
  it("does not touch the detector's own events", () => {
    const states = new Map<string, BusState>();
    const plain: DetectorEvent[] = [];
    for (const o of obs) plain.push(...stepMany(net, states, [o], planTracks([o])));
    expect(r.events).toEqual(plain);
  });
});

describe("the roll-in is not a shuffle", () => {
  it("moves the resting point with a bus still rolling inside the radius", () => {
    const r = run(track([-100, -60, -30, 0, ...rep(0, 6), 40, 80, 130, 200]));
    expect(r.out).toHaveLength(1);
    expect(r.out[0]!.shuffles).toBe(0);
    expect(r.out[0]!.arrivedAt).toBe(T0 + 3 * POLL);
    expect(r.out[0]!.standSec).toBe(30);
    expect(r.resolved.filter((c) => c.outcome === "shuffle")).toHaveLength(0);
  });
});

describe("the first rest stays inside the stop radius", () => {
  it("replays the recorded Green pass using its closest approach instead of the outside repeat", () => {
    const network = TransitNetwork.build(greenFirstRest.stops, [greenFirstRest.route as Route]);
    // One captured warm state, followed continuously by all 21 source polls.
    // This checks collector clocks, not independent physical arrival truth.
    let state: BusState | null = structuredClone(greenFirstRest.state);
    let visit: VisitState | null = structuredClone(greenFirstRest.visit);
    const events: (StopVisitEvent | LegEvent)[] = [];
    for (const { sequence, observation } of greenFirstRest.observations) {
      const before = state;
      const r = step(network, state, observation);
      const v = stepVisit(network, visit, before, r.state, observation, r.resumed);
      state = r.state;
      visit = v.state;
      events.push(...v.events);
      if (sequence === 93) {
        expect(visit!.pass!.stopId).toBe(77);
        expect(visit!.pass!.arrivedAt).toBeNull();
      }
    }
    expect(events.find(e => e.kind === "visit" && e.stopId === 77)).toMatchObject({
      outcome: "passed", standSec: 0, departedAt: 1792355509650,
    });
    expect(events.find(e => e.kind === "leg" && e.fromStopId === 77 && e.toStopId === 94)).toMatchObject({
      departedAt: 1792355509650, arrivedAt: 1792355529629, legSec: 19.979, driveSec: 19.979, holdSec: 0,
    });
  });

  it("does not turn a repeated outbound fix into an arrival at the earlier pin", () => {
    const positions = [0, 30, 60, 90, 90];
    const rolling = run(track(positions));
    const pass = rolling.visits.get("#42")!.pass!;
    expect(pass.pinnedAt).toBe(T0);
    expect(pass.arrivedAt).toBeNull();

    const r = run(track([...positions, 120, 170, 300, 450, 600, 780, 840, ...rep(840, 4)]));
    const a = r.out.find(v => v.stopId === 1)!;
    expect(a.outcome).toBe("passed");
    expect(a.arrivedAt).toBe(T0);
    expect(a.departedAt).toBe(T0);
    expect(a.standSec).toBe(0);
    expect(a.insideSec).toBe(10);
    expect(r.legs[0]).toMatchObject({ fromStopId: 1, toStopId: 2, departedAt: T0, legSec: 55 });
  });

  it("counts a sustained off-stop freeze as a leg hold", () => {
    const r = run(track([0, 30, 60, 90, ...rep(90, 4), 120, 170, 300, 450, 600, 840, ...rep(840, 4)]));
    const a = r.out.find(v => v.stopId === 1)!;
    expect(a.outcome).toBe("passed");
    expect(a.standSec).toBe(0);
    expect(a.insideSec).toBe(10);
    expect(r.legs[0]).toMatchObject({ legSec: 65, holdSec: 20, driveSec: 45, holds: 1 });
  });

  it("starts the first rest when a bus returns inside, without backdating to the outside freeze", () => {
    const r = run(track([0, 30, 90, 90, 60, ...rep(60, 6), 90, 130, 200]));
    const a = r.out.find(v => v.stopId === 1)!;
    expect(a.arrivedAt).toBe(T0 + 4 * POLL);
    expect(a.departedAt).toBe(T0 + 10 * POLL);
    expect(a.standSec).toBe(30);
    expect(a.outcome).toBe("stopped");
  });

  it.each([
    { metres: 74, arrivedAt: T0 + POLL },
    { metres: 76, arrivedAt: T0 },
  ])("uses the existing pin boundary for a first rest at $metres metres", ({ metres, arrivedAt }) => {
    const r = run(track([0, metres, metres, 110, 170]));
    expect(r.out[0]!.arrivedAt).toBe(arrivedAt);
  });

  it("preserves an established inside-radius rest across an outbound off-stop hold", () => {
    const r = run(track([0, 30, 30, 90, ...rep(90, 4), 120, 170]));
    const a = r.out.find(v => v.stopId === 1)!;
    expect(a.arrivedAt).toBe(T0 + POLL);
    expect(a.departedAt).toBe(T0 + 2 * POLL);
    expect(a.standSec).toBe(5);
  });
});

describe("a shuffle before the exit", () => {
  // Rest 8 polls at 0 m, shuffle 30 m and settle 6 polls, then leave.
  const r = run(track([-100, 0, ...rep(0, 8), 30, ...rep(30, 6), 60, 100, 160]));
  const v = r.out[0]!;
  it("restarts the plateau at the shuffled fix and dates the departure from its end", () => {
    expect(v.shuffles).toBe(1);
    expect(v.departedAt).toBe(T0 + 16 * POLL); // last of the six repeats of 30 m
    expect(v.firstMovedAt).toBe(T0 + 10 * POLL); // the shuffle itself
    expect(v.standSec).toBe(75); // from the first rest (poll 1) to poll 16
    expect(r.resolved.map((c) => c.outcome)).toEqual(["shuffle", "far"]);
  });
  it("needs the refreeze to last: three repeats, or the still threshold", () => {
    const shuffle = r.resolved[0]!;
    expect(shuffle.steps).toBe(1);
  });
});

describe("the deadband stutter is not a shuffle", () => {
  it("absorbs a single repeated fix inside the outbound run", () => {
    // Rest, then 30 m, 30 m (repeat), 65 m, 110 m, 170 m.
    const r = run(track([0, ...rep(0, 6), 30, 30, 65, 110, 170]));
    expect(r.out).toHaveLength(1);
    expect(r.out[0]!.shuffles).toBe(0);
    expect(r.out[0]!.departedAt).toBe(T0 + 6 * POLL);
    expect(r.out[0]!.how).toBe("far");
  });
  it("still calls two repeats plus one a shuffle", () => {
    const r = run(track([0, ...rep(0, 6), 30, 30, 30, 30, 65, 110, 170]));
    expect(r.out[0]!.shuffles).toBe(1);
    expect(r.out[0]!.departedAt).toBe(T0 + 10 * POLL);
  });
});

describe("passing through", () => {
  it("a bus that never rests inside the radius is passed, with both instants at the closest approach", () => {
    const r = run(track([-200, -100, -50, -20, 20, 60, 110, 170, 240]));
    expect(r.out).toHaveLength(1);
    const v = r.out[0]!;
    expect(v.outcome).toBe("passed");
    expect(v.standSec).toBe(0);
    expect(v.pinnedAt).toBe(T0 + 2 * POLL);
    expect(v.arrivedAt).toBe(T0 + 3 * POLL); // −20 m is the closest fix
    expect(v.departedAt).toBe(v.arrivedAt);
    expect(v.restPolls).toBe(0);
    expect(v.how).toBe("far");
  });
  it("a bus that never comes within the radius is passed with no pin and its closest distance", () => {
    // Anchored at A while 200 m north of the road, then on to B.
    const north = (m: number, dLat: number) => ({ ...east(m), lat: LAT + dLat });
    const obs = track([-300, -200, -100, 0, 100, 200, 300, 400, 500, 600, 700, 840, 840, 840, 840]);
    for (let i = 0; i < 8; i++) obs[i] = { ...obs[i]!, ...north([-300, -200, -100, 0, 100, 200, 300, 400][i]!, 0.0018) };
    const r = run(obs);
    const a = r.out.find((v) => v.stopId === 1)!;
    expect(a.outcome).toBe("passed");
    expect(a.pinnedAt).toBeNull();
    expect(a.closestM).toBeGreaterThan(AT_STOP_PIN_M);
    expect(a.standSec).toBe(0);
  });
  it("a rest shorter than the still threshold is passed, but keeps its stand", () => {
    const r = run(track([-100, 0, 0, 0, 40, 80, 130, 200]));
    expect(r.out[0]!.outcome).toBe("passed");
    expect(r.out[0]!.standSec).toBe(10);
  });
});

describe("confirmation by the detector", () => {
  it("'next': re-pinned at the twin before reaching the distance", () => {
    const r = run(track([0, ...rep(0, 6), 30, 60, 95, 100, 100, 100, 100, 100], { routeId: 2 }));
    const a = r.out.find((v) => v.stopId === 1)!;
    expect(a.how).toBe("next");
    expect(a.confidence).toBe(CONFIDENCE_BY_HOW.next);
    expect(a.departedAt).toBe(T0 + 6 * POLL);
    const leg = r.legs[0]!;
    expect(leg.fromStopId).toBe(1);
    expect(leg.toStopId).toBe(4);
    expect(leg.hops).toBe(1);
    expect(leg.toPinnedAt).toBe(T0 + 8 * POLL); // the 60 m fix is already 40 m from A'
  });
  it("'clock': the stationary clock restarts beyond its radius without a stop", () => {
    // Out to 140 m and hold there: past 125 m the detector restarts, under 150 m.
    const r = run(track([0, ...rep(0, 6), 40, 80, 140, 140, 140, 140]));
    expect(r.out[0]!.how).toBe("clock");
    expect(r.out[0]!.confidence).toBe(CONFIDENCE_BY_HOW.clock);
    expect(r.out[0]!.departedAt).toBe(T0 + 6 * POLL);
  });
});

describe("breaks in the track", () => {
  it("'gap': a candidate cut off by a feed break carries its evidence and the measured prior", () => {
    const obs = track([0, ...rep(0, 6), 30, 60]);
    const late = track([840, 840, 840], { startAt: T0 + 8 * POLL + MAX_OBSERVATION_GAP_MS + 1 });
    const r = run([...obs, ...late]);
    const a = r.out.find((v) => v.stopId === 1)!;
    expect(a.how).toBe("gap");
    expect(a.steps).toBe(2);
    expect(a.confidence).toBe(DEPARTURE_PRIOR_BY_STEPS[2]);
    expect(a.departedAt).toBe(T0 + 6 * POLL);
    expect(a.outcome).toBe("stopped");
  });
  it("'unresolved': a rest with no movement seen before the break keeps its lower bound", () => {
    const obs = track([0, ...rep(0, 6)]);
    const late = track([840, 840, 840], { startAt: T0 + 6 * POLL + MAX_OBSERVATION_GAP_MS + 1 });
    const r = run([...obs, ...late]);
    const a = r.out.find((v) => v.stopId === 1)!;
    expect(a.outcome).toBe("unresolved");
    expect(a.departedAt).toBeNull();
    expect(a.standSec).toBeNull();
    expect(a.lastAtRestAt).toBe(T0 + 6 * POLL);
    expect(a.confidence).toBeNull();
    // Nothing joins across the break.
    expect(r.legs).toHaveLength(0);
  });
  it("pruneVisits closes a track that went dark the same way", () => {
    const r = run(track([0, ...rep(0, 6)]));
    expect(r.out).toHaveLength(0);
    const closed = pruneVisits(r.visits, new Map());
    expect(closed).toHaveLength(1);
    expect((closed[0] as StopVisitEvent).outcome).toBe("unresolved");
    expect(r.visits.size).toBe(0);
  });
});

describe("legs", () => {
  it("run from the departure at A to the first rest at B, with a mid-leg hold split out", () => {
    // Leave A, drive, freeze 4 polls at 400 m (a light), drive on, rest at B.
    const r = run(track([0, ...rep(0, 6), 40, 100, 200, 300, 400, 400, 400, 400, 400, 500, 640, 780, 840, 840, 840, 840]));
    expect(r.legs).toHaveLength(1);
    const l = r.legs[0]!;
    expect(l.fromStopId).toBe(1);
    expect(l.toStopId).toBe(2);
    expect(l.hops).toBe(1);
    expect(l.departedAt).toBe(T0 + 6 * POLL);
    expect(l.arrivedAt).toBe(T0 + 19 * POLL); // the 840 m fix first reported
    expect(l.toPinnedAt).toBe(T0 + 18 * POLL); // the 780 m fix is 60 m from B
    expect(l.legSec).toBe(65);
    expect(l.holds).toBe(1);
    expect(l.holdSec).toBe(20); // 400 m first reported poll 11, last poll 15
    expect(l.driveSec).toBe(45);
    expect(l.reached).toBe(true);
  });
  it("a short leg between close stops is kept, not floored", () => {
    // Twin route: A → A' is 100 m. Three polls from plateau end to rest at A'.
    const r = run(track([0, ...rep(0, 6), 40, 95, 100, 100, 100, 100], { routeId: 2 }));
    const l = r.legs[0]!;
    expect(l.legSec).toBe(15);
    expect(l.driveSec).toBe(15);
  });
  it("indexes stops by sequence position on an out-and-back route", () => {
    // Route 3: A(0) B(1) C(2) B(3). Rest at each in turn.
    const r = run(track([
      0, ...rep(0, 4), 100, 300, 500, 700, 840, ...rep(840, 4), 950, 1170, 1390, 1600, 1680, ...rep(1680, 4), 1550, 1330, 1110, 900, 840, ...rep(840, 4), 700,
    ], { routeId: 3 }));
    const visitsAtB = r.out.filter((v) => v.stopId === 2);
    expect(visitsAtB.map((v) => v.stopIndex)).toEqual([1, 3]);
    const back = r.legs.find((l) => l.fromStopId === 3)!;
    expect(back.toIndex).toBe(3);
    expect(back.hops).toBe(1);
  });
});

describe("vehicle identity", () => {
  it("joins a visit to the arrivals row written under the id in force at the anchor", () => {
    const first = track([-100, 0, 0, 0, 0], { busId: 7 });
    const second = track([0, 0, 0, 0, 40, 80, 130, 200], { busId: 8, startAt: T0 + 5 * POLL });
    const r = run([...first, ...second]);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]!.anchorBusId).toBe(7);
    expect(r.out[0]!.busId).toBe(8);
    expect(r.out[0]!.outcome).toBe("stopped");
    expect(r.out[0]!.standSec).toBe(35);
  });
});
