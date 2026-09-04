import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  MAX_HANDOFF_GAP_MS,
  seedStationaryFromHistory,
  step,
  type BusObservation,
  type BusState,
  type PositionSample,
} from "./detector.js";

/**
 * Report #100, replayed from production — the first report from an outside
 * rider since launch.
 *
 * > "Possible that the timer for stop at 333 cedar restarted"
 *
 * They were right. Blue Day #44 stood at 333 Cedar (stop 10) from 15:53:39Z to
 * 16:03:34Z on 2026-09-04 without moving a metre, and `arrivals` holds FOUR
 * rows for that one stand — 15:53:39, 15:55:11, 15:56:53, 15:59:14. Six deploys
 * landed between 15:48 and 15:58 UTC, and each restart emptied the collector's
 * in-memory `states`, so every standing bus became a first sighting again and
 * had its wait restarted. The rider's own payload carried
 * `at_stop_since: 15:56:53.903` — the third restart — while the bus was four and
 * a half minutes into its layover. Two other buses in the same payload carried
 * that identical millisecond at two different stops, which is the fingerprint:
 * nothing about the buses changed, only the process watching them.
 *
 * Every coordinate below is an unedited `raw_positions` row for #44 (`bus_id`
 * 65959 throughout — no id reissue), and the stops are the real ones from the
 * checked-in 172-stop fixture, sequenced as production lists route 1.
 */
describe("report #100: the Blue #44 layover at 333 Cedar, replayed from production", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  // Production `routes.stops_json` for route 1 (Blue - Weekday Daytime).
  const BLUE_DAY = [
    106, 34, 101, 47, 100, 102, 105, 69, 139, 136, 130, 129, 140, 133, 135, 138,
    97, 118, 42, 98, 38, 39, 72, 43, 10, 2, 5, 52, 41, 20, 108,
  ];
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];
  const net = TransitNetwork.build(allStops, routes);

  const CEDAR_333 = 10;

  /** 2026-09-04T15:53:20.751Z — the last poll before #44 turns in toward the stop. */
  const T0 = Date.parse("2026-09-04T15:53:20.751Z");
  const at = (ms: number) => T0 + ms;

  /** Milliseconds after T0, latitude, longitude — the feed, unedited. */
  const FEED: Array<[number, number, number]> = [
    [0, 41.301950, -72.933273],
    [13810, 41.302422, -72.933829],
    [18842, 41.302702, -72.933986],
    [23829, 41.302702, -72.933986],
    [28839, 41.302702, -72.933986],
    [33777, 41.302953, -72.934122],
    [38872, 41.302953, -72.934122],
    [43803, 41.302953, -72.934122],
    [48762, 41.302953, -72.934122],
    [53999, 41.302953, -72.934122],
    [58782, 41.302953, -72.934122],
    [63871, 41.302953, -72.934122],
    [68866, 41.302953, -72.934122],
    [74225, 41.302953, -72.934122],
    [79279, 41.302953, -72.934122],
    [84187, 41.302953, -72.934122],
    [89183, 41.302953, -72.934122],
    [94251, 41.302953, -72.934122],
    // 16.9 s hole: the process restarted under it.
    [111159, 41.302953, -72.934122],
    [116196, 41.302953, -72.934122],
    [121134, 41.302953, -72.934122],
    [126245, 41.302953, -72.934122],
    [131344, 41.302953, -72.934122],
    [136187, 41.302953, -72.934122],
    [141137, 41.302953, -72.934122],
    [146258, 41.302953, -72.934122],
    [151173, 41.302953, -72.934122],
    [156119, 41.302953, -72.934122],
    [161177, 41.302953, -72.934122],
    [166158, 41.302953, -72.934122],
    [171804, 41.302953, -72.934122],
    [176806, 41.302953, -72.934122],
    [181921, 41.302953, -72.934122],
    [186893, 41.302953, -72.934122],
    [191745, 41.302953, -72.934122],
    [196762, 41.302953, -72.934122],
    // 16.4 s hole: the restart the rider's payload caught.
    [213152, 41.302953, -72.934122],
    [218071, 41.302953, -72.934122],
    [223165, 41.302953, -72.934122],
    [228103, 41.302953, -72.934122],
    [233093, 41.302953, -72.934122],
    [238245, 41.302953, -72.934122],
    [243131, 41.302953, -72.934122],
    [248101, 41.302953, -72.934122],
    [253145, 41.302953, -72.934122],
    [258098, 41.302953, -72.934122],
    [263111, 41.302953, -72.934122],
    [268252, 41.302953, -72.934122],
    [273421, 41.302953, -72.934122],
    [278451, 41.302953, -72.934122],
    [283420, 41.302953, -72.934122],
    [288406, 41.302953, -72.934122],
    [293405, 41.302953, -72.934122],
    [298357, 41.302953, -72.934122],
    [303367, 41.302953, -72.934122],
    [308639, 41.302953, -72.934122],
    [313393, 41.302953, -72.934122],
    [318408, 41.302953, -72.934122],
    [323378, 41.302953, -72.934122],
    [328395, 41.302953, -72.934122],
    [333397, 41.302953, -72.934122],
    [338648, 41.302953, -72.934122],
    // 15.0 s hole: another restart.
    [353684, 41.302953, -72.934122],
    [358679, 41.302953, -72.934122],
    [363654, 41.302953, -72.934122],
    [368697, 41.302953, -72.934122],
    [373678, 41.302953, -72.934122],
    [378705, 41.302953, -72.934122],
    [383764, 41.302953, -72.934122],
    [388628, 41.302953, -72.934122],
    [393792, 41.302953, -72.934122],
    // The bus creeps 30 m up to the kerb. Same stop, same wait.
    [398704, 41.303208, -72.934242],
    [403647, 41.303208, -72.934242],
    [408883, 41.303208, -72.934242],
  ];

  /** The poll on which the bus first comes within the pin radius of stop 10. */
  const STAND_BEGAN = 18842;
  /** The restart the rider's payload carried as `at_stop_since`. */
  const RESTART = 213152;
  /** `computedAtMs` on the trip option attached to report #100 (15:58:12.934Z). */
  const RIDER_SAW = 292183;

  const obsAt = (ms: number): BusObservation => {
    const row = FEED.find((r) => r[0] === ms);
    if (!row) throw new Error(`no feed row at +${ms}`);
    return {
      busId: 65959,
      busName: "#44",
      routeId: 1,
      lat: row[1],
      lon: row[2],
      heading: 337,
      lastStopId: 43,
      collectedAt: at(ms),
    };
  };

  /** Everything recorded before `ms`, newest first — the order the index yields. */
  const historyBefore = (ms: number): PositionSample[] =>
    FEED.filter((r) => r[0] < ms)
      .map(([o, lat, lon]) => ({ lat, lon, collectedAt: at(o) }))
      .reverse();

  /** The stop `step` anchors to on a first sighting: the global nearest on the route. */
  const anchorFor = (obs: BusObservation): Stop => {
    const nearest = net.nearestStopOnRoute(obs.routeId, obs);
    if (!nearest) throw new Error("no anchor");
    return net.stops.get(nearest.stopId)!;
  };

  it("anchors the stand to 333 Cedar and holds one clock when nothing restarts", () => {
    // The baseline the stop-pinned clock (report #82) already gives: one
    // uninterrupted wait, including across the 30 m creep to the kerb.
    let state: BusState | null = null;
    for (const [ms] of FEED) {
      state = step(net, state, obsAt(ms)).state;
    }
    expect(state!.stationaryStopId).toBe(CEDAR_333);
    expect(state!.stationarySince).toBe(at(STAND_BEGAN));
  });

  it("is what the rider saw: a restart mid-stand zeroed the wait", () => {
    // Reproduces the defect exactly. `states` is in-memory, so the poll after a
    // restart arrives with no previous state at all.
    const obs = obsAt(RESTART);
    const restarted = step(net, null, obs).state!;

    expect(restarted.stationaryStopId).toBe(CEDAR_333);
    expect(restarted.stationarySince).toBe(at(RESTART));
    // Which is the millisecond the rider's payload actually carried.
    expect(new Date(restarted.stationarySince).toISOString()).toBe("2026-09-04T15:56:53.903Z");
    // By the time they looked, the chip claimed 79 s of a 273 s wait.
    expect(Math.round((at(RIDER_SAW) - restarted.stationarySince) / 1000)).toBe(79);
    expect(Math.round((at(RIDER_SAW) - at(STAND_BEGAN)) / 1000)).toBe(273);
  });

  it("recovers the wait from recorded positions when the process restarts", () => {
    const obs = obsAt(RESTART);
    const anchor = anchorFor(obs);
    expect(anchor.id).toBe(CEDAR_333);

    const seed = seedStationaryFromHistory(historyBefore(RESTART), obs, anchor);
    expect(seed).not.toBeNull();
    // The reconstruction lands on the poll the detector itself had logged as
    // the arrival before the restarts began.
    expect(seed!.stationarySince).toBe(at(STAND_BEGAN));
    expect(new Date(seed!.stationarySince).toISOString()).toBe("2026-09-04T15:53:39.593Z");
    expect(seed!.stationaryStopId).toBe(CEDAR_333);

    const restarted = step(net, null, obs, () => seed).state!;
    expect(restarted.stationarySince).toBe(at(STAND_BEGAN));
    expect(Math.round((at(RIDER_SAW) - restarted.stationarySince) / 1000)).toBe(273);
  });

  it("carries the recovered wait through every later poll, creep included", () => {
    // The seed has to hand the running clock something the ordinary rules will
    // keep — otherwise it only moves the restart one poll later.
    const obs = obsAt(RESTART);
    const seed = seedStationaryFromHistory(historyBefore(RESTART), obs, anchorFor(obs));
    let state = step(net, null, obs, () => seed).state;
    for (const [ms] of FEED.filter((r) => r[0] > RESTART)) {
      state = step(net, state, obsAt(ms)).state;
    }
    expect(state!.stationarySince).toBe(at(STAND_BEGAN));
    expect(state!.stationaryStopId).toBe(CEDAR_333);
  });

  it("stops at a feed absence rather than claiming a wait across it", () => {
    // A bus that went off the air is one the live rules re-anchor anyway
    // (MAX_HANDOFF_GAP_MS). The seed must not reach back across the hole and
    // resurrect a wait the running process would have thrown away.
    const gap = MAX_HANDOFF_GAP_MS + 60_000;
    const obs = { ...obsAt(RESTART), collectedAt: at(196762) + gap };
    const seed = seedStationaryFromHistory(historyBefore(RESTART), obs, anchorFor(obs));
    expect(seed).toBeNull();
  });

  it("says nothing about a bus that is not standing at a stop", () => {
    // +0 is 166 m out on Congress; there is nothing to pin to.
    const obs = obsAt(0);
    const seed = seedStationaryFromHistory(historyBefore(0), obs, anchorFor(obs));
    expect(seed).toBeNull();
  });

  it("is consulted on a first sighting only, never on a lost track", () => {
    // A reanchor with state in hand means we lost the bus — it turned up
    // somewhere its anchor cannot explain. That restarts the clock deliberately,
    // and a seed must not undo it. Here the anchor sits at the far end of the
    // loop (Prospect / Trumbull, index 30) while the bus reports from Cedar.
    const prospectTrumbull = net.stops.get(108)!;
    const before: BusState = {
      busId: 65959,
      busName: "#44",
      routeId: 1,
      nearestStopId: 108,
      nearestIndex: 30,
      enteredAt: at(RESTART) - 5_000,
      lastObservedAt: at(RESTART) - 5_000,
      lat: prospectTrumbull.lat,
      lon: prospectTrumbull.lon,
      stationarySince: at(RESTART) - 5_000,
      stationaryLat: prospectTrumbull.lat,
      stationaryLon: prospectTrumbull.lon,
      stationaryStopId: 108,
    };
    const obs = obsAt(RESTART);
    const seed = seedStationaryFromHistory(historyBefore(RESTART), obs, anchorFor(obs));
    expect(seed).not.toBeNull(); // the seed itself would have offered one

    const after = step(net, before, obs, () => seed).state!;
    expect(after.nearestStopId).toBe(CEDAR_333); // it did reanchor
    expect(after.stationarySince).toBe(at(RESTART)); // ...and started the wait fresh
  });
});
