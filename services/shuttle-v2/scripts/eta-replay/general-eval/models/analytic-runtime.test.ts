import { describe, expect, it } from "vitest";
import { fitAnalytic, predictAnalytic, type AnalyticEpisode } from "./analytic.js";
import { AnalyticRuntime, analyticRuntimeRemaining, analyticRuntimeTotal, type AnalyticRuntimeQuery } from "./analytic-runtime.js";

const start = Date.parse("2026-09-03T11:00:00Z"), dayMs = 86_400_000;
function visits(day: number): AnalyticEpisode[] {
  return [100, 500, 250, 600, 180, 420, 300, 550, 120, 480].map((duration, lap) => {
    const departedAt = start + day * dayMs + lap * 2700_000;
    return { id: `${day}:${lap}`, routeId: 91, routePatternId: "versioned-route", stopId: 73, stopIndex: 1,
      busKey: "vehicle-identity", day: `day-${day}`, anchoredAt: departedAt - duration * 1000 - 5000,
      pinnedAt: departedAt - duration * 1000, departedAt, knownAt: departedAt + 15_000,
      patternResolved: true, outcome: "stopped" };
  });
}
const train = visits(0), history = visits(1), fit = fitAnalytic(train, start + dayMs, "remaining");
const query: AnalyticRuntimeQuery = { routeId: 91, routePatternId: "versioned-route", stopId: 73, stopIndex: 1,
  busKey: "vehicle-identity", day: "day-1", observedVisitStartMs: history[5]!.pinnedAt! + 20_000,
  issuedAtMs: history[5]!.pinnedAt! + 20_000, patternResolved: true,
  canonicalStopIds: [72, 73, 74], validUntilMs: start + 2 * dayMs };

describe("general analytic runtime adapter", () => {
  it("preserves the selected exact mixture and client visit clock across JSON transport", () => {
    const runtime = new AnalyticRuntime(fit);
    runtime.replaceCompletedHistory(history, 1);
    const context = JSON.parse(JSON.stringify(runtime.context(query)));
    expect(context).not.toBeNull();
    const levels = [.01, .1, .5, .9, .99];
    for (const elapsed of [0, 30, 150, 350, 900]) {
      const issuedAt = query.observedVisitStartMs + elapsed * 1000;
      const predicted = predictAnalytic(fit, { ...query, pinnedAt: query.observedVisitStartMs,
        issuedAt, standing: true }, history, "stacked", levels);
      const fromWire = levels.map(analyticRuntimeRemaining(context, issuedAt));
      fromWire.forEach((q, i) => expect(q).toBeCloseTo(predicted.quantiles[i]!, 5));
    }
    const unconditional = predictAnalytic(fit, { ...query, pinnedAt: query.observedVisitStartMs,
      issuedAt: query.issuedAtMs, standing: false }, history, "stacked", levels);
    const total = analyticRuntimeTotal(context);
    levels.forEach((p, i) => expect(total.quantile(p)).toBeCloseTo(unconditional.quantiles[i]!, 5));
  });

  it("falls back for first visits, unresolved topology, wrong occurrence, and expired context", () => {
    const runtime = new AnalyticRuntime(fit);
    runtime.replaceCompletedHistory(history, 1);
    expect(runtime.context({ ...query, observedVisitStartMs: history[0]!.pinnedAt! })).toBeNull();
    expect(runtime.context({ ...query, patternResolved: false })).toBeNull();
    expect(runtime.context({ ...query, routePatternId: "new-version" })).toBeNull();
    expect(runtime.context({ ...query, canonicalStopIds: [73, 72, 74] })).toBeNull();
    expect(runtime.context({ ...query, stopIndex: 0 })).toBeNull();
    expect(runtime.context({ ...query, validUntilMs: query.issuedAtMs })).toBeNull();
    expect(runtime.context({ ...query, observedVisitStartMs: query.issuedAtMs + 1 })).toBeNull();
  });

  it("freezes history at observed visit start even when later snapshots contain more labels", () => {
    const runtime = new AnalyticRuntime(fit);
    runtime.replaceCompletedHistory(history, 1);
    const initial = runtime.context(query);
    const late = { ...history[3]!, id: "late-confirmed", departedAt: history[3]!.departedAt! + 600_000,
      knownAt: query.observedVisitStartMs + 1 };
    runtime.replaceCompletedHistory([...history, late], 2);
    expect(runtime.context({ ...query, issuedAtMs: query.issuedAtMs + 180_000 })).toEqual(initial);
    const unresolved = history.map(v => ({ ...v, patternResolved: false }));
    runtime.replaceCompletedHistory(unresolved, 3);
    expect(runtime.context(query)).toBeNull();
  });
});
