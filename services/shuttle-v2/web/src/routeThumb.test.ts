import { describe, expect, it } from "vitest";

import { buildRouteThumb, THUMB_HEIGHT, THUMB_PADDING, THUMB_WIDTH } from "./routeThumb";

// A small square-ish loop at New Haven's latitude, in [lat, lon] pairs.
const LOOP: [number, number][] = [
  [41.310, -72.930],
  [41.310, -72.920],
  [41.300, -72.920],
  [41.300, -72.930],
  [41.310, -72.930],
];

/** Every "x y" pair out of a path `d`. */
function points(d: string): { x: number; y: number }[] {
  return d.split(/(?:^M| L)/).filter(Boolean).map((seg) => {
    const [x, y] = seg.trim().split(/\s+/).map(Number);
    return { x, y };
  });
}

describe("buildRouteThumb — nothing to draw", () => {
  it("returns null for a missing polyline", () => {
    expect(buildRouteThumb(null)).toBeNull();
    expect(buildRouteThumb(undefined)).toBeNull();
  });

  it("returns null for an empty polyline", () => {
    expect(buildRouteThumb([])).toBeNull();
  });

  it("returns null for a single-point polyline", () => {
    expect(buildRouteThumb([[41.31, -72.93]])).toBeNull();
  });

  it("returns null when the points aren't finite numbers", () => {
    expect(buildRouteThumb([[NaN, -72.93], [41.31, Infinity]])).toBeNull();
  });

  it("returns null when only one point survives the finite filter", () => {
    expect(buildRouteThumb([[41.31, -72.93], [NaN, NaN]])).toBeNull();
  });
});

describe("buildRouteThumb — the box", () => {
  it("reports the default viewBox", () => {
    const t = buildRouteThumb(LOOP)!;
    expect(t.width).toBe(THUMB_WIDTH);
    expect(t.height).toBe(THUMB_HEIGHT);
    expect(t.viewBox).toBe(`0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}`);
  });

  it("honours a caller-supplied size and padding", () => {
    const t = buildRouteThumb(LOOP, [], [], { width: 100, height: 50, padding: 5 })!;
    expect(t.viewBox).toBe("0 0 100 50");
    for (const p of points(t.path)) {
      expect(p.x).toBeGreaterThanOrEqual(5);
      expect(p.x).toBeLessThanOrEqual(95);
      expect(p.y).toBeGreaterThanOrEqual(5);
      expect(p.y).toBeLessThanOrEqual(45);
    }
  });

  it("starts the path with M and keeps every vertex inside the padded box", () => {
    const t = buildRouteThumb(LOOP)!;
    expect(t.path.startsWith("M")).toBe(true);
    const pts = points(t.path);
    expect(pts.length).toBe(LOOP.length);
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(THUMB_PADDING);
      expect(p.x).toBeLessThanOrEqual(THUMB_WIDTH - THUMB_PADDING);
      expect(p.y).toBeGreaterThanOrEqual(THUMB_PADDING);
      expect(p.y).toBeLessThanOrEqual(THUMB_HEIGHT - THUMB_PADDING);
    }
  });

  it("fits the polyline to the box: the binding axis touches both padded edges", () => {
    // The default box is wider than it is tall (320×168) and this loop is
    // taller than it is wide on the ground, so height binds: the drawing
    // fills the padded height exactly and is centred in what is left.
    const t = buildRouteThumb(LOOP)!;
    const pts = points(t.path);
    const ys = pts.map((p) => p.y), xs = pts.map((p) => p.x);
    expect(Math.min(...ys)).toBeCloseTo(THUMB_PADDING, 1);
    expect(Math.max(...ys)).toBeCloseTo(THUMB_HEIGHT - THUMB_PADDING, 1);
    // Centred: the slack on the left equals the slack on the right.
    expect(Math.min(...xs) - THUMB_PADDING)
      .toBeCloseTo(THUMB_WIDTH - THUMB_PADDING - Math.max(...xs), 1);
  });

  it("drops duplicate vertices that round onto the same point", () => {
    const dup: [number, number][] = [
      [41.310, -72.930],
      [41.310, -72.9300001],
      [41.300, -72.920],
    ];
    expect(points(buildRouteThumb(dup)!.path).length).toBe(2);
  });

  it("puts north at the top", () => {
    const t = buildRouteThumb([[41.30, -72.93], [41.31, -72.93], [41.30, -72.92]])!;
    const [south, north] = points(t.path);
    expect(north.y).toBeLessThan(south.y);
  });
});

describe("buildRouteThumb — aspect ratio", () => {
  it("uses one scale for both axes, so a shape is never squashed", () => {
    // 0.02° of longitude at 41.3°N is 0.02 * cos(41.3°) ≈ 0.01502° worth of
    // latitude, so this box is TALLER than it is wide on the ground even
    // though the degree spans look equal.
    const box: [number, number][] = [
      [41.30, -72.94], [41.32, -72.94], [41.32, -72.92], [41.30, -72.92], [41.30, -72.94],
    ];
    const t = buildRouteThumb(box)!;
    const pts = points(t.path);
    const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    const expected = Math.cos((41.31 * Math.PI) / 180); // ≈ 0.7513
    expect(w / h).toBeCloseTo(expected, 3);
    expect(w / h).toBeLessThan(1);
  });

  it("scales longitude by cos(latitude), so the same degrees draw narrower further north", () => {
    const span = (lat: number) => {
      const t = buildRouteThumb([
        [lat, -72.94], [lat + 0.02, -72.94], [lat + 0.02, -72.92], [lat, -72.92], [lat, -72.94],
      ])!;
      const pts = points(t.path);
      const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
      const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      return w / h;
    };
    expect(span(60)).toBeLessThan(span(41.3));
    expect(span(0)).toBeCloseTo(1, 2);
  });

  it("does not stretch a narrow route across the box", () => {
    // A nearly north-south line: height binds, and the drawn width stays tiny.
    const t = buildRouteThumb([[41.30, -72.93], [41.32, -72.93]])!;
    const pts = points(t.path);
    const w = Math.abs(pts[1].x - pts[0].x);
    expect(w).toBeLessThan(1);
    expect(Math.abs(pts[1].y - pts[0].y)).toBeCloseTo(THUMB_HEIGHT - THUMB_PADDING * 2, 1);
  });
});

describe("buildRouteThumb — degenerate bounds", () => {
  const same: [number, number][] = [
    [41.31, -72.93], [41.31, -72.93], [41.31, -72.93],
  ];

  it("centres a zero-extent route instead of dividing by zero", () => {
    const t = buildRouteThumb(same, [{ lat: 41.31, lon: -72.93 }], [
      { lat: 41.31, lon: -72.93, name: "#40" },
    ])!;
    const pts = points(t.path);
    expect(pts.length).toBe(1); // all three vertices collapse to one
    expect(pts[0].x).toBeCloseTo(THUMB_WIDTH / 2, 5);
    expect(pts[0].y).toBeCloseTo(THUMB_HEIGHT / 2, 5);
    expect(t.stops[0]).toEqual({ x: THUMB_WIDTH / 2, y: THUMB_HEIGHT / 2 });
    expect(t.buses[0]).toEqual({ x: THUMB_WIDTH / 2, y: THUMB_HEIGHT / 2, name: "#40" });
  });

  it("keeps everything finite when only one axis is degenerate", () => {
    const t = buildRouteThumb([[41.31, -72.94], [41.31, -72.92]])!;
    for (const p of points(t.path)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("buildRouteThumb — stops and buses", () => {
  it("places a stop that sits on the line exactly where the line is", () => {
    const t = buildRouteThumb(LOOP, [{ lat: LOOP[0][0], lon: LOOP[0][1] }])!;
    expect(t.stops[0]).toEqual(points(t.path)[0]);
  });

  it("carries the bus name through for the accessible title", () => {
    const t = buildRouteThumb(LOOP, [], [{ lat: 41.305, lon: -72.925, name: "#40" }])!;
    expect(t.buses).toHaveLength(1);
    expect(t.buses[0].name).toBe("#40");
  });

  it("clamps a bus that has wandered off route back inside the box", () => {
    // Far north-west of anything the route touches — West Haven-scale error.
    const t = buildRouteThumb(LOOP, [], [{ lat: 41.9, lon: -73.9, name: "#12" }])!;
    const b = t.buses[0];
    expect(b.x).toBe(THUMB_PADDING);
    expect(b.y).toBe(THUMB_PADDING);
  });

  it("clamps an off-box stop to the far edge too", () => {
    const t = buildRouteThumb(LOOP, [{ lat: 40.0, lon: -70.0 }])!;
    const s = t.stops[0];
    expect(s.x).toBe(THUMB_WIDTH - THUMB_PADDING);
    expect(s.y).toBe(THUMB_HEIGHT - THUMB_PADDING);
  });

  it("skips stops and buses with unusable coordinates", () => {
    const t = buildRouteThumb(
      LOOP,
      [{ lat: NaN, lon: -72.93 }, { lat: 41.305, lon: -72.925 }],
      [{ lat: 41.305, lon: NaN, name: "#7" }],
    )!;
    expect(t.stops).toHaveLength(1);
    expect(t.buses).toHaveLength(0);
  });

  it("returns empty collections when there are no stops or buses", () => {
    const t = buildRouteThumb(LOOP)!;
    expect(t.stops).toEqual([]);
    expect(t.buses).toEqual([]);
  });
});
