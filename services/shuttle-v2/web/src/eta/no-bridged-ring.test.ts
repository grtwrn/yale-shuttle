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
import { buildRing } from "./ring";
import { haversineMeters } from "../geo";
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

  it.each(ROUTE_IDS)("route %s can be stood at every stop it serves", (rid) => {
    // The other half of "no route declines": a route can be priced and STILL
    // have an occurrence the belief cannot occupy. `traceStopLegs` projects a
    // stop onto the line, so where the line does not run past its own marker the
    // cell does not either — and a stop with no cell inside its zone is a stand
    // the estimator has no state for. Green's Building 800 outbound was exactly
    // that (99 m, the only one of 280 occurrences), and a bus parking there was
    // relocated five legs onto the RETURN occurrence of the same stop id.
    const ring = ringForBus({ route_id: rid }, P.routes[rid]!, P.stop_coords)!;
    const claimed = new Set(Array.from(ring.nearStop).filter((i) => i >= 0));
    for (let i = 0; i < ring.N; i++) {
      expect(claimed.has(i), `route ${rid} ring ${i} (stop ${ring.stops[i]}) has no cell in its own zone`).toBe(true);
    }
  });

  it("needs the stand-point correction on exactly one occurrence of one line", () => {
    // Pinned so it cannot start firing quietly on a line whose geometry is fine:
    // it is a correction, not a normalisation. If an upstream polyline change
    // adds one, say so in the PR — it means a line stopped running past a stop
    // it serves.
    const moved = ROUTE_IDS.flatMap((rid) => {
      const ring = ringForBus({ route_id: rid }, P.routes[rid]!, P.stop_coords)!;
      return ring.unreached.map((i) => `${rid}:${i}:${ring.stops[i]}`);
    });
    expect(moved).toEqual(["9:13:25"]);
  });

  it("picks up a SECOND such occurrence on its own, and trips CI when it does", () => {
    // The blast radius, measured rather than assumed. Any stop whose kerb the
    // line serves on one pass only is exposed to this, and today exactly one
    // occurrence in 280 is. If upstream republishes a line so that a second one
    // appears, four things must be true, and this is what they are.
    //
    // Measured on a NON-FOLD route on purpose: route 3 is neither bridged nor
    // repaired, so `traceStopLegs` alone decides its legs and displacing one
    // marker cannot move the aligner under the measurement. (Displacing a marker
    // on GREEN does move it — an earlier attempt took the ring to N=25, and
    // another to `bridged`, which is a different geometry and not this question.)
    //
    // NOTE `buildRing` directly, never `ringForBus`: `ringFor`'s cache key is
    // route + stops + path hash and does NOT include the stop coordinates, so a
    // perturbed lookup would be answered from the cache.
    const coords: Record<number, { lat: number; lon: number }> = {};
    for (const [k, v] of Object.entries(P.stop_coords)) coords[Number(k)] = v as LatLon;

    const survey = (tag: string, cs: Record<number, LatLon>) => {
      const moved: string[] = [];
      const shape: Record<string, number> = {};
      let zoneless = 0, clashes = 0;
      const bridged: string[] = [];
      for (const rid of ROUTE_IDS) {
        const r = buildRing(`${tag}|${rid}`, P.route_paths[rid]!, P.routes[rid]!, cs)!;
        shape[rid] = r.N;
        if (r.bridged) bridged.push(rid);
        for (const i of r.unreached) moved.push(`${rid}:${i}:${r.stops[i]}`);
        const claimed = new Set(Array.from(r.nearStop).filter((i) => i >= 0));
        for (let i = 0; i < r.N; i++) if (!claimed.has(i)) zoneless++;
        // Two unreached occurrences of ONE stop id would put two standing points
        // on one marker, and the emission could not separate them — the very
        // ambiguity this change fixes. It does not happen today.
        for (let a = 0; a < r.unreached.length; a++) {
          for (let b = a + 1; b < r.unreached.length; b++) {
            const ca = r.stopCell[r.unreached[a]!]!, cb = r.stopCell[r.unreached[b]!]!;
            const d = haversineMeters({ lat: r.standLat[ca]!, lon: r.standLon[ca]! }, { lat: r.standLat[cb]!, lon: r.standLon[cb]! });
            if (d < 5) clashes++;
          }
        }
      }
      return { moved, shape, zoneless, clashes, bridged };
    };

    const before = survey("today", coords);
    expect(before.moved).toEqual(["9:13:25"]);
    expect(before.zoneless).toBe(0);
    expect(before.clashes).toBe(0);

    // Republish route 3's line so it no longer runs past one of its own kerbs.
    const stopId = P.routes["3"]![4]!;
    const after = survey("republished", { ...coords, [stopId]: { lat: coords[stopId]!.lat + 0.00135, lon: coords[stopId]!.lon } });

    // 1. It is picked up automatically — no per-route list to edit.
    expect(after.moved).toEqual([`3:4:${stopId}`, "9:13:25"]);
    // 2. Nothing else about any ring moves: same cells, same legs, same N.
    expect(after.shape).toEqual(before.shape);
    expect(after.bridged).toEqual(before.bridged);
    // 3. The invariant still holds everywhere: every occurrence has a zone.
    expect(after.zoneless).toBe(0);
    // 4. And no two standing points collide, which is the one case the fix
    //    could not disambiguate.
    expect(after.clashes).toBe(0);
    // 5. CI notices: the pin above compares against ["9:13:25"] and would fail,
    //    so a republished line reaches a human instead of changing prices quietly.
    expect(after.moved).not.toEqual(before.moved);
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
