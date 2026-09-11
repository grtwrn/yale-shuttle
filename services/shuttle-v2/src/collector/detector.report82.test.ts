import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { distanceMeters } from "../network/geo.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  AT_STOP_PIN_M,
  STATIONARY_RADIUS_M,
  step,
  type BusObservation,
  type BusState,
} from "./detector.js";

/**
 * Report #82, replayed from production.
 *
 * The operator filed this as urgent from the trip view — "it jumped from 3min
 * to 8 min!" — with three screenshots ninety seconds apart. Red #316 sat at
 * 344 Winchester while its dwell chip read "5 min / ~5 min", then
 * "6 min / ~5 min", then "25s / ~5 min". The bus had not moved. Its layover
 * clock had restarted, so the client re-billed the whole ~5 min hold and the
 * trip went from 15 min / arrive 5:00p to 20 min / arrive 5:06p.
 *
 * Every coordinate below is an unedited `raw_positions` row for #316 on
 * 2026-09-03 (`bus_id` 65901 throughout — this was never an id reissue), and
 * the stops are the real ones, read from the checked-in 172-stop fixture and
 * sequenced as production's route 3 lists them. Nothing here is hand-typed
 * geometry: the whole value of the test is that it is the real yard.
 */
describe("report #82: the Red #316 layover, replayed from production", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  // Production `routes.stops_json` for route 3 (Red - Weekday Daytime).
  const RED_DAY = [
    121, 115, 45, 75, 30, 31, 41, 126, 36, 128, 120, 3, 147, 27, 11, 146, 49,
    48, 104, 113, 4, 42, 98, 38, 39, 72, 117, 13, 14,
  ];
  const routes: Route[] = [
    { id: 3, name: "Red - Weekday Daytime", shortName: "RD", color: "#FF0000", stops: RED_DAY },
  ];
  const net = TransitNetwork.build(allStops, routes);
  const byId = new Map(allStops.map((s) => [s.id, s]));

  const WINCHESTER_344 = 11;   // the garage the bus is laid over at
  const WINCHESTER_DIVISION = 146; // the next stop, ~200 m on

  /** 2026-09-03T20:39:38Z — the poll on which #316 rolls into the yard. */
  const T0 = Date.parse("2026-09-03T20:39:38Z");
  const at = (sec: number) => T0 + sec * 1000;

  /** Seconds after T0, latitude, longitude — the feed, unedited. */
  const FEED: Array<[number, number, number]> = [
  [0, 41.324138, -72.928193],
  [5, 41.324417, -72.928099],
  [10, 41.324417, -72.928099],
  [15, 41.324417, -72.928099],
  [20, 41.324417, -72.928099],
  [25, 41.324417, -72.928099],
  [30, 41.324643, -72.928366],
  [35, 41.324905, -72.928268],
  [40, 41.324905, -72.928268],
  [45, 41.324768, -72.928594],
  [50, 41.324497, -72.928678],
  [55, 41.324497, -72.928678],
  [60, 41.324497, -72.928678],
  [65, 41.324497, -72.928678],
  [70, 41.324497, -72.928678],
  [75, 41.324497, -72.928678],
  [80, 41.324497, -72.928678],
  [85, 41.324497, -72.928678],
  [90, 41.324497, -72.928678],
  [95, 41.324497, -72.928678],
  [100, 41.324497, -72.928678],
  [105, 41.324497, -72.928678],
  [110, 41.324497, -72.928678],
  [115, 41.324497, -72.928678],
  [120, 41.324497, -72.928678],
  [125, 41.324497, -72.928678],
  [130, 41.324497, -72.928678],
  [135, 41.324497, -72.928678],
  [140, 41.324497, -72.928678],
  [145, 41.324497, -72.928678],
  [150, 41.324497, -72.928678],
  [155, 41.324497, -72.928678],
  [160, 41.324497, -72.928678],
  [165, 41.324497, -72.928678],
  [170, 41.324497, -72.928678],
  [175, 41.324497, -72.928678],
  [180, 41.324497, -72.928678],
  [185, 41.324497, -72.928678],
  [190, 41.324497, -72.928678],
  [195, 41.324497, -72.928678],
  [200, 41.324497, -72.928678],
  [205, 41.324497, -72.928678],
  [210, 41.324497, -72.928678],
  [215, 41.324497, -72.928678],
  [220, 41.324497, -72.928678],
  [225, 41.324497, -72.928678],
  [230, 41.324497, -72.928678],
  [235, 41.324497, -72.928678],
  [240, 41.324497, -72.928678],
  [245, 41.324497, -72.928678],
  [250, 41.324497, -72.928678],
  [255, 41.324497, -72.928678],
  [260, 41.324497, -72.928678],
  [265, 41.324497, -72.928678],
  [270, 41.324497, -72.928678],
  [275, 41.324497, -72.928678],
  [280, 41.324497, -72.928678],
  [285, 41.324497, -72.928678],
  [290, 41.324497, -72.928678],
  [295, 41.324497, -72.928678],
  [300, 41.324497, -72.928678],
  [305, 41.324497, -72.928678],
  [310, 41.324497, -72.928678],
  [315, 41.324497, -72.928678],
  [320, 41.324497, -72.928678],
  [325, 41.324497, -72.928678],
  [330, 41.324497, -72.928678],
  [335, 41.324497, -72.928678],
  [340, 41.324185, -72.928788],
  [345, 41.323921, -72.928879],
  [350, 41.323921, -72.928879],
  [355, 41.323921, -72.928879],
  [360, 41.324035, -72.928551],
  [365, 41.324333, -72.928449],
  [370, 41.324333, -72.928449],
  [375, 41.324333, -72.928449],
  [380, 41.324333, -72.928449],
  [385, 41.324333, -72.928449],
  [390, 41.324333, -72.928449],
  [395, 41.324333, -72.928449],
  [400, 41.324333, -72.928449],
  [405, 41.324497, -72.928135],
  [410, 41.324745, -72.927989],
  [415, 41.32506, -72.927886],
  [420, 41.325374, -72.92779],
  [425, 41.325374, -72.92779],
  [430, 41.325409, -72.927054],
  [435, 41.325351, -72.926679],
  [440, 41.325282, -72.92627],
  [445, 41.325144, -72.925451],
  [450, 41.324993, -72.924659],
  ];

  // Offsets in seconds from T0, all read off the feed above.
  const ARRIVES_AT = 0;   // 20:39:38 — rolls in, already inside the stop's radius
  const EXCURSION = 345;  // 20:45:23 — 84 m out, the furthest point of the shuffle
  const RETURNS_AT = 365; // 20:45:43 — back at 41 m, sitting again
  const DEPARTS_AT = 405; // 20:46:23 — the genuine departure
  const SCREENSHOT = 380; // 20:45:58 — the poll behind report #82's "25s" chip

  const obs = (sec: number, lat: number, lon: number): BusObservation => ({
    busId: 65901,
    busName: "#316",
    routeId: 3,
    lat,
    lon,
    heading: 0,
    lastStopId: WINCHESTER_344,
    collectedAt: at(sec),
  });

  /** Replay the feed, returning the state after every poll. */
  function replay(): Array<{ sec: number; state: BusState; o: BusObservation }> {
    const out: Array<{ sec: number; state: BusState; o: BusObservation }> = [];
    let st: BusState | null = null;
    for (const [sec, lat, lon] of FEED) {
      const o = obs(sec, lat, lon);
      st = step(net, st, o).state;
      out.push({ sec, state: st!, o });
    }
    return out;
  }

  /**
   * What `collector.ts` would publish for this poll — the only thing a rider
   * ever sees. It gates on its own `AT_STOP_MAX_M`, so a clock that is right
   * outside that window is neither a win nor a regression.
   */
  function published(e: { state: BusState; o: BusObservation }) {
    if (e.o.collectedAt - e.state.enteredAt < 15_000) return null;
    const stop = byId.get(e.state.nearestStopId);
    if (!stop || distanceMeters(e.o, stop) > AT_STOP_PIN_M) return null;
    return { id: e.state.nearestStopId, since: e.state.stationarySince };
  }

  it("the bus really does wander far enough to have broken the old guard", () => {
    // Guards the premise, so this test cannot quietly stop testing anything.
    // The guard that shipped anchored on where the bus came to REST, so that
    // is the distance to measure: it is what used to cross 75 m and throw the
    // layover away.
    const rest = FEED.find(([s]) => s === 30)!; // 20:40:08, settled in the yard
    const restAt = { lat: rest[1], lon: rest[2] };
    const excursion = Math.max(
      ...FEED.filter(([s]) => s > 30 && s < DEPARTS_AT).map(([, lat, lon]) =>
        distanceMeters({ lat, lon }, restAt),
      ),
    );
    expect(excursion).toBeGreaterThan(75); // past the radius that used to ship
    // ...and yet never far enough from the STOP to be a departure, which is
    // the whole reason changing the frame fixes it.
    const stop = byId.get(WINCHESTER_344)!;
    const fromStop = Math.max(
      ...FEED.filter(([s]) => s >= ARRIVES_AT && s < DEPARTS_AT).map(([, lat, lon]) =>
        distanceMeters({ lat, lon }, stop),
      ),
    );
    expect(fromStop).toBeLessThan(STATIONARY_RADIUS_M);
  });

  it("does not restart the layover clock while the bus is still parked", () => {
    const trace = replay();
    const parked = trace.filter((e) => e.sec >= ARRIVES_AT && e.sec < DEPARTS_AT);
    const clocks = new Set(parked.map((e) => e.state.stationarySince));
    // ONE clock for the whole layover — through the excursion and back.
    expect([...clocks]).toEqual([at(ARRIVES_AT)]);
    // And it stays pinned to the stop the rider is waiting at.
    for (const e of parked) expect(e.state.stationaryStopId).toBe(WINCHESTER_344);
  });

  it("tells the rider the whole wait, not 25 s of it", () => {
    const trace = replay();
    // The poll behind report #82's screenshot, whose chip read "25s / ~5 min".
    const e = trace.find((x) => x.sec === SCREENSHOT)!;
    const pub = published(e)!;
    expect(pub.id).toBe(WINCHESTER_344);
    const standingSec = (e.o.collectedAt - pub.since) / 1000;
    expect(standingSec).toBe(SCREENSHOT);     // the truth: six and a half minutes
    // Comfortably past the ~5 min hold, so the client cancels it instead of
    // billing it a second time. That re-billing is the 5 min the rider saw.
    expect(standingSec).toBeGreaterThan(300);
  });

  it("survives the excursion that broke it, including the return", () => {
    const trace = replay();
    const out = trace.find((x) => x.sec === EXCURSION)!; // furthest point
    const back = trace.find((x) => x.sec === RETURNS_AT)!;
    // Leaving the pin radius does not restart the clock...
    expect(distanceMeters(out.o, byId.get(WINCHESTER_344)!)).toBeGreaterThan(AT_STOP_PIN_M);
    expect(out.state.stationarySince).toBe(at(ARRIVES_AT));
    // ...and coming back to the SAME stop does not either. Re-pinning on the
    // way back in is exactly how the bus-anchored guard lost the layover.
    expect(back.state.stationarySince).toBe(at(ARRIVES_AT));
    expect(back.state.stationaryStopId).toBe(WINCHESTER_344);
  });

  it("still notices the genuine departure promptly", () => {
    const trace = replay();
    const after = trace.filter((e) => e.sec >= DEPARTS_AT);
    const restarted = after.find((e) => e.state.stationarySince !== at(ARRIVES_AT))!;
    expect(restarted).toBeDefined();
    // Two polls after pulling out, not half a layover. The cost of pinning is
    // this lag and it is bounded here so a future widening cannot hide in it.
    expect(restarted.sec - DEPARTS_AT).toBe(10);

    // More to the point, the rider stops being told about this stop at all:
    // the payload's own 75 m gate closes, so nothing stale is published.
    const stillShown = after.filter(
      (e) => published(e)?.id === WINCHESTER_344 && e.sec - DEPARTS_AT > 30,
    );
    expect(stillShown).toEqual([]);
  });

  it("hands the clock to the next stop rather than dragging it along", () => {
    const trace = replay();
    const onward = trace.filter((e) => e.state.stationaryStopId === WINCHESTER_DIVISION);
    expect(onward.length).toBeGreaterThan(0);
    // A different stop is a different wait: the clock restarts there, it does
    // not carry the layover forward and over-cancel the dwell at the next stop
    // (which would make the ETA too SHORT — the direction a rider feels as a
    // missed bus).
    for (const e of onward) {
      expect(e.state.stationarySince).toBeGreaterThan(at(DEPARTS_AT));
    }
  });
});

describe("the pin radius tracks the collector's own at-stop radius", () => {
  it("equals AT_STOP_MAX_M in collector.ts", () => {
    // The clock is only ever rider-visible inside the collector's at-stop
    // radius, so pinning over a different region would be either dead code or
    // a silent gap. Parsed out of the source so the two cannot drift apart —
    // the same trick `walk.test.ts` uses on the walk speed.
    const src = readFileSync(new URL("./collector.ts", import.meta.url), "utf8");
    const m = /const AT_STOP_MAX_M = (\d+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(AT_STOP_PIN_M);
  });

  it("keeps the fallback radius under the widest twin-stop pair", () => {
    // 160 m is the widest (N)/(S) pair on this network. A fallback radius at
    // or beyond it could swallow a neighbouring stop, which is the one way
    // pinning could start crediting a wait to the wrong platform.
    expect(STATIONARY_RADIUS_M).toBeLessThan(160);
    expect(STATIONARY_RADIUS_M).toBeGreaterThan(AT_STOP_PIN_M);
  });
});
