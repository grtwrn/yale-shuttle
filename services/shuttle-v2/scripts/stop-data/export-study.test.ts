import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { exportStudy } from "./export-study.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const start = Date.parse("2026-09-08T12:00:00Z");
const episode = { id: "rebuilt", day: "2026-09-08", routeId: 91, routePatternId: "91:pattern", stopId: 731,
  stopIndex: 2, busId: 7, busKey: "shuttle", anchoredAt: start - 10_000, pinnedAt: start,
  arrivedAt: start + 15_000, departedAt: start + 120_000, outcome: "stopped", patternResolved: true,
  labelStatus: "complete", leftCensored: false, rightCensored: false };
function display(sec: number, value: number) {
  return { id: `query-${sec}`, episodeId: "rebuilt", issuedAt: start + sec * 1000,
    routeId: 91, stopId: 731, stopIndex: 2, labelStopIndex: 2, busKey: "shuttle", elapsedSec: sec + 5,
    occurrenceAgreement: true, shown: { sec: value, typicalSec: value + 10, remaining: true } };
}
function eta(sec: number, arrival = "physical-arrival") {
  return { currentVisitId: "rebuilt", issuedAt: start + sec * 1000, servedOccurrencesAhead: 1,
    routeId: 91, busKey: "shuttle", currentStopId: 731, stopId: 732, stopIndex: 3,
    targetArrivalId: arrival, targetAt: start + 200_000, quantileLevels: [.1, .5, .9],
    quantilesSec: [-3, 100, 250], actualSec: 200 - sec };
}
async function config(files: Record<string, unknown[]>, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "stop-study-export-")); directories.push(dir);
  for (const [name, values] of Object.entries(files)) await writeFile(join(dir, `${name}.jsonl.gz`), gzipSync(values.map(v => JSON.stringify(v)).join("\n") + "\n"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ title: "Synthetic arbitrary route", forecastIntervalSec: 30,
    days: [{ episodes: "episodes.jsonl.gz", baselineStands: "baseline.jsonl.gz", candidateStands: "candidate.jsonl.gz", ...extra }], ...options }));
  return path;
}

describe("saved study exporter", () => {
  it("pairs before sampling without promoting a later row to an original first display", async () => {
    const path = await config({ episodes: [episode], baseline: [display(0, 200), display(10, 180), display(20, 170), display(40, 140)],
      candidate: [display(10, 80), display(20, 70), display(40, 50)],
      recorded: [{ ...episode, id: "original", pinnedAt: start + 50_000 }],
      matches: [{ status: "matched", reconstructedEpisodeId: "rebuilt", originalEpisodeId: "original" }],
    }, { recordedEpisodes: "recorded.jsonl.gz", matches: "matches.jsonl.gz" });
    const out = await exportStudy(path, start);
    const visit = out.visits[0]!;
    expect(visit.pinnedAt).toBe(start);
    expect(visit.recordedPinnedAt).toBe(start + 50_000);
    expect(visit.predictions.map(p => [p.issuedAt - start, p.arm, p.firstCapturedDisplay])).toEqual([
      [10_000, "baseline", false], [10_000, "candidate", true], [40_000, "baseline", false], [40_000, "candidate", false],
    ]);
    expect(visit.predictions[0]!.observedStartAt).toBe(start - 5_000);
    expect(visit.predictions[0]!.predictedTotalSec).toBe(190);
    expect(out.provenance.counts).toMatchObject({ pairedDisplayQueries: 3, exportedDisplayQueries: 2, baselineUnpairedDisplayQueries: 1 });
    expect(out.provenance.inputs.every(row => !row.name.includes("/"))).toBe(true);
  });
  it("rejects duplicate saved queries", async () => {
    const path = await config({ episodes: [episode], baseline: [display(0, 60), display(0, 60)], candidate: [display(0, 50)] });
    await expect(exportStudy(path)).rejects.toThrow(/Duplicate baseline display query/);
  });
  it("retains censored episodes without manufacturing a complete total", async () => {
    const path = await config({ episodes: [{ ...episode, labelStatus: "censored", leftCensored: true, censorReason: "initial_inside_pin" }], baseline: [], candidate: [] });
    const out = await exportStudy(path);
    expect(out.visits[0]).toMatchObject({ pinnedAt: start, departedAt: start + 120_000, pinnedStandSec: null, labelStatus: "censored", predictions: [] });
  });
  it("preserves exact negative ETA bounds only when both arms target the same arrival", async () => {
    const path = await config({ episodes: [episode], baseline: [display(10, 60), display(40, 40)], candidate: [display(10, 50), display(40, 30)],
      baselineEta: [eta(10), eta(40)], candidateEta: [eta(10), eta(40, "different-arrival")],
    }, { baselineEtas: "baselineEta.jsonl.gz", candidateEtas: "candidateEta.jsonl.gz" });
    const out = await exportStudy(path);
    expect(out.visits[0]!.predictions[0]!.downstream?.quantilesSec).toEqual([-3, 100, 250]);
    expect(out.visits[0]!.predictions[2]!.downstream).toBeUndefined();
    expect(out.provenance.counts.displayQueriesWithPairedArrival).toBe(1);
  });
  it("retains the first and last observed GPS fix without attaching another bus", async () => {
    const position = (sec: number, bus = 7) => ({ collected_at: start + sec * 1000, route_id: 91, bus_id: bus,
      bus_name: "shuttle", lat: 41.3, lon: -72.9 });
    const path = await config({ episodes: [episode], baseline: [], candidate: [], positions: [position(0), position(2), position(5), position(7), position(10, 8)] }, { positions: "positions.jsonl.gz" });
    const out = await exportStudy(path);
    expect(out.positionTracks?.[0]!.positions.map(p => p.at - start)).toEqual([0, 5000, 7000]);
    expect(out.positionTracks?.[0]!.positions.map(p => p.gapSec)).toEqual([null, 3, 2]);
  });
  it("supports a selected downstream stop several served hops away without mixing targets", async () => {
    const later = { ...eta(10), stopId: 800, stopIndex: 6, servedOccurrencesAhead: 3 };
    const path = await config({ episodes: [episode], baseline: [display(10, 60)], candidate: [display(10, 50)],
      baselineEta: [eta(10), later], candidateEta: [eta(10), later],
    }, { baselineEtas: "baselineEta.jsonl.gz", candidateEtas: "candidateEta.jsonl.gz" }, { arrivalTargetStopId: 800 });
    const out = await exportStudy(path);
    expect(out.visits[0]!.predictions.map(p => p.downstream?.targetStopId)).toEqual([800, 800]);
    expect(out.provenance.arrivalSelection).toEqual({ kind: "target_stop", targetStopId: 800 });
  });
  it("uses only complete stopped visits as an earlier departure, keeping passes visible", async () => {
    const earlier = { ...episode, id: "earlier", anchoredAt: start - 300_000, pinnedAt: start - 300_000, departedAt: start - 200_000 };
    const pass = { ...episode, id: "pass", anchoredAt: start - 150_000, pinnedAt: null, departedAt: start - 100_000, outcome: "passed" };
    const path = await config({ episodes: [earlier, pass, episode], baseline: [], candidate: [] });
    const out = await exportStudy(path);
    expect(out.visits).toHaveLength(3);
    expect(out.visits.find(v => v.id === "rebuilt")?.previousDepartureAt).toBe(start - 200_000);
  });
  it("preserves both edges of a raw dropout even with a longer GPS sampling interval", async () => {
    const positions = [0, 10, 50, 55, 60].map(sec => ({ collected_at: start + sec * 1000, route_id: 91,
      bus_id: 7, bus_name: "shuttle", lat: 41.3, lon: -72.9 }));
    const path = await config({ episodes: [episode], baseline: [], candidate: [], positions },
      { positions: "positions.jsonl.gz" }, { positionIntervalSec: 60 });
    const out = await exportStudy(path), points = out.positionTracks![0]!.positions;
    expect(points.map(p => p.at - start)).toEqual([0, 10_000, 50_000, 60_000]);
    expect(points[2]!.gapSec).toBe(40);
  });
});
