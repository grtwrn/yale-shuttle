import { describe, expect, it } from "vitest";
import { fitAnalytic as referenceFit, predictAnalytic as referencePredict, type AnalyticEpisode } from "./analytic.js";
import { fitAnalytic, predictAnalytic } from "../../../../src/calibrator/analytic/analytic.js";
import { classPools as referencePools, globalClassPools as referenceGlobal, poolsWithFallback as referenceFallback, stopModel as referenceStop } from "../../../../web/src/eta/tables.js";
import { classPools, globalClassPools, poolsWithFallback, stopModel } from "../../../../src/calibrator/analytic/durationTables.js";
import { quantile } from "../../../../src/calibrator/analytic/dist.js";

describe("production extraction preserves the selected analytic model", () => {
  it("fits and predicts the exact same model on an arbitrary route", () => {
    const start = Date.parse("2026-09-03T11:00:00Z");
    const rows: AnalyticEpisode[] = Array.from({ length: 16 }, (_, i) => {
      const day = Math.floor(i / 8), lap = i % 8, dep = start + day * 86400_000 + lap * 2700_000;
      return { id: i, routeId: 91, routePatternId: "arbitrary", stopId: 731, stopIndex: 1,
        busKey: "vehicle", day: `2026-09-0${3 + day}`, anchoredAt: dep - 180_000,
        pinnedAt: dep - 120_000 - lap * 10_000, departedAt: dep,
        knownAt: dep + 30_000, outcome: "stopped", patternResolved: true };
    });
    const cutoff = start + 2 * 86400_000;
    const reference = referenceFit(rows, cutoff, "remaining"), actual = fitAnalytic(rows, cutoff, "remaining");
    expect(actual).toEqual(reference);
    const query = { routeId: 91, routePatternId: "arbitrary", stopId: 731, stopIndex: 1,
      busKey: "vehicle", day: "2026-09-04", pinnedAt: cutoff - 400_000, issuedAt: cutoff - 300_000, standing: true };
    expect(predictAnalytic(actual, query, rows)).toEqual(referencePredict(reference, query, rows));
  });

  it("retains the exact legacy duration pool and shrinkage law", () => {
    const route = { ordinary: { med: 0, n: 12, q: [0, 5, 10, 20, 40] },
      layover: { med: 0, n: 3, q: [50, 150, 250, 400, 800] } };
    const network = { a: route, b: { other: { med: 0, n: 8, q: [0, 10, 40, 90, 120] } } };
    for (const row of [...Object.values(route), undefined]) {
      const actual = stopModel(row, poolsWithFallback(classPools(route), globalClassPools(network)));
      const expected = referenceStop(row, referenceFallback(referencePools(route), referenceGlobal(network)));
      expect(actual).toEqual(expected);
      expect(quantile(actual.stand, .9)).toBe(quantile(expected.stand, .9));
    }
  });
});
