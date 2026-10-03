import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Collector } from "../collector/collector.js";
import { stepManyWithVisits, type VisitEvent, type VisitState } from "../collector/departure.js";
import { planTracks, type BusObservation, type BusState } from "../collector/detector.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";
import { parseStopSkips, skipNotice } from "../../web/src/stopSkips.js";
import {
  classifyPasses, createStopSkips, LOOKBACK_MS, stopSkipsOf,
  type Fix, type StopPass, type StopSkipsWire, type VisitRow,
} from "./stopSkips.js";
import { createBusesPayloadCache } from "./v1compat.js";

const SCHEMA = `CREATE TABLE stop_visits(bus_id INTEGER, route_id INTEGER, stop_id INTEGER, stop_index INTEGER,
    anchored_at INTEGER, closest_m REAL);
  CREATE INDEX stop_visits_time_idx ON stop_visits(anchored_at);
  CREATE TABLE raw_positions(bus_id INTEGER, collected_at INTEGER, lat REAL, lon REAL);
  CREATE INDEX raw_positions_bus_time_idx ON raw_positions(bus_id, collected_at);`;

// -- 2026-10-03, replayed --------------------------------------------------------
//
// Every Purple position the rider harness recorded that day, through the
// collector's own detector, written to the tables the way the collector writes
// them: a visit row when the detector emits it, a position when it is polled.
// The summary is read minute by minute from only what existed at that minute.

const fx = JSON.parse(gunzipSync(readFileSync(new URL("./__fixtures__/purple-union-skips-2026-10-03.json.gz", import.meta.url))).toString()) as {
  stops: Stop[]; route: Route; buses: Record<string, string>; fixes: [number, number, number, number, number, number | null][];
};
const purple = TransitNetwork.build(fx.stops, [fx.route]);
const names: Record<number, string> = Object.fromEntries(fx.stops.map((s) => [s.id, s.name]));
const coords: Record<number, { lat: number; lon: number }> = Object.fromEntries(fx.stops.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
const UNION_S = 122, CHURCH_S = 1;
const at = (hhmm: string) => Date.parse(`2026-10-03T${hhmm}:00Z`);

function replayDay(): Map<number, StopSkipsWire | null> {
  const obs: BusObservation[] = fx.fixes.map(([busId, t, lat, lon, heading, lastStopId]) => ({
    busId, busName: fx.buses[String(busId)]!, routeId: 10, lat, lon, heading, lastStopId, collectedAt: t,
  }));
  const states = new Map<string, BusState>(), visits = new Map<string, VisitState>();
  const written: { at: number; v: Extract<VisitEvent, { kind: "visit" }> }[] = [];
  for (let i = 0; i < obs.length;) {
    let j = i;
    while (j < obs.length && obs[j]!.collectedAt === obs[i]!.collectedAt) j++;
    const poll = obs.slice(i, j);
    for (const e of stepManyWithVisits(purple, states, visits, poll, planTracks(poll)).visits) {
      if (e.kind === "visit") written.push({ at: poll[0]!.collectedAt, v: e });
    }
    i = j;
  }
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const putVisit = db.prepare("INSERT INTO stop_visits VALUES (?,?,?,?,?,?)");
  const putFix = db.prepare("INSERT INTO raw_positions VALUES (?,?,?,?)");
  const out = new Map<number, StopSkipsWire | null>();
  let vi = 0, oi = 0;
  for (let t = at("09:30"); t <= at("20:54"); t += 60_000) {
    while (vi < written.length && written[vi]!.at <= t) {
      const { v } = written[vi++]!;
      putVisit.run(v.busId, v.routeId, v.stopId, v.stopIndex, v.anchoredAt, v.closestM);
    }
    while (oi < obs.length && obs[oi]!.collectedAt <= t) {
      const o = obs[oi++]!;
      putFix.run(o.busId, o.collectedAt, o.lat, o.lon);
    }
    out.set(t, createStopSkips(db)(purple, t));
  }
  db.close();
  return out;
}
const day = replayDay();
const noticeAt = (t: number) => skipNotice(parseStopSkips(day.get(t)), "Purple", [10], UNION_S, names, coords);

describe("Union Station (S), 2026-10-03 (unionskip20261003)", () => {
  it("warns the rider who waited there from 19:24Z until giving up at 20:09Z", () => {
    // Run 1791055477789: #330 went by 180 m away at 19:39Z and #317 175 m away
    // at 20:02Z. On master the card said nothing about either.
    for (let t = at("19:24"); t <= at("20:09"); t += 60_000) {
      expect(day.get(t)?.["10"]?.[String(UNION_S)], new Date(t).toISOString()).toMatchObject({ alt: CHURCH_S });
    }
    expect(noticeAt(at("19:30"))).toBe(
      "⚠️ 2 of the last 3 Purple buses skipped Union Station (S). Try 100 Church Street South (4 min walk).");
    expect(noticeAt(at("20:30"))).toBe(
      "⚠️ The last 3 Purple buses skipped Union Station (S). Try 100 Church Street South (4 min walk).");
  });

  it("says nothing all morning, while every bus served the stop", () => {
    // 14 passes between 09:35Z and 15:55Z came 13–72 m from the pole (one more
    // at 77 m is a kerb, not a skip). The first skip was #330 at 16:42Z.
    for (let t = at("09:30"); t <= at("17:00"); t += 60_000) expect(day.get(t), new Date(t).toISOString()).toBeNull();
  });

  it("starts after the second skip and ends when a bus serves the stop again", () => {
    // Skips at 16:42Z and 16:59Z; the second is confirmed once #317 has left
    // West Haven Train Station. #330 served the pole at 18:38Z (22 m).
    expect(day.get(at("17:11"))).toBeNull();
    expect(day.get(at("17:13"))?.["10"]?.[String(UNION_S)]).toMatchObject({ skipped: 2, of: 3 });
    expect(day.get(at("18:39"))?.["10"]?.[String(UNION_S)]).toBeDefined();
    expect(day.get(at("18:41"))).toBeNull();
  });

  it("never names another Purple stop", () => {
    for (const wire of day.values()) {
      if (!wire) continue;
      expect(Object.keys(wire)).toEqual(["10"]);
      expect(Object.keys(wire["10"]!)).toEqual([String(UNION_S)]);
    }
  });
});

// -- The guards, one at a time ---------------------------------------------------
//
// A straight north–south line of five stops 400 m apart. Each test drives one
// bus past stop 3 (index 2) and changes one thing.

const DEG_PER_M_LAT = 1 / 111_320;
const LINE: Stop[] = [1, 2, 3, 4, 5].map((id) => ({ id, name: `S${id}`, lat: 41.3 + (id - 1) * 400 * DEG_PER_M_LAT, lon: -72.93 }));
const line = TransitNetwork.build(LINE, [{ id: 50, name: "Test", shortName: "T", color: "000000", stops: [1, 2, 3, 4, 5] }]);
const T0 = Date.parse("2026-10-03T19:00:00Z");
const DEG_PER_M_LON = 1 / (111_320 * Math.cos((41.3 * Math.PI) / 180));

const visit = (busId: number, index: number, anchoredAt: number, closestM = 20): VisitRow =>
  ({ busId, routeId: 50, stopId: index + 1, stopIndex: index, anchoredAt, closestM });
/** A bus driving from stop 2 to stop 4, `offsetM` east of the stops, one fix every 5 s. */
function driveBy(from: number, to: number, offsetM: number, holeFrom = Infinity, holeTo = -Infinity): Fix[] {
  const out: Fix[] = [];
  for (let t = from; t <= to; t += 5_000) {
    if (t > holeFrom && t < holeTo) continue;
    const f = (t - from) / (to - from);
    out.push({ at: t, lat: LINE[1]!.lat + f * (LINE[3]!.lat - LINE[1]!.lat), lon: -72.93 + offsetM * DEG_PER_M_LON });
  }
  return out;
}
const trackOf = (fixes: Fix[]) => (_bus: number, from: number, to: number) => fixes.filter((f) => f.at >= from && f.at <= to);
/** One pass by stop 3 starting at `t`: anchored at 2, 3 and 4, two minutes apart. */
function pass(t: number, offsetM: number, busId = 7) {
  return {
    visits: [visit(busId, 1, t), visit(busId, 2, t + 120_000, offsetM), visit(busId, 3, t + 240_000)],
    fixes: driveBy(t, t + 240_000 + 120_000, offsetM),
  };
}
const verdict = (visits: VisitRow[], fixes: Fix[]) =>
  classifyPasses(visits, line, trackOf(fixes)).filter((p) => p.stopId === 3).map((p) => p.verdict);

describe("judging one pass", () => {
  it("a bus that never comes within 150 m of the pole skipped it", () => {
    const p = pass(T0, 175);
    expect(verdict(p.visits, p.fixes)).toEqual(["skipped"]);
  });

  it("a bus within 75 m served it", () => {
    const p = pass(T0, 30);
    expect(verdict(p.visits, p.fixes)).toEqual(["served"]);
  });

  it("a kerb or shuffle 80–140 m out counts neither way", () => {
    const p = pass(T0, 110);
    expect(verdict(p.visits, p.fixes)).toEqual(["unknown"]);
  });

  it("a hole in the feed counts neither way", () => {
    const p = pass(T0, 175);
    expect(verdict(p.visits, driveBy(T0, T0 + 360_000, 175, T0 + 60_000, T0 + 180_000))).toEqual(["unknown"]);
  });

  it("a bus that served the pole while the detector anchored a neighbour served it", () => {
    // Green's Orange / Bradley (N): `closest_m` 430 on the stop's own row, a
    // fix 4 m from the pole during the previous anchor.
    const p = pass(T0, 175);
    const visits = [p.visits[0]!, { ...p.visits[1]!, closestM: 430 }, p.visits[2]!];
    const fixes = [...p.fixes.filter((f) => f.at > T0 + 60_000), { at: T0 + 30_000, lat: LINE[2]!.lat, lon: -72.93 + 4 * DEG_PER_M_LON }];
    expect(verdict(visits, fixes.sort((a, b) => a.at - b.at))).toEqual(["served"]);
  });

  it("a bus on another leg is not a pass at all", () => {
    // Purple's return leg anchors Union Station (S) from 385 m on every lap,
    // coming from the far end of the line.
    const visits = [visit(7, 4, T0), visit(7, 2, T0 + 120_000, 385), visit(7, 0, T0 + 240_000)];
    expect(verdict(visits, driveBy(T0, T0 + 360_000, 385))).toEqual([]);
  });

  it("a bus that leaves the line (deadhead, end of service) is not judged a skip", () => {
    const p = pass(T0, 175);
    expect(verdict(p.visits.slice(0, 2), p.fixes)).toEqual([]);
    // Nor when its next visit is far down the line or much later.
    expect(verdict([...p.visits.slice(0, 2), visit(7, 0, T0 + 240_000)], p.fixes)).toEqual([]);
    expect(verdict([...p.visits.slice(0, 2), visit(7, 3, T0 + 120_000 + 21 * 60_000)], p.fixes)).toEqual([]);
  });

  it("a served pass counts before the bus reaches the next stop", () => {
    const p = pass(T0, 20);
    expect(verdict(p.visits.slice(0, 2), p.fixes)).toEqual(["served"]);
  });
});

describe("when to warn", () => {
  const passAt = (min: number, v: "served" | "skipped", stopId = 3): StopPass =>
    ({ routeId: 50, stopId, at: T0 + min * 60_000, verdict: v });
  const now = T0 + 100 * 60_000;

  it("needs the latest pass skipped and at least 2 of the last 3", () => {
    expect(stopSkipsOf([passAt(10, "served"), passAt(40, "skipped"), passAt(70, "skipped")], line, now))
      .toEqual({ 50: { 3: { skipped: 2, of: 3, last_at: T0 + 70 * 60_000 } } });
    expect(stopSkipsOf([passAt(40, "skipped"), passAt(70, "skipped"), passAt(90, "served")], line, now)).toBeNull();
    expect(stopSkipsOf([passAt(40, "served"), passAt(70, "served"), passAt(90, "skipped")], line, now)).toBeNull();
    expect(stopSkipsOf([passAt(90, "skipped")], line, now)).toBeNull();
  });

  it("forgets passes older than two hours, so last night's skips are gone by morning", () => {
    const old = (now - LOOKBACK_MS - T0) / 60_000 - 1;
    expect(stopSkipsOf([passAt(old, "skipped"), passAt(old + 0.5, "skipped"), passAt(90, "skipped")], line, now)).toBeNull();
  });

  it("names the stop before as the alternative only while buses serve it, within 500 m", () => {
    const skipping = [passAt(40, "skipped"), passAt(70, "skipped")];
    expect(stopSkipsOf([...skipping, passAt(68, "served", 2)], line, now)?.["50"]?.["3"]?.alt).toBe(2);
    expect(stopSkipsOf([...skipping, passAt(68, "skipped", 2)], line, now)?.["50"]?.["3"]?.alt).toBeUndefined();
    expect(stopSkipsOf(skipping, line, now)?.["50"]?.["3"]?.alt).toBeUndefined();
    const far = TransitNetwork.build(LINE.map((s) => (s.id === 2 ? { ...s, lat: s.lat - 200 * DEG_PER_M_LAT } : s)),
      [{ id: 50, name: "Test", shortName: "T", color: "000000", stops: [1, 2, 3, 4, 5] }]);
    expect(stopSkipsOf([...skipping, passAt(68, "served", 2)], far, now)?.["50"]?.["3"]?.alt).toBeUndefined();
  });
});

describe("serving it", () => {
  it("reads the collector's tables and never throws", () => {
    const db = new Database(":memory:");
    expect(createStopSkips(db)(line, T0)).toBeNull();
    db.exec(SCHEMA);
    const putVisit = db.prepare("INSERT INTO stop_visits VALUES (?,?,?,?,?,?)");
    const putFix = db.prepare("INSERT INTO raw_positions VALUES (?,?,?,?)");
    for (const [k, t] of [T0, T0 + 30 * 60_000].entries()) {
      const p = pass(t, 175, 7 + k);
      for (const v of p.visits) putVisit.run(v.busId, v.routeId, v.stopId, v.stopIndex, v.anchoredAt, v.closestM);
      for (const f of p.fixes) putFix.run(7 + k, f.at, f.lat, f.lon);
    }
    const read = createStopSkips(db);
    const now = T0 + 40 * 60_000;
    expect(read(line, now)).toEqual({ 50: { 3: { skipped: 2, of: 2, last_at: T0 + 32 * 60_000 } } });
    // Re-read at most once a minute.
    db.exec("DELETE FROM stop_visits");
    expect(read(line, now + 59_000)).not.toBeNull();
    expect(read(line, now + 60_000)).toBeNull();
    db.close();
  });

  it("is additive on /api/buses: the field only while there is something to say", () => {
    const collector = {
      ref: { get: () => line }, getLiveBuses: () => [], lapAges: () => undefined, derivedPaths: () => new Map(),
      announcements: () => [], routeActive: () => ({}), dataVersion: () => 1, observationVersion: () => 1,
    } as unknown as Collector;
    const plain = createBusesPayloadCache(collector, null)();
    expect(createBusesPayloadCache(collector, null, null, () => null)()).toBe(plain);
    const wire: StopSkipsWire = { 50: { 3: { skipped: 2, of: 3, last_at: T0, alt: 2 } } };
    const on = JSON.parse(createBusesPayloadCache(collector, null, null, () => wire)()) as Record<string, unknown>;
    expect(on["stop_skips"]).toEqual(wire);
    delete on["stop_skips"];
    expect(on).toEqual(JSON.parse(plain));
  });
});
