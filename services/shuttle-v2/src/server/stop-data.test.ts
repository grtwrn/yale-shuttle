import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import { etDayStartMs } from "./actives.js";
import {
  readStopDataCatalog, readStopDataDay, readStopDataVisit, STOP_DATA_LIMITS,
  StopDataInputError, stopDataDayRange,
} from "./stop-data.js";

const DAY = "2026-09-08";
const START = etDayStartMs(DAY);
const NOW = etDayStartMs("2026-09-09");
let bundle: DbBundle;

beforeEach(() => {
  bundle = openDb(":memory:");
  migrate(bundle.db, { migrationsFolder: "./drizzle" });
  bundle.sqlite.exec(`
    INSERT INTO stops (id,name,lat,lon,updated_at) VALUES (11,'344 Winchester',41.3,-72.9,0), (48,'Prospect / Division',41.31,-72.91,0);
    INSERT INTO routes (id,name,short_name,color,stops_json,updated_at) VALUES (3,'Red','R','#f00','[11,48,11]',0);
  `);
});
afterEach(() => { bundle.sqlite.close(); });

interface Fx {
  at: number;
  bus?: string;
  busId?: number;
  stop?: number;
  index?: number;
  pin?: number | null;
  arrival?: number | null;
  departure?: number | null;
  stand?: number | null;
  outcome?: "stopped" | "passed" | "unresolved";
  how?: "far" | "next" | "clock" | "gap" | null;
}

function visit(f: Fx): string {
  const pin = f.pin === undefined ? f.at : f.pin;
  const arrival = f.arrival === undefined ? f.at - 60_000 : f.arrival;
  const departure = f.departure === undefined ? f.at + 600_000 : f.departure;
  return String(bundle.sqlite.prepare(`INSERT INTO stop_visits
    (bus_id,bus_name,anchor_bus_id,route_id,stop_id,stop_index,anchored_at,pinned_at,arrived_at,departed_at,stand_sec,
      outcome,how,confidence,steps,rest_polls,shuffles,closest_m,dow,hour)
    VALUES (?,?,1,3,?,?,?,?,?,?,?, ?,?,0.9,4,10,0,10,2,7)`).run(
    f.busId ?? 1, f.bus ?? "#40", f.stop ?? 11, f.index ?? 0, f.at, pin, arrival, departure,
    f.stand === undefined ? (arrival !== null && departure !== null ? (departure - arrival) / 1000 : null) : f.stand,
    f.outcome ?? "stopped", f.how === undefined ? "far" : f.how,
  ).lastInsertRowid);
}

function position(at: number, lat = 41.3, busId = 1, bus = "#40") {
  bundle.sqlite.prepare(`INSERT INTO raw_positions
    (bus_id,bus_name,route_id,lat,lon,heading,collected_at) VALUES (?,?,3,?,-72.9,0,?)`).run(busId, bus, lat, at);
}

const selection = { day: DAY, routeId: 3, stopId: 11, stopIndex: 0 };

describe("operator stop evidence", () => {
  it("keeps repeated stop occurrences separate and keeps both stored clocks visible", () => {
    const first = visit({ at: START + 7 * 3_600_000 });
    visit({ at: START + 8 * 3_600_000, index: 2 });
    const result = readStopDataDay(bundle.sqlite, selection, NOW);
    expect(result.totalVisits).toBe(1);
    expect(result.visits[0]).toMatchObject({ id: first, pinnedStandSec: 600, recordedStandSec: 660,
      pinnedAt: START + 7 * 3_600_000, recordedPinnedAt: START + 7 * 3_600_000 });
    const catalog = readStopDataCatalog(bundle.sqlite, NOW);
    expect(catalog.days).toEqual([{ day: DAY, visitCount: 2 }]);
    expect(catalog.routes[0]?.occurrences).toMatchObject([
      { stopId: 11, stopIndex: 0, visitCount: 1, currentTopologyMatch: true },
      { stopId: 11, stopIndex: 2, visitCount: 1, currentTopologyMatch: true },
    ]);
    expect(readStopDataDay(bundle.sqlite, { ...selection, stopIndex: 2 }, NOW).totalVisits).toBe(1);
  });

  it("preserves a historical occurrence that disagrees with the current topology", () => {
    visit({ at: START + 1000, index: 1 });
    const stop = readStopDataCatalog(bundle.sqlite, NOW).routes[0]!.occurrences[0]!;
    expect(stop).toMatchObject({ stopId: 11, stopIndex: 1, currentTopologyMatch: false });
    expect(readStopDataDay(bundle.sqlite, { ...selection, stopIndex: 1 }, NOW).totalVisits).toBe(1);
  });

  it("uses ET day boundaries at UTC midnight and on 23/25-hour DST days", () => {
    visit({ at: START - 1 });
    visit({ at: START });
    visit({ at: NOW - 1 });
    visit({ at: NOW });
    expect(readStopDataDay(bundle.sqlite, selection, NOW).visits.map((v) => v.anchoredAt)).toEqual([START, NOW - 1]);
    const spring = stopDataDayRange("2026-03-08", NOW);
    const fall = stopDataDayRange("2026-11-01", etDayStartMs("2026-11-03"));
    expect(spring.to - spring.from).toBe(23 * 3_600_000);
    expect(fall.to - fall.from).toBe(25 * 3_600_000);
  });

  it("links same-day departures across bus id rotation without crossing bus or stop identity", () => {
    visit({ at: START - 30 * 60_000, departure: START - 1 });
    const firstAt = START + 7 * 3_600_000;
    const first = visit({ at: firstAt, busId: 9 });
    visit({ at: firstAt + 20 * 60_000, index: 2 });
    visit({ at: firstAt + 25 * 60_000, bus: "#41" });
    const second = visit({ at: firstAt + 40 * 60_000, bus: "40", busId: 42 });
    const rows = readStopDataDay(bundle.sqlite, selection, NOW).visits;
    expect(rows.find((r) => r.id === first)?.previousDepartureAt).toBeNull();
    expect(rows.find((r) => r.id === second)).toMatchObject({ previousDepartureAt: firstAt + 600_000, loopSec: 2400 });
    expect(readStopDataVisit(bundle.sqlite, second, NOW)?.visit).toEqual(rows.find((r) => r.id === second));
  });

  it("does not use a prior row's departure if it occurs after the next anchor", () => {
    visit({ at: START + 7 * 3_600_000, departure: START + 9 * 3_600_000 });
    const second = visit({ at: START + 8 * 3_600_000 });
    expect(readStopDataDay(bundle.sqlite, selection, NOW).visits[1]?.previousDepartureAt).toBeNull();
    expect(readStopDataVisit(bundle.sqlite, second, NOW)?.visit.previousDepartureAt).toBeNull();
  });

  it("does not turn passes, unresolved visits, or invalid clocks into zero-minute stands", () => {
    const passed = visit({ at: START + 1_000, outcome: "passed", pin: null, stand: 0 });
    const unresolved = visit({ at: START + 2_000, outcome: "unresolved", departure: null });
    const reversed = visit({ at: START + 3_000, departure: START + 2_999 });
    const rows = readStopDataDay(bundle.sqlite, selection, NOW).visits;
    for (const id of [passed, unresolved, reversed]) expect(rows.find((r) => r.id === id)?.pinnedStandSec).toBeNull();
    expect(rows.find((r) => r.id === unresolved)?.qualityNotes.join(" ")).toContain("censored");
    expect(rows.find((r) => r.id === reversed)?.qualityNotes.join(" ")).toContain("precedes");
  });

  it("reports empty GPS coverage and missing stop coordinates truthfully", () => {
    const id = visit({ at: START + 7 * 3_600_000, stop: 999 });
    const result = readStopDataVisit(bundle.sqlite, id, NOW)!;
    expect(result.positions).toEqual([]);
    expect(result.stop.lat).toBeNull();
    expect(result.coverage).toMatchObject({ actualFrom: null, actualTo: null, maxGapSec: null, missingBefore: true, missingAfter: true });
    expect(result.warnings.join(" ")).toContain("No retained raw GPS");
  });

  it("exposes gaps and simultaneous bus-name ambiguity without inventing movement", () => {
    const at = START + 7 * 3_600_000;
    const id = visit({ at });
    position(at - 120_000);
    position(at - 115_000, 41.3, 2, "40");
    position(at - 115_000, 41.301, 3, "#40");
    position(at + 720_000, 41.301);
    position(at, 42, 7, "#unrelated");
    const result = readStopDataVisit(bundle.sqlite, id, NOW)!;
    expect(result.positions).toHaveLength(4);
    expect(result.positions[0]).toMatchObject({ distanceM: 0, gapSec: null });
    expect(result.positions[1]?.gapSec).toBe(5);
    expect(result.positions[2]?.distanceM).toBeCloseTo(111.19, 1);
    expect(result.coverage).toMatchObject({ identityAmbiguous: true, maxGapSec: 835, missingBefore: true, missingAfter: false });
    expect(result.warnings.join(" ")).toContain("connecting line");
  });

  it("caps dense GPS and long windows explicitly", () => {
    const at = START + 7 * 3_600_000;
    const id = visit({ at, departure: at + 6 * 3_600_000 });
    bundle.sqlite.transaction(() => {
      for (let i = 0; i <= STOP_DATA_LIMITS.positions; i++) position(at + i * 1000);
    })();
    const result = readStopDataVisit(bundle.sqlite, id, NOW)!;
    expect(result.positions).toHaveLength(STOP_DATA_LIMITS.positions);
    expect(result.coverage).toMatchObject({ truncated: true, windowCapped: true });
    expect(result.coverage.requestedTo - result.coverage.requestedFrom).toBe(3 * 3_600_000);
  });

  it("flags sequential name reuse or id rotation as uncertain GPS identity", () => {
    const at = START + 7 * 3_600_000;
    const id = visit({ at });
    position(at, 41.3, 1);
    position(at + 5_000, 41.301, 2);
    const result = readStopDataVisit(bundle.sqlite, id, NOW)!;
    expect(result.coverage.identityAmbiguous).toBe(true);
    expect(result.warnings.join(" ")).toContain("do not join GPS tracks");
  });

  it("includes early GPS evidence that predates a late recorded pin clock", () => {
    const at = START + 7 * 3_600_000;
    const id = visit({ at, arrival: at });
    position(at - 12 * 60_000);
    const result = readStopDataVisit(bundle.sqlite, id, NOW)!;
    expect(result.coverage.requestedFrom).toBe(at - 15 * 60_000);
    expect(result.positions[0]?.at).toBe(at - 12 * 60_000);
  });

  it("returns a full count while capping the visit payload", () => {
    bundle.sqlite.transaction(() => {
      for (let i = 0; i <= STOP_DATA_LIMITS.visits; i++) visit({ at: START + i * 1000 });
    })();
    const result = readStopDataDay(bundle.sqlite, selection, NOW);
    expect(result.totalVisits).toBe(STOP_DATA_LIMITS.visits + 1);
    expect(result.visits).toHaveLength(STOP_DATA_LIMITS.visits);
    expect(result.truncated).toBe(true);
  });

  it("rejects malformed selectors, impossible dates and injected ids", () => {
    for (const day of ["2026-02-30", "2026-09-10", "2020-01-01", "2026-9-08", "today"]) {
      expect(() => readStopDataDay(bundle.sqlite, { ...selection, day }, NOW)).toThrow(StopDataInputError);
    }
    for (const routeId of [-1, 0, 1.1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readStopDataDay(bundle.sqlite, { ...selection, routeId }, NOW)).toThrow(StopDataInputError);
    }
    expect(() => readStopDataDay(bundle.sqlite, { ...selection, stopIndex: -1 }, NOW)).toThrow(StopDataInputError);
    for (const id of ["1 OR 1=1", "0", "-1", "1.1", "01", "9007199254740992"]) {
      expect(() => readStopDataVisit(bundle.sqlite, id, NOW)).toThrow(StopDataInputError);
    }
    expect(readStopDataVisit(bundle.sqlite, "100", NOW)).toBeNull();
  });

  it("requires no write permission and never widens its allowlist to rider tables", () => {
    const id = visit({ at: START + 1000 });
    bundle.sqlite.exec("PRAGMA query_only = ON");
    expect(() => readStopDataCatalog(bundle.sqlite, NOW)).not.toThrow();
    const payload = { day: readStopDataDay(bundle.sqlite, selection, NOW), detail: readStopDataVisit(bundle.sqlite, id, NOW) };
    expect(JSON.stringify(payload)).not.toMatch(/reporter|anonId|search_term|client_ip|user_agent/);
  });
});
