import { describe, expect, it } from "vitest";

import { analyticCellKey, fitAnalytic, predictAnalytic, type AnalyticEpisode, type AnalyticQuery } from "./analytic.js";
import { analyticMixture, analyticResidual, atomQuantiles } from "./analytic-distribution.js";

const START = Date.parse("2026-09-03T11:00:00Z");
const DAY = 86_400_000;
function scheduled(dayOffset: number, stops = [201]): AnalyticEpisode[] {
  const durations = [100, 500, 250, 600, 180, 420, 300, 550, 120, 480];
  return stops.flatMap(stopId => durations.map((duration, lap) => {
    const dep = START + dayOffset * DAY + lap * 2700_000;
    return { id: `${dayOffset}:${stopId}:${lap}`, routeId: 17, routePatternId: "test-pattern", stopId, stopIndex: stopId,
      busKey: "test-vehicle", day: `day-${dayOffset}`, anchoredAt: dep - duration * 1000 - 5000,
      pinnedAt: dep - duration * 1000, departedAt: dep, knownAt: dep + 15_000, outcome: "stopped" };
  }));
}
function query(v: AnalyticEpisode, elapsed = 0): AnalyticQuery {
  return { ...v, pinnedAt: v.pinnedAt!, issuedAt: v.pinnedAt! + elapsed * 1000, standing: elapsed > 0 };
}

describe("generic analytical duration experts", () => {
  it("learns predictable phase without relying on any particular route, stop or vehicle name", () => {
    const train = scheduled(0), future = scheduled(1);
    const fit = fitAnalytic(train, START + DAY);
    const cell = fit.cells[analyticCellKey(train[0]!)];
    expect(cell?.phase?.periodSec).toBe(2700);
    expect(cell!.weight).toBeGreaterThan(0);
    const phase = predictAnalytic(fit, query(future[5]!), future, "phase", [0.5]);
    expect(phase.quantiles[0]).toBeCloseTo(420, 0);
    const rename = (v: AnalyticEpisode): AnalyticEpisode => ({ ...v, routeId: 902, routePatternId: "renamed", stopId: 877, stopIndex: 1, busKey: "renamed-bus" });
    const renamed = fitAnalytic(train.map(rename), START + DAY);
    const changed = predictAnalytic(renamed, query(rename(future[5]!)), future.map(rename), "stacked");
    expect(changed.quantiles).toEqual(predictAnalytic(fit, query(future[5]!), future, "stacked").quantiles);
  });

  it("cannot train on a future or not-yet-known outcome", () => {
    const train = scheduled(0), future = scheduled(1), cutoff = START + DAY;
    const base = fitAnalytic(train, cutoff);
    const contaminated = [...train, ...future, { ...train[0]!, id: "late-record", knownAt: cutoff + 1, departedAt: cutoff + 10 }];
    expect(fitAnalytic(contaminated, cutoff)).toEqual(base);
    const q = query(future[4]!);
    expect(predictAnalytic(base, q, future, "phase")).toEqual(predictAnalytic(base, q, future.slice(0, 4), "phase"));
  });

  it("falls back on the first visit and keeps distinct route-pattern occurrences apart", () => {
    const train = scheduled(0), future = scheduled(1), fit = fitAnalytic(train, START + DAY);
    expect(predictAnalytic(fit, query(future[0]!), future, "stacked").phaseAvailable).toBe(false);
    const changed = { ...query(future[5]!), routePatternId: "different-path" };
    expect(predictAnalytic(fit, changed, future, "phase").phaseAvailable).toBe(false);
  });

  it("conditions the mixture on survival, increasing phase support during a predictably long stand", () => {
    const train = scheduled(0), future = scheduled(1), fit = fitAnalytic(train, START + DAY);
    const v = future[3]!; // A 600-second service stand.
    const first = predictAnalytic(fit, { ...query(v), standing: true }, future, "stacked");
    const later = predictAnalytic(fit, { ...query(v, 520), standing: true }, future, "stacked");
    expect(later.phaseWeightNow).toBeGreaterThan(first.phaseWeightNow);
    expect(later.quantiles[49]).toBeGreaterThan(0);
    expect(later.quantiles[49]).toBeLessThan(first.quantiles[49]!);
  });

  it("preserves positive atoms and conditions away completed modes in a mixture", () => {
    const short = atomQuantiles(Array(10).fill(60)), long = atomQuantiles(Array(10).fill(420));
    expect(long.quantile(0.5)).toBe(420);
    expect(long.cdf(420)).toBe(0.95);
    expect(long.cdf(420 - 1e-5)).toBeLessThan(0.051);
    const mix = analyticMixture(short, long, 0.5);
    const remaining = analyticResidual(mix, 120)(0.5);
    expect(remaining).toBeCloseTo(300, 0);
  });

  it("keeps unpinned passes out of the production duration prior", () => {
    const train = scheduled(0), cutoff = START + DAY;
    const passed = { ...train[0]!, id: "unpinned-pass", pinnedAt: null, departedAt: null, outcome: "passed" };
    const base = fitAnalytic(train, cutoff), changed = fitAnalytic([...train, passed], cutoff);
    const key = analyticCellKey(train[0]!);
    expect(changed.cells[key]!.q).toEqual(base.cells[key]!.q);
    expect(changed.cells[key]!.n).toBe(base.cells[key]!.n);
    expect(changed.cells[key]!.pStop).toBeLessThan(base.cells[key]!.pStop);
  });

  it("learns the ongoing-wait objective causally and counts visits rather than repeated polls", () => {
    const train = scheduled(0), future = scheduled(1), cutoff = START + DAY;
    const fit = fitAnalytic(train, cutoff, "remaining");
    expect(fitAnalytic([...train, ...future], cutoff, "remaining")).toEqual(fit);
    const cell = fit.cells[analyticCellKey(train[0]!)]!;
    expect(cell.evidence.points).toBeGreaterThan(cell.evidence.n);
    expect(cell.evidence.selectedLoss).toBeLessThanOrEqual(cell.evidence.baseLoss!);
    expect(cell.weight).toBeGreaterThan(0);
    expect(cell.weight).toBeLessThanOrEqual(1);
  });
});
