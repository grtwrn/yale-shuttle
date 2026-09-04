// One answer per bus per poll — now for "is it standing, and where".
//
// Report #102, 2026-09-04: "a bus sitting in a garage lot was counted down as
// if on its way". After #130 the PRICE knew that bus was standing; the pause
// chip beside it did not, because it read `at_stop_id` off the payload and a
// bus resting short of the marker publishes none. Two answers, one screen —
// the very thing `liveAnchor.ts` exists to prevent.
//
// These replay the two recorded incidents through `resolveStandingStop` and
// assert it gives the SAME answer the estimator prices from, so the chip and
// the countdown cannot disagree again.
import { describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import type { AnchorStore } from "./anchorGate";
import type { DwellTimes } from "./arrivals";
import type { LatLon } from "./geo";
import { resolveStandingStop } from "./liveAnchor";
import type { BusData } from "./map-data";
import { ROUTE_LISTS } from "./routes";

import onRoadFx from "./__fixtures__/red-approach-rest.json";
import garageFx from "./__fixtures__/red-garage-rest.json";

const RED = ROUTE_LISTS.find((r) => r.label === "Red")!;
const LAYOVER = 11; // 344 Winchester

type Position = {
  t: number; lat: number; lon: number; heading: number;
  last_stop_id: number; stationary_since: number; at_stop_id: number | null;
};

function busAt(fx: typeof onRoadFx, p: Position): BusData {
  const naive = (ms: number) => new Date(ms).toISOString().replace("Z", "");
  const b: Record<string, unknown> = {
    bus_id: 1, bus_name: fx.busName, route_id: 3,
    lat: p.lat, lon: p.lon, heading: p.heading, last_stop_id: p.last_stop_id,
  };
  if (p.at_stop_id != null) {
    b.at_stop_id = p.at_stop_id;
    b.at_stop_since = naive(p.stationary_since);
  }
  b.stationary_since = naive(p.stationary_since);
  return b as unknown as BusData;
}

for (const [title, fx] of [
  ["#310 short of the marker", onRoadFx],
  ["#304 in the garage lot", garageFx],
] as const) {
  describe(`resolveStandingStop — ${title}`, () => {
    registerRoutePaths(null);
    const positions = fx.positions as Position[];
    const dwells = (fx.dwells as unknown as DwellTimes)["3"]!;
    const coords = fx.stopCoords as unknown as Record<number, LatLon>;
    const routeStops = fx.routeStops as Record<string, number[]>;

    const run = () => {
      const store: AnchorStore = new Map();
      return positions.map((p) => ({
        t: p.t,
        at: p.at_stop_id,
        answer: resolveStandingStop(
          busAt(fx, p), RED, routeStops, coords, dwells, p.t, store,
        ),
      }));
    };

    it("names the layover stop while the bus rests short of it", () => {
      const rows = run().filter(
        (r) => r.t >= fx.approachRest.startedAt && r.t <= fx.approachRest.endedAt,
      );
      const standing = rows.filter((r) => r.answer != null);
      expect(standing.length).toBeGreaterThan(20);
      // Every one of them says 344 Winchester, and says it is an APPROACH —
      // the bus is not at the marker and the payload never claimed it was.
      for (const r of standing) {
        expect(r.answer!.stopId).toBe(LAYOVER);
        expect(r.answer!.approach).toBe(true);
        expect(r.at).toBeNull();
      }
    });

    it("the clock it reports only ever runs forward through the wait", () => {
      const rows = run().filter(
        (r) => r.t >= fx.approachRest.startedAt && r.answer?.stopId === LAYOVER,
      );
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.answer!.standingSec).toBeGreaterThanOrEqual(
          rows[i - 1]!.answer!.standingSec - 1,
        );
      }
    });

    it("stops calling it an approach once the bus is really at the marker", () => {
      const atMarker = run().filter((r) => r.at === LAYOVER && r.answer != null);
      expect(atMarker.length).toBeGreaterThan(0);
      for (const r of atMarker) {
        expect(r.answer!.stopId).toBe(LAYOVER);
        expect(r.answer!.approach).toBe(false);
      }
      // ...and the wait carried across, so it is longer than the marker touch.
      const first = atMarker[0]!;
      const markerTouchSec = (first.t - fx.approachRest.endedAt) / 1000;
      expect(first.answer!.standingSec).toBeGreaterThan(markerTouchSec + 60);
    });

    it("a storeless caller gets nothing, exactly as before", () => {
      const p = positions.find((x) => x.t >= fx.approachRest.endedAt - 30_000)!;
      expect(
        resolveStandingStop(busAt(fx, p), RED, routeStops, coords, dwells, p.t, undefined),
      ).toBeNull();
    });
  });
}
