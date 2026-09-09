import { describe, expect, it } from "vitest";
import { TransitNetwork } from "../../../src/network/TransitNetwork.js";
import type { Episode, Position } from "./contract.js";
import { rebuildLabels, matchLabels, type RebuiltEpisode } from "./rebuild-labels.js";

const base = 1788500000000, lat = 41.31, lon = -72.93;
const coord = (m: number) => ({ lat, lon: lon + m / (111320 * Math.cos(lat * Math.PI / 180)) });
const stops = [0, 840, 1680].map((m, i) => ({ id: i + 1, name: String(i + 1), ...coord(m) }));
const network = TransitNetwork.build(stops, [1, 2].map(id => ({ id, name: String(id), shortName: String(id), color: "#000", stops: [1, 2, 3] })));
const position = (m: number, seconds: number, extra: Partial<Position> = {}): Position => ({
  bus_id: 1, bus_name: "A", route_id: 1, heading: 90, last_stop_id: null,
  collected_at: base + seconds * 1000, ...coord(m), ...extra });

describe("prediction-blind label reconstruction", () => {
  it("retains observed entry and emits its departure only after confirmation", () => {
    const rows = [-100, -50, 0, 0, 0, 0, 0, 40, 80, 160].map((m, i) => position(m, i * 5));
    const result = rebuildLabels(network, rows, "2026-09-04");
    const visit = result.episodes.find(e => e.labelStatus === "complete")!;
    expect(visit.pinnedAt).toBe(base + 5000);
    expect(visit.departedAt).toBe(base + 30000);
    expect(visit.knownAt).toBe(base + 45000);
    expect(visit.leftCensored).toBe(false);
    expect(visit.outcome).toBe("stopped");
  });

  it("censors a visit already inside the pin radius at capture start", () => {
    const rows = [0, 0, 0, 0, 40, 80, 160].map((m, i) => position(m, i * 5));
    const visit = rebuildLabels(network, rows, "2026-09-04").episodes[0]!;
    expect(visit.leftCensored).toBe(true);
    expect(visit.labelStatus).toBe("censored");
    expect(visit.departedAt).not.toBeNull();
    expect(visit.outcome).toBe("unresolved");
  });

  it("splits gaps over30 seconds and does not invent a departure through the gap", () => {
    const rows = [position(-100, 0), position(0, 5), position(0, 10), position(0, 15),
      position(0, 60), position(0, 65), position(0, 70), position(160, 75)];
    const result = rebuildLabels(network, rows, "2026-09-04");
    expect(result.counts.gapBreaks).toBe(1);
    expect(result.episodes.every(e => e.labelStatus === "censored")).toBe(true);
    expect(result.episodes[0]!.rightCensored).toBe(true);
    expect(result.episodes[0]!.censorReason).toBe("observation_gap");
  });

  it("retains an initial-rest censor even when the captured rest starts short of the pin radius", () => {
    const rows = [-100, -100, -100, -100, -50, 0, 0, 0, 0, 40, 160].map((m, i) => position(m, i * 5));
    const visit = rebuildLabels(network, rows, "2026-09-04").episodes[0]!;
    expect(visit.leftCensored).toBe(false);
    expect(visit.initialRestCensored).toBe(true);
    expect(visit.labelStatus).toBe("censored");
    expect(visit.departedAt).not.toBeNull();
  });

  it("censors an initially-inside visit even when a nearby anchor delays its pin and fixes change", () => {
    const twin = TransitNetwork.build([...stops, { id: 4, name: "Twin", ...coord(100) }],
      [{ id: 1, name: "Twin line", shortName: "T", color: "#000", stops: [1, 4, 2] }]);
    const rows = [60, 40, 0, 0, 0, 0, 160, 200].map((m, i) => position(m, i * 5));
    const visit = rebuildLabels(twin, rows, "2026-09-04").episodes.find(e => e.stopId === 1)!;
    expect(visit.pinnedAt).toBeGreaterThan(base);
    expect(visit.initialRestCensored).toBe(false);
    expect(visit.leftCensored).toBe(true);
    expect(visit.labelStatus).toBe("censored");
  });

  it("breaks globally duplicated names even when they appear on different routes", () => {
    const rows = [position(-100, 0), position(0, 5), position(0, 10), position(0, 15),
      position(0, 20), position(840, 20, { bus_id: 2, route_id: 2 })];
    const result = rebuildLabels(network, rows, "2026-09-04");
    expect(result.counts.ambiguousPollRows).toBe(2);
    expect(result.episodes[0]!.censorReason).toBe("ambiguous_identity");
    expect(result.episodes.every(e => e.labelStatus === "censored")).toBe(true);
  });
});

describe("original-label matching is mutual and occurrence-specific", () => {
  const old = (id: string, index = 0) => ({ id, busKey: "A", routeId: 1, routePatternId: "same-pattern", stopId: 1,
    stopIndex: index, patternResolved: true, pinnedAt: base + 10000, departedAt: base + 120000 }) as Episode;
  const rebuilt = (id: string, index = 0) => ({ ...old(id, index), labelStatus: "complete", pinnedAt: base }) as RebuiltEpisode;
  it("rejects both duplicate originals instead of choosing a favorable nearest match", () => {
    const rows = matchLabels([old("a"), old("b")], [rebuilt("new")]);
    expect(rows.map(r => r.status)).toEqual(["ambiguous", "ambiguous"]);
    expect(rows.every(r => r.reconstructedEpisodeId === null)).toBe(true);
  });
  it("does not collapse repeated physical stops or unresolved patterns", () => {
    const rows = matchLabels([old("a", 2), { ...old("b"), patternResolved: false }], [rebuilt("new", 0)]);
    expect(rows.map(r => r.status)).toEqual(["unmatched", "unresolved_original"]);
    expect(matchLabels([old("a", 2)], [rebuilt("new", 2)])[0]!.status).toBe("matched");
  });
});
