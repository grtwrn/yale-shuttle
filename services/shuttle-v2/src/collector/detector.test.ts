import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  MAX_HANDOFF_GAP_MS,
  MAX_OBSERVATION_GAP_MS,
  MAX_SEGMENT_SEC,
  MIN_DWELL_SEC,
  MIN_SEGMENT_SEC,
  planTracks,
  reconcileTracks,
  step,
  stepMany,
  type BusObservation,
  type BusState,
  type DetectorEvent,
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
      lat: stops[0]!.lat,
      lon: stops[0]!.lon,
      stationarySince: T0,
      stationaryLat: stops[0]!.lat,
      stationaryLon: stops[0]!.lon,
      stationaryStopId: 1,
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
      lat: stops[0]!.lat,
      lon: stops[0]!.lon,
      stationarySince: T0,
      stationaryLat: stops[0]!.lat,
      stationaryLon: stops[0]!.lon,
      stationaryStopId: 1,
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
    const states = new Map<string, BusState>();
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
    expect(states.get("#1")?.nearestStopId).toBe(2);
    expect(states.get("#2")?.nearestStopId).toBe(3);
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
    const states = new Map<string, BusState>();
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
    const states = new Map<string, BusState>();
    stepMany(
      wcNet,
      states,
      [26, 25, 24, 23, 22, 23].map((id, i) => atStop(id, T0 + i * 60_000)),
    );
    // Second visit to stop 23 — index 10, not the first occurrence at 8.
    expect(states.get("#1")?.nearestStopId).toBe(23);
    expect(states.get("#1")?.nearestIndex).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Vehicle identity. Upstream's `bus_id` is reissued per service block — 1,059
// distinct ids for 50 distinct `bus_name`s over 30 days of production, a
// median id lifetime of 5.9 h. Tracking keyed on the id therefore drops a
// bus's anchor several times a day; tracking keyed naively on the name
// inherits it across the multi-minute layover the reissue happens during.
// ---------------------------------------------------------------------------

describe("bus identity across an id reissue", () => {
  /** One observation for fleet number `name` reported under upstream id `id`. */
  function seen(
    stop: Stop,
    when: number,
    name: string,
    id: number,
  ): BusObservation {
    return {
      busId: id,
      busName: name,
      routeId: 1,
      lat: stop.lat,
      lon: stop.lon,
      heading: 90,
      lastStopId: stop.id,
      collectedAt: when,
    };
  }

  it("keeps a bus's anchor when upstream reissues its id", () => {
    // Keyed by bus_id this is two different buses, so the second poll
    // re-anchors: `enteredAt` resets and the segment spanning the reissue is
    // never emitted.
    const states = new Map<string, BusState>();
    stepMany(net, states, [seen(stops[0]!, T0, "#40", 65531)]);
    const events = stepMany(net, states, [
      seen(stops[1]!, T0 + 45_000, "#40", 65540),
    ]);

    expect(states.size).toBe(1);
    expect(states.get("#40")?.busId).toBe(65540);
    expect(events.map((e) => e.kind)).toEqual(["dwell", "arrival", "segment"]);
    const segment = events.find((e) => e.kind === "segment")!;
    expect(segment).toMatchObject({
      busName: "#40",
      fromStopId: 1,
      toStopId: 2,
      travelSec: 45,
      startedAt: T0,
    });
  });

  it("tells the dwell which id its arrival row was written under", () => {
    // The arrival being patched was inserted while the OLD id was in force.
    // Patching on the reporting id would match nothing and silently leave a
    // real visit with no departure time.
    const states = new Map<string, BusState>();
    stepMany(net, states, [seen(stops[0]!, T0, "#40", 65531)]);
    const events = stepMany(net, states, [
      seen(stops[1]!, T0 + 45_000, "#40", 65540),
    ]);
    const dwell = events.find((e) => e.kind === "dwell")!;
    expect(dwell).toMatchObject({ busId: 65540, anchorBusId: 65531 });
  });

  it("re-anchors rather than billing a layover as travel time", () => {
    // The reason keying on the name is not enough on its own. Every
    // multi-minute hole in one vehicle's feed observed in a 6.6 h production
    // replay coincided with an id reissue: the bus goes off the air at a block
    // boundary and sits still. Inheriting `enteredAt` across it made route
    // 15's 10→153 leg read 1,149 s instead of 326 s.
    const states = new Map<string, BusState>();
    stepMany(net, states, [seen(stops[0]!, T0, "#40", 65531)]);
    const gone = T0 + MAX_HANDOFF_GAP_MS + 60_000;
    const events = stepMany(net, states, [seen(stops[0]!, gone, "#40", 65540)]);

    // Identity and the map slot survive; the stopwatch does not.
    expect(states.get("#40")?.busId).toBe(65540);
    expect(states.get("#40")?.enteredAt).toBe(gone);
    expect(events.map((e) => e.kind)).toEqual(["arrival"]);

    // ...so the next leg is timed from the reissue, not from before the gap.
    const after = stepMany(net, states, [
      seen(stops[1]!, gone + 45_000, "#40", 65540),
    ]);
    expect(after.find((e) => e.kind === "segment")).toMatchObject({
      travelSec: 45,
    });
  });

  it("re-anchors when a reissued id turns up impossibly far away", () => {
    // Backstop for two live ids sharing one name that never appear in the same
    // poll, so `planTracks` cannot see the collision. 1,700 m in 5 s is
    // 1,200 km/h — a different bus, not a shuttle.
    const states = new Map<string, BusState>();
    stepMany(net, states, [seen(stops[0]!, T0, "#40", 65531)]);
    const events = stepMany(net, states, [
      seen(stops[2]!, T0 + 5_000, "#40", 65540),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["arrival"]);
    expect(states.get("#40")?.enteredAt).toBe(T0 + 5_000);
  });

  it("starts a genuinely new vehicle clean", () => {
    const states = new Map<string, BusState>();
    stepMany(net, states, [seen(stops[0]!, T0, "#40", 65531)]);
    const events = stepMany(net, states, [
      seen(stops[0]!, T0 + 5_000, "#40", 65531),
      seen(stops[1]!, T0 + 5_000, "#317", 65999),
    ]);
    expect(states.size).toBe(2);
    expect(states.get("#317")).toMatchObject({ nearestStopId: 2, enteredAt: T0 + 5_000 });
    // First sight: an anchor only, never a dwell or a segment inherited from
    // whatever else happened to be in the map.
    expect(events.map((e) => e.kind)).toEqual(["arrival"]);
  });
});

describe("two live ids sharing one bus name", () => {
  // Observed in production: `#43` was reported by ids 65531 and 65533
  // simultaneously for 6.7 h, both on route 1 — one at stop 102 while the
  // other was at stop 2. Keyed naively on the name they merge into one track
  // and the anchor thrashes between two physical buses.
  function seen(stop: Stop, when: number, id: number): BusObservation {
    return {
      busId: id,
      busName: "#43",
      routeId: 1,
      lat: stop.lat,
      lon: stop.lon,
      heading: 90,
      lastStopId: stop.id,
      collectedAt: when,
    };
  }

  it("keeps the two streams on separate anchors and emits no segment between them", () => {
    const states = new Map<string, BusState>();
    // Bus A works stops 1→2 while bus B works 3→1, each poll carrying both.
    const drive = [
      [stops[0]!, stops[2]!],
      [stops[0]!, stops[2]!],
      [stops[1]!, stops[0]!],
    ] as const;
    const events: DetectorEvent[] = [];
    drive.forEach(([a, b], i) => {
      events.push(
        ...stepMany(net, states, [
          seen(a, T0 + i * 60_000, 65531),
          seen(b, T0 + i * 60_000, 65533),
        ]),
      );
    });

    expect([...states.keys()].sort()).toEqual(["#43#65531", "#43#65533"]);
    expect(states.get("#43#65531")?.nearestStopId).toBe(2);
    expect(states.get("#43#65533")?.nearestStopId).toBe(1);
    // Each bus advanced one real hop. Nothing spans the two of them: a merged
    // anchor would have produced 3→1 / 1→3 flapping every poll.
    const legs = events
      .filter((e) => e.kind === "segment")
      .map((e) => `${e.busId}:${e.fromStopId}->${e.toStopId}`)
      .sort();
    expect(legs).toEqual(["65531:1->2", "65533:3->1"]);
  });

  it("hands the surviving id the name back when the collision ends", () => {
    const contended = planTracks([
      { ...({} as BusObservation), busId: 65531, busName: "#43", collectedAt: T0 },
      { ...({} as BusObservation), busId: 65533, busName: "#43", collectedAt: T0 },
    ]);
    expect(contended.contendedNames.has("#43")).toBe(true);
    expect([...contended.keySet].sort()).toEqual(["#43#65531", "#43#65533"]);

    // 65531 goes out of service; 65533 keeps reporting.
    const map = new Map([
      ["#43#65531", { busId: 65531, busName: "#43" }],
      ["#43#65533", { busId: 65533, busName: "#43" }],
    ]);
    const alone = planTracks([
      { ...({} as BusObservation), busId: 65533, busName: "#43", collectedAt: T0 + 5_000 },
    ]);
    reconcileTracks(map, alone);
    // One entry for one vehicle — the retired half does not linger.
    expect([...map.keys()]).toEqual(["#43"]);
    expect(map.get("#43")?.busId).toBe(65533);
  });

  it("moves an existing track under the qualified key when a collision starts", () => {
    const map = new Map([["#43", { busId: 65531, busName: "#43" }]]);
    reconcileTracks(
      map,
      planTracks([
        { ...({} as BusObservation), busId: 65531, busName: "#43", collectedAt: T0 },
        { ...({} as BusObservation), busId: 65533, busName: "#43", collectedAt: T0 },
      ]),
    );
    // The stream we were tracking keeps its anchor under a longer name; the
    // newcomer gets no entry at all and will anchor from scratch.
    expect([...map.keys()]).toEqual(["#43#65531"]);
  });

  it("leaves buses that are not reporting this poll alone", () => {
    const map = new Map([["#99", { busId: 1, busName: "#99" }]]);
    reconcileTracks(
      map,
      planTracks([
        { ...({} as BusObservation), busId: 2, busName: "#40", collectedAt: T0 },
      ]),
    );
    // Not in the poll is not the same as gone — that is the TTL sweep's job.
    expect([...map.keys()]).toEqual(["#99"]);
  });
});

describe("the stationary clock survives a parked shuffle (2026-09-03)", () => {
  // A garage stop and its next stop 200 m on, laid out east-west — the shape
  // of 344 Winchester and Winchester / Division, where this was reported.
  const LON_PER_M = 1 / 83_700; // at latitude 41.32
  const garage: Stop = { id: 10, name: "Garage", lat: 41.32, lon: -72.94 };
  const onward: Stop = { id: 11, name: "Onward", lat: 41.32, lon: -72.94 + 200 * LON_PER_M };
  const nearNet = TransitNetwork.build([garage, onward], [
    { id: 1, name: "Line", shortName: "L", color: "#000", stops: [10, 11] },
  ]);
  const at = (metresEast: number, when: number): BusObservation => ({
    busId: 42,
    busName: "#42",
    routeId: 1,
    lat: 41.32,
    lon: -72.94 + metresEast * LON_PER_M,
    heading: 90,
    lastStopId: 10,
    collectedAt: when,
  });

  it("pins the wait to the stop, not to where the bus happened to stop", () => {
    // The frame is the fix. Anchoring on the bus put the anchor wherever it
    // came to rest during roll-in — at the EDGE of the stop — so the bus then
    // settled ~64 m away and every later shuffle crossed the radius.
    const parked = step(nearNet, null, at(40, T0)).state!;
    expect(parked.stationaryStopId).toBe(10);
    expect(parked.stationaryLon).toBe(garage.lon);
    expect(parked.stationarySince).toBe(T0);
  });

  it("keeps the wait a rider is watching when the bus only shuffles", () => {
    const parked = step(nearNet, null, at(0, T0)).state!;
    expect(parked.stationarySince).toBe(T0);

    // Eight minutes in it pulls 90 m down the yard — past the 75 m radius the
    // bus-anchored guard used, and past the pin radius too, so this is the
    // fallback radius doing the work.
    const shuffled = step(nearNet, parked, at(90, T0 + 8 * 60_000)).state!;
    expect(shuffled.stationarySince).toBe(T0);
    expect(shuffled.stationaryStopId).toBe(10);

    // ...and coming back in re-pins to the SAME stop, which must not restart
    // it either. Re-anchoring on the way back is how the old guard ratcheted
    // the clock forward one shuffle at a time.
    const back = step(nearNet, shuffled, at(20, T0 + 9 * 60_000)).state!;
    expect(back.stationarySince).toBe(T0);
  });

  it("restarts once the bus reaches a DIFFERENT stop", () => {
    const parked = step(nearNet, null, at(0, T0)).state!;
    const arrived = step(nearNet, parked, at(200, T0 + 8 * 60_000)).state!;
    // A different stop is a different wait. This is the rule that stops a
    // layover's clock following the bus onward and cancelling the dwell at its
    // next stop — the direction that makes an ETA too SHORT.
    //
    // The trade it accepts: two stops close enough that a yard shuffle lands
    // the bus nearer the OTHER one will restart the clock. Replayed over
    // 89,607 production positions that costs 3 resets across 964 stop visits,
    // against 595 for the guard it replaces.
    expect(arrived.stationaryStopId).toBe(11);
    expect(arrived.stationarySince).toBe(T0 + 8 * 60_000);
  });

  it("restarts once the bus has actually gone somewhere that is not a stop", () => {
    const parked = step(nearNet, null, at(0, T0)).state!;
    // 500 m east: past STATIONARY_RADIUS_M of the garage and not at any stop.
    const left = step(nearNet, parked, at(500, T0 + 8 * 60_000)).state!;
    expect(left.stationarySince).toBe(T0 + 8 * 60_000);
    expect(left.stationaryStopId).toBeNull();
  });

  it("cannot be walked across town one metre at a time", () => {
    // The anchor point is kept, not re-centred on every observation, so a
    // slow drift never accumulates into a free stationary clock.
    let st = step(nearNet, null, at(0, T0)).state!;
    for (let i = 1; i <= 8; i++) {
      st = step(nearNet, st, at(i * 20, T0 + i * 60_000)).state!;
    }
    // 160 m from the stop it was pinned to: it must have restarted on the way.
    expect(st.stationarySince).toBeGreaterThan(T0);
  });
});

// The Red #316 incident (report #82) is replayed from the unedited production
// feed, against the real stop geometry, in `detector.report82.test.ts`. The
// synthetic two-stop version that used to live here was superseded by it.
