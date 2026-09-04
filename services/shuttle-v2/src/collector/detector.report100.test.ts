import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";

import {
  BLUE_DAY,
  CEDAR_333,
  FEED,
  RESTARTS,
  STAND_BEGAN,
  T0,
} from "./__fixtures__/report100-cedar-stand.js";

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
 * a half minutes into its layover.
 *
 * The fingerprint is the duplicate arrival on a bus that did not move: each
 * extra row sits on a 13–17 s hole in `raw_positions` (the poll the restarting
 * machine missed) with #44's coordinate byte-identical either side of it. NOT
 * the fact that another bus in the same payload carried the same millisecond —
 * #45 did, at Temple / Grove, but it was driving and genuinely entered the pin
 * radius on that poll. A shared stamp is what a missed poll looks like from any
 * cause.
 *
 * Every coordinate comes from `__fixtures__/report100-cedar-stand.ts` — the
 * unedited `raw_positions` rows for #44 (`bus_id` 65959 throughout, no id
 * reissue) — and the stops are the real ones from the checked-in 172-stop
 * fixture, sequenced as production lists route 1.
 */
describe("report #100: the Blue #44 layover at 333 Cedar, replayed from production", () => {
  const allStops: Stop[] = JSON.parse(
    readFileSync(new URL("../server/__fixtures__/stops.json", import.meta.url), "utf8"),
  ) as Stop[];
  const routes: Route[] = [
    { id: 1, name: "Blue - Weekday Daytime", shortName: "BD", color: "#1565C0", stops: BLUE_DAY },
  ];
  const net = TransitNetwork.build(allStops, routes);

  const at = (ms: number) => T0 + ms;

  /** The restart the rider's payload carried as `at_stop_since`. */
  const RESTART = RESTARTS[1]!;
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
