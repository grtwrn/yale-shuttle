import { describe, expect, it } from "vitest";
import { fromQuantiles } from "./dist";
import { standingForecastsFor, forecastForStand, standingRemaining, standingTotalAtArrival,
  standingDepartureProbability, type StandingForecastPrior } from "./standingForecast";
import { analyticRuntimeRemaining } from "../../../scripts/eta-replay/general-eval/models/analytic-runtime";

const arrival = 1_780_000_000_000;
const ring = { routeId: "42", stops: [7, 8, 7], N: 3 };
function wire(overrides: Partial<StandingForecastPrior> = {}): StandingForecastPrior {
  const d = fromQuantiles([0, 15, 20, 30, 45, 60, 100, 180, 400, 650]);
  return { route_id: 42, route_pattern_id: "fixture", canonical_stop_ids: [...ring.stops],
    stop_id: 7, stop_index: 2, observed_visit_start_at: arrival,
    previous_departed_at: arrival - 3_000_000, history_available_at: arrival - 2_800_000,
    phase_slot_at: arrival + 600_000, phase_error_q: [-100, -80, -40, -20, 0, 0, 0, 40, 80, 180],
    phase_weight: 0.4, duration_dist: { xs: [...d.xs], ps: [...d.ps], tail_hazard: d.tailHazard },
    fitted_at: arrival - 86_400_000, valid_until: arrival + 86_400_000, ...overrides };
}
function decode(p = wire(), now = arrival) {
  return standingForecastsFor({ route_id: 42, standing_forecasts: [p] }, ring, now);
}

describe("general standing forecasts", () => {
  it("matches the frozen offline distribution at the browser's observed clock", () => {
    const p = wire();
    for (const offset of [-30_000, 0, 30_000]) {
      const start = arrival + offset;
      const context = forecastForStand(decode(p), 2, start)!;
      for (const elapsed of [0, 30, 180, 600, 900]) {
        const now = start + elapsed * 1000;
        const expected = analyticRuntimeRemaining(p, now, start);
        for (const level of [0.05, 0.5, 0.95]) expect(standingRemaining(context, now)(level)).toBeCloseTo(expected(level), 7);
      }
    }
  });

  it("conditions zero-duration passes out of a known current stand at elapsed zero", () => {
    const p = wire({ phase_weight: 0.01 });
    const context = forecastForStand(decode(p), 2, arrival)!;
    expect(standingTotalAtArrival(context)).toBeGreaterThan(context.total.quantile(0.5));
    expect(standingTotalAtArrival(context)).toBe(standingRemaining(context, arrival)(0.5));
  });

  it("uses the same conditional law for departure probability, including a release-time atom", () => {
    const context = forecastForStand(decode(wire({ phase_weight: 1, phase_error_q: Array(10).fill(0) })), 2, arrival)!;
    expect(standingRemaining(context, arrival)(0.5)).toBeCloseTo(600, 6);
    const before = arrival + 595_000;
    expect(standingDepartureProbability(context, before, 10)).toBeGreaterThan(0.94);
    const f0 = context.total.cdf(100), f1 = context.total.cdf(105);
    expect(standingDepartureProbability(context, arrival + 100_000, 5)).toBeCloseTo((f1 - f0) / (1 - f0), 12);
  });

  it("rejects a different occurrence, later history, and an already completed visit", () => {
    const contexts = decode();
    expect(forecastForStand(contexts, 0, arrival)).toBeNull();
    expect(forecastForStand(contexts, 2, arrival - 3_000_000)).toBeNull();
    expect(forecastForStand(decode(wire({ history_available_at: arrival - 10_000 })), 2, arrival - 20_000)).toBeNull();
    expect(forecastForStand(contexts, 2, arrival)).not.toBeNull();
  });

  it.each([
    { route_id: 43 }, { stop_index: 0, canonical_stop_ids: [7, 7, 8] },
    { valid_until: arrival }, { fitted_at: arrival + 1 }, { phase_weight: NaN },
    { phase_error_q: [0, 4, 3] }, { phase_error_q: [0, Infinity, Infinity] },
    { duration_dist: { xs: [0, 0], ps: [0, 0.95], tail_hazard: 0.01 } },
  ])("falls back for malformed, stale or changed-pattern context %j", bad => {
    expect(decode(wire(bad)).size).toBe(0);
  });

  it("rejects duplicate occurrence contexts instead of depending on payload ordering", () => {
    expect(standingForecastsFor({ route_id: 42, standing_forecasts: [wire(), wire()] }, ring, arrival).size).toBe(0);
  });
});
