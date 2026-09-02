import { describe, expect, it } from "vitest";

import {
  BIKE_COLOR, BIKE_DETOUR, BIKE_EFFECTIVE_M_S, BIKE_LABEL, BIKE_MAX_SEC,
  BIKE_MIN_SAVING_SEC, BIKE_OVERHEAD_SEC, BIKE_SPEED_M_S, bikeOption,
  bikeSecFromMeters, bikeTravelSecFromMeters, withBikeOption,
} from "./bike";
import type { TripOption } from "./planner";
import { ROUTE_LISTS } from "./routes";
import { walkSecFromMeters } from "./walk";

/** Two points `m` metres apart on the same meridian, near New Haven. */
const pair = (m: number) => ({
  from: { lat: 41.31, lon: -72.93 },
  to: { lat: 41.31 + m / 111_320, lon: -72.93 },
});

const shuttle = (label: string, totalSec: number): TripOption => ({
  mode: "shuttle", routeLabel: label, color: "#000",
  boardStopId: 1, alightStopId: 2,
  walkToSec: 60, waitSec: 60, rideSec: totalSec - 180, walkFromSec: 60,
  totalSec, busName: "1", directWalkSec: 9_999,
});

describe("the cycling model", () => {
  it("keeps the effective rate consistent with the pace and detour it claims", () => {
    expect(BIKE_EFFECTIVE_M_S).toBeCloseTo(BIKE_SPEED_M_S / BIKE_DETOUR, 10);
  });

  // The failure mode this guards is a model that quotes a racing pace and then
  // disappoints every rider who follows it. 14.4 km/h on the ground is a city
  // average WITH the lights in it.
  it("rides at a city pace, not a sport one", () => {
    expect(BIKE_SPEED_M_S * 3.6).toBeGreaterThanOrEqual(12);
    expect(BIKE_SPEED_M_S * 3.6).toBeLessThanOrEqual(17);
  });

  it("detours further than a walk does — a bike cannot take the footpaths", () => {
    expect(BIKE_DETOUR).toBeGreaterThan(1.2);
  });

  it("charges the lock once, not per metre", () => {
    for (const m of [0, 500, 2_000, 8_000]) {
      expect(bikeSecFromMeters(m) - bikeTravelSecFromMeters(m)).toBe(BIKE_OVERHEAD_SEC);
    }
  });

  it("beats walking everywhere it is offered", () => {
    for (const m of [800, 1_500, 3_000, 6_000]) {
      expect(bikeSecFromMeters(m)).toBeLessThan(walkSecFromMeters(m));
    }
  });
});

describe("when a bike is worth suggesting", () => {
  // Without the lock in the model a 400 m hop "saves" four minutes, which is
  // exactly the trip where wheeling a bike out is absurd.
  it("is not offered for a trip a rider would simply walk", () => {
    expect(bikeOption(pair(200).from, pair(200).to)).toBeNull();
    expect(bikeOption(pair(400).from, pair(400).to)).toBeNull();
  });

  it("is offered once it saves a real amount of time", () => {
    const { from, to } = pair(1_500);
    const o = bikeOption(from, to);
    expect(o).not.toBeNull();
    expect(o!.directWalkSec - o!.totalSec).toBeGreaterThanOrEqual(BIKE_MIN_SAVING_SEC);
  });

  it("never offers less than the minimum saving it promises", () => {
    for (let m = 0; m <= 9_000; m += 50) {
      const o = bikeOption(pair(m).from, pair(m).to);
      if (!o) continue;
      expect(o.directWalkSec - o.totalSec).toBeGreaterThanOrEqual(BIKE_MIN_SAVING_SEC);
      expect(o.totalSec).toBeLessThanOrEqual(BIKE_MAX_SEC);
    }
  });

  it("stops offering rides that are no longer campus errands", () => {
    expect(bikeOption(pair(12_000).from, pair(12_000).to)).toBeNull();
  });

  // The threshold has to sit somewhere a rider would recognise. ~700 m is an
  // 11-minute walk: the point where "I'd take the bike" starts being true.
  it("turns on somewhere between a short stroll and a long one", () => {
    expect(bikeOption(pair(600).from, pair(600).to)).toBeNull();
    expect(bikeOption(pair(900).from, pair(900).to)).not.toBeNull();
  });

  it("carries no legs and no bus — it is an alternative to the trip, not part of one", () => {
    const o = bikeOption(pair(2_000).from, pair(2_000).to)!;
    expect(o.mode).toBe("bike");
    expect(o.busName).toBe("");
    expect([o.walkToSec, o.waitSec, o.rideSec, o.walkFromSec]).toEqual([0, 0, 0, 0]);
    expect(o.boardStopId).toBe(0);
    expect(o.alightStopId).toBe(0);
  });
});

describe("the bike row's identity", () => {
  // Option identity — expansion state, the remembered display order, the map
  // overview — is the routeLabel and nothing else. A collision with a real
  // line would make two rows share one expansion.
  it("does not collide with any shuttle line", () => {
    expect(ROUTE_LISTS.map((c) => c.label)).not.toContain(BIKE_LABEL);
    expect(ROUTE_LISTS.map((c) => c.color)).not.toContain(BIKE_COLOR);
  });
});

describe("folding the bike row into a plan", () => {
  it("does nothing when the rider has turned it off", () => {
    const opts = [shuttle("Blue Day", 600)];
    expect(withBikeOption(opts, pair(2_000).from, pair(2_000).to, false)).toBe(opts);
  });

  it("does nothing when the trip does not warrant a bike", () => {
    const opts = [shuttle("Blue Day", 600)];
    expect(withBikeOption(opts, pair(300).from, pair(300).to, true)).toBe(opts);
  });

  it("sorts the bike row honestly among the shuttles", () => {
    const { from, to } = pair(2_000);
    const bikeSec = bikeSecFromMeters(2_000);
    const out = withBikeOption(
      [shuttle("Blue Day", bikeSec - 120), shuttle("Red", bikeSec + 120)],
      from, to, true,
    );
    expect(out.map((o) => o.routeLabel)).toEqual(["Blue Day", BIKE_LABEL, "Red"]);
  });

  it("leaves the caller's array alone", () => {
    const opts = [shuttle("Blue Day", 600)];
    withBikeOption(opts, pair(2_000).from, pair(2_000).to, true);
    expect(opts).toHaveLength(1);
  });
});
