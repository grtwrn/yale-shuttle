// Geometry for the All tab's per-route map thumbnail.
//
// The All tab draws one card per route, and each card carries a small picture
// of the line. Fifteen Leaflet instances (each with its own tile requests and
// its own DOM panes) on one phone page is not shippable, so the thumbnail is a
// plain inline SVG: this module turns published geometry into coordinates and
// the card just renders them. No DOM, no Leaflet, no React — so it is unit
// tested directly.
//
// Projection is the same equirectangular one the rest of the app uses
// (`progressAlongSegment`, `distanceToSegmentM` in geo.ts): longitude is
// scaled by cos(latitude) so a degree of longitude is drawn as short as it
// really is at New Haven's latitude. Both axes then share ONE scale factor, so
// the loop keeps its true shape instead of being stretched to fill the box.

import type { LatLon } from "./geo";

export interface ThumbPoint {
  x: number;
  y: number;
}

export interface ThumbBus extends ThumbPoint {
  name: string;
}

export interface RouteThumb {
  /** viewBox width in user units. */
  width: number;
  /** viewBox height in user units. */
  height: number;
  /** Ready to drop into <svg viewBox=…>. */
  viewBox: string;
  /** The route line, as an SVG path `d` ("M x y L x y …"). */
  path: string;
  /** One point per stop, in the order given. */
  stops: ThumbPoint[];
  /** One point per live bus, carrying the bus name for the <title>. */
  buses: ThumbBus[];
}

export interface RouteThumbOptions {
  width?: number;
  height?: number;
  /**
   * Margin kept clear inside the box, in user units. Every returned point is
   * clamped into this inset rectangle, so a marker never straddles the edge.
   */
  padding?: number;
}

export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 168;
export const THUMB_PADDING = 8;

/** Spans smaller than this are treated as "no extent at all". */
const EPS = 1e-12;

type PolylinePoint = readonly [number, number];

function isFinitePair(p: PolylinePoint | undefined): p is PolylinePoint {
  return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Project a route's published polyline, its stops and its live buses into a
 * fixed viewBox.
 *
 * Returns `null` when there is nothing drawable (no polyline, a single point,
 * or coordinates that aren't finite) — the caller renders nothing at all
 * rather than an empty framed box.
 *
 * The box is fitted to the POLYLINE's bounds; stops and buses are projected
 * with the same transform and then clamped inside, so a bus that has wandered
 * off route (or a stop the published line doesn't reach) shows at the edge
 * instead of being drawn outside the SVG.
 */
export function buildRouteThumb(
  polyline: readonly PolylinePoint[] | null | undefined,
  stops: readonly LatLon[] = [],
  buses: readonly { lat: number; lon: number; name: string }[] = [],
  opts: RouteThumbOptions = {},
): RouteThumb | null {
  const width = opts.width ?? THUMB_WIDTH;
  const height = opts.height ?? THUMB_HEIGHT;
  const padding = opts.padding ?? THUMB_PADDING;

  if (!polyline) return null;
  const pts = polyline.filter(isFinitePair);
  if (pts.length < 2) return null;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // Same longitude foreshortening as geo.ts, taken at the route's mid
  // latitude. Guarded so a pathological latitude can't collapse x to zero.
  const lonScale = Math.max(Math.abs(Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)), 1e-6);
  // Screen y grows downward, latitude grows northward — hence the negation.
  const projX = (lon: number) => lon * lonScale;
  const projY = (lat: number) => -lat;

  const minPx = projX(minLon), maxPx = projX(maxLon);
  // maxLat projects to the SMALLER y (north is up).
  const minPy = projY(maxLat), maxPy = projY(minLat);
  const spanX = maxPx - minPx;
  const spanY = maxPy - minPy;

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);

  // ONE scale for both axes: that is what keeps the shape honest. A route with
  // no extent at all (every point identical) gets scale 1 and lands, via the
  // centring below, in the middle of the box.
  let scale: number;
  if (spanX <= EPS && spanY <= EPS) {
    scale = 1;
  } else {
    scale = Math.min(
      spanX > EPS ? innerW / spanX : Infinity,
      spanY > EPS ? innerH / spanY : Infinity,
    );
  }

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = padding + (innerW - drawnW) / 2;
  const offsetY = padding + (innerH - drawnH) / 2;

  const loX = padding, hiX = Math.max(padding, width - padding);
  const loY = padding, hiY = Math.max(padding, height - padding);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  const place = (lat: number, lon: number): ThumbPoint => ({
    x: round2(clamp(offsetX + (projX(lon) - minPx) * scale, loX, hiX)),
    y: round2(clamp(offsetY + (projY(lat) - minPy) * scale, loY, hiY)),
  });

  let d = "";
  let prevX = NaN, prevY = NaN;
  for (const [lat, lon] of pts) {
    const p = place(lat, lon);
    // Rounding can collapse neighbouring vertices onto one another; a repeated
    // "L x y" draws nothing and only lengthens the attribute.
    if (p.x === prevX && p.y === prevY) continue;
    d += `${d === "" ? "M" : " L"}${p.x} ${p.y}`;
    prevX = p.x; prevY = p.y;
  }

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    path: d,
    stops: stops
      .filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .map((s) => place(s.lat, s.lon)),
    buses: buses
      .filter((b) => b && Number.isFinite(b.lat) && Number.isFinite(b.lon))
      .map((b) => ({ ...place(b.lat, b.lon), name: b.name })),
  };
}
