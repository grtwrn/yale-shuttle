import { describe, expect, it } from "vitest";

import {
  aggregate,
  chainSummary,
  chooseAlight,
  compareRuns,
  dedupeAndSort,
  fmtSequence,
  groupPolls,
  parseCaptureLine,
  parseRiderArg,
  scoreWait,
  stopVisits,
  subsample,
  truthFor,
  type PosRow,
  type RiderSpec,
  type Tick,
  type WaitResult,
} from "./lib";

const T0 = Date.parse("2026-09-03T21:00:00Z");
const row = (o: Partial<PosRow>): PosRow => ({ i: 1, b: "#1", r: 3, lat: 41.32, lon: -72.92, h: 0, l: null, t: T0, ...o });

describe("positions", () => {
  it("parses a capture line and rejects junk", () => {
    expect(parseCaptureLine('{"bus_id":65885,"bus_name":"#306","route_id":8,"lat":41.28609,"lon":-72.952305,"heading":239,"last_stop_id":109,"collected_at":1788443472343}'))
      .toEqual({ i: 65885, b: "#306", r: 8, lat: 41.28609, lon: -72.952305, h: 239, l: 109, t: 1788443472343 });
    expect(parseCaptureLine("")).toBeNull();
    expect(parseCaptureLine("not json")).toBeNull();
    expect(parseCaptureLine('{"bus_id":1}')).toBeNull();
  });

  it("de-duplicates the recorder's overlapping day files on (bus_id, collected_at)", () => {
    const a = row({ i: 1, t: T0 });
    const b = row({ i: 2, t: T0 });
    const c = row({ i: 1, t: T0 + 5000 });
    const out = dedupeAndSort([c, a, b, { ...a }, { ...c }]);
    expect(out).toEqual([a, b, c]);
  });

  it("groups rows sharing collected_at into one poll", () => {
    const polls = groupPolls([row({ i: 1, t: T0 }), row({ i: 2, t: T0 }), row({ i: 1, t: T0 + 5000 })]);
    expect(polls.map((p) => p.length)).toEqual([2, 1]);
  });
});

describe("truth: the curb rule", () => {
  // stop A at the origin; the bus approaches along a line, sits, leaves
  const stopCoords = { 10: { lat: 41.32, lon: -72.92 }, 11: { lat: 41.33, lon: -72.92 } };
  const stopsFor = () => [10, 11];
  const m = 1 / 111_000; // ~1 m of latitude
  const track = [
    row({ t: T0, lat: 41.32 + 500 * m }),
    row({ t: T0 + 5000, lat: 41.32 + 100 * m }),
    row({ t: T0 + 10000, lat: 41.32 + 40 * m }), // inside 45 m -> enter
    row({ t: T0 + 15000, lat: 41.32 + 5 * m }),
    row({ t: T0 + 20000, lat: 41.32 + 80 * m }), // still armed (< 120 m)
    row({ t: T0 + 25000, lat: 41.32 + 200 * m }), // exit
    row({ t: T0 + 30000, lat: 41.32 + 30 * m }), // second visit
  ];
  const visits = stopVisits(track, stopsFor, stopCoords);

  it("records one interval per approach, re-arming past 120 m", () => {
    const v = visits.get(10)!;
    expect(v.map((x) => [x.enter - T0, x.exit === null ? null : x.exit - T0])).toEqual([[10000, 25000], [30000, null]]);
    expect(visits.get(11)).toBeUndefined();
  });

  it("a rider arriving before the bus gets its first approach", () => {
    expect(truthFor(visits.get(10), [3], T0 + 2000, 60 * 60_000)).toEqual({ kind: "arrived", at: T0 + 10000, busName: "#1" });
  });

  it("a rider arriving while the bus is at the stop is boardedOnArrival; armed, they get the next approach", () => {
    expect(truthFor(visits.get(10), [3], T0 + 12000, 60 * 60_000)).toEqual({ kind: "boardedOnArrival", busName: "#1" });
    expect(truthFor(visits.get(10), [3], T0 + 12000, 60 * 60_000, true)).toEqual({ kind: "arrived", at: T0 + 30000, busName: "#1" });
  });

  it("another line's bus is not an arrival, and the give-up bound holds", () => {
    expect(truthFor(visits.get(10), [99], T0, 60 * 60_000)).toEqual({ kind: "none" });
    expect(truthFor(visits.get(10), [3], T0, 5000)).toEqual({ kind: "none" });
  });
});

describe("riders", () => {
  it("parses a named rider", () => {
    expect(parseRiderArg("Red@48@2026-09-03T21:18:03Z")).toEqual({ label: "Red", boardStopId: 48, t0: Date.parse("2026-09-03T21:18:03Z") });
    expect(() => parseRiderArg("Red@48")).toThrow();
  });

  it("picks an alight stop about a quarter loop ahead and at least 500 m away", () => {
    const m = 1 / 111_000;
    const stops = [1, 2, 3, 4, 5, 6, 7, 8];
    const stopCoords: Record<number, { lat: number; lon: number }> = {};
    stops.forEach((s, i) => { stopCoords[s] = { lat: 41.3 + i * 100 * m, lon: -72.9 }; });
    // from stop 1, quarter loop = 2 stops ahead = 200 m (too near), first >= 500 m is stop 6
    expect(chooseAlight(stops, 0, stopCoords)).toBe(6);
    // wrapping: from stop 7 the candidates go 1, 2, ... ; stop 1 is 600 m back -> 1
    expect(chooseAlight(stops, 6, stopCoords)).toBe(1);
  });
});

// -- scoring ---------------------------------------------------------------------

const spec: RiderSpec = { id: "Red|48|x", label: "Red", boardStopId: 48, alightStopId: 11, t0: T0, source: "named" };
const tick = (sec: number, token: string | null, bus = "309", state: Tick["state"] = token ? "countdown" : "departed"): Tick =>
  ({ t: T0 + sec * 1000, state, token, etaSec: null, nextSec: null, bus, missedBus: null });

describe("scoreWait", () => {
  it("a healthy countdown scores zero drift and a first-sight miss inside the bucket", () => {
    const ticks = [tick(0, "in 3, 20 min"), tick(60, "in 2, 19 min"), tick(120, "in 1, 18 min"), tick(180, "in <1, 17 min"), tick(200, "now, then 17 min")];
    const r = scoreWait(spec, ticks, { kind: "arrived", at: T0 + 205_000, busName: "#309" }, null, "arrived", { sampleMs: 5000 });
    expect(r.transitions).toEqual([]);
    expect(r.worstDriftSec).toBe(0);
    expect(r.firstSight).toEqual({ atMs: T0, raw: "in 3, 20 min", lo: 180, hi: 240 });
    expect(r.firstSightMissSec).toBe(0);
    expect(r.strand).toBe(false);
    expect(r.pins).toEqual(["309"]);
    expect(r.waitSec).toBe(205);
    expect(r.sequence).toBe("21:00:00 in 3, 20 min | 21:01:00 in 2, 19 min | 21:02:00 in 1, 18 min | 21:03:00 in <1, 17 min | 21:03:20 now, then 17 min");
  });

  it("told 7, then 2, gone in 66 s is a STRAND", () => {
    const ticks = [tick(0, "in 7, 30 min"), tick(15, "in 2, 30 min"), tick(60, "in 1, 30 min")];
    const r = scoreWait(spec, ticks, { kind: "arrived", at: T0 + 81_000, busName: "#304" }, null, "arrived", { sampleMs: 5000 });
    expect(r.worst!.driftSec).toBe(-225); // 7 min bucket [420,480) -> 2 min [120,180) in 15 s: at least 420-180-15
    expect(r.catastrophic).toBe(1);
    expect(r.strand).toBe(true);
    expect(r.firstSightMissSec).toBe(-339); // promised >= 420 s, came after 81
  });

  it("the same collapse with no bus for three minutes is not a strand, but is an overshoot", () => {
    const ticks = [tick(0, "in 7, 30 min"), tick(15, "in 2, 30 min"), tick(60, "in 1, 30 min")];
    const r = scoreWait(spec, ticks, { kind: "arrived", at: T0 + 240_000, busName: "#304" }, null, "arrived", { sampleMs: 5000 });
    expect(r.strand).toBe(false);
    expect(r.overshoot).toBe(false); // 225 < 420 shown before it
    const r2 = scoreWait(spec, [tick(0, "in 1, 30 min"), tick(15, "in 56 min")], { kind: "arrived", at: T0 + 22_000, busName: "#301" }, null, "arrived", { sampleMs: 5000 });
    expect(r2.overshoot).toBe(true);
    expect(r2.worst!.driftSec).toBeGreaterThan(3000);
    expect(r2.lapRepriced).toBe(true); // same bus, +54 min
    expect(r2.reversals).toBe(1);
  });

  it("counts reversals, pin changes and vanishing", () => {
    const ticks = [
      tick(0, "in 5, 20 min", "309"),
      tick(60, "in 3, 20 min", "309"),
      tick(120, "in 8, 20 min", "309"), // clock reset: +5 min
      tick(180, null, "309"), // Departed
      tick(240, "in 4, 20 min", "304"), // another bus
    ];
    const r = scoreWait(spec, ticks, { kind: "arrived", at: T0 + 500_000, busName: "#304" }, null, "arrived", { sampleMs: 5000 });
    expect(r.notableReversals).toBe(1);
    expect(r.worst!.driftSec).toBe(300);
    expect(r.pins).toEqual(["309", "304"]);
    expect(r.pinChanged).toBe(true);
    expect(r.vanished).toBe(1);
    expect(r.returned).toBe(true);
    // the transition after the gap is not scored (the canary resets on a missing reading)
    expect(r.transitions.map((t) => t.driftSec)).toEqual([300]);
  });

  it("subsamples to the canary's cadence", () => {
    const ticks = [0, 5, 10, 15, 20, 25, 30].map((s) => tick(s, "in 3 min"));
    expect(subsample(ticks, T0, 15_000).map((k) => (k.t - T0) / 1000)).toEqual([0, 15, 30]);
    expect(subsample(ticks, T0, 0).length).toBe(7);
  });

  it("a wait with no countdown at all is flagged, and fmtSequence compresses repeats", () => {
    const ticks = [tick(0, null, "309", "nopin"), tick(5, null, "309", "nopin")];
    const r = scoreWait(spec, ticks, { kind: "arrived", at: T0 + 20_000, busName: "#309" }, null, "arrived", { sampleMs: 5000 });
    expect(r.neverShown).toBe(true);
    expect(fmtSequence(ticks)).toBe("21:00:00 (no countdown)");
  });
});

describe("chain: the departure moment", () => {
  it("scores the raw rise beyond the clock at +0/+30/+60 s and the displayed drift at the departure poll", () => {
    const T = T0 + 100_000;
    const chainSpec: RiderSpec = { ...spec, id: "Red|146|c", boardStopId: 146, source: "chain", eventT: T, eventBus: "#316" };
    const tk = (sec: number, eta: number): Tick => ({ t: T0 + sec * 1000, state: "countdown", token: `in ${Math.floor(eta / 60)} min`, etaSec: eta, nextSec: null, bus: "316", missedBus: null });
    // parked: ticking down 5 s a poll; at the departure the ETA jumps +180 s beyond the clock, then keeps rising
    const ticks = [tk(80, 200), tk(85, 195), tk(90, 190), tk(95, 185), tk(100, 360), tk(105, 355), tk(130, 420), tk(160, 430)];
    const r = scoreWait(chainSpec, ticks, { kind: "arrived", at: T0 + 400_000, busName: "#316" }, null, "arrived", { sampleMs: 5000 });
    expect(r.departure).toBeDefined();
    expect(r.departure!.watching).toBe(true);
    expect(r.departure!.riseAt0).toBe(180); // 360 - 185 + 5
    expect(r.departure!.riseAt30).toBe(270); // 420 - 185 + 35
    expect(r.departure!.riseAt60).toBe(310); // 430 - 185 + 65
    expect(r.departure!.drift).toBeGreaterThan(0); // "3 min" -> "6 min" in 5 s
    const c = chainSummary([r], [146, 49]);
    expect(c.departure.watching).toBe(1);
    expect(c.departure.riseAt0.p50).toBe(180);
    expect(c.departure.byStop["146"]!.n).toBe(1);
    expect(c.departure.byStop["49"]!.n).toBe(0);
    expect(c.stops.map((s) => s.hops)).toEqual([1, 2]);
  });

  it("a rider who was not watching at the departure contributes no rise", () => {
    const T = T0 + 100_000;
    const chainSpec: RiderSpec = { ...spec, id: "Red|146|c2", boardStopId: 146, source: "chain", eventT: T, eventBus: "#316" };
    const ticks: Tick[] = [{ t: T0 + 90_000, state: "departed", token: null, etaSec: null, nextSec: null, bus: "316", missedBus: null }];
    const r = scoreWait(chainSpec, ticks, { kind: "arrived", at: T0 + 400_000, busName: "#316" }, null, "arrived", { sampleMs: 5000 });
    expect(r.departure!.watching).toBe(false);
    expect(r.departure!.riseAt0).toBeNull();
  });
});

describe("aggregate and compare", () => {
  const mk = (id: string, over: Partial<WaitResult>): WaitResult => ({
    id, label: "Red", boardStopId: 48, alightStopId: 11, t0: T0, source: "uniform", outcome: "arrived", busAtStopOnArrival: null,
    arrivedAt: T0 + 300_000, arrivedBus: "#1", detectorArrivedAt: null, waitSec: 300, ticks: 60, readings: 60,
    firstSight: { atMs: T0, raw: "in 5 min", lo: 300, hi: 360 }, firstSightMissSec: 0,
    transitions: [], reversals: 0, notableReversals: 0, catastrophic: 0, worstDriftSec: 0, worst: null,
    pins: ["1"], pinChanged: false, vanished: 0, returned: false, lapRepriced: false, strand: false, overshoot: false, neverShown: false,
    sequence: "", ...over,
  });
  const a = [mk("w1", {}), mk("w2", { worstDriftSec: 200, catastrophic: 1, strand: true }), mk("w3", { outcome: "gaveUp", arrivedAt: null, waitSec: null }), mk("w4", { busAtStopOnArrival: "#1" })];

  it("summarises shares over scored waits only", () => {
    const s = aggregate(a);
    expect(s.all.waits).toBe(4);
    expect(s.all.arrived).toBe(2);
    expect(s.all.gaveUp).toBe(1);
    expect(s.all.boardedOnArrival).toBe(1);
    expect(s.all.scored).toBe(2);
    expect(s.all.pctJump180).toBe(50);
    expect(s.all.pctStrand).toBe(50);
    expect(s.all.medianWaitMin).toBe(5);
    expect(s.byRoute.Red!.scored).toBe(2);
    expect(s.worstWaits[0]!.id).toBe("w2");
  });

  it("pairs two runs wait for wait", () => {
    const b = [mk("w1", { worstDriftSec: 190 }), mk("w2", {}), mk("w3", { outcome: "gaveUp", arrivedAt: null, waitSec: null }), mk("w5", {})];
    const c = compareRuns(a, b);
    expect(c.paired).toBe(3);
    expect(c.onlyA).toBe(1);
    expect(c.onlyB).toBe(1);
    expect(c.jump180).toEqual({ both: 0, onlyA: 1, onlyB: 1, neither: 0 });
    expect(c.examples.fixed).toEqual(["w2"]);
    expect(c.examples.introduced).toEqual(["w1"]);
    expect(c.worstDriftDelta.improved).toBe(1);
    expect(c.worstDriftDelta.worsened).toBe(1);
  });
});
