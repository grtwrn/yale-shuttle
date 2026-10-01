import fs from "node:fs";
import { serialize, deserialize } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import { registerRoutePaths } from "../../web/src/anchor.js";
import {
  computeUpcomingArrivals,
  type UpcomingArrival,
} from "../../web/src/arrivals.js";
import {
  applyModelParams,
  resetModelParams,
} from "../../web/src/eta/params.js";
import { setReleaseModelEnabled } from "../../web/src/eta/release.js";
import type { AnchorStore } from "../../web/src/eta/index.js";
import type { BusData } from "../../web/src/map-data.js";
import { ServerEta, type EtaPayloadView } from "./serverEta.js";
const capture = JSON.parse(
  fs.readFileSync(
    new URL("./__fixtures__/red-release-2026-09-17.json", import.meta.url),
    "utf8",
  ),
) as {
  static: Omit<EtaPayloadView, "buses">;
  frames: { at: number; buses: BusData[] }[];
};

afterEach(() => {
  setReleaseModelEnabled(true);
  resetModelParams();
});
describe("recorded Red release transitions", () => {
  it("keeps both target occurrences ordered, preserves position, and survives a warm checkpoint", () => {
    registerRoutePaths(capture.static.route_paths!);
    applyModelParams(capture.static.model_params!);
    const baseline: AnchorStore = new Map(),
      candidate: AnchorStore = new Map();
    let previous: UpcomingArrival[] = [];
    let previousAt = 0,
      compared = 0,
      twoOccurrences = 0,
      maxRise = 0;
    let checkpoint: Buffer | undefined;
    let checkpointIndex = 0;
    for (const [i, f] of capture.frames.entries()) {
      const read = (store: AnchorStore) =>
        computeUpcomingArrivals(
          [48, 4],
          f.buses,
          capture.static.routes,
          capture.static.stop_coords,
          capture.static.segments,
          f.at,
          capture.static.dwells,
          store,
          true,
        );
      setReleaseModelEnabled(false);
      read(baseline);
      setReleaseModelEnabled(true);
      const rows = read(candidate);
      for (const [key, e] of candidate) {
        const old = baseline.get(key)!;
        expect(e.belief!.lead).toBe(old.belief!.lead);
        expect(e.belief!.p).toEqual(old.belief!.p);
      }
      for (const row of rows) {
        const q = row.distribution!;
        expect(q).toHaveLength(50);
        expect(q).toEqual([...q].sort((a, b) => a - b));
        expect(row.low).toBeLessThanOrEqual(row.eta);
        expect(row.eta).toBeLessThanOrEqual(row.high);
        // During route ambiguity the point follows the lead cluster while
        // the distribution includes alternatives; the band must cover them.
        expect(row.low).toBeLessThanOrEqual(q[5]! + 1e-7);
        expect(row.high).toBeGreaterThanOrEqual(q[44]! - 1e-7);
        const old = previous.find(
          (r) => r.stopId === row.stopId && r.stopsAhead === row.stopsAhead,
        );
        const dt = (f.at - previousAt) / 1000;
        if (old && dt > 0 && dt < 15 && f.buses[0]?.at_stop_id === 11)
          maxRise = Math.max(maxRise, dt + row.eta - old.eta);
        compared++;
      }
      if (rows.filter((r) => r.stopId === 48).length === 2) twoOccurrences++;
      previous = rows;
      previousAt = f.at;
      // Save a supported live stand; resume the exact next raw observation.
      if (!checkpoint && f.at >= Date.parse("2026-09-17T12:57:00Z")) {
        checkpoint = serialize({
          v: 1,
          at: f.at,
          store: candidate,
          seen: new Map([...candidate.keys()].map((k) => [k, f.at])),
        });
        checkpointIndex = i;
      }
    }
    expect(compared).toBeGreaterThan(600);
    expect(twoOccurrences).toBeGreaterThan(100);
    expect(maxRise).toBeLessThan(60);
    const resumed = new ServerEta({ routes: ["Red"] });
    const at = capture.frames[checkpointIndex]!.at;
    resumed.useCheckpoint({ load: () => checkpoint!, save: () => {} }, at);
    expect(resumed.stats().restored).toBeGreaterThan(0);
    const direct: AnchorStore = deserialize(checkpoint!).store;
    for (let j = checkpointIndex + 1; j < checkpointIndex + 8; j++) {
      const f = capture.frames[j]!,
        payload = { ...capture.static, buses: f.buses };
      const rows = computeUpcomingArrivals(
        [48, 4],
        f.buses,
        payload.routes,
        payload.stop_coords,
        payload.segments,
        f.at,
        payload.dwells,
        direct,
        true,
      );
      const wire = resumed.contribute(payload, j, f.at)!;
      for (const r of rows) {
        const k = wire.rows.findIndex(
          (w) => w[1] === r.stopId && w[5] === r.stopsAhead,
        );
        expect(k).toBeGreaterThanOrEqual(0);
        expect(wire.rows[k]![2]).toBe(Math.round(r.eta));
        expect(wire.distributions![k]).toEqual(r.distribution!.map(Math.round));
      }
    }
  }, 60_000);
});
