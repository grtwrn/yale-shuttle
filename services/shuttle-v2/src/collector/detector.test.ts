import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  MAX_OBSERVATION_GAP_MS,
  MAX_SEGMENT_SEC,
  MIN_DWELL_SEC,
  MIN_SEGMENT_SEC,
  step,
  stepMany,
  type BusObservation,
  type BusState,
} from "./detector.js";

// Three stops in a line going east. Route 1 visits all three in order.
const stops: Stop[] = [
  { id: 1, name: "A", lat: 41.31, lon: -72.93 },
  { id: 2, name: "B", lat: 41.31, lon: -72.92 }, // ~840 m east of A
  { id: 3, name: "C", lat: 41.31, lon: -72.91 }, // ~840 m east of B
];

const routes: Route[] = [
  { id: 1, name: "Line", shortName: "L", color: "#000", stops: [1, 2, 3] },
];

const net = TransitNetwork.build(stops, routes);

const T0 = 1_700_000_000_000;

function obsAt(stop: Stop, when: number, busId = 42): BusObservation {
  return {
    busId,
    busName: `#${busId}`,
    routeId: 1,
    lat: stop.lat,
    lon: stop.lon,
    heading: 90,
    lastStopId: stop.id,
    collectedAt: when,
  };
}

describe("step", () => {
  it("emits an arrival on first sight, no dwell or segment", () => {
    const result = step(net, null, obsAt(stops[0]!, T0));
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual(["arrival"]);
    expect(result.events[0]).toMatchObject({ stopId: 1, arrivedAt: T0 });
    expect(result.state?.nearestStopId).toBe(1);
    expect(result.state?.enteredAt).toBe(T0);
  });

  it("emits no events while the bus stays nearest the same stop", () => {
    const first = step(net, null, obsAt(stops[0]!, T0)).state;
    const second = step(net, first, obsAt(stops[0]!, T0 + 5_000));
    expect(second.events).toHaveLength(0);
    // enteredAt is sticky — dwell timer keeps counting from first sighting.
    expect(second.state?.enteredAt).toBe(T0);
    expect(second.state?.lastObservedAt).toBe(T0 + 5_000);
  });

  it("emits arrival + dwell + segment on a transition", () => {
    const first = step(net, null, obsAt(stops[0]!, T0)).state;
    const result = step(net, first, obsAt(stops[1]!, T0 + 60_000));
    const kinds = result.events.map((e) => e.kind).sort();
    expect(kinds).toEqual(["arrival", "dwell", "segment"]);

    const segment = result.events.find((e) => e.kind === "segment")!;
    expect(segment).toMatchObject({
      fromStopId: 1,
      toStopId: 2,
      hops: 1,
      travelSec: 60,
    });

    const dwell = result.events.find((e) => e.kind === "dwell")!;
    expect(dwell).toMatchObject({ stopId: 1, dwellSec: 60 });
  });

  it("skips dwell events shorter than MIN_DWELL_SEC", () => {
    const first = step(net, null, obsAt(stops[0]!, T0)).state;
    const result = step(net, first, obsAt(stops[1]!, T0 + (MIN_DWELL_SEC - 1) * 1000));
    expect(result.events.some((e) => e.kind === "dwell")).toBe(false);
    // Arrival + segment should still fire — a quick pass-through is real
    // information about travel time, just not about dwell.
    expect(result.events.some((e) => e.kind === "arrival")).toBe(true);
    expect(result.events.some((e) => e.kind === "segment")).toBe(true);
  });

  it("re-anchors with an arrival (but no dwell/segment) after a long gap", () => {
    const first = step(net, null, obsAt(stops[0]!, T0)).state;
    const result = step(
      net,
      first,
      obsAt(stops[1]!, T0 + MAX_OBSERVATION_GAP_MS + 1),
    );
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual(["arrival"]);
    expect(result.state?.nearestStopId).toBe(2);
    expect(result.state?.enteredAt).toBe(T0 + MAX_OBSERVATION_GAP_MS + 1);
  });

  it("re-anchors with an arrival when the bus switches to a known route", () => {
    // Add a second route that visits the same stops in reverse.
    const twoRouteNet = TransitNetwork.build(stops, [
      ...routes,
      { id: 2, name: "Reverse", shortName: "R", color: "#000", stops: [3, 2, 1] },
    ]);
    const stateOnRouteOne: BusState = {
      busId: 7,
      busName: "#7",
      routeId: 1,
      nearestStopId: 1,
      nearestIndex: 0,
      enteredAt: T0,
      lastObservedAt: T0,
    };
    const obsOnRouteTwo: BusObservation = { ...obsAt(stops[1]!, T0 + 30_000, 7), routeId: 2 };
    const result = step(twoRouteNet, stateOnRouteOne, obsOnRouteTwo);
    expect(result.events.map((e) => e.kind)).toEqual(["arrival"]);
    expect(result.state?.routeId).toBe(2);
  });

  it("drops state entirely when the bus is on an unknown route", () => {
    const stateOnRouteOne: BusState = {
      busId: 7,
      busName: "#7",
      routeId: 1,
      nearestStopId: 1,
      nearestIndex: 0,
      enteredAt: T0,
      lastObservedAt: T0,
    };
    const obsOnUnknown: BusObservation = { ...obsAt(stops[1]!, T0 + 30_000, 7), routeId: 999 };
    const result = step(net, stateOnRouteOne, obsOnUnknown);
    expect(result.state).toBeNull();
    expect(result.events).toHaveLength(0);
  });

  it("skips segments with too many hops", () => {
    // Build a longer route so a 6-hop jump is even possible.
    const longStops: Stop[] = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      name: `s${i}`,
      lat: 41.31,
      lon: -72.93 + i * 0.005,
    }));
    const longRoute: Route = {
      id: 50,
      name: "Long",
      shortName: "X",
      color: "#000",
      stops: longStops.map((s) => s.id),
    };
    const longNet = TransitNetwork.build(longStops, [longRoute]);

    const first = step(longNet, null, {
      ...obsAt(longStops[0]!, T0),
      routeId: 50,
    }).state;
    const result = step(longNet, first, {
      ...obsAt(longStops[7]!, T0 + 60_000),
      routeId: 50,
    });
    // 7 hops > MAX_SEGMENT_HOPS (5) → no segment event, but arrival + dwell still fire.
    expect(result.events.some((e) => e.kind === "segment")).toBe(false);
    expect(result.events.some((e) => e.kind === "arrival")).toBe(true);
  });

  it("stepMany processes multi-bus streams independently", () => {
    const states = new Map<number, BusState>();
    const events = stepMany(net, states, [
      obsAt(stops[0]!, T0, 1),
      obsAt(stops[0]!, T0, 2),
      obsAt(stops[1]!, T0 + 60_000, 1),
      obsAt(stops[2]!, T0 + 60_000, 2),
    ]);
    // Bus 1 transitioned 1→2; bus 2 transitioned 1→3 (2 hops). Both should
    // emit arrival + dwell + segment.
    expect(events.filter((e) => e.busId === 1 && e.kind === "segment")).toHaveLength(1);
    expect(events.filter((e) => e.busId === 2 && e.kind === "segment")).toHaveLength(1);
    expect(states.get(1)?.nearestStopId).toBe(2);
    expect(states.get(2)?.nearestStopId).toBe(3);
  });
});

describe("step: observation ordering", () => {
  it("ignores an observation older than the one already folded in", () => {
    // Belt-and-braces against overlapping polls. The collector's in-flight
    // guard is the primary defence, but if a stale observation ever reached
    // the reducer it would rewind the anchor and emit a dwell and segment
    // measured over a negative window, straight into the calibration tables.
    const anchored = step(net, null, obsAt(stops[1]!, T0 + 60_000)).state!;
    const stale = step(net, anchored, obsAt(stops[0]!, T0));

    expect(stale.events).toHaveLength(0);
    expect(stale.state).toBe(anchored); // untouched, not rewound
    expect(stale.state?.nearestStopId).toBe(2);
    expect(stale.state?.lastObservedAt).toBe(T0 + 60_000);
  });

  it("ignores a duplicate observation at the same timestamp", () => {
    // Two rows for one bus in a single payload: the only "segment" they can
    // produce spans zero seconds.
    const first = step(net, null, obsAt(stops[0]!, T0)).state!;
    const dup = step(net, first, obsAt(stops[1]!, T0));
    expect(dup.events).toHaveLength(0);
    expect(dup.state?.nearestStopId).toBe(1);
  });
});

describe("step: segment plausibility", () => {
  it("drops a segment whose travel time is physically impossible", () => {
    // A bus straddling the midpoint between two stops flaps between them on
    // GPS noise every poll. Each flap looks like a 5-second segment, and the
    // calibrator takes a median — enough of them drag a real 90 s leg to
    // nothing.
    const first = step(net, null, obsAt(stops[0]!, T0)).state!;
    const flap = step(net, first, obsAt(stops[1]!, T0 + 5_000));
    expect(flap.events.some((e) => e.kind === "segment")).toBe(false);
    // The arrival still fires — the bus really is nearest a new stop.
    expect(flap.events.some((e) => e.kind === "arrival")).toBe(true);
  });

  it("keeps a segment at the plausibility floor", () => {
    const first = step(net, null, obsAt(stops[0]!, T0)).state!;
    const ok = step(net, first, obsAt(stops[1]!, T0 + MIN_SEGMENT_SEC * 1000));
    expect(ok.events.some((e) => e.kind === "segment")).toBe(true);
  });

  it("drops a segment from a bus that sat at a stop for most of an hour", () => {
    // Note this is NOT covered by MAX_OBSERVATION_GAP_MS: the bus is visible
    // the whole time, reporting every 5 s. The gap between observations stays
    // tiny while `enteredAt` recedes, so without an upper bound the eventual
    // departure records a ~46-minute "travel time" for a one-hop leg.
    let state = step(net, null, obsAt(stops[0]!, T0)).state!;
    const parkedMs = (MAX_SEGMENT_SEC + 60) * 1000;
    for (let t = 5_000; t <= parkedMs; t += 60_000) {
      state = step(net, state, obsAt(stops[0]!, T0 + t)).state!;
    }
    expect(state.enteredAt).toBe(T0); // still anchored at the same stop
    const departed = step(net, state, obsAt(stops[1]!, T0 + parkedMs + 5_000));
    expect(departed.events.some((e) => e.kind === "segment")).toBe(false);
  });
});

// Route 1's real defect: `College / Wall (S)` sits at index 18 and
// `College / Wall (N)` at index 28, but they are 28 m apart on the ground.
// A pure nearest-stop scan flickers between them, which discards the flicker
// itself (10 or 21 hops) AND poisons the next genuine transition.
describe("step: anchor continuity across a doubled-back route", () => {
  const twinStops: Stop[] = [
    { id: 1, name: "Start", lat: 41.31, lon: -72.93 },
    { id: 2, name: "College / Wall (S)", lat: 41.315, lon: -72.925 },
    { id: 3, name: "Phelps Gate", lat: 41.318, lon: -72.928 },
    { id: 5, name: "Elm / York", lat: 41.32, lon: -72.94 },
    { id: 4, name: "College / Wall (N)", lat: 41.31525, lon: -72.925 },
  ];
  const twinRoute: Route = {
    id: 1,
    name: "Doubles back",
    shortName: "D",
    color: "#000",
    stops: [1, 2, 3, 5, 4],
  };
  const twinNet = TransitNetwork.build(twinStops, [twinRoute]);

  function at(lat: number, lon: number, when: number): BusObservation {
    return {
      busId: 1,
      busName: "#1",
      routeId: 1,
      lat,
      lon,
      heading: 0,
      lastStopId: null,
      collectedAt: when,
    };
  }

  it("does not let the 28 m twin steal the anchor", () => {
    const anchored = step(twinNet, null, at(41.31, -72.93, T0)).state!;
    expect(anchored.nearestIndex).toBe(0);

    // Bus reaches College/Wall (S); GPS noise puts it marginally closer to
    // the (N) twin, which a global scan would pick.
    const nudged = at(41.3152, -72.925, T0 + 60_000);
    expect(twinNet.nearestStopOnRoute(1, nudged)!.stopId).toBe(4);

    const result = step(twinNet, anchored, nudged);
    expect(result.state?.nearestStopId).toBe(2);
    expect(result.state?.nearestIndex).toBe(1);

    const segment = result.events.find((e) => e.kind === "segment");
    expect(segment).toMatchObject({ fromStopId: 1, toStopId: 2, hops: 1 });
  });

  it("still records the next leg after passing the twin", () => {
    // The compounding half of the bug: once the anchor lands on the far twin,
    // the FOLLOWING transition also scores an impossible hop count and is
    // discarded too.
    let state = step(twinNet, null, at(41.31, -72.93, T0)).state!;
    state = step(twinNet, state, at(41.3152, -72.925, T0 + 60_000)).state!;
    const onward = step(twinNet, state, at(41.318, -72.928, T0 + 120_000));
    expect(onward.events.find((e) => e.kind === "segment")).toMatchObject({
      fromStopId: 2,
      toStopId: 3,
      hops: 1,
    });
  });

  it("re-anchors without a segment when the bus leaves the modelled path", () => {
    // The safety valve. A bus that turns up far outside its lookahead window
    // — here it skips two stops and appears at Elm / York, a kilometre from
    // anything the window admits — has genuinely jumped ahead. We move the
    // anchor but refuse to invent a travel-time sample for a leg we never
    // watched it drive.
    const state = step(twinNet, null, at(41.31, -72.93, T0)).state!;
    const jumped = step(twinNet, state, at(41.32, -72.94, T0 + 60_000));
    expect(jumped.state?.nearestStopId).toBe(5);
    expect(jumped.state?.nearestIndex).toBe(3);
    expect(jumped.events.map((e) => e.kind)).toEqual(["arrival"]);
  });

  it("prefers the stop the bus is actually at over the twin it is nearest", () => {
    // Standing at College/Wall, the correct anchor is the (S) stop the bus is
    // working through — not the (N) twin 28 m away that it will not reach for
    // another ten stops, even when GPS says the twin is marginally closer.
    const state = step(twinNet, null, at(41.31, -72.93, T0)).state!;
    const arrived = step(twinNet, state, at(41.31525, -72.925, T0 + 60_000));
    expect(arrived.state?.nearestStopId).toBe(2);
    expect(arrived.state?.nearestIndex).toBe(1);
  });
});

// Upstream route 10 verbatim: the West Campus shuttle runs out and back, so
// stops 23, 24, 25 and 26 each occupy two positions in the sequence.
describe("step: out-and-back route (West Campus)", () => {
  const ids = [10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 72];
  const wcStops: Stop[] = ids.map((id, i) => ({
    id,
    name: `S${id}`,
    lat: 41.29,
    lon: -72.95 + i * 0.004,
  }));
  const wcRoute: Route = {
    id: 10,
    name: "Purple - West Campus",
    shortName: "P",
    color: "#000",
    stops: [10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 72],
  };
  const wcNet = TransitNetwork.build(wcStops, [wcRoute]);
  const byId = new Map(wcStops.map((s) => [s.id, s]));

  function atStop(id: number, when: number): BusObservation {
    const s = byId.get(id)!;
    return {
      busId: 1,
      busName: "#1",
      routeId: 10,
      lat: s.lat,
      lon: s.lon,
      heading: 0,
      lastStopId: null,
      collectedAt: when,
    };
  }

  it("records the return leg that first-occurrence indexing threw away", () => {
    // Drive the real turnaround: …26, 25, 24, 23, 22, then back out
    // 23, 24, 25, 26, 72. Before this fix every leg after the turnaround
    // scored 14 hops and was discarded — 3,256 recorded route-10 segments
    // contained not one sample from the return leg.
    const drive = [26, 25, 24, 23, 22, 23, 24, 25, 26, 72];
    const states = new Map<number, BusState>();
    const events = stepMany(
      wcNet,
      states,
      drive.map((id, i) => atStop(id, T0 + i * 60_000)),
    );
    const legs = events
      .filter((e) => e.kind === "segment")
      .map((e) => `${e.fromStopId}->${e.toStopId}`);

    expect(legs).toEqual([
      "26->25",
      "25->24",
      "24->23",
      "23->22",
      "22->23",
      "23->24",
      "24->25",
      "25->26",
      "26->72",
    ]);
    for (const e of events) {
      if (e.kind === "segment") expect(e.hops).toBe(1);
    }
  });

  it("tracks which visit to a repeated stop the bus is on", () => {
    const states = new Map<number, BusState>();
    stepMany(
      wcNet,
      states,
      [26, 25, 24, 23, 22, 23].map((id, i) => atStop(id, T0 + i * 60_000)),
    );
    // Second visit to stop 23 — index 10, not the first occurrence at 8.
    expect(states.get(1)?.nearestStopId).toBe(23);
    expect(states.get(1)?.nearestIndex).toBe(10);
  });
});
