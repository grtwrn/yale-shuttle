import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BERTH_MAP_CONSTANTS, BERTH_MAP_VIEW, buildBerthGeometry, labelSides, __projection } from "./berthMap";
import { BERTHS } from "./berths";
import payload from "./__fixtures__/buses-payload.json";

/**
 * The real payload, so the roads under these maps are the routes' own published
 * polylines rather than a synthetic line: everything this module decides — which
 * stretch of road is drawn, which way buses drive along it, where the arrowhead
 * goes — is a fact about those polylines, and a straight test line cannot fail
 * on any of it. (Church / George's arrowhead landed on the far side of the Blue
 * Night loop once, which no synthetic road has.)
 */
const P = payload as unknown as {
  stop_coords: Record<string, { lat: number; lon: number }>;
  route_paths: Record<string, [number, number][]>;
};

const { world, unworld, metresPerPx, Z } = __projection;
/** Metres between two coordinates, in the same frame the module works in. */
const metresBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const A = world(a, Z), B = world(b, Z);
  return Math.hypot(B.x - A.x, B.y - A.y) * metresPerPx((a.lat + b.lat) / 2, Z);
};

const cells = BERTHS.map((b) => ({
  b,
  id: `${b.stopId}/${b.routeId}`,
  published: P.stop_coords[String(b.stopId)],
  road: (P.route_paths[String(b.routeId)] ?? []).map(([lat, lon]) => ({ lat, lon })),
}));
const geom = (c: (typeof cells)[number]) =>
  buildBerthGeometry(c.published, { lat: c.b.lat, lon: c.b.lon }, c.road);

describe("the berth map's geometry", () => {
  it("covers every cell we ship with a coordinate and a road", () => {
    expect(cells.length).toBe(10);
    for (const c of cells) {
      expect(c.published, c.id).toBeTruthy();
      expect(c.road.length, c.id).toBeGreaterThan(2);
    }
  });

  it("round-trips its own projection — every answer is a coordinate Leaflet takes", () => {
    // The module works in Web Mercator world pixels and hands back lat/lon, so
    // a broken inverse would put the road and the arrowhead near, but not on,
    // the street the rider is looking at. Sub-centimetre is the bar at z22.
    for (const c of cells) {
      for (const p of [c.published, { lat: c.b.lat, lon: c.b.lon }]) {
        const back = unworld(world(p, Z), Z);
        expect(metresBetween(p, back), c.id).toBeLessThan(0.01);
      }
    }
  });

  it("finds the route's own road through both markers, in every cell", () => {
    for (const c of cells) {
      const g = geom(c);
      expect(g.onRoad, c.id).toBe(true);
      expect(g.road.length, c.id).toBeGreaterThan(1);
      expect(g.arrow, c.id).not.toBeNull();
    }
  });

  it("puts both markers ON the drawn stretch, not near it", () => {
    // The whole point of clipping the polyline rather than drawing a chord: the
    // line the rider follows has to pass through the two dots. `ROAD_NEAR_M` is
    // the admission test; this is what it buys.
    for (const c of cells) {
      const g = geom(c);
      // A published polyline carries a vertex only where the road turns, so a
      // nearest-VERTEX test says nothing: it is the SEGMENTS that must pass
      // through the dots, and both ends of the window are interpolated.
      for (const [name, p] of [["published", c.published], ["berth", { lat: c.b.lat, lon: c.b.lon }]] as const) {
        expect(segmentDistM(g.road, p), `${c.id} ${name}`).toBeLessThan(BERTH_MAP_CONSTANTS.ROAD_NEAR_M);
      }
    }
  });

  it("runs the road PAST both markers, and stops short of the loop coming back", () => {
    // Clipped exactly published-to-berth, the line stopped dead at two dots in
    // the middle of a street — and where the published coordinate is off the
    // kerb it stopped short of the very dot it was there to explain. The window
    // is bounded on the other side too: an out-and-back route puts its return
    // leg on the same street, and drawing both makes the one the bus is on
    // unreadable.
    const W = BERTH_MAP_CONSTANTS.ROAD_WINDOW_M;
    for (const c of cells) {
      const g = geom(c);
      const total = pathLengthM(g.road);
      expect(total, c.id).toBeGreaterThan(g.alongM);
      expect(total, c.id).toBeLessThanOrEqual(g.alongM + 2 * W + 1);
    }
  });

  it("points the arrowhead the way the published polyline runs", () => {
    // Two claims, and they need different tolerances.
    //
    // The tight one is that the bearing is the road's own tangent at the point
    // the arrow sits, read in the right frame: a bearing computed with the wrong
    // sign or in a y-grows-north frame is 90 or 180 degrees out, so 5 degrees
    // against the same +/-4 m window measured off the RETURNED road catches it.
    //
    // The loose one is the claim the picture actually makes — "past" is the way
    // the arrow points. That is about the direction of TRAVEL, and where the
    // arrow lands on a corner (Canal / Munson, where Red turns) the tangent and
    // the next 30 m legitimately differ: the arrow bearing is 59.9 there and
    // the segment it is nearest reads 88.2. Both are the same turn. So this is
    // a 90-degree test, which is what "forward, not backward" means.
    for (const c of cells) {
      const g = geom(c);
      const a = g.arrow!;
      const tangent = bearingAlong(g.road, a, 4);
      expect(offBy(a.bearingDeg, tangent), `${c.id} tangent`).toBeLessThan(5);
      const forward = bearingAhead(g.road, a, 30);
      expect(offBy(a.bearingDeg, forward), `${c.id} forward`).toBeLessThan(90);
    }
  });

  it("keeps the arrowhead clear of both dots", () => {
    for (const c of cells) {
      const g = geom(c);
      const a = g.arrow!;
      const d = Math.min(metresBetween(a, c.published), metresBetween(a, { lat: c.b.lat, lon: c.b.lon }));
      expect(d, c.id).toBeGreaterThan(4);
    }
  });

  it("ties the published dot to the road only where it is genuinely off it", () => {
    // 300 George St's published coordinate is 36.7 m off its own road and needs
    // the tie-line or it reads as the map being broken; Wall / York's is 0.9 m
    // off and a dashed stub there would be noise.
    const byId = new Map(cells.map((c) => [c.id, geom(c)]));
    expect(byId.get("9/13")!.publishedLink, "300 George St").not.toBeNull();
    expect(byId.get("67/13")!.publishedLink, "Wall / York").toBeNull();
    for (const c of cells) {
      const g = byId.get(c.id)!;
      const off = segmentDistM(g.road, c.published);
      expect(g.publishedLink !== null, `${c.id} off by ${off.toFixed(1)} m`)
        .toBe(off > BERTH_MAP_CONSTANTS.LINK_MIN_M);
      if (g.publishedLink) {
        // It must start at the dot and end on the line, or it ties nothing.
        expect(metresBetween(g.publishedLink[0], c.published), c.id).toBeLessThan(0.05);
        expect(segmentDistM(g.road, g.publishedLink[1]), c.id).toBeLessThan(1);
      }
    }
  });

  it("degrades to markers alone when the route's path is not in the payload", () => {
    // A route whose polyline has not been registered yet still has to show the
    // two dots over a basemap — that is most of the answer — rather than throw.
    const c = cells[0];
    const g = buildBerthGeometry(c.published, { lat: c.b.lat, lon: c.b.lon }, []);
    expect(g.onRoad).toBe(false);
    expect(g.road).toEqual([]);
    expect(g.arrow).toBeNull();
    expect(g.publishedLink).toBeNull();
    expect(g.alongM).toBeCloseTo(metresBetween(c.published, { lat: c.b.lat, lon: c.b.lon }), 1);
  });

  it("declines a polyline that is not the road through these markers", () => {
    // `ROAD_NEAR_M` is the admission test, and it has to be able to say no: a
    // stop genuinely off its own line would otherwise get a stretch of some
    // other street drawn through it.
    const c = cells[0];
    const far = c.road.map((p) => ({ lat: p.lat + 0.01, lon: p.lon }));
    expect(buildBerthGeometry(c.published, { lat: c.b.lat, lon: c.b.lon }, far).onRoad).toBe(false);
  });

  it("opens at the scale the static inset drew every cell at", () => {
    // 0.45 m/px was one scale for all ten cells, and it is tile zoom 18 at this
    // latitude. Capping `fitBounds` there is what keeps the opening view the
    // detail the operator has been reading — a bare fitBounds on two markers
    // 38 m apart would open at z19 and look like a different picture per cell.
    expect(BERTH_MAP_VIEW.maxZoom).toBe(18);
    expect(metresPerPx(41.31, BERTH_MAP_VIEW.maxZoom)).toBeCloseTo(0.45, 2);
    expect(BERTH_MAP_VIEW.paddingPx).toBeGreaterThanOrEqual(24);
  });

  it("opens the two labels away from each other, however close the dots are", () => {
    // Leaflet tooltips cannot be re-placed per zoom the way the SVG clamped its
    // <text>, so the sides are decided once — the northernmost dot takes the
    // upper side. Building 900's two dots are 27 px apart vertically at z18 and
    // both used to pick the side facing the other.
    for (const c of cells) {
      const s = labelSides(c.published, { lat: c.b.lat, lon: c.b.lon });
      expect(s.published, c.id).not.toBe(s.berth);
    }
    expect(labelSides({ lat: 41.5, lon: -72.9 }, { lat: 41.4, lon: -72.9 }))
      .toEqual({ published: "top", berth: "bottom" });
    expect(labelSides({ lat: 41.4, lon: -72.9 }, { lat: 41.5, lon: -72.9 }))
      .toEqual({ published: "bottom", berth: "top" });
  });
});

// ── helpers, in the module's own frame so a comparison is apples to apples ───

type LL = { lat: number; lon: number };

function pathLengthM(p: readonly LL[]): number {
  let t = 0;
  for (let i = 1; i < p.length; i++) t += metresBetween(p[i - 1], p[i]);
  return t;
}

/** Distance from a point to the nearest SEGMENT of a polyline, in metres. */
function segmentDistM(p: readonly LL[], q: LL): number {
  if (p.length < 2) return Infinity;
  const lat0 = q.lat;
  const mpp = metresPerPx(lat0, Z);
  const Q = world(q, Z);
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const u = world(p[i - 1], Z), v = world(p[i], Z);
    const vx = v.x - u.x, vy = v.y - u.y, L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((Q.x - u.x) * vx + (Q.y - u.y) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(Q.x - (u.x + t * vx), Q.y - (u.y + t * vy)));
  }
  return best * mpp;
}

function bearingBetween(a: LL, b: LL): number {
  const A = world(a, Z), B = world(b, Z);
  return ((Math.atan2(B.x - A.x, -(B.y - A.y)) * 180) / Math.PI + 360) % 360;
}

/** Angular difference between two compass bearings, 0..180. */
const offBy = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Cumulative metres to each vertex of a lat/lon polyline. */
function cum(p: readonly LL[]): number[] {
  const out = [0];
  for (let i = 1; i < p.length; i++) out.push(out[i - 1] + metresBetween(p[i - 1], p[i]));
  return out;
}
/** The point `s` metres along a lat/lon polyline. */
function walk(p: readonly LL[], s: number): LL {
  const L = cum(p);
  const total = L[L.length - 1];
  const t = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < L.length - 1 && L[i] < t) i++;
  const span = L[i] - L[i - 1] || 1;
  const f = (t - L[i - 1]) / span;
  return { lat: p[i - 1].lat + f * (p[i].lat - p[i - 1].lat), lon: p[i - 1].lon + f * (p[i].lon - p[i - 1].lon) };
}
/** How far along a polyline a point's foot lies, in metres. */
function alongM(p: readonly LL[], q: LL): number {
  const L = cum(p);
  let best = 0, bd = Infinity;
  for (let i = 1; i < p.length; i++) {
    const d = segmentDistM([p[i - 1], p[i]], q);
    if (d < bd) {
      bd = d;
      const seg = metresBetween(p[i - 1], p[i]) || 1;
      const f = Math.max(0, Math.min(1, metresBetween(p[i - 1], q) / seg));
      best = L[i - 1] + f * seg;
    }
  }
  return best;
}
/** The polyline's own bearing over a window of +/- `w` metres about a point. */
const bearingAlong = (p: readonly LL[], q: LL, w: number) => {
  const u = alongM(p, q);
  return bearingBetween(walk(p, u - w), walk(p, u + w));
};
/** The bearing from a point to the road `d` metres further along it. */
const bearingAhead = (p: readonly LL[], q: LL, d: number) => {
  const u = alongM(p, q);
  return bearingBetween(q, walk(p, u + d));
};

// ─────────────────────────────────────────────────────────────────────────────
// The scroll trap, pinned at the SOURCE.
//
// This repo has no jsdom or testing-library setup (see ContributeButton.test.tsx),
// and a Leaflet map needs a real layout anyway, so the component cannot be
// mounted here. What CAN be pinned is the decision, the way `mapFilter.test.ts`
// and `walk.test.ts` pin theirs: read the file and assert the map is built inert.
//
// It is worth pinning because the failure is silent and phone-only. A Leaflet
// map with `dragging` enabled takes the `leaflet-touch-drag` class, whose CSS
// sets `touch-action: none`, and a rider dragging the page upward over the inset
// then pans the map instead — the page stops dead in the middle of a card. On a
// desktop mouse, everything looks fine.
describe("the berth map mounts inert, so the card still scrolls", () => {
  const src = readFileSync(new URL("./BerthInset.tsx", import.meta.url), "utf8");
  const mapCall = src.slice(src.indexOf("L.map("), src.indexOf("mapRef.current = map;"));

  it("disables every gesture handler that would steal a touch", () => {
    for (const opt of ["dragging", "touchZoom", "doubleClickZoom", "boxZoom"]) {
      expect(mapCall, opt).toMatch(new RegExp(`${opt}:\\s*false`));
    }
  });

  it("never enables scroll-wheel zoom, in either state", () => {
    expect(mapCall).toMatch(/scrollWheelZoom:\s*false/);
    // The armed effect may turn on drag and pinch; the wheel is not a gesture a
    // page should lose, so it is absent from that list on purpose.
    const armEffect = src.slice(src.indexOf("const armed ="), src.indexOf("}, [armed]);"));
    expect(armEffect).toContain("map.dragging");
    expect(armEffect).toContain("map.touchZoom");
    expect(armEffect).not.toContain("scrollWheelZoom");
    expect(armEffect).toMatch(/h\.enable\(\)/);
    expect(armEffect).toMatch(/h\.disable\(\)/);
  });

  it("grows Leaflet's 30 px zoom buttons to this app's 44 px touch target", () => {
    // The buttons are the way to zoom while the map is inert, so they are the
    // one control that must work in both states — and every touch target in
    // this app is 44 px.
    expect(src).toMatch(/\.leaflet-control-zoom a \{\s*width: 44px; height: 44px;/);
  });

  it("reaches fullscreen through the app's own close path, not a new one", () => {
    // Same wrapper-plus-`map-fs` class the trip map uses, same Back at top-left
    // beside ✕ at top-right, same Escape (operator, 2026-09-02).
    expect(src).toContain("map-fs");
    expect(src).toMatch(/aria-label="Back"/);
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toContain('aria-label={fullscreen ? "Exit fullscreen" : "Full map"}');
  });

  it("keeps the operator's wording, and both map labels, verbatim", () => {
    // "published stop" / "expected stop", never "stop sign" — some stops have no
    // sign at all (operator, 2026-09-10). Both labels are Leaflet tooltips now,
    // so they land in `innerText` and the canary's NOT_A_ROUTE guard still has
    // to hold them (scripts/canary-metrics.test.mjs).
    expect(src).toContain('bindTooltip("published stop"');
    expect(src).toContain('bindTooltip("expected stop"');
    expect(src).toContain("Wait about {m} m {past ? \"past\" : \"before\"} the published stop");
    // The retired word may appear in the header comment, which is the RECORD of
    // why it is retired ("lets not call it 'stop sign' because sometimes there's
    // not even a sign"). What must not carry it is any line of code.
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toMatch(/stop sign/i);
  });
});
