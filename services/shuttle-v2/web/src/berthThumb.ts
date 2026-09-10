// The little picture beside "wait about 55 m past the stop sign".
//
// The sentence alone did not land (operator, 2026-09-10: "this message doesn't
// make sense until i zoom into map. maybe it could have small zoomed in
// snippet with points labelled?"), and the first version — two dots and a road
// on a blank ground — did not either: "this should have open street map
// background". Without streets and buildings behind them the dots have nothing
// to be near.
//
// A second Leaflet map per card is still not the answer: `routeThumb.ts` exists
// because fifteen Leaflet instances on one page is not shippable, and one more
// per expanded card has the same problem in miniature — its own tile requests,
// its own DOM panes, its own teardown. So this draws the SAME tiles Leaflet
// would, as plain <image> elements inside the SVG: one to four requests from
// the host the map already uses, no map object at all.
//
// That forces the projection to be Web Mercator rather than the equirectangular
// one `routeThumb.ts` uses, because the coordinates have to agree with the
// tiles to the pixel. Everything here is therefore in WORLD PIXELS at a chosen
// zoom, where a tile (x, y) occupies [256x, 256y] to [256(x+1), 256(y+1)] — so
// placing a tile is subtraction, and placing a point is the same subtraction.

import type { LatLon } from "./geo";

export interface BerthThumbPoint { x: number; y: number; }
export interface BerthThumbTile { x: number; y: number; z: number; px: number; py: number; size: number; }

export interface BerthThumb {
  width: number;
  height: number;
  viewBox: string;
  sign: BerthThumbPoint;
  berth: BerthThumbPoint;
  /** The road between them, clipped from the route's polyline. */
  road: BerthThumbPoint[];
  /** OSM tiles to draw behind, already positioned in the same coordinates. */
  tiles: BerthThumbTile[];
  /** Metres represented by the full width — for a scale note. */
  spanM: number;
  berthAnchor: "start" | "end";
  signAnchor: "start" | "end";
  zoom: number;
}

const TILE = 256;
const rad = (d: number) => (d * Math.PI) / 180;

/** Web Mercator world pixels at `z` — the coordinate system OSM tiles are cut on. */
function world(p: LatLon, z: number): { x: number; y: number } {
  const n = TILE * 2 ** z;
  const s = Math.sin(rad(p.lat));
  return {
    x: ((p.lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

/** Metres per world pixel at this latitude and zoom. */
function metresPerPx(lat: number, z: number): number {
  return (156543.03392 * Math.cos(rad(lat))) / 2 ** z;
}

export function buildBerthThumb(
  sign: LatLon,
  berth: LatLon,
  road: readonly LatLon[] = [],
  opts: { width?: number; height?: number; pad?: number; maxZoom?: number } = {},
): BerthThumb {
  const width = opts.width ?? 200;
  const height = opts.height ?? 110;
  const pad = opts.pad ?? 18;
  const maxZoom = opts.maxZoom ?? 19;

  // Pick the deepest zoom at which both points still fit with their labels.
  // Deeper is better here: the whole complaint is that at trip-map zoom these
  // two are one blob.
  const lat0 = (sign.lat + berth.lat) / 2;
  let zoom = maxZoom;
  for (let z = maxZoom; z >= 12; z--) {
    const a = world(sign, z), b = world(berth, z);
    if (Math.abs(a.x - b.x) <= width - 2 * pad && Math.abs(a.y - b.y) <= height - 2 * pad) { zoom = z; break; }
    zoom = z;
  }

  const a = world(sign, zoom), b = world(berth, zoom);

  // The stretch of road BETWEEN the two points, clipped — not the polyline's
  // vertices near them. A published polyline carries a vertex only where the
  // road turns, so on a straight block there may be none at all between a sign
  // and a kerb 55 m apart, and selecting by bounding box drew nothing exactly
  // where the road is simplest.
  const W = road.map((p) => world(p, zoom));
  const proj = (q: { x: number; y: number }) => {
    let best = { i: 0, t: 0, d: Infinity };
    for (let i = 1; i < W.length; i++) {
      const u = W[i - 1], v = W[i];
      const vx = v.x - u.x, vy = v.y - u.y, L2 = vx * vx + vy * vy;
      let t = L2 > 0 ? ((q.x - u.x) * vx + (q.y - u.y) * vy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(q.x - (u.x + t * vx), q.y - (u.y + t * vy));
      if (d < best.d) best = { i, t, d };
    }
    return best;
  };
  const at = (i: number, t: number) => ({
    x: W[i - 1].x + t * (W[i].x - W[i - 1].x),
    y: W[i - 1].y + t * (W[i].y - W[i - 1].y),
  });
  let near: { x: number; y: number }[] = [];
  if (W.length >= 2) {
    const pa = proj(a), pb = proj(b);
    const nearM = 40 / metresPerPx(lat0, zoom);
    // Only when BOTH ends really sit on this line; otherwise the polyline is
    // not the road between them and drawing it would mislead.
    if (pa.d < nearM && pb.d < nearM) {
      const [lo, hi] = pa.i < pb.i || (pa.i === pb.i && pa.t <= pb.t) ? [pa, pb] : [pb, pa];
      near.push(at(lo.i, lo.t));
      for (let i = lo.i; i < hi.i; i++) near.push(W[i]);
      near.push(at(hi.i, hi.t));
    }
  }

  // Tile zooms come in powers of two, so the deepest one that FITS can still
  // leave the pair at 42 px in a 110 px box — half the picture wasted on the
  // thing it exists to show. Leaflet solves this by drawing tiles between
  // integer zooms; so does this. One scale factor applies to the geometry AND
  // the tiles, so the streets stay under the dots.
  const wantX = (width - 2 * pad) / Math.max(Math.abs(a.x - b.x), 1);
  const wantY = (height - 2 * pad) / Math.max(Math.abs(a.y - b.y), 1);
  // Capped at 2: past that an OSM tile is visibly soft, and the labels on it
  // stop being readable, which is worse than a little slack.
  const scale = Math.max(1, Math.min(2, Math.min(wantX, wantY)));

  // Centre the two points; the tiles follow the same transform.
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const place = (p: { x: number; y: number }): BerthThumbPoint => ({
    x: +((p.x - cx) * scale + width / 2).toFixed(1),
    y: +((p.y - cy) * scale + height / 2).toFixed(1),
  });

  const tiles: BerthThumbTile[] = [];
  const n = 2 ** zoom;
  // World-pixel window the box covers, once scaled.
  const halfW = width / (2 * scale), halfH = height / (2 * scale);
  for (let tx = Math.floor((cx - halfW) / TILE); tx <= Math.floor((cx + halfW) / TILE); tx++) {
    for (let ty = Math.floor((cy - halfH) / TILE); ty <= Math.floor((cy + halfH) / TILE); ty++) {
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      const at = place({ x: tx * TILE, y: ty * TILE });
      tiles.push({ x: tx, y: ty, z: zoom, px: at.x, py: at.y, size: +(TILE * scale).toFixed(1) });
    }
  }

  const s = place(a), t = place(b);
  return {
    width, height, viewBox: `0 0 ${width} ${height}`,
    sign: s, berth: t, road: near.map(place), tiles,
    spanM: Math.round((width / scale) * metresPerPx(lat0, zoom)),
    berthAnchor: t.x >= s.x ? "start" : "end",
    signAnchor: t.x >= s.x ? "end" : "start",
    zoom,
  };
}
