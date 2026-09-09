import { describe, expect, it, vi } from "vitest";
import type { StandingForecastContext } from "../calibrator/standingForecast.js";
import type { Collector } from "../collector/collector.js";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { BusPosition } from "../schema/api.js";
import { buildBusesPayload } from "./v1compat.js";

const context = { route_id: 91, stop_id: 731, stop_index: 0 } as StandingForecastContext;
function bus(id: number, name: string, route = 91): BusPosition {
  return { busId: id, busName: name, routeId: route, lat: 41, lon: -72, heading: 0,
    lastStopId: 731, atStopId: 731, atStopSince: 1000, collectedAt: 2000 };
}
function payload(live: BusPosition[]) {
  const standingForecasts = vi.fn((b: BusPosition) => b.routeId === 91 ? [context] : []);
  const collector = { ref: { get: () => TransitNetwork.build([], []) }, getLiveBuses: () => live,
    standingForecasts, derivedPaths: () => new Map(), announcements: () => [], routeActive: () => ({}) } as unknown as Collector;
  return { standingForecasts, buses: buildBusesPayload(collector).buses as Array<Record<string, unknown>> };
}
describe("general standing forecasts in the public buses payload", () => {
  it("omits history for both live IDs with a contended route/name identity", () => {
    const rows = [bus(1, "A"), bus(2, "A"), bus(3, "B")], result = payload(rows);
    expect(result.buses[0]).not.toHaveProperty("standing_forecasts");
    expect(result.buses[1]).not.toHaveProperty("standing_forecasts");
    expect(result.buses[2]!.standing_forecasts).toEqual([context]);
    expect(result.standingForecasts).toHaveBeenCalledTimes(1);
    expect(result.standingForecasts).toHaveBeenCalledWith(rows[2]);
    expect(result.buses.every(b => !("terminal_departure" in b))).toBe(true);
  });
  it("omits empty optional forecasts on another route", () => {
    const result = payload([bus(1, "A"), bus(2, "B", 92)]);
    expect(result.buses[0]!.standing_forecasts).toEqual([context]);
    expect(result.buses[1]).not.toHaveProperty("standing_forecasts");
  });
  it("also suppresses a globally duplicated fleet name appearing on different routes", () => {
    const result = payload([bus(1, "A"), bus(2, "A", 92)]);
    expect(result.buses.every(b => !("standing_forecasts" in b))).toBe(true);
    expect(result.standingForecasts).not.toHaveBeenCalled();
  });
});
