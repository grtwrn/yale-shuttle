import type { legs, stopVisits } from "../db/schema.js";

import type { VisitEvent } from "./departure.js";

export type StopVisitRow = typeof stopVisits.$inferInsert;
export type LegRow = typeof legs.$inferInsert;

/**
 * The reducer's events as `stop_visits` / `legs` rows.
 *
 * One mapping, used by the live collector (`persistVisits`) and by the archive
 * backfill (`scripts/backfill-departures.ts`), so a row written from a capture
 * file is byte-identical to the one the collector would have written had it
 * been running. `dow`/`hour` follow the ET convention of `arrivals`/`segments`
 * (process TZ), keyed on the instant a consumer groups by: the arrival for a
 * visit, the departure for a leg.
 */
export function visitRowsOf(events: readonly VisitEvent[]): { visitRows: StopVisitRow[]; legRows: LegRow[] } {
  const visitRows: StopVisitRow[] = [];
  const legRows: LegRow[] = [];
  const ts = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
  for (const e of events) {
    if (e.kind === "visit") {
      const d = new Date(e.arrivedAt ?? e.anchoredAt);
      visitRows.push({
        busId: e.busId,
        busName: e.busName,
        anchorBusId: e.anchorBusId,
        routeId: e.routeId,
        stopId: e.stopId,
        stopIndex: e.stopIndex,
        anchoredAt: new Date(e.anchoredAt),
        pinnedAt: ts(e.pinnedAt),
        arrivedAt: ts(e.arrivedAt),
        departedAt: ts(e.departedAt),
        standSec: e.standSec,
        insideSec: e.insideSec,
        outcome: e.outcome,
        how: e.how,
        confidence: e.confidence,
        firstStepM: e.firstStepM,
        steps: e.steps,
        farM: e.farM,
        confirmSec: e.confirmSec,
        restPolls: e.restPolls,
        shuffles: e.shuffles,
        firstMovedAt: ts(e.firstMovedAt),
        lastAtRestAt: ts(e.lastAtRestAt),
        closestM: e.closestM,
        dow: d.getDay(),
        hour: d.getHours(),
      });
    } else {
      const d = new Date(e.departedAt);
      legRows.push({
        busId: e.busId,
        busName: e.busName,
        routeId: e.routeId,
        fromStopId: e.fromStopId,
        fromIndex: e.fromIndex,
        toStopId: e.toStopId,
        toIndex: e.toIndex,
        hops: e.hops,
        departedAt: d,
        arrivedAt: new Date(e.arrivedAt),
        toPinnedAt: ts(e.toPinnedAt),
        legSec: e.legSec,
        holdSec: e.holdSec,
        driveSec: e.driveSec,
        holds: e.holds,
        reached: e.reached,
        dow: d.getDay(),
        hour: d.getHours(),
      });
    }
  }
  return { visitRows, legRows };
}
