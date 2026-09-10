// The little picture beside "wait about 55 m past the stop sign".
//
// The sentence alone did not land (operator, 2026-09-10: "this message doesn't
// make sense until i zoom into map. maybe it could have small zoomed in
// snippet with points labelled?"). The trip map above it is framed to show the
// whole journey, so at that scale the sign and the kerb are two red dots a few
// pixels apart with nothing to tell them apart — the words point at something
// the picture cannot show.
//
// A second Leaflet map per card is not the answer: `routeThumb.ts` exists
// because fifteen Leaflet instances on one phone page is not shippable, and
// one more per expanded card has the same problem in miniature — its own tile
// requests, its own DOM panes. So this is the same solution: a pure function
// that turns two coordinates and the road between them into SVG coordinates,
// and the card renders them. No DOM, no Leaflet, no tiles, no React.
//
// Projection is the app's usual equirectangular one (`geo.ts`): longitude
// scaled by cos(latitude), then ONE scale factor on both axes so the walk is
// drawn at its true shape rather than stretched to fill the box.

import type { LatLon } from "./geo";

export interface BerthThumbPoint { x: number; y: number; }

export interface BerthThumb {
  width: number;
  height: number;
  viewBox: string;
  /** The published stop — where the map draws it today. */
  sign: BerthThumbPoint;
  /** Where the line actually pulls up. */
  berth: BerthThumbPoint;
  /** The road between them, if the route's polyline supplied one. */
  road: BerthThumbPoint[];
  /** Metres represented by the full width — for a "50 m" scale note. */
  spanM: number;
  /** Which side of the box the berth label should sit on, so it never clips. */
  berthAnchor: "start" | "end";
  signAnchor: "start" | "end";
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * @param sign     the published stop coordinate
 * @param berth    the measured pull-up coordinate
 * @param road     the route polyline, any length; the part between the two
 *                 points is extracted. Pass [] to draw a straight tie instead.
 */
export function buildBerthThumb(
  sign: LatLon,
  berth: LatLon,
  road: readonly LatLon[] = [],
  opts: { width?: number; height?: number; pad?: number } = {},
): BerthThumb {
  // Squarer than the card is wide, because a berth is as often up the road as
  // across it: a 292x78 letterbox squeezed Division / Prospect's mostly
  // north-south walk into 50 px of height while wasting 200 px of width.
  const width = opts.width ?? 200;
  const height = opts.height ?? 110;
  const pad = opts.pad ?? 14;

  const lat0 = (sign.lat + berth.lat) / 2;
  const mx = R * Math.cos(rad(lat0)) * (Math.PI / 180);
  const my = R * (Math.PI / 180);
  const proj = (p: LatLon) => ({ x: p.lon * mx, y: -p.lat * my });

  const a = proj(sign), b = proj(berth);

  // The stretch of road BETWEEN the two points, clipped — not the polyline's
  // vertices that happen to fall near them.
  //
  // A published polyline carries a vertex only where the road turns, so on a
  // straight block there may be none at all between a sign and a kerb 55 m
  // apart. Selecting vertices by bounding box therefore drew nothing exactly
  // where the road is simplest, which a test caught after the slack was
  // tightened. Projecting both points onto the line and walking between them
  // always yields a segment, and it is the segment a rider would walk.
  const proj2 = (q: { x: number; y: number }) => {
    let best = { i: 0, t: 0, d: Infinity };
    for (let i = 1; i < road.length; i++) {
      const u = proj(road[i - 1]), v = proj(road[i]);
      const vx = v.x - u.x, vy = v.y - u.y;
      const L2 = vx * vx + vy * vy;
      let t = L2 > 0 ? ((q.x - u.x) * vx + (q.y - u.y) * vy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(q.x - (u.x + t * vx), q.y - (u.y + t * vy));
      if (d < best.d) best = { i, t, d };
    }
    return best;
  };
  const at = (i: number, t: number) => {
    const u = proj(road[i - 1]), v = proj(road[i]);
    return { x: u.x + t * (v.x - u.x), y: u.y + t * (v.y - u.y) };
  };
  let near: { x: number; y: number }[] = [];
  if (road.length >= 2) {
    const pa = proj2(a), pb = proj2(b);
    // Only if BOTH ends really sit on this line; otherwise the polyline is not
    // the road between them and drawing it would mislead.
    if (pa.d < 40 && pb.d < 40) {
      const [lo, hi] = pa.i < pb.i || (pa.i === pb.i && pa.t <= pb.t) ? [pa, pb] : [pb, pa];
      near.push(at(lo.i, lo.t));
      for (let i = lo.i; i < hi.i; i++) near.push(proj(road[i]));
      near.push(at(hi.i, hi.t));
    }
  }

  const pts = [a, b, ...near];
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  // ONE scale for both axes — a walk drawn out of shape is worse than no picture.
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2, offY = (height - spanY * scale) / 2;
  const place = (p: { x: number; y: number }): BerthThumbPoint => ({
    x: +((p.x - minX) * scale + offX).toFixed(1),
    y: +((p.y - minY) * scale + offY).toFixed(1),
  });

  const s = place(a), t = place(b);
  return {
    width, height, viewBox: `0 0 ${width} ${height}`,
    sign: s, berth: t,
    road: near.map(place),
    spanM: Math.round(width / scale),
    // Labels hang away from the middle so two of them never collide.
    berthAnchor: t.x >= s.x ? "start" : "end",
    signAnchor: t.x >= s.x ? "end" : "start",
  };
}
