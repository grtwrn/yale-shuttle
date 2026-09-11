/**
 * NO ROUTE DECLINES. Asserted from the payload, not from the source.
 *
 * The estimator used to hand two classes of route to a second arithmetic —
 * a ring the published line could not trace (`ring.bridged`) and a route with
 * no measured drive (`tables.priced` false). Both are closed: #157 gave an
 * untimed line the network's pooled pace and stand pools, #160 reads a stop
 * ORDER off the published polyline where the published list disagrees with it
 * (Green). With nothing left to decline, the legacy arithmetic had no caller
 * and was deleted on 2026-09-07.
 *
 * That deletion removed the net as well as the fall. Before it, an upstream
 * change that re-bridged a ring would have been INVISIBLE: the route would
 * have quietly gone back to the other arithmetic and the suite would still be
 * green. So this file is the replacement net, and it is deliberately not a
 * unit test — it runs the real `ringForBus` and `buildTables` over a real
 * `/api/buses` payload (`__fixtures__/buses-payload.json`), every route, and
 * fails if any of them declines.
 *
 * If this test ever fails, the answer is NOT to re-add a fallback. It is that
 * upstream changed a stop list or a polyline and the ring must be made to
 * describe it — see `src/network/alignStops.ts` and the "Route lines: the
 * published geometry is right, drawing it was wrong" section of CLAUDE.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerRoutePaths } from "../anchor";
import type { LatLon } from "../geo";
import { globalPoolsFor, ringForBus } from "./index";
import { buildTables, type DwellLike, type SegmentLike } from "./tables";

import payload from "../__fixtures__/buses-payload.json";

const P = payload as unknown as {
  routes: Record<string, number[]>;
  route_paths: Record<string, [number, number][]>;
  stop_coords: Record<number, LatLon>;
  segments: Record<string, Record<string, SegmentLike>>;
  dwells: Record<string, Record<string, DwellLike>>;
};

const ROUTE_IDS = Object.keys(P.routes);

beforeAll(() => registerRoutePaths(P.route_paths));
afterAll(() => registerRoutePaths(null));

describe("every route the payload serves is priced by the model", () => {
  it("the fixture is the whole network, not a slice", () => {
    // Fifteen published lines. A route added upstream lands here on the next
    // capture and must pass the same two assertions.
    expect(ROUTE_IDS.length).toBe(15);
    for (const rid of ROUTE_IDS) {
      expect(P.route_paths[rid]!.length, `route ${rid} has no polyline`).toBeGreaterThan(1);
      expect(P.routes[rid]!.length, `route ${rid} has fewer than two stops`).toBeGreaterThan(1);
    }
  });

  it.each(ROUTE_IDS)("route %s builds a ring the published line can trace", (rid) => {
    const ring = ringForBus({ route_id: rid }, P.routes[rid]!, P.stop_coords);
    expect(ring, `route ${rid} has no ring at all`).not.toBeNull();
    // The one thing that used to send a route to the legacy arithmetic on its
    // geometry. Green is `repaired` here — its published order disagrees with
    // its published line — and the repair is what makes it unbridged.
    expect(ring!.bridged, `route ${rid} bridged a leg with a chord`).toBe(false);
  });

  it.each(ROUTE_IDS)("route %s has tables that can price a leg", (rid) => {
    const ring = ringForBus({ route_id: rid }, P.routes[rid]!, P.stop_coords)!;
    const pools = globalPoolsFor(P.dwells).pools;
    const t = buildTables(
      P.routes[rid]!, P.stop_coords, P.segments[rid] ?? {}, P.dwells[rid] ?? {},
      ring, pools, ring.repaired ? ring.order : undefined,
    );
    // The other decline. It is true here for the two grocery lines as well,
    // which have few or no measured hops of their own (route 6 has none at
    // all) and are priced from the ALL-ROUTES pooled pace — the change that
    // closed this one.
    expect(t.priced, `route ${rid} has no hop the model can price`).toBe(true);
    expect(t.hops).toHaveLength(P.routes[rid]!.length);
    expect(t.stops).toHaveLength(P.routes[rid]!.length);
  });

  it("repairs the three out-and-backs the evidence names, and nothing else", () => {
    // Pinned so the repair cannot silently start firing on a line whose
    // published order is right: it is a correction, not a normalisation.
    // Green (9) is the bridged one; Pink (8) and Purple (10) trace perfectly
    // and are wrong anyway, and reach the aligner on the fold instead.
    const repaired = ROUTE_IDS.filter((rid) => ringForBus({ route_id: rid }, P.routes[rid]!, P.stop_coords)!.repaired);
    expect(repaired).toEqual(["8", "9", "10"]);
    // Green: the line passes West Haven station twice and the list names it
    // once, so the repaired ring carries one cell more than the published
    // list. Purple: the same station, the same one extra. Pink: twelve
    // published stops for a lap of eighteen passes, of which the line can
    // name sixteen.
    expect(ringForBus({ route_id: "9" }, P.routes["9"]!, P.stop_coords)!.N).toBe(P.routes["9"]!.length + 1);
    expect(ringForBus({ route_id: "10" }, P.routes["10"]!, P.stop_coords)!.N).toBe(P.routes["10"]!.length + 1);
    expect(ringForBus({ route_id: "8" }, P.routes["8"]!, P.stop_coords)!.N).toBe(P.routes["8"]!.length + 4);
  });
});
