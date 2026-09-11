import { describe, expect, it } from "vitest";

import { BERTH_THUMB_CONSTANTS, buildBerthThumb } from "./berthThumb";
import { BERTHS } from "./berths";
import payload from "./__fixtures__/buses-payload.json";

/**
 * The real payload, so the roads under these pictures are the routes' own
 * published polylines rather than a synthetic line: half of what this module
 * decides — the direction of travel, the stretch of road it draws, where the
 * arrowhead goes — is a fact about those polylines, and a straight test line
 * cannot fail on any of it. (Church / George's arrow landed on the far side of
 * the Blue Night loop, which no synthetic road has.)
 */
const P = payload as unknown as {
  stop_coords: Record<string, { lat: number; lon: number }>;
  route_paths: Record<string, [number, number][]>;
};

const rad = (d: number) => (d * Math.PI) / 180;
const W = 346, H = 160, LABEL_HALF = 44;
const cells = BERTHS.map((b) => ({
  b,
  id: `${b.stopId}/${b.routeId}`,
  published: P.stop_coords[String(b.stopId)],
  road: (P.route_paths[String(b.routeId)] ?? []).map(([lat, lon]) => ({ lat, lon })),
}));

const thumb = (c: (typeof cells)[number], width = W, height = H) =>
  buildBerthThumb(c.published, { lat: c.b.lat, lon: c.b.lon }, c.road, { width, height, labelHalfW: LABEL_HALF });

describe("the berth inset", () => {
  it("covers every cell we ship with a coordinate and a road", () => {
    expect(cells.length).toBe(10);
    for (const c of cells) {
      expect(c.published, c.id).toBeTruthy();
      expect(c.road.length, c.id).toBeGreaterThan(2);
    }
  });

  it("draws EVERY cell at one scale — the defect that made the set unreadable", () => {
    // The first version picked the deepest zoom at which the pair fitted, so
    // resolution was set by the pair's compass bearing: Chapel / Dwight (39.9 m,
    // bearing 116) drew at 0.22 m/px and 300 George St (74.9 m, bearing 180) at
    // 0.94 — 4.3x the detail for 1.9x the distance, with no scale cue. One
    // resolution for all ten is what makes a 91 m offset LOOK farther than a
    // 38 m one.
    for (const c of cells) {
      const t = thumb(c);
      expect(t.metresPerPx, c.id).toBeCloseTo(BERTH_THUMB_CONSTANTS.TARGET_M_PER_PX, 3);
      expect(t.zoom, c.id).toBe(18);
      expect(t.spanM, c.id).toBe(Math.round(W * t.metresPerPx));
    }
  });

  it("holds that one scale at 360, 390 and 430 px of phone", () => {
    // The viewBox is sized from the card's measured width now, so the same cell
    // is built at several widths in a day. A width may add ground; it may not
    // change what a pixel is worth.
    for (const c of cells) for (const w of [316, 346, 386]) {
      expect(thumb(c, w).metresPerPx, `${c.id} @${w}`).toBeCloseTo(BERTH_THUMB_CONSTANTS.TARGET_M_PER_PX, 3);
    }
  });

  it("zooms OUT rather than overflowing, for a berth farther than any we ship", () => {
    const far = buildBerthThumb({ lat: 41.31, lon: -72.92 }, { lat: 41.3136, lon: -72.92 }, [], { width: W, height: H });
    expect(far.metresPerPx).toBeGreaterThan(BERTH_THUMB_CONSTANTS.TARGET_M_PER_PX);
    expect(Math.hypot(far.berth.x - far.published.x, far.berth.y - far.published.y)).toBeLessThan(W);
    expect(far.zoom).toBeGreaterThanOrEqual(BERTH_THUMB_CONSTANTS.MIN_ZOOM);
  });

  it("puts the expected stop DOWNSTREAM of the published one, the way the arrow points", () => {
    // The tile group is rotated until the road lies along the long edge, and
    // the direction along it is whichever of the two keeps the basemap's own
    // labels upright (three of the ten cells drive west). So the invariant is
    // not "past is to the right" but "past is the way the arrow points" — the
    // picture and the heading cannot contradict each other.
    for (const c of cells) {
      const t = thumb(c);
      const downstream = (t.berth.x - t.published.x) * (t.travelsRight ? 1 : -1);
      if (c.b.offsetM > 0) expect(downstream, `${c.id} past`).toBeGreaterThan(20);
      else expect(downstream, `${c.id} before`).toBeLessThan(-20);
      // and the cross-axis carries the slack, never the fact
      expect(Math.abs(t.berth.y - t.published.y), c.id).toBeLessThan(Math.abs(t.berth.x - t.published.x));
    }
  });

  it("never stands the basemap on its head", () => {
    // Pointing travel right in every cell mirrored the street names on 300
    // George St, Church / George and Chapel / Dwight, which reads as a broken
    // picture rather than as a rotated one.
    for (const c of cells) expect(Math.abs(thumb(c).rotationDeg), c.id).toBeLessThanOrEqual(90);
  });

  it("keeps both dots well inside the box, at every phone width", () => {
    for (const c of cells) for (const w of [316, 346, 386]) {
      const t = thumb(c, w);
      for (const p of [t.published, t.berth]) {
        expect(Math.min(p.x, w - p.x, p.y, H - p.y), `${c.id} @${w}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("keeps both labels inside the box, whole words", () => {
    // They are centred on their dot and clamped, one above and one below, so
    // they cannot collide however close the dots are — and a dot near an edge
    // still gets its whole word rather than a clipped one.
    for (const c of cells) for (const w of [316, 346, 386]) {
      const t = thumb(c, w);
      for (const l of [t.publishedLabel, t.berthLabel]) {
        expect(l.x - LABEL_HALF, `${c.id} @${w} left`).toBeGreaterThanOrEqual(0);
        expect(l.x + LABEL_HALF, `${c.id} @${w} right`).toBeLessThanOrEqual(w);
        expect(l.y, `${c.id} @${w} top`).toBeGreaterThanOrEqual(11);
        expect(l.y, `${c.id} @${w} bottom`).toBeLessThanOrEqual(H);
      }
      // The higher dot's label opens upward and the lower one's downward, so
      // the two are always at least a line apart however close the dots are.
      expect(Math.abs(t.berthLabel.y - t.publishedLabel.y), `${c.id} @${w}`).toBeGreaterThanOrEqual(24);
    }
  });

  it("runs the road PAST both markers, not between them", () => {
    // Clipped exactly published-to-berth, the line stopped dead at two dots in the
    // middle of a street — and where the published coordinate is off the kerb
    // (36.7 m at 300 George St) it stopped short of the very dot it explains.
    for (const c of cells) {
      const t = thumb(c);
      expect(t.road.length, c.id).toBeGreaterThan(1);
      const xs = t.road.map((p) => p.x);
      const lo = Math.min(t.published.x, t.berth.x), hi = Math.max(t.published.x, t.berth.x);
      expect(Math.min(...xs), c.id).toBeLessThan(lo - 20);
      expect(Math.max(...xs), c.id).toBeGreaterThan(hi + 20);
    }
  });

  it("ties the published dot to the road only when it is really off it", () => {
    // Drawing the published marker where it IS is the honest thing; a dot 36 m
    // from the line then needs saying why. Wall / York's is 0.9 m off, and a
    // tie-line there would be noise.
    const byId = new Map(cells.map((c) => [c.id, thumb(c)]));
    expect(byId.get("9/13")!.publishedLink, "300 George St, 36.7 m off the line").toBeTruthy();
    expect(byId.get("67/13")!.publishedLink, "Wall / York, 0.9 m off the line").toBeNull();
  });

  it("puts one arrowhead on the stretch the bus drives, pointing the way it drives", () => {
    for (const c of cells) {
      const t = thumb(c);
      expect(t.arrow, c.id).toBeTruthy();
      const a = t.arrow!;
      expect(Math.min(a.x, W - a.x, a.y, H - a.y), c.id).toBeGreaterThanOrEqual(12);
      // the tangent must agree with the direction the rotation chose
      const off = Math.abs(((a.deg - (t.travelsRight ? 0 : 180) + 540) % 360) - 180);
      expect(off, c.id).toBeLessThan(80);
      expect(Math.min(Math.hypot(a.x - t.published.x, a.y - t.published.y), Math.hypot(a.x - t.berth.x, a.y - t.berth.y)), c.id)
        .toBeGreaterThanOrEqual(11);
    }
  });

  it("asks for tiles that are actually shown, and not many", () => {
    for (const c of cells) {
      const t = thumb(c);
      expect(t.tiles.length, c.id).toBeGreaterThanOrEqual(1);
      // A rotated box's bounding box spans up to 3x3; the corner tiles are
      // culled by the real overlap test, which took Church / George 9 -> 4.
      expect(t.tiles.length, c.id).toBeLessThanOrEqual(6);
      for (const tile of t.tiles) {
        expect(tile.z, c.id).toBe(t.zoom);
        expect(tile.x, c.id).toBeGreaterThanOrEqual(0);
        expect(tile.y, c.id).toBeGreaterThanOrEqual(0);
        expect(tile.size, c.id).toBeGreaterThan(100);
      }
      expect(t.tileTransform, c.id).toMatch(/^rotate\(-?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?\)$/);
    }
  });

  it("quotes a round scale bar that fits the box", () => {
    for (const c of cells) for (const w of [316, 346, 386]) {
      const t = thumb(c, w);
      expect([5, 10, 20, 25, 50, 100, 200, 500], c.id).toContain(t.scale.m);
      expect(t.scale.px, `${c.id} @${w}`).toBeLessThanOrEqual(0.34 * w);
      expect(t.scale.px, `${c.id} @${w}`).toBeGreaterThan(30);
      expect(t.scale.px, `${c.id} @${w}`).toBeCloseTo(t.scale.m / t.metresPerPx, 0);
    }
  });

  it("places a dot exactly where the TILE puts that coordinate", () => {
    // The annotation is rotated numerically and the tiles by an SVG
    // `rotate(deg cx cy)` on their group. If those two disagree by even a few
    // degrees every dot sits off its street and the whole picture lies — and
    // nothing else in this suite would notice, because the geometry would still
    // be self-consistent. So: take the berth's own coordinate to world pixels,
    // carry it through the tile that contains it and that tile's own transform,
    // and land on the dot.
    const TILE = 256;
    for (const c of cells) {
      const t = thumb(c);
      const n = TILE * 2 ** t.zoom;
      const sinLat = Math.sin(rad(c.b.lat));
      const wx = ((c.b.lon + 180) / 360) * n;
      const wy = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
      const tile = t.tiles.find((q) => q.x === Math.floor(wx / TILE) && q.y === Math.floor(wy / TILE));
      expect(tile, `${c.id}: the berth's own tile must be requested`).toBeTruthy();
      const scale = tile!.size / TILE;
      const inTile = { x: tile!.px + (wx - tile!.x * TILE) * scale, y: tile!.py + (wy - tile!.y * TILE) * scale };
      // SVG: rotate(a, cx, cy) about (cx, cy), clockwise in this y-down space.
      const [dg, cx, cy] = t.tileTransform.replace(/rotate\(|\)/g, "").split(" ").map(Number);
      const a = rad(dg), cos = Math.cos(a), sin = Math.sin(a);
      const placed = {
        x: cx + (inTile.x - cx) * cos - (inTile.y - cy) * sin,
        y: cy + (inTile.x - cx) * sin + (inTile.y - cy) * cos,
      };
      expect(Math.hypot(placed.x - t.berth.x, placed.y - t.berth.y), c.id).toBeLessThan(0.5);
    }
  });

  it("keeps the walk undistorted WITHIN one picture", () => {
    // One scale on both axes: a right angle with equal legs must be drawn with
    // equal legs, rotation or no rotation.
    const o = { lat: 41.31, lon: -72.92 };
    const dLat = 30 / 111_320;
    const dLon = 30 / (111_320 * Math.cos(rad(41.31)));
    const diag = buildBerthThumb(o, { lat: o.lat + dLat, lon: o.lon + dLon }, [], { width: W, height: H });
    // rotated so the pair lies along x, the diagonal's length is what is fixed
    const len = Math.hypot(diag.berth.x - diag.published.x, diag.berth.y - diag.published.y);
    expect(len * diag.metresPerPx).toBeCloseTo(Math.hypot(30, 30), 0);
  });
});
