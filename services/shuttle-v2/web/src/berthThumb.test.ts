import { describe, expect, it } from "vitest";

import { buildBerthThumb } from "./berthThumb";
import { BERTHS } from "./berths";
import STOPS from "../../src/server/__fixtures__/stops.json";

const byId = new Map((STOPS as { id: number; name: string; lat: number; lon: number }[]).map((s) => [s.id, s]));
const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const m = rad((a.lat + b.lat) / 2);
  return Math.hypot(rad(b.lon - a.lon) * Math.cos(m), rad(b.lat - a.lat)) * R;
};

describe("the berth inset", () => {
  it("draws both points inside the box, for every berth we ship", () => {
    for (const b of BERTHS) {
      const s = byId.get(b.stopId)!;
      const t = buildBerthThumb(s, { lat: b.lat, lon: b.lon });
      for (const p of [t.sign, t.berth]) {
        expect(p.x, s.name).toBeGreaterThanOrEqual(0);
        expect(p.x, s.name).toBeLessThanOrEqual(t.width);
        expect(p.y, s.name).toBeGreaterThanOrEqual(0);
        expect(p.y, s.name).toBeLessThanOrEqual(t.height);
      }
    }
  });

  it("separates them enough to be two things rather than one blob", () => {
    // The whole complaint was that at trip-map zoom they are indistinguishable.
    for (const b of BERTHS) {
      const s = byId.get(b.stopId)!;
      const t = buildBerthThumb(s, { lat: b.lat, lon: b.lon });
      // The pair must DOMINATE the picture, not sit in a corner of it: at 40 m of
      // road slack they spanned about a third of the box and read as one blob again.
      const span = Math.hypot(t.berth.x - t.sign.x, t.berth.y - t.sign.y);
      expect(span, s.name).toBeGreaterThan(0.45 * Math.min(t.width, t.height));
    }
  });

  it("keeps the walk undistorted WITHIN one picture", () => {
    // The guarantee is one scale on both axes, not one scale across thumbs:
    // each inset is fitted to its own box, which is what makes 55 m readable
    // at all. So the invariant to hold is that a right angle with equal legs
    // is drawn with equal legs — a diagonal must not be stretched.
    //
    // (An earlier version of this test asserted the stronger thing — that
    // 60 m north and 60 m east draw the same length — and it is false by
    // design: the box is 132x84, so a north-south walk is fitted to the short
    // axis and an east-west one to the long axis.)
    const o = { lat: 41.31, lon: -72.92 };
    const dLat = 60 / 111_320;
    const dLon = 60 / (111_320 * Math.cos(rad(41.31)));
    const diag = buildBerthThumb(o, { lat: o.lat + dLat, lon: o.lon + dLon });
    const dx = Math.abs(diag.berth.x - diag.sign.x);
    const dy = Math.abs(diag.berth.y - diag.sign.y);
    // equal metres each way must come out as equal pixels each way
    expect(dx).toBeCloseTo(dy, 0);
  });

  it("hangs the two labels on opposite sides so they cannot collide", () => {
    const o = { lat: 41.31, lon: -72.92 };
    const right = buildBerthThumb(o, { lat: 41.31, lon: -72.9192 });
    expect(right.berthAnchor).toBe("start");
    expect(right.signAnchor).toBe("end");
    const left = buildBerthThumb(o, { lat: 41.31, lon: -72.9208 });
    expect(left.berthAnchor).toBe("end");
    expect(left.signAnchor).toBe("start");
  });

  it("reports a span a scale note can quote", () => {
    const t = buildBerthThumb({ lat: 41.31, lon: -72.92 }, { lat: 41.3105, lon: -72.92 });
    expect(t.spanM).toBeGreaterThan(55);
    expect(t.spanM).toBeLessThan(400);
  });

  it("survives a road polyline and keeps only the stretch that matters", () => {
    const sign = { lat: 41.3248, lon: -72.9235 };
    const berth = { lat: 41.3245, lon: -72.9232 };
    // A long line whose vertices are ~111 m apart — so NONE of them falls
    // between two stops 40 m apart. Selecting vertices by bounding box drew
    // nothing here; clipping the line always yields the segment.
    const road = Array.from({ length: 60 }, (_, i) => ({ lat: 41.32 + i * 0.001, lon: -72.9233 }));
    const t = buildBerthThumb(sign, berth, road);
    expect(t.road.length).toBeGreaterThanOrEqual(2);
    expect(t.road.length).toBeLessThan(road.length);
    for (const p of t.road) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(t.width + 1);
    }
  });
});
