// The little picture beside "Wait about 55 m past the published stop".
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
// would, as plain <image> elements inside the SVG: one to a handful of requests
// from the host the map already uses, no map object at all.
//
// That forces the projection to be Web Mercator rather than the equirectangular
// one `routeThumb.ts` uses, because the coordinates have to agree with the
// tiles to the pixel. Everything here is therefore in WORLD PIXELS at a chosen
// zoom, where a tile (x, y) occupies [256x, 256y] to [256(x+1), 256(y+1)] — so
// placing a tile is subtraction, and placing a point is the same subtraction.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO THINGS THE FIRST VERSION GOT WRONG, both measured on all ten cells
// (`scripts/berth-inset-measure.ts`, 2026-09-10):
//
// 1. ONE SCALE, NOT A PER-CELL FIT. It picked the deepest zoom at which the
//    pair fitted, so the resolution was set by the pair's COMPASS BEARING and
//    not by its length: Chapel / Dwight (39.9 m, bearing 116°) drew at 0.22 m
//    per pixel and 300 George St (74.9 m, bearing 180°) at 0.94 — a 4.3x
//    difference in detail for a 1.9x difference in distance, and no scale cue
//    to tell them apart. Every cell now draws at `TARGET_M_PER_PX`, zooming out
//    only if a pair is too long to fit; so a 91 m offset LOOKS 2.4x farther
//    than a 38 m one, which is the whole point, and `scale.m` gives the reader
//    a bar to check it against.
//
// 2. THE LONG EDGE BELONGS TO THE OFFSET. 7 of the 10 measured pairs lie within
//    40° of the north-south axis, including the two longest (90.6 m at 167° and
//    74.9 m at 180°) — New Haven's shuttle stops are mostly on north-south
//    streets. A landscape box therefore put the fact being shown on the SHORT
//    axis and spent its width on unrelated blocks, and holding ONE scale for
//    all ten cells north-up would have needed a box 277 px tall (100 Church
//    Street South) where the card can afford 160. So the whole tile group is
//    rotated about the box centre until the road between the two markers lies
//    along the long edge. Labels are placed after the rotation, so they stay
//    upright.
//
// The rotation is taken MODULO 180°, and that is a measured decision too:
// pointing travel right in every cell stood three of the ten (300 George St,
// Church / George, Chapel / Dwight — all westbound) on their heads, mirroring
// the basemap's own street names, which reads as a broken picture. Modulo 180
// the fit is identical and every OSM label stays the right way up; the
// direction is carried by the ARROWHEAD instead, which is what it is for, and
// by the heading's own words.
//
// North is still not up. The reference frame a rider standing at a kerb
// actually has is the street and the direction the bus comes from; a north-up
// thumbnail of a north-south block is the version that could not be drawn.

import type { LatLon } from "./geo";

export interface BerthThumbPoint { x: number; y: number; }
export interface BerthThumbTile { x: number; y: number; z: number; px: number; py: number; size: number; }
/** Where to draw the one arrowhead, and the direction of travel there. */
export interface BerthThumbArrow { x: number; y: number; deg: number; }
/** A round number of metres and how long that is in this picture. */
export interface BerthThumbScale { m: number; px: number; }

export interface BerthThumb {
  width: number;
  height: number;
  viewBox: string;
  published: BerthThumbPoint;
  berth: BerthThumbPoint;
  /** The road through both of them, clipped from the route's polyline. */
  road: BerthThumbPoint[];
  /**
   * Published stop dot -> its own place on the road, drawn only when the
   * published coordinate is visibly off the line (36.7 m at 300 George St).
   * Without it that dot reads as a mistake rather than as the fact it is.
   */
  publishedLink: { x1: number; y1: number; x2: number; y2: number } | null;
  arrow: BerthThumbArrow | null;
  /** OSM tiles to draw behind, positioned BEFORE the rotation. */
  tiles: BerthThumbTile[];
  /** The rotation to hang on the tile group: `rotate(deg, cx, cy)`. */
  tileTransform: string;
  rotationDeg: number;
  /** True when the arrowhead points right, i.e. "past" is drawn to the right. */
  travelsRight: boolean;
  /** Metres represented by the full width — for a scale note. */
  spanM: number;
  metresPerPx: number;
  scale: BerthThumbScale;
  /** Anchor points for the two upright labels; both are centred on their dot. */
  publishedLabel: BerthThumbPoint;
  berthLabel: BerthThumbPoint;
  zoom: number;
}

const TILE = 256;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * The one resolution every cell draws at. 0.45 m/px puts the longest offset we
 * ship (90.6 m at 100 Church Street South) 201 px apart and the shortest
 * (38.0 m at Canal / Munson) 84 px apart, so both fit a 300 px card with room
 * for labels, and it lands on tile zoom 18 at scale ~1.0 at this latitude —
 * i.e. OSM's own pixels, never upscaled into softness.
 */
const TARGET_M_PER_PX = 0.45;
/** Deeper than 19 there are no tiles; shallower than 15 a 40 m offset is a blob. */
const MAX_ZOOM = 19;
const MIN_ZOOM = 15;
/** Fraction of the usable axis the pair may take before we zoom out. */
const FILL = 0.86;
/** A published dot this far off the road line gets a tie-line to it. */
const LINK_MIN_PX = 6;
/** Both ends must sit on this polyline, or it is not the road between them. */
const ROAD_NEAR_M = 60;
/** Kept clear at the foot of the box for the scale bar and the OSM credit. */
const RESERVED_BOTTOM = 30;

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

/** 10, 20, 25 … — the bar has to be a number a rider can hold in their head. */
const NICE_M = [5, 10, 20, 25, 50, 100, 200, 500];
function scaleBar(mPerPx: number, width: number): BerthThumbScale {
  const max = 0.34 * width;
  let pick = NICE_M[0];
  for (const m of NICE_M) if (m / mPerPx <= max) pick = m;
  return { m: pick, px: +(pick / mPerPx).toFixed(1) };
}

/**
 * Does a rotated tile square overlap the box at all? Separating-axis over both
 * shapes' edge normals — the cheap bounding-box version keeps corner tiles that
 * are entirely off screen, and each one is a wasted OSM request.
 */
function showsInBox(quad: readonly BerthThumbPoint[], width: number, height: number): boolean {
  const box = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  for (const [A, B] of [[quad, box], [box, quad]] as const) {
    for (let i = 0; i < A.length; i++) {
      const p = A[i], q = A[(i + 1) % A.length];
      const ax = -(q.y - p.y), ay = q.x - p.x;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of A) { const d = v.x * ax + v.y * ay; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const v of B) { const d = v.x * ax + v.y * ay; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

export function buildBerthThumb(
  published: LatLon,
  berth: LatLon,
  road: readonly LatLon[] = [],
  opts: {
    width?: number;
    height?: number;
    /** Room kept along each edge for a label to sit in. */
    pad?: number;
    /** Half the widest label, in px — labels are clamped to stay inside. */
    labelHalfW?: number;
    maxZoom?: number;
  } = {},
): BerthThumb {
  const width = opts.width ?? 300;
  const height = opts.height ?? 160;
  const pad = opts.pad ?? 24;
  const labelHalfW = opts.labelHalfW ?? 42;
  const maxZoom = opts.maxZoom ?? MAX_ZOOM;

  const lat0 = (published.lat + berth.lat) / 2;

  // ── Direction of travel, which sets the rotation ───────────────────────────
  // Off the route's own polyline, whose vertices run in the direction buses
  // drive (the premise `alignStops.ts` rests on). Without a polyline the walk
  // from the published stop to the berth is the only axis there is.
  let travel: { x: number; y: number } | null = null;
  const Z_DIR = 18; // any zoom will do for a direction; world px are conformal
  const Wdir = road.map((p) => world(p, Z_DIR));
  const sDir = world(published, Z_DIR), bDir = world(berth, Z_DIR);
  const nearDirPx = ROAD_NEAR_M / metresPerPx(lat0, Z_DIR);
  let onRoad = false;
  if (Wdir.length >= 2) {
    const pa = projectOnto(Wdir, sDir), pb = projectOnto(Wdir, bDir);
    onRoad = pa.d < nearDirPx && pb.d < nearDirPx;
    if (onRoad) {
      // The tangent across the whole stretch, not one vertex pair: a single
      // segment can be 1 m long where a road turns.
      const A = lerp(Wdir, pa.i, pa.t), B = lerp(Wdir, pb.i, pb.t);
      const fwd = pa.i < pb.i || (pa.i === pb.i && pa.t <= pb.t);
      travel = fwd ? { x: B.x - A.x, y: B.y - A.y } : { x: A.x - B.x, y: A.y - B.y };
    }
  }
  if (!travel || Math.hypot(travel.x, travel.y) < 1e-6) {
    travel = { x: bDir.x - sDir.x, y: bDir.y - sDir.y };
  }
  // Rotate the world so the direction of travel lies along the LONG edge. SVG's
  // rotate() turns clockwise in this y-down frame, which is the same sense as
  // atan2 here.
  //
  // Travel points right where it can, and LEFT where pointing it right would
  // stand the basemap on its head: of the ten cells, three (300 George St,
  // Church / George, Chapel / Dwight) drive west, and a travel-always-right
  // rule drew their street names mirrored and their house numbers upside down
  // — a picture that reads as broken. So the rotation is taken modulo 180°,
  // which changes nothing about the fit (the pair still lies on the long edge
  // at the same scale) and leaves every OSM label the right way up. What
  // carries the direction instead is the ARROWHEAD, which is what it is for.
  let rot = -Math.atan2(travel.y, travel.x);
  const travelsRight = Math.abs(rot) <= Math.PI / 2;
  if (!travelsRight) rot += rot > 0 ? -Math.PI : Math.PI;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const spin = (p: P): P => ({ x: p.x * cosR - p.y * sinR, y: p.x * sinR + p.y * cosR });

  // ── One scale for every cell, zoomed out only if the pair will not fit ─────
  const pairVec = spin({ x: bDir.x - sDir.x, y: bDir.y - sDir.y });
  const mPerDirPx = metresPerPx(lat0, Z_DIR);
  const alongM = Math.abs(pairVec.x) * mPerDirPx;
  const acrossM = Math.abs(pairVec.y) * mPerDirPx;
  const fitNeed = Math.max(
    alongM / (FILL * Math.max(width - 2 * pad, 1)),
    acrossM / (FILL * Math.max(height - 2 * pad, 1)),
  );
  const want = Math.max(TARGET_M_PER_PX, fitNeed);

  const K = 156543.03392 * Math.cos(rad(lat0));
  // The NEAREST tile zoom, not the deepest that fits. Taking the deepest put
  // 0.45 m/px on zoom 17 at this latitude (zoom 18 is 0.449 m/px — a hair too
  // coarse to qualify) and drew every tile at 1.99x, i.e. visibly soft, for
  // nothing. Rounding lands on 18 at 1.00x, and bounds the softness at sqrt(2)
  // for any target.
  const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, Math.round(Math.log2(K / want))));
  const mppTile = metresPerPx(lat0, zoom);
  // Leaflet draws between integer zooms and so does this: one scale factor for
  // the geometry AND the tiles, so the streets stay under the dots.
  const scale = Math.max(0.6, Math.min(2, mppTile / want));
  const mPerPx = mppTile / scale;

  const a = world(published, zoom), b = world(berth, zoom);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const bx = width / 2, by = height / 2;
  /** Tile frame: scaled and centred, BEFORE the rotation the group carries. */
  const place0 = (p: P): P => ({ x: (p.x - cx) * scale + bx, y: (p.y - cy) * scale + by });
  /** Everything drawn upright is rotated here instead, numerically. */
  const place = (p: P): BerthThumbPoint => {
    const q = place0(p);
    const r = spin({ x: q.x - bx, y: q.y - by });
    return { x: +(r.x + bx).toFixed(1), y: +(r.y + by).toFixed(1) };
  };

  // ── The road, run PAST both markers rather than clipped between them ───────
  // The first version clipped exactly published-to-berth, which left the line
  // stopping dead at two dots in the middle of a street — and where the
  // published coordinate is off the kerb (7.1 m at Chapel / Dwight, 36.7 m at
  // 300 George St) it stopped short of the dot it was meant to explain. The
  // window is now the box's own diagonal either side, and the clip rect trims
  // it; a published polyline carries a vertex only where the road turns, so the
  // ends are interpolated rather than selected.
  let drawn: BerthThumbPoint[] = [];
  let publishedLink: BerthThumb["publishedLink"] = null;
  if (Wdir.length >= 2 && onRoad) {
    const W = road.map((p) => world(p, zoom));
    const L = arcLengths(W);
    const pa = projectOnto(W, a), pb = projectOnto(W, b);
    const sa = L[pa.i - 1] + pa.t * (L[pa.i] - L[pa.i - 1]);
    const sb = L[pb.i - 1] + pb.t * (L[pb.i] - L[pb.i - 1]);
    const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
    const reach = Math.hypot(width, height) / scale;
    const from = Math.max(0, lo - reach), to = Math.min(L[L.length - 1], hi + reach);
    const pts: P[] = [at(W, L, from)];
    for (let i = 0; i < W.length; i++) if (L[i] > from && L[i] < to) pts.push(W[i]);
    pts.push(at(W, L, to));
    drawn = pts.map(place);

    const s = place(a);
    const proj = projectOnto(drawn, s);
    const foot = lerp(drawn, proj.i, proj.t);
    if (proj.d > LINK_MIN_PX) {
      publishedLink = { x1: s.x, y1: s.y, x2: +foot.x.toFixed(1), y2: +foot.y.toFixed(1) };
    }
  }

  // ── Tiles: only those the ROTATED box actually shows ───────────────────────
  // A rotated box's bounding box in the tile frame spans up to 3x3 tiles, and
  // its corner tiles are often entirely off screen — 9 requests for 4 tiles of
  // picture. Each candidate is therefore carried FORWARD through the rotation
  // and tested against the box properly, which takes Church / George from 9
  // tiles to 4.
  const tiles: BerthThumbTile[] = [];
  const n = 2 ** zoom;
  const back = (p: P): P => {
    const r = { x: p.x - bx, y: p.y - by };
    const u = { x: r.x * cosR + r.y * sinR, y: -r.x * sinR + r.y * cosR };
    return { x: u.x / scale + cx, y: u.y / scale + cy };
  };
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }].map(back);
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  for (let tx = Math.floor(Math.min(...xs) / TILE); tx <= Math.floor(Math.max(...xs) / TILE); tx++) {
    for (let ty = Math.floor(Math.min(...ys) / TILE); ty <= Math.floor(Math.max(...ys) / TILE); ty++) {
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      const quad = [
        { x: tx * TILE, y: ty * TILE }, { x: (tx + 1) * TILE, y: ty * TILE },
        { x: (tx + 1) * TILE, y: (ty + 1) * TILE }, { x: tx * TILE, y: (ty + 1) * TILE },
      ].map(place);
      if (!showsInBox(quad, width, height)) continue;
      const p = place0({ x: tx * TILE, y: ty * TILE });
      tiles.push({ x: tx, y: ty, z: zoom, px: +p.x.toFixed(1), py: +p.y.toFixed(1), size: +(TILE * scale).toFixed(1) });
    }
  }

  const s = place(a), t = place(b);

  // ── One arrowhead, on the road, clear of both dots ─────────────────────────
  // It must sit on the stretch the bus drives BETWEEN the two markers, or just
  // upstream of them. Taking the point of the drawn line farthest from both
  // dots put Church / George's arrow on the far side of the Blue Night loop,
  // pointing down the cross street — 145 px away from anything this picture is
  // about. The polyline runs in the direction buses drive, so the tangent is
  // read off increasing index and never guessed.
  let arrow: BerthThumbArrow | null = null;
  if (drawn.length >= 2) {
    const L = arcLengths(drawn);
    const total = L[L.length - 1];
    const us = (() => { const pr = projectOnto(drawn, s); return L[pr.i - 1] + pr.t * (L[pr.i] - L[pr.i - 1]); })();
    const ut = (() => { const pr = projectOnto(drawn, t); return L[pr.i - 1] + pr.t * (L[pr.i] - L[pr.i - 1]); })();
    const lo = Math.min(us, ut), hi = Math.max(us, ut);
    const between = hi - lo;
    for (const u of [between >= 36 ? (lo + hi) / 2 : lo - 26, lo - 26, hi + 26, (lo + hi) / 2]) {
      const at0 = Math.max(0, Math.min(total, u));
      const p = at(drawn, L, at0);
      if (p.x < 12 || p.x > width - 12 || p.y < 12 || p.y > height - 12) continue;
      if (Math.min(Math.hypot(p.x - s.x, p.y - s.y), Math.hypot(p.x - t.x, p.y - t.y)) < 11) continue;
      const q = at(drawn, L, Math.min(total, at0 + 5)), r = at(drawn, L, Math.max(0, at0 - 5));
      arrow = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), deg: +deg(Math.atan2(q.y - r.y, q.x - r.x)).toFixed(1) };
      break;
    }
  }

  // ── Labels: upright, centred on their dot, one above and one below ─────────
  // Above/below rather than left/right so they cannot collide however close the
  // dots are, and clamped so a dot near an edge still gets its whole word.
  // The HIGHER dot's label goes above it and the lower dot's below it, so the
  // two always open away from each other. Choosing by dot ROLE instead put both
  // of Building 900's labels in the middle 3.6 px apart (its dots are 27 px
  // apart vertically and each picked the side facing the other), and choosing
  // by which side had more room did the same thing. A side is given up only to
  // stay inside the box.
  // The bottom strip belongs to the scale bar and the credit: 300 George St's
  // published dot sits low and left, and its label landed straight on top of
  // "50 m".
  const clampX = (x: number) => +Math.max(labelHalfW + 3, Math.min(width - labelHalfW - 3, x)).toFixed(1);
  const above = (p: BerthThumbPoint) => +(p.y - 12 < 12 ? p.y + 19 : p.y - 12).toFixed(1);
  const below = (p: BerthThumbPoint) => +(p.y + 19 > height - RESERVED_BOTTOM ? p.y - 12 : p.y + 19).toFixed(1);
  const publishedHigher = s.y <= t.y;

  return {
    width, height, viewBox: `0 0 ${width} ${height}`,
    published: s, berth: t,
    road: drawn, publishedLink, arrow,
    tiles, tileTransform: `rotate(${(deg(rot)).toFixed(2)} ${bx} ${by})`,
    rotationDeg: +deg(rot).toFixed(2), travelsRight,
    spanM: Math.round(width * mPerPx),
    metresPerPx: +mPerPx.toFixed(4),
    scale: scaleBar(mPerPx, width),
    publishedLabel: { x: clampX(s.x), y: publishedHigher ? above(s) : below(s) },
    berthLabel: { x: clampX(t.x), y: publishedHigher ? below(t) : above(t) },
    zoom,
  };
}

/** Exported for the tests that pin the rule this module is built on. */
export const BERTH_THUMB_CONSTANTS = { TARGET_M_PER_PX, MIN_ZOOM, MAX_ZOOM, FILL, ROAD_NEAR_M, RESERVED_BOTTOM };
