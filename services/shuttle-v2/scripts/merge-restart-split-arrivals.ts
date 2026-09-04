/**
 * Merge the arrival rows a process restart split, and lengthen the dwell and
 * segment samples that were measured from the wrong end of them.
 *
 * `Collector.states` is in memory only, so until the resume landed
 * (`resumeArrival` in `src/collector/collector.ts`) every deploy made each
 * standing bus a first sighting: a second `arrivals` row for one stand, and —
 * because `dwell_sec` and `segments.travel_sec` are both measured from
 * `BusState.enteredAt` — a dwell and a segment that began at the restart
 * instead of at the arrival. Report #100 caught the rider-visible half of this;
 * this is the historical half, already on disk.
 *
 * Measured on a production snapshot taken 2026-09-04, over 30 days:
 *
 *   1,427 split stands           4.3% of every arrival row in the last 7 days
 *   1,143 segments               0.93% of the table, short by a median 98 s
 *   1,094 dwells                 0.66% of the closed arrivals, short by 101 s
 *
 * ## What it does NOT touch
 *
 * `stop_visits.pinned_at` — the column the served stand tables measure from,
 * and the most damaged of the three (344 Winchester's median stand reads 273 s
 * against 310, 333 Cedar 405 against 475). `pinned_at` is the first poll within
 * `AT_STOP_PIN_M`, and `raw_positions` is swept after six hours, so for a stand
 * a month old there is nothing left to recompute it FROM. The arrival instant
 * is not a substitute: it precedes the pin by a median 10 s and a p95 of 95 s,
 * so writing it there would put an estimate in a column that holds an
 * observation. `stop_visits` is a 30-day window and heals itself as correct
 * rows arrive; the two tables below are 90-day and do not.
 *
 * ## Identifying a restart
 *
 * A restart re-anchors EVERY live bus on one poll, so its stamp carries an
 * arrival for each of them. Ordinary coincidence puts three buses on a stamp
 * often enough (907 times in a week); six is the fleet, and gating on it
 * changes the population by 4% — the measurement is not sensitive to the
 * threshold, which is why it is a constant here and not a flag.
 *
 * ## Usage
 *
 *   npx tsx scripts/merge-restart-split-arrivals.ts --target ./store/snap.db
 *   npx tsx scripts/merge-restart-split-arrivals.ts --target ./store/snap.db --apply
 *
 * Dry run by default: it prints what it would merge and writes nothing.
 * Idempotent — a second run finds no chains, because the superseded rows are
 * gone. Run it against a snapshot before anything else.
 */
import Database from "better-sqlite3";

import { MAX_DWELL_SEC, MAX_SEGMENT_SEC } from "../src/collector/detector.js";

/** Distinct buses that must share one `arrived_at` stamp for it to be a restart. */
const RESTART_MIN_BUSES = 6;

/**
 * Longest a stand may be split across and still be one stand.
 *
 * The same 30 minutes as `STATE_TTL_MS` / the live seed window: a bus the
 * detector would have aged out is one it would have re-anchored anyway, so a
 * merge must not reach further back than the running rules would.
 */
const MAX_SPLIT_MS = 30 * 60_000;

interface ArrivalRow {
  id: number;
  busId: number;
  busName: string;
  routeId: number;
  stopId: number;
  arrivedAt: number;
  departedAt: number | null;
  dwellSec: number | null;
}

interface Chain {
  /** Oldest first. The last row is the one the departure closed. */
  rows: ArrivalRow[];
}

/** Consecutive arrivals for one bus at one stop that a restart split. */
export function findChains(rows: readonly ArrivalRow[], restarts: ReadonlySet<number>): Chain[] {
  const byBus = new Map<string, ArrivalRow[]>();
  for (const r of rows) {
    let list = byBus.get(r.busName);
    if (!list) byBus.set(r.busName, (list = []));
    list.push(r);
  }
  const chains: Chain[] = [];
  for (const list of byBus.values()) {
    list.sort((a, b) => a.arrivedAt - b.arrivedAt);
    let open: Chain | null = null;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const row = list[i]!;
      const continues =
        prev.stopId === row.stopId &&
        prev.routeId === row.routeId &&
        // The earlier row was never closed, because the process that would have
        // closed it did not survive to see the bus leave.
        prev.departedAt === null &&
        row.arrivedAt - prev.arrivedAt <= MAX_SPLIT_MS &&
        restarts.has(row.arrivedAt);
      if (continues) {
        if (!open) chains.push((open = { rows: [prev] }));
        open.rows.push(row);
      } else {
        open = null;
      }
    }
  }
  return chains;
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const targetIdx = argv.indexOf("--target");
  const target = targetIdx >= 0 ? argv[targetIdx + 1] : process.env.REPLAY_DB;
  if (!target) {
    console.error("usage: merge-restart-split-arrivals.ts --target <db> [--apply]");
    process.exit(2);
  }
  const db = new Database(target, { readonly: !apply });

  const restarts = new Set<number>(
    (
      db
        .prepare(
          `SELECT arrived_at AS t FROM arrivals GROUP BY arrived_at
           HAVING COUNT(DISTINCT bus_name) >= ?`,
        )
        .all(RESTART_MIN_BUSES) as Array<{ t: number }>
    ).map((r) => r.t),
  );
  const rows = db
    .prepare(
      `SELECT id, bus_id AS busId, bus_name AS busName, route_id AS routeId, stop_id AS stopId,
              arrived_at AS arrivedAt, departed_at AS departedAt, dwell_sec AS dwellSec
       FROM arrivals ORDER BY bus_name, arrived_at`,
    )
    .all() as ArrivalRow[];
  const chains = findChains(rows, restarts);

  const selSeg = db.prepare(
    `SELECT id, travel_sec AS travelSec FROM segments
     WHERE bus_id = ? AND route_id = ? AND from_stop_id = ? AND started_at = ?`,
  );

  let deletedArrivals = 0;
  let movedArrivals = 0;
  let lengthenedDwells = 0;
  let droppedDwells = 0;
  let lengthenedSegments = 0;
  let droppedSegments = 0;
  const dwellGain: number[] = [];
  const segGain: number[] = [];

  const work = db.transaction(() => {
    for (const chain of chains) {
      const first = chain.rows[0]!;
      const last = chain.rows[chain.rows.length - 1]!;
      const gainMs = last.arrivedAt - first.arrivedAt;
      const day = new Date(first.arrivedAt);

      // The segment that LEFT this stand started at the restart, so it is short
      // by exactly the part of the stand the restart hid.
      for (const seg of selSeg.all(last.busId, last.routeId, last.stopId, last.arrivedAt) as Array<{
        id: number;
        travelSec: number;
      }>) {
        const merged = seg.travelSec + gainMs / 1000;
        if (merged > MAX_SEGMENT_SEC) {
          // An uninterrupted process would never have recorded this: the
          // detector drops a transition longer than its own ceiling.
          droppedSegments++;
          if (apply) db.prepare("DELETE FROM segments WHERE id = ?").run(seg.id);
        } else {
          lengthenedSegments++;
          segGain.push(gainMs / 1000);
          if (apply) {
            db.prepare("UPDATE segments SET travel_sec = ?, started_at = ?, dow = ?, hour = ? WHERE id = ?").run(
              merged,
              first.arrivedAt,
              day.getDay(),
              day.getHours(),
              seg.id,
            );
          }
        }
      }

      // The surviving arrival takes the stand's real start, and its dwell with it.
      let dwellSec = last.dwellSec;
      let departedAt = last.departedAt;
      if (departedAt !== null) {
        const merged = (departedAt - first.arrivedAt) / 1000;
        if (merged > MAX_DWELL_SEC) {
          droppedDwells++;
          dwellSec = null;
          departedAt = null;
        } else {
          lengthenedDwells++;
          dwellGain.push(gainMs / 1000);
          dwellSec = merged;
        }
      }
      movedArrivals++;
      if (apply) {
        db.prepare(
          "UPDATE arrivals SET arrived_at = ?, departed_at = ?, dwell_sec = ?, dow = ?, hour = ? WHERE id = ?",
        ).run(first.arrivedAt, departedAt, dwellSec, day.getDay(), day.getHours(), last.id);
      }
      for (const dead of chain.rows.slice(0, -1)) {
        deletedArrivals++;
        if (apply) db.prepare("DELETE FROM arrivals WHERE id = ?").run(dead.id);
      }
    }
  });
  work();

  const pct = (a: number[], p: number): number =>
    a.length ? [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]! : NaN;

  console.log(`=== ${apply ? "MERGE APPLIED" : "MERGE DRY RUN"} — ${target} ===`);
  console.log(`restart instants (>=${RESTART_MIN_BUSES} buses on one arrived_at): ${restarts.size}`);
  console.log(`split stands: ${chains.length} (of ${rows.length} arrivals)`);
  console.log(`  arrivals rewound: ${movedArrivals}, superseded rows deleted: ${deletedArrivals}`);
  console.log(
    `  dwells lengthened: ${lengthenedDwells} (median +${pct(dwellGain, 0.5).toFixed(0)} s, ` +
      `p95 +${pct(dwellGain, 0.95).toFixed(0)} s), dropped past MAX_DWELL_SEC: ${droppedDwells}`,
  );
  console.log(
    `  segments lengthened: ${lengthenedSegments} (median +${pct(segGain, 0.5).toFixed(0)} s, ` +
      `p95 +${pct(segGain, 0.95).toFixed(0)} s), dropped past MAX_SEGMENT_SEC: ${droppedSegments}`,
  );
  console.log(`  stop_visits: untouched by design (see this file's header)`);
  if (!apply) console.log("\nnothing was written. Re-run with --apply against a COPY first.");
  db.close();
}

main();
