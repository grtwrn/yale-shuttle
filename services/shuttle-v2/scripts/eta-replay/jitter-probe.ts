/**
 * Is the shared-endpoint tie a knife edge at the exact stop coordinate, or a
 * real oscillation? Walk a bus through every stop of every route in the
 * snapshot, jitter it, and count how often the anchor changes.
 */
import { loadNet } from "./common.js";
import { registerRoutePaths, ANCHOR_GPS_THRESHOLD_M } from "../../web/src/anchor.js";
import { distanceToSegmentM, traceStopLegs } from "../../web/src/geo.js";
import { ROUTE_LISTS, mergedRouteStops } from "../../web/src/routes.js";
import type { LatLon } from "../../web/src/geo.js";

const net = loadNet();
registerRoutePaths(net.routePaths);

const pick = (cands: number[], d: number[], lastIdx: number, N: number, EPS: number) => {
  let keep = cands;
  if (lastIdx >= 0) { const k = cands.filter((i) => ((i - lastIdx + N) % N) <= 5); if (k.length) keep = k; }
  let nearest = Infinity;
  for (const i of keep) if (d[i]! < nearest) nearest = d[i]!;
  const tied = keep.filter((i) => d[i]! <= nearest + EPS);
  if (lastIdx >= 0) tied.sort((a, b) => {
    const fa = (a - lastIdx + N) % N, fb = (b - lastIdx + N) % N;
    return fa !== fb ? fa - fb : d[a]! - d[b]!;
  });
  else tied.sort((a, b) => d[a]! - d[b]!);
  return tied[0]!;
};

const OFFSETS = [-30, -20, -10, -5, 0, 5, 10, 20, 30];
for (const EPS of [0, 15, 30, 60, 80]) {
  let cases = 0, unstable = 0, spread = 0;
  for (const cfg of ROUTE_LISTS) {
    const stops = mergedRouteStops(cfg, net.routeStops);
    const N = stops.length;
    if (N < 3) continue;
    const path = net.routePaths[cfg.routeIds[0]!];
    let legs: (readonly [number, number])[][] | null = null;
    if (path && path.length >= 2) {
      const ring: LatLon[] = stops.map((s) => net.stopCoords[s]!);
      ring.push(ring[0]!);
      const t = traceStopLegs(path, ring);
      if (t.length === N) legs = t.map((l) => l.slice);
    }
    const distsAt = (p: LatLon) => {
      const out: number[] = new Array(N);
      for (let i = 0; i < N; i++) {
        const leg = legs?.[i];
        if (leg && leg.length >= 2) {
          let best = Infinity;
          for (let j = 0; j + 1 < leg.length; j++) {
            const d = distanceToSegmentM(p, { lat: leg[j]![0], lon: leg[j]![1] }, { lat: leg[j + 1]![0], lon: leg[j + 1]![1] });
            if (d < best) best = d;
          }
          out[i] = best;
        } else {
          out[i] = distanceToSegmentM(p, net.stopCoords[stops[i]!]!, net.stopCoords[stops[(i + 1) % N]!]!);
        }
      }
      return out;
    };
    for (let k = 0; k < N; k++) {
      const c = net.stopCoords[stops[k]!]!;
      const lastIdx = (k - 1 + N) % N;  // the feed's usual lag: the stop before
      // Jitter PERPENDICULAR to the road here, which is what GPS noise does:
      // along-track displacement is real movement and should move the anchor.
      const a = net.stopCoords[stops[lastIdx]!]!, b = net.stopCoords[stops[(k + 1) % N]!]!;
      const kx = Math.cos((c.lat * Math.PI) / 180);
      let ux = (b.lon - a.lon) * kx, uy = b.lat - a.lat;
      const un = Math.hypot(ux, uy) || 1;
      ux /= un; uy /= un;
      const answers = OFFSETS.map((m) => {
        // rotate the unit vector 90 degrees, then step m metres along it
        const p = { lat: c.lat + (ux * m) / 111_000, lon: c.lon - (uy * m) / (111_000 * kx) };
        const d = distsAt(p);
        const cands: number[] = [];
        for (let i = 0; i < N; i++) if (d[i]! < ANCHOR_GPS_THRESHOLD_M) cands.push(i);
        if (!cands.length) return -1;
        return pick(cands, d, lastIdx, N, EPS);
      });
      cases++;
      const uniq = new Set(answers);
      if (uniq.size > 1) unstable++;
      // ignoring the exact-coordinate sample, is it still unstable?
      const off = new Set(answers.filter((_, i) => OFFSETS[i] !== 0));
      if (off.size > 1) spread++;
    }
  }
  console.log(`EPS=${String(EPS).padStart(2)}  stops ${cases}  anchor differs across +-30 m: ${unstable} (${(100 * unstable / cases).toFixed(1)}%)   excluding the exact coordinate: ${spread} (${(100 * spread / cases).toFixed(1)}%)`);
}
