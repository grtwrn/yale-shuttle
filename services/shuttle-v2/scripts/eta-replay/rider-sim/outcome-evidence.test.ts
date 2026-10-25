import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/outcome-evidence.json";
import { aggregate, renderCompare, renderSummary, compareRuns, type PosRow, type StopVisit, type WaitResult } from "./lib.js";
import { createOutcomeEvidenceLookup, summarizeOutcomeEvidence } from "./outcome-evidence.js";

const records = fixture.records as unknown as Array<{ wait: WaitResult; visit: StopVisit;
  stopCoordinate: { lat: number; lon: number }; rawRows: PosRow[]; expectedDistanceMeters: number }>;
const far = records[0]!;
function enrich(record = far, rows = record.rawRows, vs = [record.visit], coords = { [record.wait.boardStopId]: record.stopCoordinate }) {
  return { ...record.wait, outcomeEvidence: createOutcomeEvidenceLookup(rows,
    new Map([[record.wait.boardStopId, vs]]), coords)(record.wait, [3]) };
}

describe("recorded arrival-label evidence", () => {
  it("exposes the 2km feed fallback and retains the original -881s miss and all score fields", () => {
    const enriched = enrich(), { outcomeEvidence: e, ...original } = enriched;
    expect(original).toEqual(far.wait);
    expect(enriched.firstSightMissSec).toBe(-881);
    expect(e.physicalArrivalVerified).toBe(false);
    expect(e.arrival).toMatchObject({ visitSource: "feed", rawMatch: "unique", routeAgreement: "matched", distanceBand: ">1000m" });
    expect(e.arrival!.distanceMeters).toBeCloseTo(2012.4123196655648, 6);
  });

  it("retains actual curb-correlated Red75/39 labels without claiming physical boarding", () => {
    for (const record of records.slice(1)) {
      const e = enrich(record).outcomeEvidence;
      expect(e.arrival).toMatchObject({ visitSource: "curb", distanceBand: "<=45m", rawMatch: "unique" });
      expect(e.arrival!.distanceMeters).toBeCloseTo(record.expectedDistanceMeters, 6);
      expect(e.physicalArrivalVerified).toBe(false);
    }
  });

  it("reports missing raw witnesses, visits and stop coordinates separately", () => {
    expect(enrich(far, []).outcomeEvidence.arrival).toMatchObject({ rawMatch: "missing", distanceMeters: null, distanceBand: "unknown" });
    expect(enrich(far, far.rawRows, []).outcomeEvidence.arrival).toMatchObject({ visitSource: "missing", rawMatch: "unique", routeAgreement: "unknown" });
    expect(enrich(far, far.rawRows, [far.visit], {}).outcomeEvidence.arrival).toMatchObject({ stopCoordinate: null, distanceMeters: null, distanceBand: "unknown" });
  });

  it("counts identical raw duplicates and exposes competing IDs/coordinates without picking the nearest", () => {
    const p = far.rawRows[0]!;
    expect(enrich(far, [p, { ...p }]).outcomeEvidence.arrival).toMatchObject({ rawMatch: "duplicate", rawRowCount: 2, uniqueRawRowCount: 1, distanceBand: ">1000m" });
    for (const other of [{ ...p, i: p.i + 1 }, { ...p, ...far.stopCoordinate }]) {
      expect(enrich(far, [p, other]).outcomeEvidence.arrival).toMatchObject({ rawMatch: "ambiguous", rawRowCount: 2, uniqueRawRowCount: 2, distanceMeters: null, distanceBand: "unknown" });
    }
  });

  it("retains duplicate/competing visits and other-route raw fixes", () => {
    expect(enrich(far, far.rawRows, [far.visit, { ...far.visit }]).outcomeEvidence.arrival).toMatchObject({ visitSource: "ambiguous", visits: [expect.anything(), expect.anything()], routeAgreement: "ambiguous" });
    expect(enrich(far, far.rawRows.map(p => ({ ...p, r: 99 }))).outcomeEvidence.arrival).toMatchObject({ rawMatch: "unique", routeAgreement: "mismatched" });
    expect(enrich(far, far.rawRows, [{ ...far.visit, routeId: 99 }]).outcomeEvidence.arrival!.visitSource).toBe("missing");
  });

  it("keeps gaveUp/dataEnded and bus-at-stop context without inventing an arrival", () => {
    for (const outcome of ["gaveUp", "dataEnded"] as const) {
      const w = { ...far.wait, outcome, arrivedAt: null, arrivedBus: null, busAtStopOnArrival: "#126" };
      const e = createOutcomeEvidenceLookup([], new Map(), {})(w, [3]);
      expect(e.arrival).toBeNull(); expect(e.busAtStopOnArrival).toBe("#126");
      expect(summarizeOutcomeEvidence([{ ...w, outcomeEvidence: e }]).waits.noClaimedArrival).toBe(1);
    }
  });

  it("reports curb-only labels and invalid coordinates without inventing distance evidence", () => {
    const e = enrich(far, far.rawRows, [{ ...far.visit, source: "curb-only" }],
      { [far.wait.boardStopId]: { lat: NaN, lon: far.stopCoordinate.lon } }).outcomeEvidence;
    expect(e.arrival).toMatchObject({ visitSource: "curb-only", stopCoordinate: null, distanceMeters: null, distanceBand: "unknown" });
  });

  it("counts correlated waits and distinct labels separately, with per-route and old-file unknowns", () => {
    const a = enrich(), b = { ...a, id: a.id + ":second" };
    const s = summarizeOutcomeEvidence([a, b, records[1]!.wait]);
    expect(s.waits).toMatchObject({ total: 3, missingMetadata: 1, visitSources: { feed: 2 } });
    expect(s.distinctArrivals).toMatchObject({ total: 2, missingMetadata: 1, visitSources: { feed: 1 } });
    expect(s.byRoute.Red).toEqual({ waits: s.waits, distinctArrivals: s.distinctArrivals, unidentifiedArrivalWaits: 0 });
    const contextOnly = summarizeOutcomeEvidence([a, { ...b, busAtStopOnArrival: "#126",
      outcomeEvidence: { ...b.outcomeEvidence, busAtStopOnArrival: "#126" } }]);
    expect(contextOnly.distinctArrivals.conflictingEvidence).toBe(0);
    expect(contextOnly.distinctArrivals.visitSources.feed).toBe(1);
    const conflicting = summarizeOutcomeEvidence([a, { ...b, outcomeEvidence: enrich(far, []).outcomeEvidence }]);
    expect(conflicting.distinctArrivals.conflictingEvidence).toBe(1);
    expect(conflicting.distinctArrivals.visitSources.feed).toBe(0);
  });

  it("leaves all legacy aggregates and paired scores identical and warns in the console", () => {
    const original = records.map(r => r.wait), enriched = records.map(r => enrich(r));
    const { outcomeEvidence: _old, ...before } = aggregate(original);
    const { outcomeEvidence: _new, ...after } = aggregate(enriched);
    expect(after).toEqual(before);
    expect(compareRuns(original, enriched)).toEqual(compareRuns(original, original));
    expect(renderSummary("recorded", aggregate(enriched))).toContain("distinct arrival labels 3");
    expect(renderSummary("old", aggregate(original))).toContain("missing metadata 3");
    expect(renderCompare(compareRuns(original, enriched), "old", "new")).toContain("not independent physical boarding evidence");
  });
});
