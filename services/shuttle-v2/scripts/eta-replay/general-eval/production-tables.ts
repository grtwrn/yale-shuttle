/** Causal replay of the actual production calibrator and serializer. */
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { calibrate } from "../../../src/calibrator/calibrator.js";
import { TransitNetwork } from "../../../src/network/TransitNetwork.js";
import { buildBusesPayload } from "../../../src/server/v1compat.js";
import * as schema from "../../../src/db/schema.js";
import type { Collector } from "../../../src/collector/collector.js";

export function productionTables(sqlite: Database.Database, cutoff: number) {
  const rows = sqlite.prepare("SELECT * FROM main.routes").all() as any[];
  const stops = sqlite.prepare("SELECT * FROM main.stops").all() as any[];
  const routes = rows.map(r => ({ id: r.id, name: r.name, shortName: r.short_name, color: r.color,
    stops: JSON.parse(r.stops_json), path: r.path_json ? JSON.parse(r.path_json) : undefined }));
  const network = TransitNetwork.build(stops, routes);
  const visits = sqlite.prepare("SELECT * FROM main.stop_visits ORDER BY bus_name,route_id,anchored_at,id").all() as any[];
  const anchors = new Map<string, number[]>();
  for (const v of visits) {
    const key = `${v.bus_name}:${v.route_id}`, group = anchors.get(key) ?? [];
    group.push(v.anchored_at); anchors.set(key, group);
  }
  function knownAt(bus: string, route: number, after: number): number {
    const group = anchors.get(`${bus}:${route}`) ?? [];
    let lo = 0, hi = group.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (group[mid]! <= after) lo = mid + 1; else hi = mid; }
    return group[lo + 1] === undefined ? Infinity : group[lo + 1]! + 120_000;
  }
  sqlite.exec("CREATE TEMP TABLE allowed_visits(id INTEGER PRIMARY KEY); CREATE TEMP TABLE allowed_legs(id INTEGER PRIMARY KEY)");
  const addVisit = sqlite.prepare("INSERT INTO allowed_visits VALUES (?)");
  const addLeg = sqlite.prepare("INSERT INTO allowed_legs VALUES (?)");
  sqlite.transaction(() => {
    for (const v of visits) if (knownAt(v.bus_name, v.route_id, Math.max(v.anchored_at, v.departed_at ?? 0, v.pinned_at ?? 0)) <= cutoff) addVisit.run(v.id);
    for (const l of sqlite.prepare("SELECT * FROM main.legs").all() as any[]) {
      if (knownAt(l.bus_name, l.route_id, Math.max(l.departed_at, l.arrived_at, l.to_pinned_at ?? 0)) <= cutoff) addLeg.run(l.id);
    }
  })();
  // TEMP views shadow the source tables only on this read-only connection.
  sqlite.exec(`
    CREATE TEMP VIEW stop_visits AS SELECT v.* FROM main.stop_visits v JOIN allowed_visits a USING(id);
    CREATE TEMP VIEW legs AS SELECT l.* FROM main.legs l JOIN allowed_legs a USING(id);
    CREATE TEMP VIEW arrivals AS SELECT * FROM main.arrivals WHERE arrived_at + COALESCE(dwell_sec,0)*1000 <= ${cutoff};
    CREATE TEMP VIEW segments AS SELECT * FROM main.segments WHERE started_at + travel_sec*1000 <= ${cutoff};
  `);
  calibrate(drizzle(sqlite, { schema }), network, new Date(cutoff));
  const collector = { ref: { get: () => network }, getLiveBuses: () => [], derivedPaths: () => new Map(), announcements: () => [], routeActive: () => ({}) } as unknown as Collector;
  return { payload: buildBusesPayload(collector), network, cutoff,
    availability: "two subsequent same-bus same-route anchors after physical completion plus 120 seconds; legacy samples completed before cutoff" };
}
