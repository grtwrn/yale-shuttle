import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  MAX_OBSERVATION_GAP_MS,
  MIN_DWELL_SEC,
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
