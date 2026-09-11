import { describe, expect, it } from "vitest";
import { parseStopStudyJson, StopStudySchema, type StopStudy } from "./stop-study.js";

export function fixture(): StopStudy {
  const at = Date.parse("2026-09-08T12:00:00Z");
  return {
    schemaVersion: 1, source: "saved_study", title: "Synthetic evidence", generatedAt: at,
    timezone: "America/New_York", days: ["2026-09-08"],
    routes: [{ routeId: 91, name: "Route 91", shortName: "Route 91" }],
    stops: [{ stopId: 11, name: "Synthetic stop", lat: null, lon: null }],
    visits: [{ id: "visit", day: "2026-09-08", routeId: 91, routePatternId: "91:pattern", stopId: 11,
      stopIndex: 2, busId: 1, busKey: "bus", busName: "bus", anchoredAt: at, pinnedAt: at,
      recordedPinnedAt: at + 30_000, arrivedAt: at + 15_000, departedAt: at + 90_000,
      recordedStandSec: 45, pinnedStandSec: 90, outcome: "stopped", how: "far", confidence: 1,
      qualityNotes: [], previousDepartureAt: null, loopSec: null, labelStatus: "complete",
      leftCensored: false, rightCensored: false, originalEpisodeId: "old-visit",
      predictions: [{ model: "baseline", arm: "baseline", issuedAt: at + 15_000, target: "departure",
        targetStopId: 11, predictedTotalSec: 80, predictedRemainingSec: 60, actualRemainingSec: 75,
        displayKind: "remaining", displaySec: 60, observedStartAt: at - 10_000,
        firstCapturedDisplay: true, occurrenceAgreement: true,
        downstream: { targetStopId: 12, targetStopIndex: 3, targetArrivalId: "arrival", targetAt: at + 120_000,
          quantileLevels: [.1, .5, .9], quantilesSec: [-5, 90, 200], actualRemainingSec: 105 } }],
    }],
    provenance: { exporterVersion: "stop-study-v1", inputs: [{ role: "synthetic", name: "inline", sha256: "0".repeat(64) }],
      sourceHashes: {}, sampling: { forecastIntervalSec: 30, positionIntervalSec: null, pairedQueriesOnly: true,
        firstPairedDisplayPreserved: true, description: "Synthetic" }, counts: {}, warnings: [] },
  };
}

describe("browser-local saved study contract", () => {
  it("preserves distinct clocks, first-display evidence and negative saved ETA bounds", () => {
    const input = fixture();
    expect(parseStopStudyJson(JSON.stringify(input))).toEqual(input);
  });
  it("rejects duplicate forecasts instead of silently counting the same arm twice", () => {
    const input = fixture(); input.visits[0]!.predictions.push(input.visits[0]!.predictions[0]!);
    expect(() => StopStudySchema.parse(input)).toThrow(/Duplicate forecast/);
  });
  it("rejects malformed clocks, non-finite values and interval shapes", () => {
    for (const mutate of [
      (input: StopStudy) => { input.visits[0]!.pinnedAt = NaN; },
      (input: StopStudy) => { input.visits[0]!.predictions[0]!.downstream!.quantilesSec = [1]; },
      (input: StopStudy) => { input.visits[0]!.predictions[0]!.targetStopId = 99; },
    ]) { const input = fixture(); mutate(input); expect(StopStudySchema.safeParse(input).success).toBe(false); }
  });
  it("rejects a different schema or unexpected imported fields", () => {
    expect(StopStudySchema.safeParse({ ...fixture(), schemaVersion: 2 }).success).toBe(false);
    expect(StopStudySchema.safeParse({ ...fixture(), runtimeCode: "not accepted" }).success).toBe(false);
  });
  it("rejects impossible dates and conflicting identities for one physical arrival", () => {
    const badDay = fixture(); badDay.days = ["2026-02-31"];
    expect(StopStudySchema.safeParse(badDay).success).toBe(false);
    const badArrival = fixture();
    const first = badArrival.visits[0]!.predictions[0]!;
    badArrival.visits[0]!.predictions.push({ ...first, arm: "candidate", downstream: { ...first.downstream!, targetStopId: 99 } });
    expect(() => StopStudySchema.parse(badArrival)).toThrow(/Conflicting arrival identity/);
  });
  it("keeps a missing original first missing and rejects later-row first flags", () => {
    const input = fixture(), first = input.visits[0]!.predictions[0]!;
    first.firstCapturedDisplay = false;
    expect(StopStudySchema.safeParse(input).success).toBe(true);
    input.visits[0]!.predictions.push({ ...first, issuedAt: first.issuedAt + 30_000, firstCapturedDisplay: true });
    expect(() => StopStudySchema.parse(input)).toThrow(/later row/);
  });
});
