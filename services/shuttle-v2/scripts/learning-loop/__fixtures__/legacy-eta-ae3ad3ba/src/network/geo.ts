// Small geo helpers shared across the network and planner.
// Equirectangular projection is accurate to <0.1% over a ~5 km radius,
// which covers Yale's network with room to spare; the full haversine
// formula is overkill here.

const METERS_PER_DEG_LAT = 111_320;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Meters between two coordinates via equirectangular projection. */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const midLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * METERS_PER_DEG_LAT * Math.cos(midLatRad);
  const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Build a closure that projects (lat, lon) to local meters around `center`.
 * Reusing the same cos(lat) avoids the trig call per point — material when
 * projecting thousands of polyline vertices on every snapshot.
 */
export function makeProjector(center: LatLon): (p: LatLon) => [number, number] {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  return (p) => [
    (p.lon - center.lon) * METERS_PER_DEG_LAT * cosLat,
    (p.lat - center.lat) * METERS_PER_DEG_LAT,
  ];
}
