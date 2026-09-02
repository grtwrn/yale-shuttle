import { describe, expect, it } from "vitest";

import {
  BIKE_COLOR, BIKE_DETOUR, BIKE_EFFECTIVE_M_S, BIKE_LABEL, BIKE_MAX_SEC,
  BIKE_MIN_SAVING_SEC, BIKE_OVERHEAD_SEC, BIKE_SPEED_M_S, bikeLegFor,
  bikeSecFromMeters, bikeTravelSecFromMeters, withBikeOption,
} from "./bike";
import { haversineMeters } from "./geo";
import type { TripOption } from "./planner";
import { ROUTE_LISTS } from "./routes";
import { walkSecFromMeters } from "./walk";

/**
 * Two points roughly `m` metres apart on the same meridian, near New Haven.
 * "Roughly": the degree-per-metre constant is flat-earth, so assertions about
 * exact seconds go through `metres()` rather than the nominal argument.
 */
const pair = (m: number) => ({
  from: { lat: 41.31, lon: -72.93 },
  to: { lat: 41.31 + m / 111_320, lon: -72.93 },
});
/** What `pair(m)` actually spans, to the model's own precision. */
const metres = (m: number) => haversineMeters(pair(m).from, pair(m).to);

const shuttle = (label: string, totalSec: number): TripOption => ({
  mode: "shuttle", routeLabel: label, color: "#000",
  boardStopId: 1, alightStopId: 2,
  walkToSec: 60, waitSec: 60, rideSec: totalSec - 180, walkFromSec: 60,
  totalSec, busName: "1", directWalkSec: 9_999,
});

const walkRow = (meters: number): TripOption => ({
  mode: "walk", routeLabel: "Walk", color: "#546e7a",
  boardStopId: 0, alightStopId: 0,
  walkToSec: 0, waitSec: 0, rideSec: 0, walkFromSec: 0,
  totalSec: walkSecFromMeters(meters), busName: "",
  directWalkSec: walkSecFromMeters(meters),
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
    expect(bikeLegFor(pair(200).from, pair(200).to)).toBeNull();
    expect(bikeLegFor(pair(400).from, pair(400).to)).toBeNull();
  });

  it("is offered once it saves a real amount of time", () => {
    const { from, to } = pair(1_500);
    const leg = bikeLegFor(from, to);
    expect(leg).not.toBeNull();
    expect(walkSecFromMeters(1_500) - leg!.totalSec).toBeGreaterThanOrEqual(BIKE_MIN_SAVING_SEC);
  });

  it("never offers less than the minimum saving it promises", () => {
    for (let m = 0; m <= 9_000; m += 50) {
      const leg = bikeLegFor(pair(m).from, pair(m).to);
      if (!leg) continue;
      expect(walkSecFromMeters(m) - leg.totalSec).toBeGreaterThanOrEqual(BIKE_MIN_SAVING_SEC);
      expect(leg.totalSec).toBeLessThanOrEqual(BIKE_MAX_SEC);
    }
  });

  it("stops offering rides that are no longer campus errands", () => {
    expect(bikeLegFor(pair(12_000).from, pair(12_000).to)).toBeNull();
  });

  // The threshold has to sit somewhere a rider would recognise. ~700 m is an
  // 11-minute walk: the point where "I'd take the bike" starts being true.
  it("turns on somewhere between a short stroll and a long one", () => {
    expect(bikeLegFor(pair(600).from, pair(600).to)).toBeNull();
    expect(bikeLegFor(pair(900).from, pair(900).to)).not.toBeNull();
  });

  it("breaks the lock out of the total so the row can print it", () => {
    const leg = bikeLegFor(pair(2_000).from, pair(2_000).to)!;
    expect(leg.overheadSec).toBe(BIKE_OVERHEAD_SEC);
    expect(leg.travelSec + leg.overheadSec).toBeCloseTo(leg.totalSec, 6);
  });
});

describe("the standalone bike row's identity", () => {
  // Option identity — expansion state, the remembered display order, the map
  // overview — is the routeLabel and nothing else. A collision with a real
  // line would make two rows share one expansion.
  it("does not collide with any shuttle line", () => {
    expect(ROUTE_LISTS.map((c) => c.label)).not.toContain(BIKE_LABEL);
    expect(ROUTE_LISTS.map((c) => c.color)).not.toContain(BIKE_COLOR);
  });
});

describe("folding the bike into the plan", () => {
  it("does nothing when the rider has turned it off", () => {
    const opts = [walkRow(2_000)];
    expect(withBikeOption(opts, pair(2_000).from, pair(2_000).to, false)).toBe(opts);
  });

  it("does nothing when the trip does not warrant a bike", () => {
    const opts = [walkRow(300)];
    expect(withBikeOption(opts, pair(300).from, pair(300).to, true)).toBe(opts);
  });

  // The point of the merge: walking and biking are one answer to one question,
  // and honest sorting would otherwise wedge a shuttle between them.
  it("joins the walk row instead of adding a second one", () => {
    const { from, to } = pair(2_000);
    const out = withBikeOption([walkRow(2_000), shuttle("Blue Day", 900)], from, to, true);
    expect(out.filter((o) => o.mode !== "shuttle")).toHaveLength(1);
    const self = out.find((o) => o.mode === "walk")!;
    expect(self.bike?.totalSec).toBeCloseTo(bikeSecFromMeters(metres(2_000)), 6);
  });

  // The row leads with the walk, because that is the time every rider can
  // actually have. Ranking it on the bike was tried and is wrong.
  it("keeps the walk's rank and headline time", () => {
    const { from, to } = pair(2_000);
    const self = withBikeOption([walkRow(2_000)], from, to, true)[0];
    expect(self.totalSec).toBeCloseTo(walkSecFromMeters(2_000), 6);
    expect(self.directWalkSec).toBeCloseTo(walkSecFromMeters(2_000), 6);
    expect(self.bike!.totalSec).toBeLessThan(self.totalSec);
  });

  it("does not let the bike push the row up past a shuttle", () => {
    const { from, to } = pair(2_000);
    const bikeSec = bikeSecFromMeters(metres(2_000));
    const walkSec = walkSecFromMeters(2_000);
    // A shuttle slower than the bike but faster than the walk: it must still
    // outrank the self-powered row, exactly as it did before the bike existed.
    const between = (bikeSec + walkSec) / 2;
    const out = withBikeOption(
      [walkRow(2_000), shuttle("Blue Day", between), shuttle("Red", walkSec + 120)],
      from, to, true,
    );
    expect(out.map((o) => o.routeLabel)).toEqual(["Blue Day", "Walk", "Red"]);
  });

  // A walk over an hour is suppressed, and that is exactly the trip where a
  // bike is worth the most — too far to walk, still inside the 45-min cap.
  it("stands on its own when there is no walk row to join", () => {
    const { from, to } = pair(5_000);
    const out = withBikeOption([shuttle("Blue Day", 1_800)], from, to, true);
    const bike = out.find((o) => o.mode === "bike");
    expect(bike).toBeDefined();
    expect(bike!.routeLabel).toBe(BIKE_LABEL);
    expect(bike!.bike?.totalSec).toBeCloseTo(bikeSecFromMeters(metres(5_000)), 6);
    expect([bike!.walkToSec, bike!.waitSec, bike!.rideSec, bike!.walkFromSec]).toEqual([0, 0, 0, 0]);
    expect(bike!.busName).toBe("");
  });

  it("leaves the caller's options alone", () => {
    const opts = [walkRow(2_000)];
    const before = { ...opts[0] };
    withBikeOption(opts, pair(2_000).from, pair(2_000).to, true);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual(before);
  });
});
