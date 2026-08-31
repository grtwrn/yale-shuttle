// Pure geometry helpers shared by the planner, the arrivals board and the
// map layers. Extracted from TransitMap.tsx so the maths is reachable from
// tests without mounting React or Leaflet — behaviour is unchanged.

export type LatLon = { lat: number; lon: number };

export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Fraction of the way from a to b that p projects onto (0 = at a, 1 = at b).
// Values outside [0, 1] mean p sits beyond an endpoint. Projecting onto the
// segment axis is what makes the anchor stable against perpendicular GPS
// jitter. Straight-line distance comparisons aren't robust: a bus at the
// midpoint flips "closer to A" vs "closer to B" on noise, wrecking both
// anchor-advance and mid-segment proration.
export function progressAlongSegment(p: LatLon, a: LatLon, b: LatLon): number {
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const scale = Math.cos(meanLat);
  const ax = a.lon * scale, ay = a.lat;
  const bx = b.lon * scale, by = b.lat;
  const px = p.lon * scale, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-12) return 0;
  return ((px - ax) * dx + (py - ay) * dy) / denom;
}

// Distance from a point to a line segment, in meters (flat-earth
// approximation adequate for intra-campus distances). Unlike the line
// distance, this clamps projection to [0, 1] — points past either
// endpoint return distance to that endpoint, not some imagined
// perpendicular into the wrong direction.
export function distanceToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const t = Math.max(0, Math.min(1, progressAlongSegment(p, a, b)));
  const projLat = a.lat + (b.lat - a.lat) * t;
  const projLon = a.lon + (b.lon - a.lon) * t;
  const dlat = (p.lat - projLat) * 111_000;
  const dlon = (p.lon - projLon) * 84_000;
  return Math.sqrt(dlat * dlat + dlon * dlon);
}
