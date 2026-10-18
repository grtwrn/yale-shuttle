import { describe, expect, it } from "vitest";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";
import { MAX_HANDOFF_GAP_MS, MAX_OBSERVATION_GAP_MS, step, type BusState } from "./detector.js";
import { stepManyWithVisits } from "./departure.js";
import fixture from "./__fixtures__/restart-after-departure-blue-20261017.json";

const approachAt = 1792258982413;
const next = fixture.observations.find(o => o.collectedAt === 1792258987499)!;
function setup() {
  const network = TransitNetwork.build(structuredClone(fixture.stops) as Stop[], [structuredClone(fixture.route) as Route]);
  let state: BusState | null = null;
  for (const obs of fixture.observations) {
    state = step(network, state, obs).state;
    if (obs.collectedAt === approachAt) break;
  }
  expect(state).toMatchObject({ nearestStopId: 116, enteredAt: approachAt });
  return { network, state: state! };
}

describe("an unchanged fix must not advance the route window again", () => {
  it("keeps the first Stop & Shop approach instead of cascading to Elm/York at the same position", () => {
    const { network, state } = setup();
    Object.freeze(state);
    expect(next.lat).toBe(state.lat); expect(next.lon).toBe(state.lon);
    const result = step(network, state, next);
    expect(result.state).toMatchObject({ nearestStopId: 116, enteredAt: approachAt, lastObservedAt: next.collectedAt });
    expect(result.events).toEqual([]);
    expect(state.lastObservedAt).toBe(approachAt);
  });

  it("continues stationary and movement clocks while the position repeats", () => {
    const { network, state } = setup();
    let current = state;
    for (let i = 1; i <= 6; i++) {
      const result = step(network, current, { ...next, collectedAt: approachAt + i * 5000 });
      expect(result.events).toEqual([]); current = result.state!;
    }
    expect(current).toMatchObject({ nearestStopId: 116, enteredAt: state.enteredAt,
      stationarySince: state.stationarySince, lastMovedAt: state.lastMovedAt });
  });

  it("still selects the closest anchor with unknown cold history", () => {
    const { network } = setup(), result = step(network, null, next);
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.map(e => e.kind)).toEqual(["arrival"]);
  });

  it("allows a newly moved fix to select the next stop normally", () => {
    const { network, state } = setup(), stop = network.stops.get(53)!;
    const result = step(network, state, { ...next, lat: stop.lat, lon: stop.lon });
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.some(e => e.kind === "arrival" && e.stopId === 53)).toBe(true);
  });

  it("does not require a route polyline to keep an unchanged position", () => {
    const { network, state } = setup(); delete network.routes.get(4)!.path;
    const result = step(network, state, next);
    expect(result.state?.nearestStopId).toBe(116); expect(result.events).toEqual([]);
  });

  it("allows a stale same-position fix to re-anchor after an observation gap", () => {
    const { network, state } = setup();
    const result = step(network, state, { ...next, collectedAt: approachAt + MAX_OBSERVATION_GAP_MS + 1 });
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.map(e => e.kind)).toEqual(["arrival"]);
  });

  it("keeps the anchor through a continuous provider ID handoff", () => {
    const { network, state } = setup();
    const result = step(network, state, { ...next, busId: next.busId + 1 });
    expect(result.state).toMatchObject({ busId: next.busId + 1, nearestStopId: 116, enteredAt: approachAt });
    expect(result.events).toEqual([]);
  });

  it("allows a discontinuous provider ID to re-anchor", () => {
    const { network, state } = setup();
    const result = step(network, state, { ...next, busId: next.busId + 1, collectedAt: approachAt + MAX_HANDOFF_GAP_MS + 1 });
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.map(e => e.kind)).toEqual(["arrival"]);
  });

  it("does not retain an occurrence removed from the current route order", () => {
    const { network, state } = setup(); network.routes.get(4)!.stops[state.nearestIndex] = 53;
    const result = step(network, state, next);
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.some(e => e.kind === "arrival")).toBe(true);
  });

  it("preserves the global re-anchor escape when the saved marker is no longer competitive", () => {
    const { network, state } = setup(); network.stops.get(116)!.lat += 0.02;
    const result = step(network, state, next);
    expect(result.state?.nearestStopId).toBe(53);
    expect(result.events.map(e => e.kind)).toEqual(["arrival"]);
  });

  it.each([0, -1])("does not accept a duplicate or older fix (%s ms)", offset => {
    const { network, state } = setup();
    const result = step(network, state, { ...next, collectedAt: approachAt + offset });
    expect(result.state).toBe(state); expect(result.events).toEqual([]);
  });

  it.each([approachAt, fixture.recordedVisit.arrived_at + 30_000])(
    "resets the visit and inbound transit when a rebuilt topology removes the old occurrence after %s", at => {
      const network = TransitNetwork.build(fixture.stops as Stop[], [fixture.route as Route]);
      const states = new Map(), visits = new Map();
      let previous = fixture.observations[0]!;
      for (const obs of fixture.observations) {
        if (obs.collectedAt > at) break;
        stepManyWithVisits(network, states, visits, [obs]); previous = obs;
      }
      expect(states.get(previous.busName).nearestStopId).toBe(116);
      const changed = TransitNetwork.build(fixture.stops.filter(s => s.id !== 116) as Stop[],
        [{ ...fixture.route, stops: fixture.route.stops.filter(id => id !== 116) } as Route]);
      const result = stepManyWithVisits(changed, states, visits, [{ ...previous, collectedAt: previous.collectedAt + 5000 }]);
      const detector = states.get(previous.busName), visit = visits.get(previous.busName);
      expect(detector.nearestStopId).not.toBe(116);
      expect(visit.pass.stopId).toBe(detector.nearestStopId);
      expect(visit.transit).toBeNull();
      expect(result.visits.filter(e => e.kind === "leg")).toEqual([]);
      if (at > approachAt) expect(result.visits).toContainEqual(expect.objectContaining({
        kind: "visit", stopId: 116, outcome: "unresolved", departedAt: null,
      }));
    },
  );
});
