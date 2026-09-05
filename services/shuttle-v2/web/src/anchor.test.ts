import { afterEach, describe, expect, it } from "vitest";

import {
  ANCHOR_FEED_LEAD_HOPS, ANCHOR_GPS_THRESHOLD_M, findRouteAnchor, isBusOnRoute,
  OFF_ROUTE_THRESHOLD_M, registerRoutePaths,
} from "./anchor";
import { distanceToSegmentM, haversineMeters } from "./geo";
import { at, routeStops, STOP, stopCoords } from "./__fixtures__/payload";
import incidents from "./__fixtures__/anchor-incidents.json";
import { resolveAnchorIndex } from "./liveAnchor";
import type { AnchorStore } from "./anchorGate";

const blueWeekend = routeStops["4"]!;
const blueDay = routeStops["1"]!;

const IDX = {
  yorkChapel: blueWeekend.indexOf(STOP.yorkChapel),      // 21
  broadwayYork: blueWeekend.indexOf(STOP.broadwayYork),  // 22
  stopAndShop: blueWeekend.indexOf(STOP.stopAndShop),    // 23
  elmYork: blueWeekend.indexOf(STOP.elmYorkTyco),        // 24
};

/** Nudge a coordinate by roughly `m` metres north. */
const nudgeNorth = (c: { lat: number; lon: number }, m: number) =>
  ({ lat: c.lat + m / 111_000, lon: c.lon });

describe("the fixture really does contain the pathological geometry", () => {
  it("Broadway/York and Elm/York are ~23 m apart but two stops apart", () => {
    expect(IDX.broadwayYork).toBe(22);
    expect(IDX.elmYork).toBe(24);
    expect(IDX.elmYork - IDX.broadwayYork).toBe(2);
    const gap = haversineMeters(at(STOP.broadwayYork), at(STOP.elmYorkTyco));
    expect(gap).toBeGreaterThan(15);
    expect(gap).toBeLessThan(30);
    // Both sit comfortably inside the GPS threshold of each other, which is
    // exactly why at_stop_id cannot be trusted to disambiguate them.
    expect(gap).toBeLessThan(ANCHOR_GPS_THRESHOLD_M);
  });
});

describe("findRouteAnchor: at_stop_id refines, never overrides", () => {
  // Reports #37/#38 (and the ETA swing in #32): at_stop_id used to
  // short-circuit the whole GPS scan. A bus physically at Elm/York whose feed
  // still said "at Broadway/York" was relocated TWO STOPS BACKWARDS, throwing
  // the ETA a third of a loop.
  it("does not anchor backwards when at_stop_id disagrees with GPS", () => {
    const bus = {
      ...at(STOP.elmYorkTyco),
      last_stop_id: STOP.stopAndShop,
      at_stop_id: STOP.broadwayYork,
    };
    const idx = findRouteAnchor(bus, blueWeekend, stopCoords);
    expect(idx).not.toBe(IDX.broadwayYork);
    // The GPS scan's own answer stands.
    expect(idx).toBe(IDX.stopAndShop);
  });

  it("does not anchor backwards even with no last_stop_id hint", () => {
    const bus = { ...at(STOP.elmYorkTyco), at_stop_id: STOP.broadwayYork };
    const idx = findRouteAnchor(bus, blueWeekend, stopCoords);
    expect(idx).not.toBe(IDX.broadwayYork);
    expect(idx).toBeGreaterThanOrEqual(IDX.stopAndShop);
  });

  // Report #27's fix, which the refinement must preserve: the segment scan
  // legitimately lags one stop behind at a shared segment endpoint, and
  // at_stop_id is the fresher signal there.
  it("still accepts at_stop_id exactly one stop ahead of the GPS anchor", () => {
    const bus = {
      ...at(STOP.broadwayYork),
      last_stop_id: STOP.yorkChapel,
      at_stop_id: STOP.broadwayYork,
    };
    // Without the hint the scan anchors on the segment ENDING at Broadway/York.
    const withoutHint = findRouteAnchor(
      { ...at(STOP.broadwayYork), last_stop_id: STOP.yorkChapel },
      blueWeekend, stopCoords,
    );
    expect(withoutHint).toBe(IDX.yorkChapel);
    // With it, the bus is correctly advanced by exactly one.
    expect(findRouteAnchor(bus, blueWeekend, stopCoords)).toBe(IDX.broadwayYork);
  });

  it("agrees with at_stop_id when GPS already points at the same stop", () => {
    const bus = { ...at(STOP.elmYorkTyco), at_stop_id: STOP.elmYorkTyco };
    expect(findRouteAnchor(bus, blueWeekend, stopCoords)).toBe(IDX.elmYork);
  });

  it("ignores at_stop_id when the bus is nowhere near that stop", () => {
    // Bus is at Phelps Gate; the feed claims Union Station, ~1.2 km away.
    const gpsOnly = findRouteAnchor(at(STOP.phelpsGate ?? 98), blueWeekend, stopCoords);
    const withBadHint = findRouteAnchor(
      { ...at(98), at_stop_id: 122 }, blueWeekend, stopCoords,
    );
    expect(haversineMeters(at(98), at(122))).toBeGreaterThan(ANCHOR_GPS_THRESHOLD_M);
    expect(withBadHint).toBe(gpsOnly);
  });

  it("ignores an at_stop_id that isn't on this route", () => {
    const gpsOnly = findRouteAnchor(at(STOP.elmYorkTyco), blueWeekend, stopCoords);
    const withOffRouteHint = findRouteAnchor(
      { ...at(STOP.elmYorkTyco), at_stop_id: STOP.peabody }, blueWeekend, stopCoords,
    );
    expect(blueWeekend).not.toContain(STOP.peabody);
    expect(withOffRouteHint).toBe(gpsOnly);
  });
});

describe("findRouteAnchor: GPS scan", () => {
  it("uses last_stop_id only to break ties among GPS candidates", () => {
    // Blue Day passes College/Wall twice — (S) at idx 18 and (N) at idx 28.
    const sIdx = blueDay.indexOf(42);
    const nIdx = blueDay.indexOf(41);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThan(sIdx);
    // A bus sitting between them with a fresh southbound last_stop_id should
    // pick the leg that follows that stop, not the far one.
    const fromSouth = findRouteAnchor(
      { ...at(42), last_stop_id: 118 }, blueDay, stopCoords,
    );
    expect(fromSouth).toBeGreaterThanOrEqual(blueDay.indexOf(118));
    expect(fromSouth).toBeLessThanOrEqual(sIdx + 1);
  });

  it("falls back to last_stop_id when there is no GPS at all", () => {
    const idx = findRouteAnchor(
      { lat: 0, lon: 0, last_stop_id: STOP.elmYorkTyco }, blueWeekend, stopCoords,
    );
    expect(idx).toBe(IDX.elmYork);
  });

  it("returns 0 with neither GPS nor a usable last_stop_id", () => {
    expect(findRouteAnchor({ lat: 0, lon: 0 }, blueWeekend, stopCoords)).toBe(0);
    expect(findRouteAnchor({ lat: 0, lon: 0, last_stop_id: 99_999 }, blueWeekend, stopCoords)).toBe(0);
  });

  it("returns -1 for an empty stop list", () => {
    expect(findRouteAnchor(at(STOP.elmYorkTyco), [], stopCoords)).toBe(-1);
  });

  it("still produces an anchor for a bus far off the route", () => {
    // 5 km north of everything — no segment is within threshold, so the
    // globally-nearest one is used rather than crashing downstream code.
    const idx = findRouteAnchor(nudgeNorth(at(STOP.elmYorkTyco), 5_000), blueWeekend, stopCoords);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(blueWeekend.length);
  });

  it("is unmoved by GPS jitter perpendicular to the segment", () => {
    const base = { ...at(STOP.phelpsGate), last_stop_id: 42 };
    const anchor = findRouteAnchor(base, blueWeekend, stopCoords);
    for (const m of [-30, -10, 10, 30]) {
      expect(findRouteAnchor({ ...nudgeNorth(base, m), last_stop_id: 42 }, blueWeekend, stopCoords))
        .toBe(anchor);
    }
  });
});

describe("isBusOnRoute", () => {
  it("accepts a bus sitting on the route", () => {
    expect(isBusOnRoute(at(STOP.elmYorkTyco), blueWeekend, stopCoords)).toBe(true);
  });

  it("rejects a depot ghost far from every stop", () => {
    // ~2 km north, the Hamden-yard case that produced phantom arrivals.
    const parked = nudgeNorth(at(STOP.elmYorkTyco), 2_000);
    expect(isBusOnRoute(parked, blueWeekend, stopCoords)).toBe(false);
  });

  it("tolerates drift up to the threshold", () => {
    const near = nudgeNorth(at(STOP.elmYorkTyco), OFF_ROUTE_THRESHOLD_M - 50);
    const far = nudgeNorth(at(STOP.elmYorkTyco), OFF_ROUTE_THRESHOLD_M + 50);
    expect(isBusOnRoute(near, blueWeekend, stopCoords)).toBe(true);
    expect(isBusOnRoute(far, blueWeekend, stopCoords)).toBe(false);
  });

  it("does not filter a bus with no GPS", () => {
    expect(isBusOnRoute({ lat: 0, lon: 0 }, blueWeekend, stopCoords)).toBe(true);
  });
});

describe("isBusOnRoute measures against the road polyline when one is registered", () => {
  // Purple's Building 900 → LEPH leg is 6.7 km with no stop in between: a
  // bus honestly on the highway sits > 500 m from every stop for half its
  // lap. Model that with a two-stop route and a path that detours 3 km out.
  const a = at(STOP.elmYorkTyco);
  const far = { lat: a.lat + 0.03, lon: a.lon + 0.03 }; // ~4.4 km away
  const apex = { lat: a.lat + 0.03, lon: a.lon };       // 3.3 km north of `a`
  const coords = { 1: a, 2: far };
  const stops = [1, 2];
  const path: [number, number][] = [[a.lat, a.lon], [apex.lat, apex.lon], [far.lat, far.lon]];
  const onHighway = { lat: a.lat + 0.015, lon: a.lon, route_id: 10 }; // halfway up the first leg

  afterEach(() => registerRoutePaths(null));

  it("keeps a bus on a long stopless leg that the stop test would drop", () => {
    expect(isBusOnRoute(onHighway, stops, coords)).toBe(false); // the old behaviour
    registerRoutePaths({ "10": path });
    expect(isBusOnRoute(onHighway, stops, coords)).toBe(true);
  });

  it("still rejects a depot ghost far from the polyline", () => {
    registerRoutePaths({ "10": path });
    const ghost = { lat: a.lat + 0.015, lon: a.lon - 0.03, route_id: 10 }; // 2.5 km west of the leg
    expect(isBusOnRoute(ghost, stops, coords)).toBe(false);
  });

  it("falls back to the stop test for a route with no registered path", () => {
    registerRoutePaths({ "10": path });
    expect(isBusOnRoute({ ...onHighway, route_id: 3 }, stops, coords)).toBe(false);
    expect(isBusOnRoute({ ...a, route_id: 3 }, stops, coords)).toBe(true);
  });
});

describe("findRouteAnchor: two fresh fixes decide which branch of a fold", () => {
  // The out-and-back in miniature. Four stops on one road, run out and back:
  // the middle pair's coordinates belong to TWO legs, one in each direction,
  // which is Green and Purple's whole problem in six stops.
  //
  //   idx  0    1    2    3    4    5
  //   stop 1 -> 2 -> 3 -> 4 -> 3 -> 2 -> (1)
  //        outbound-----  ----inbound
  const M = 1 / 111_000; // one metre of latitude
  const E = 1 / (111_000 * Math.cos((41.3 * Math.PI) / 180)); // one metre of longitude
  const coords: Record<number, { lat: number; lon: number }> = {
    1: { lat: 41.300, lon: -72.930 },
    2: { lat: 41.305, lon: -72.930 },
    3: { lat: 41.310, lon: -72.930 },
    4: { lat: 41.315, lon: -72.930 },
  };
  const stops = [1, 2, 3, 4, 3, 2];
  const OUTBOUND = 1; // leg 2 -> 3
  const INBOUND = 4;  // leg 3 -> 2
  // Between stops 2 and 3, 20 m off the road — on both legs at once.
  const here = { lat: 41.3075, lon: -72.930 + 20 * E };
  const northOf = (m: number) => ({ lat: here.lat + m * M, lon: here.lon });

  it("the fixture really is ambiguous: both legs are within threshold and equidistant", () => {
    const dOut = distanceToSegmentM(here, coords[2]!, coords[3]!);
    const dIn = distanceToSegmentM(here, coords[3]!, coords[2]!);
    expect(dOut).toBeLessThan(ANCHOR_GPS_THRESHOLD_M);
    expect(Math.abs(dOut - dIn)).toBeLessThan(1);
  });

  it("without a previous fix it cannot tell, and behaves exactly as before", () => {
    expect(findRouteAnchor({ ...here }, stops, coords)).toBe(OUTBOUND);
    expect(findRouteAnchor({ ...here }, stops, coords, null)).toBe(OUTBOUND);
    expect(findRouteAnchor({ ...here }, stops, coords, undefined)).toBe(OUTBOUND);
  });

  it("a bus travelling south is on the inbound leg", () => {
    expect(findRouteAnchor({ ...here }, stops, coords, northOf(60))).toBe(INBOUND);
  });

  it("a bus travelling north is on the outbound leg", () => {
    expect(findRouteAnchor({ ...here }, stops, coords, northOf(-60))).toBe(OUTBOUND);
  });

  it("direction beats a last_stop_id that has gone stale, which is the I-95 case", () => {
    // Green #326 ran 5 km down I-95 with last_stop_id frozen at the stop it
    // left, 135 m from the outbound chord and 139 m from the inbound one.
    // Forward distance from the stale stop names the outbound leg; the bus is
    // plainly driving the other way.
    const bus = { ...here, last_stop_id: 1 };
    expect(findRouteAnchor(bus, stops, coords)).toBe(OUTBOUND);
    expect(findRouteAnchor(bus, stops, coords, northOf(60))).toBe(INBOUND);
  });

  it("a step smaller than the feed's deadband is not a direction", () => {
    // The feed publishes a new coordinate only past ~30 m; anything under it
    // is noise and must not move the bus to the other side of the loop.
    expect(findRouteAnchor({ ...here }, stops, coords, northOf(20))).toBe(OUTBOUND);
  });

  it("never leaves the bus with no candidate when the step contradicts every leg", () => {
    // Broadside — a shuffle in a car park, or a fix on a road the chord does
    // not model. Nothing is excluded; the old answer stands.
    const east = { lat: here.lat, lon: here.lon - 80 * E };
    expect(findRouteAnchor({ ...here }, stops, coords, east)).toBe(OUTBOUND);
  });
});

describe("findRouteAnchor: direction changes nothing on a plain loop", () => {
  // A loop with no fold has no opposed pair to separate: consecutive legs
  // share a stop and point roughly the same way, so nothing is ever excluded
  // and the answer is the stateless one. Walk both fixture routes stop by
  // stop, each with the previous fix 60 m back along the leg it arrived on —
  // the step a bus actually takes between two polls — and assert it.
  it("gives the same anchor at every stop of Blue Day and Blue Weekend", () => {
    for (const stops of [blueDay, blueWeekend]) {
      const N = stops.length;
      for (let i = 0; i < N; i++) {
        const bus = at(stops[i]!);
        const from = at(stops[(i - 1 + N) % N]!);
        const d = haversineMeters(from, bus);
        if (d < 60) continue;
        const f = 60 / d;
        const prev = { lat: bus.lat + (from.lat - bus.lat) * f, lon: bus.lon + (from.lon - bus.lon) * f };
        expect(findRouteAnchor({ ...bus }, stops, stopCoords, prev))
          .toBe(findRouteAnchor({ ...bus }, stops, stopCoords));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The two recorded incidents. Everything below runs on production feed rows
// and the operator's own published geometry — `__fixtures__/anchor-incidents.json`,
// written by `scripts/eta-replay/make-incident-fixture.ts` — so a regression
// fails here with the real coordinates rather than a contrived pair of stops.
// ---------------------------------------------------------------------------

const INC = incidents as unknown as {
  routes: Record<string, { label: string; stops: number[]; path: [number, number][] }>;
  stopCoords: Record<string, { lat: number; lon: number }>;
  stopNames: Record<string, string>;
  incidents: Record<string, {
    route_id: number; bus_name: string;
    polls: Array<{ et: string; collected_at: number; lat: number; lon: number; last_stop_id: number }>;
  }>;
};
const incCoords: Record<number, { lat: number; lon: number }> = {};
for (const [k, v] of Object.entries(INC.stopCoords)) incCoords[Number(k)] = v;
const incPaths: Record<string, [number, number][]> = {};
for (const [k, v] of Object.entries(INC.routes)) incPaths[k] = v.path;
const pollAt = (id: string, et: string) => {
  const p = INC.incidents[id]!.polls.find((x) => x.et === et);
  if (!p) throw new Error(`no poll ${et} in ${id}`);
  return p;
};

describe("a leg is the road between two stops, not the chord (Blue West #126)", () => {
  // Blue West bus #126, 2026-09-03 21:37 ET (PR #122's handover trace names
  // these polls in UTC). Canal / Munson -> Mansfield / Division
  // (leg 7) is a 573 m hop whose road bows more than 200 m off its own chord;
  // leg 8 is the return down the same road. Measuring to the chord loses the
  // leg the bus is driving for three consecutive polls, leaving the return as
  // the ONLY candidate — so the fold's direction filter had nothing to compare
  // and the gate took the hop. The bus was at the kerb 33 s later.
  const bw = INC.routes["16"]!;
  const stops = bw.stops;
  const LEG_OUT = 7;   // Canal / Munson -> Mansfield / Division
  const LEG_BACK = 8;  // Mansfield / Division -> Pauli Murray
  const seq = ["21:37:40", "21:37:45", "21:37:50", "21:37:55", "21:38:00", "21:38:05", "21:38:10"];
  const busAt = (et: string) => {
    const p = pollAt("blueWest126", et);
    return { lat: p.lat, lon: p.lon, last_stop_id: p.last_stop_id, route_id: 16 };
  };
  const chordTo = (et: string, leg: number) => {
    const p = pollAt("blueWest126", et);
    return distanceToSegmentM(p, incCoords[stops[leg]!]!, incCoords[stops[(leg + 1) % stops.length]!]!);
  };

  afterEach(() => registerRoutePaths(null));

  it("names the legs the incident is about", () => {
    expect(INC.stopNames[String(stops[LEG_OUT])]).toBe("Canal / Munson");
    expect(INC.stopNames[String(stops[LEG_BACK])]).toBe("Mansfield / Division");
  });

  it("the chord puts the bus off its own leg — the defect, pinned", () => {
    // The three polls PR #122 names: leg 7's chord runs 121 / 186 / 211 m
    // while leg 8's closes to 230 / 143 / 109 m.
    expect(chordTo("21:37:40", LEG_OUT)).toBeGreaterThan(100);
    for (const et of ["21:37:45", "21:37:50"]) {
      expect(chordTo(et, LEG_OUT)).toBeGreaterThan(ANCHOR_GPS_THRESHOLD_M);
      expect(chordTo(et, LEG_BACK)).toBeLessThan(ANCHOR_GPS_THRESHOLD_M);
    }
    // With no path registered — the pre-fix behaviour — the anchor crosses to
    // the return leg while the bus is driving the outbound one.
    const crossed = seq.map((et) => findRouteAnchor(busAt(et), stops, incCoords));
    expect(crossed).toContain(LEG_BACK);
  });

  it("the published line keeps the bus on the leg it is driving", () => {
    registerRoutePaths(incPaths);
    for (const et of seq) {
      expect(findRouteAnchor(busAt(et), stops, incCoords), et).toBe(LEG_OUT);
    }
  });

  it("degrades to the chord for a route with no registered path", () => {
    registerRoutePaths({ "3": incPaths["3"]! });
    const withOtherPath = findRouteAnchor(busAt("21:37:45"), stops, incCoords);
    registerRoutePaths(null);
    expect(withOtherPath).toBe(findRouteAnchor(busAt("21:37:45"), stops, incCoords));
  });
});

describe("last_stop_id excludes, it does not rank (report #95)", () => {
  // Red #316, 2026-09-04. Upstream froze `last_stop_id` at Whitney / Audubon
  // (index 9) from 11:34:56 to 11:41:57 — seven minutes, five stops — and the
  // old sort, which ordered candidates by forward distance from that value and
  // used GPS only as a tiebreak, therefore always took the EARLIEST candidate
  // in range however far away it was. One stop of lag on Red is worth five
  // minutes, because the hop that vanishes carries 344 Winchester's layover.
  const red = INC.routes["3"]!;
  const stops = red.stops;
  const idxOf = (name: string) => stops.findIndex((s) => INC.stopNames[String(s)] === name);
  const busAt = (et: string) => {
    const p = pollAt("red316", et);
    return { lat: p.lat, lon: p.lon, last_stop_id: p.last_stop_id, route_id: 3 };
  };
  const legDists = (et: string) => {
    const p = pollAt("red316", et);
    return stops.map((_, i) =>
      distanceToSegmentM(p, incCoords[stops[i]!]!, incCoords[stops[(i + 1) % stops.length]!]!));
  };

  afterEach(() => registerRoutePaths(null));

  it("the feed really was frozen five stops back", () => {
    const frozen = INC.incidents["red316"]!.polls.filter((p) => p.et <= "11:41:57");
    expect(frozen.every((p) => p.last_stop_id === 128)).toBe(true);
    expect(idxOf("Whitney / Audubon")).toBe(9);
    expect(idxOf("Canal / Munson")).toBe(13);
    expect(idxOf("344 Winchester")).toBe(14);
  });

  it("11:38:26 — the nearer leg wins, not the earlier one", () => {
    // 130 Prospect (N) -> Winchester / Sachem is 32 m away at forward 2;
    // Trumbull / Hillhouse -> 130 Prospect (N) is 145 m away at forward 1.
    const d = legDists("11:38:26");
    const near = idxOf("130 Prospect Street (N)");
    const far = idxOf("Trumbull / Hillhouse");
    expect(d[near]!).toBeLessThan(40);
    expect(d[far]!).toBeGreaterThan(140);
    expect(findRouteAnchor(busAt("11:38:26"), stops, incCoords)).toBe(near);
  });

  it("11:41:27 — the bus has left Canal / Munson and the anchor follows", () => {
    // `stop_visits` has #316 standing at Canal / Munson 11:40:02–11:41:17, so
    // by 11:41:27 it is on the leg OUT of it: 46 m from Canal / Munson ->
    // 344 Winchester (forward 4), 136 m from the leg into it (forward 3).
    const d = legDists("11:41:27");
    const near = idxOf("Canal / Munson");
    const far = idxOf("Winchester / Sachem");
    expect(d[near]!).toBeLessThan(60);
    expect(d[far]!).toBeGreaterThan(130);
    expect(findRouteAnchor(busAt("11:41:27"), stops, incCoords)).toBe(near);
  });

  it("the window still refuses the fold at 130 Prospect", () => {
    // 11:36:46: the bus is 128 m from SCL -> 130 Prospect (S) — nearer than
    // anything else in range — but that leg is ten stops ahead of the frozen
    // `last_stop_id`, on the far side of Red's fold. Choosing it would skip
    // the whole Winchester loop, layover included. Forward distance is what
    // rules it out, and it must keep doing so.
    const d = legDists("11:36:46");
    const scl = idxOf("SCL");
    expect(d[scl]!).toBeLessThan(ANCHOR_GPS_THRESHOLD_M);
    const chosen = findRouteAnchor(busAt("11:36:46"), stops, incCoords);
    expect(d[scl]!).toBeLessThan(d[chosen]!);      // it really was the nearest
    expect(chosen).not.toBe(scl);
    expect((scl - 9 + stops.length) % stops.length).toBeGreaterThan(ANCHOR_FEED_LEAD_HOPS);
  });

  it("a candidate behind last_stop_id is still excluded", () => {
    // Forward distance is measured on the ring, so "one stop back" reads as
    // N-1 hops forward and never survives the window.
    const N = stops.length;
    expect((-1 + N) % N).toBeGreaterThan(ANCHOR_FEED_LEAD_HOPS);
  });

  it("the reporter's own moment: Blue Day #38 at 11:20:59", () => {
    // "Seems a stop behind? Not critical better than being past it" — and it
    // was. `predictions_log` for 11:21:00 has #38 anchored at Whitney /
    // Cottage (S), while the bus had passed Whitney / Edwards (S) 132 m back
    // and was 79 m short of Whitney / Humphrey (S). The feed's `last_stop_id`
    // still said Cottage, so the sort took forward 0 and the rider was
    // promised 297 s to College / Wall (S) for a bus that took 224 s.
    const bd = INC.routes["1"]!.stops;
    const nameOf = (i: number) => INC.stopNames[String(bd[i]!)];
    const p = pollAt("blueDay38", "11:20:59");
    const idx = findRouteAnchor(
      { lat: p.lat, lon: p.lon, last_stop_id: p.last_stop_id, route_id: 1 }, bd, incCoords,
    );
    expect(nameOf(bd.indexOf(p.last_stop_id))).toBe("Whitney / Cottage (S)");
    expect(nameOf(idx)).toBe("Whitney / Edwards (S)");
  });

  it("the gated anchor walks the incident forward, one leg at a time", () => {
    // Poll by poll on the real geometry, through the production sequence —
    // `noteFix` -> `findRouteAnchor` -> `gateAnchor` — which is the only
    // sequence a rider ever sees. Over seven minutes of a frozen feed the
    // anchor advances and never retreats, and never skips a stop.
    registerRoutePaths(incPaths);
    const store: AnchorStore = new Map();
    const N = stops.length;
    let prev = -1;
    const visited: string[] = [];
    for (const p of INC.incidents["red316"]!.polls) {
      const idx = resolveAnchorIndex(
        { lat: p.lat, lon: p.lon, last_stop_id: p.last_stop_id, route_id: 3 },
        stops, incCoords, "Red|#316", p.collected_at, store,
      );
      if (prev >= 0) {
        const forward = (idx - prev + N) % N;
        expect(
          forward,
          `${p.et}: ${INC.stopNames[String(stops[prev]!)]} -> ${INC.stopNames[String(stops[idx]!)]}`,
        ).toBeLessThanOrEqual(1);
      }
      if (idx !== prev) visited.push(INC.stopNames[String(stops[idx]!)]!);
      prev = idx;
    }
    // and it walked the whole Winchester loop rather than stalling behind it.
    // Master ends this trace at Canal / Munson, two stops short, with the
    // 344 Winchester layover still in front of every rider downstream.
    expect(visited).toContain("Canal / Munson");
    expect(visited).toContain("344 Winchester");
    expect(stops.indexOf(3 /* 130 Prospect (N) */)).toBeLessThan(prev);
    // Master's gate ends this trace at Winchester / Division. The ring
    // estimator (web/src/eta/, which answers for Red here) is a leg further on
    // at 11:46:58 — the bus is 221 m past 344 Winchester and the hop to
    // Winchester / Division is 112 m — so the bound is "at or past it".
    expect(prev).toBeGreaterThanOrEqual(stops.indexOf(146 /* Winchester / Division */));
  });
});
