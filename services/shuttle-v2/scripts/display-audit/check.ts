// Compare the actual screen calculators with independently counted route calls.
// These are feed-correlated consistency checks, not physical arrival truth.
import { registerRoutePaths, isBusOnRoute } from '../../web/src/anchor';
import { attachServerEta, serverArrivals, serverTrack } from '../../web/src/etaSource';
import { anchorIndexOnList, observedAtStop, rideApproach, rideStopsToExit } from '../../web/src/liveAnchor';
import type { BusData } from '../../web/src/map-data';
import { mergedRouteStops, ROUTE_LISTS } from '../../web/src/routes';
import { nextRouteStop } from '../../web/src/nextRouteStop';

export interface AuditFeed {
  buses: BusData[];
  routes: Record<string, number[]>;
  stop_coords: Record<number, { lat: number; lon: number }>;
  route_paths?: Record<string, [number, number][]>;
  server_eta?: unknown;
}
export interface Finding {
  kind: 'standing-position' | 'pickup-count' | 'exit-count' | 'next-stop';
  line: string; bus: string; standingStop: number; targetStop: number;
  expected: number; actual: number | null;
}
export function auditDisplay(feed: AuditFeed, now: number) {
  const findings: Finding[] = [];
  const coverage = { buses: feed.buses.length, confirmedStands: 0, positions: 0, pickupCounts: 0, exitCounts: 0, nextStops: 0, foldedCountsSkipped: 0 };
  registerRoutePaths(feed.route_paths ?? null);
  try {
    if (!attachServerEta(feed.buses, feed.server_eta, now)) throw new Error('Missing, invalid, or expired server ETA snapshot');
    for (const cfg of ROUTE_LISTS) {
      const seq = mergedRouteStops(cfg, feed.routes);
      if (!seq.length) continue;
      const folded = new Set(seq).size !== seq.length;
      for (const bus of feed.buses.filter(b => cfg.busRouteIds.includes(b.route_id))) {
        // A successful HTTP poll alone does not make an individual bus fresh.
        if (!Number.isFinite(bus.observed_at) || now - bus.observed_at! >= 45_000 || bus.observed_at! > now + 5000) continue;
        const standing = serverTrack(bus, cfg.label, now)?.standing;
        if (!standing || standing.approach || !observedAtStop(bus, standing.stopId, feed.stop_coords)
          || !isBusOnRoute(bus, seq, feed.stop_coords)) continue;
        const start = seq.indexOf(standing.stopId);
        if (start < 0) continue;
        coverage.confirmedStands++;
        const base = { line: cfg.label, bus: bus.bus_name, standingStop: standing.stopId };
        const display = [...new Set(seq)]; // the overview's actual physical-stop rows
        const index = anchorIndexOnList(bus, cfg, feed.routes, feed.stop_coords, display, now);
        coverage.positions++;
        if (display[index] !== standing.stopId) findings.push({ ...base, kind: 'standing-position', targetStop: standing.stopId,
          expected: standing.stopId, actual: display[index] ?? null });
        // A physical stop cannot identify the outbound/return occurrence.
        // Their counts need the recorded pass-specific regressions instead.
        if (folded) { coverage.foldedCountsSkipped++; continue; }
        const arrivals = serverArrivals(feed.buses, seq, now)!.filter(a => a.routeLabel === cfg.label
          && a.busName.replace(/^#/, '') === bus.bus_name.replace(/^#/, ''));
        const expectedNext = seq[(start + 1) % seq.length]!;
        if (arrivals.some(a => a.stopId === expectedNext)) {
          coverage.nextStops++;
          const next = nextRouteStop(arrivals, cfg.label, bus.bus_name, standing.stopId, seq);
          if (next !== expectedNext) findings.push({ ...base, kind: 'next-stop', targetStop: expectedNext, expected: expectedNext, actual: next });
        }
        for (const target of seq) {
          const rows = arrivals.filter(a => a.stopId === target).sort((a, b) => a.eta - b.eta);
          if (!rows.length) continue;
          const expected = (seq.indexOf(target) - start + seq.length) % seq.length;
          const hops: [number, number][] = [[rows[0]!.stopsAhead, target]];
          const pickup = rideApproach(bus, cfg, feed.routes, feed.stop_coords, target, hops, now)?.length ?? null;
          const exit = rideStopsToExit(bus, cfg, feed.routes, feed.stop_coords, target, rows, now);
          coverage.pickupCounts++; coverage.exitCounts++;
          if (pickup !== expected) findings.push({ ...base, kind: 'pickup-count', targetStop: target, expected, actual: pickup });
          if (exit !== expected) findings.push({ ...base, kind: 'exit-count', targetStop: target, expected, actual: exit });
        }
      }
    }
    return { coverage, findings };
  } finally { registerRoutePaths(null); }
}
