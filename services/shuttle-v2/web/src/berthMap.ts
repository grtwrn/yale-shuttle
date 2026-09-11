// Geometry for the berth map — the little map beside "Wait about 55 m past the
// published stop".
//
// ── WHY THIS FILE IS NO LONGER A THUMBNAIL BUILDER ──────────────────────────
// Until 2026-09-11 this was `berthThumb.ts`: it projected the two markers into
// Web Mercator world pixels itself, chose a tile zoom, picked the OSM tiles to
// request, rotated the whole box so the road lay on the long edge, placed two
// upright labels and a scale bar, and handed `BerthInset` a finished SVG. The
// reason was `routeThumb.ts`'s: fifteen Leaflet instances on one page is not
// shippable, and one per expanded card looked like the same problem.
//
// The operator ruled otherwise on 2026-09-11: "the berth changes are looking
// good but we might want it to be a real map area so I can see the street name
// and zoom out if needed." A static picture cannot answer either ask — the
// street name is whatever OSM baked into the tile at the one zoom we chose, and
// there is no zooming out of an image. And the objection does not apply here:
// the berth inset exists only inside the ONE expanded card (`expandedKey` is a
// single key in TransitMap.tsx), so it is one map on the page, mounted on
// expand and destroyed on collapse — not fifteen.
//
// So Leaflet now owns the projection, the tiles, the zoom and the panning, and
// what survives here is only the part Leaflet cannot do: deciding WHICH stretch
// of the route's published polyline is the road through these two markers,
// which way buses drive along it, and whether the published coordinate is far
// enough off that line to need tying to it. All of that is answered in lat/lon,
// so a Leaflet layer can be built straight from it at any zoom.
//
// The rotation, the tile selection, the scale bar and the label placement went
// with the SVG — a real map is north-up, its labels are the basemap's own, and
// its scale is whatever the rider has zoomed to. Deleted rather than kept
// "just in case": two renderers for one picture is how they drift.
//
// The arithmetic is still in WEB MERCATOR world pixels (`world` / `unworld`),
// not in the equirectangular frame `geo.ts` uses, because the answers have to
// agree with Leaflet's own projection to the pixel — a tangent computed in a
// frame Leaflet does not share would point the arrowhead slightly off its own
// road.

import type { LatLon } from "./geo";

/** Where the one arrowhead goes, and the compass bearing buses drive there. */
export interface BerthArrow {
  lat: number;
  lon: number;
  /** Degrees clockwise from north — Leaflet's screen frame is north-up. */
  bearingDeg: number;
}

export interface BerthMapGeometry {
  /**
   * The route's own line through both markers, clipped to a window either side
   * — not the whole loop. An out-and-back route puts its return leg on the same
   * street, and drawing both makes the one the bus is on unreadable.
   */
  road: LatLon[];
  arrow: BerthArrow | null;
  /**
   * Published dot -> its own place on the road, drawn only when the published
   * coordinate is visibly off the line (36.7 m at 300 George St). Without it
   * that dot reads as a mistake rather than as the fact it is.
   */
  publishedLink: [LatLon, LatLon] | null;
  /** True when both markers sit on the route's published polyline. */
  onRoad: boolean;
  /** Metres along the road between the two markers (crow-flies when off it). */
  alongM: number;
}

const TILE = 256;
/**
 * The zoom the arithmetic runs at. Nothing is drawn here, so this is only a
 * precision choice: at z22 a world pixel is 2.8 cm at this latitude, which is
 * two orders of magnitude finer than the 30 m the feed itself resolves.
 */
const Z = 22;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Both ends must sit this close to the polyline, or it is not their road. */
const ROAD_NEAR_M = 60;
/**
 * How far past each marker the road is drawn. The old SVG drew the box's own
 * diagonal either side, which at its fixed 0.45 m/px worked out at ~170 m; 250
 * gives the rider something to follow after zooming out a step or two, and
 * still stops well short of the loop coming back down the same street.
 */
const ROAD_WINDOW_M = 250;
/** A published dot further than this off the road line gets a tie-line to it. */
const LINK_MIN_M = 3;
/**
 * Below this gap between the markers there is no room for an arrowhead between
 * them, so it goes upstream of the first instead.
 */
const ARROW_BETWEEN_MIN_M = 20;
const ARROW_UPSTREAM_M = 18;

/**
 * Initial view: the two markers, with margin, capped at the scale the static
 * inset used to draw every cell at (0.45 m/px = tile z18 at this latitude). So
 * the picture opens at the detail the operator has been reading all week, and
 * zooming out is the rider's to do.
 */
export const BERTH_MAP_VIEW = { maxZoom: 18, paddingPx: 34 } as const;

/** Web Mercator world pixels at `z` — the frame Leaflet itself projects into. */
function world(p: LatLon, z: number): { x: number; y: number } {
  const n = TILE * 2 ** z;
  const s = Math.sin(rad(p.lat));
  return {
    x: ((p.lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

/** And back again, so every answer here is a coordinate a Leaflet layer takes. */
function unworld(p: { x: number; y: number }, z: number): LatLon {
  const n = TILE * 2 ** z;
  return {
    lat: deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * p.y) / n)))),
    lon: (p.x / n) * 360 - 180,
  };
}

/** Metres per world pixel at this latitude and zoom. */
function metresPerPx(lat: number, z: number): number {
  return (156543.03392 * Math.cos(rad(lat))) / 2 ** z;
}

type P = { x: number; y: number };

/** Nearest point on a polyline, as a segment index, a fraction along it and a distance. */
function projectOnto(W: readonly P[], q: P): { i: number; t: number; d: number } {
  let best = { i: 1, t: 0, d: Infinity };
  for (let i = 1; i < W.length; i++) {
    const u = W[i - 1], v = W[i];
    const vx = v.x - u.x, vy = v.y - u.y, L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((q.x - u.x) * vx + (q.y - u.y) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(q.x - (u.x + t * vx), q.y - (u.y + t * vy));
    if (d < best.d) best = { i, t, d };
  }
  return best;
}

const lerp = (W: readonly P[], i: number, t: number): P => ({
  x: W[i - 1].x + t * (W[i].x - W[i - 1].x),
  y: W[i - 1].y + t * (W[i].y - W[i - 1].y),
});

/** Cumulative length to each vertex. */
function arcLengths(W: readonly P[]): number[] {
  const out = [0];
  for (let i = 1; i < W.length; i++) out.push(out[i - 1] + Math.hypot(W[i].x - W[i - 1].x, W[i].y - W[i - 1].y));
  return out;
}

const at = (W: readonly P[], L: readonly number[], s: number): P => {
  if (s <= 0) return W[0];
  if (s >= L[L.length - 1]) return W[W.length - 1];
  let i = 1;
  while (i < L.length - 1 && L[i] < s) i++;
  const span = L[i] - L[i - 1];
  return lerp(W, i, span > 0 ? (s - L[i - 1]) / span : 0);
};

/** Compass bearing, in a y-grows-south pixel frame. */
const bearingOf = (dx: number, dy: number): number => (deg(Math.atan2(dx, -dy)) + 360) % 360;

export function buildBerthGeometry(
  published: LatLon,
  berth: LatLon,
  road: readonly LatLon[] = [],
  opts: { windowM?: number } = {},
): BerthMapGeometry {
  const windowM = opts.windowM ?? ROAD_WINDOW_M;
  const lat0 = (published.lat + berth.lat) / 2;
  const mpp = metresPerPx(lat0, Z);

  const a = world(published, Z), b = world(berth, Z);
  const W = road.map((p) => world(p, Z));

  const crowM = Math.hypot(b.x - a.x, b.y - a.y) * mpp;

  // ── Is this polyline the road through both markers? ────────────────────────
  // Same test the static inset used: both ends within ROAD_NEAR_M of the line.
  // A route the rider's option names but whose path has not arrived yet (or a
  // stop genuinely off its own line) falls through to no road at all — the two
  // markers and the basemap still say where to stand.
  const nearPx = ROAD_NEAR_M / mpp;
  if (W.length < 2) {
    return { road: [], arrow: null, publishedLink: null, onRoad: false, alongM: crowM };
  }
  const L = arcLengths(W);
  const pa = projectOnto(W, a), pb = projectOnto(W, b);
  if (!(pa.d < nearPx && pb.d < nearPx)) {
    return { road: [], arrow: null, publishedLink: null, onRoad: false, alongM: crowM };
  }

  // ── The stretch, run PAST both markers rather than clipped between them ────
  // Clipping exactly published-to-berth left the line stopping dead at two dots
  // in the middle of a street, and where the published coordinate is off the
  // kerb it stopped short of the very dot it was there to explain. A published
  // polyline carries a vertex only where the road turns, so both ends are
  // interpolated rather than selected.
  const sa = L[pa.i - 1] + pa.t * (L[pa.i] - L[pa.i - 1]);
  const sb = L[pb.i - 1] + pb.t * (L[pb.i] - L[pb.i - 1]);
  const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
  const reach = windowM / mpp;
  const from = Math.max(0, lo - reach), to = Math.min(L[L.length - 1], hi + reach);
  const pts: P[] = [at(W, L, from)];
  for (let i = 0; i < W.length; i++) if (L[i] > from && L[i] < to) pts.push(W[i]);
  pts.push(at(W, L, to));

  // ── The tie-line, when the published dot is genuinely off its own road ─────
  let publishedLink: BerthMapGeometry["publishedLink"] = null;
  const foot = lerp(W, pa.i, pa.t);
  if (pa.d * mpp > LINK_MIN_M) {
    publishedLink = [unworld(a, Z), unworld(foot, Z)];
  }

  // ── One arrowhead, on the road, clear of both dots ─────────────────────────
  // The polyline runs in the direction buses drive (the premise `alignStops.ts`
  // rests on), so the tangent is read off increasing index and never guessed.
  // Between the markers where there is room for it; otherwise just upstream of
  // the first, which is still the stretch the bus is about to drive.
  const between = hi - lo;
  const u = between * mpp >= ARROW_BETWEEN_MIN_M
    ? (lo + hi) / 2
    : Math.max(0, lo - ARROW_UPSTREAM_M / mpp);
  const tip = at(W, L, u);
  const ahead = at(W, L, Math.min(L[L.length - 1], u + 4 / mpp));
  const behind = at(W, L, Math.max(0, u - 4 / mpp));
  const arrow: BerthArrow = {
    ...unworld(tip, Z),
    bearingDeg: +bearingOf(ahead.x - behind.x, ahead.y - behind.y).toFixed(1),
  };

  const drawn = pts.map((p) => unworld(p, Z));
  return {
    road: drawn,
    arrow,
    publishedLink,
    onRoad: true,
    alongM: +(between * mpp).toFixed(1),
  };
}

/**
 * Which of the two markers hangs its label ABOVE its dot. The labels are
 * Leaflet tooltips now, so they cannot be re-placed per zoom the way the SVG
 * clamped them — but they still must not collide, and the dots can be a few
 * pixels apart vertically (Building 900's are 27 px apart at z18). The
 * northernmost dot takes the upper side and the other takes the lower, so the
 * two always open away from each other however close they are.
 */
export const labelSides = (published: LatLon, berth: LatLon): {
  published: "top" | "bottom";
  berth: "top" | "bottom";
} => (published.lat >= berth.lat
  ? { published: "top", berth: "bottom" }
  : { published: "bottom", berth: "top" });

/** Exported for the tests that pin the rules this module is built on. */
export const BERTH_MAP_CONSTANTS = {
  ROAD_NEAR_M, ROAD_WINDOW_M, LINK_MIN_M, ARROW_BETWEEN_MIN_M, ARROW_UPSTREAM_M,
};

/** Exported for the tests only — the projection they check the geometry in. */
export const __projection = { world, unworld, metresPerPx, Z };
