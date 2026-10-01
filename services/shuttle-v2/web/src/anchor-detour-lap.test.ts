/**
 * A DETOUR MUST NOT LAP THE RIDE — incident 5a7ad1d03bb72cfaa710.
 *
 * 2026-09-25, road race: Red buses left College Street and ran down Temple,
 * alongside the Chapel St leg of their own loop — a dozen legs ahead of
 * where they were. The lead took that jump and the in-ride header went from
 * "5 stops" to "21 stops" with the bus still short of LEPH / 60 College;
 * when the feed then put the bus AT LEPH the true position read as a wrap
 * behind and was held: "21 stops · 59 min" at the kerb. #317 had a feed
 * last stop that contradicted the jump; #309 an hour later had none; #127
 * stood beside the Chapel St leg for five minutes with the feed against it.
 * Replayed here fix by fix through the shared anchor.
 */
import { afterEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import { resolveAnchorIndex } from "./liveAnchor";
import type { AnchorStore } from "./eta";
import fixture from "./__fixtures__/red-detour-lap-2026-09-25.json";

const stops = fixture.routeStops["3"];
const N = stops.length;
const alightIdx = stops.indexOf(fixture.alightStopId);
const coords = fixture.stopCoords as unknown as Record<number, { lat: number; lon: number }>;

type Ride = (typeof fixture.rides)[number];

function replay(ride: Ride): { left: number; atExit: boolean }[] {
  registerRoutePaths(fixture.path as unknown as Record<string, [number, number][]>);
  const store: AnchorStore = new Map();
  return ride.positions.map((fix) => {
    const bus = { ...fix, route_id: 3, bus_name: ride.busName };
    const idx = resolveAnchorIndex(bus, stops, coords, `Red|${ride.busName}`, fix.observed_at + 100, store);
    return {
      left: (alightIdx - idx + N) % N,
      atExit: fix.stationary === true && fix.at_stop_id === fixture.alightStopId,
    };
  });
}

describe.each(fixture.rides.map((r) => [r.busName, r] as const))(
  "Red %s through the 2026-09-25 detour (incident 5a7ad1d)",
  (_name, ride) => {
    afterEach(() => registerRoutePaths(null));

    it("the recording is the reported defect: the page lapped the exit", () => {
      expect(ride.positions.some((p) => /^2\d stops/.test(p.shown))).toBe(true);
      const atExit = ride.positions.find((p) => p.stationary && p.at_stop_id === fixture.alightStopId)!;
      expect(atExit.shown).toMatch(/^2\d stops/);
    });

    it("never counts more stops than at boarding before the bus reaches the exit", () => {
      const steps = replay(ride);
      const exit = steps.findIndex((s) => s.atExit);
      expect(exit).toBeGreaterThan(0);
      expect(steps[0]!.left).toBe(8);
      expect(Math.max(...steps.slice(0, exit).map((s) => s.left))).toBeLessThanOrEqual(8);
    });

    // At the exit, or on its approach leg — the ring can hold a bus standing
    // 60 m short of the marker on the leg before it, the "Get off NEXT stop"
    // every ordinary ride shows at the kerb — but never a lap away.
    it("reads the exit when the feed has the bus standing at it", () => {
      const steps = replay(ride);
      expect(steps.find((s) => s.atExit)!.left).toBeLessThanOrEqual(1);
    });
  },
);
