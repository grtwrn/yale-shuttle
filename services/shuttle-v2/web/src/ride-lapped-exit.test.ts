/**
 * "MAY HAVE PASSED" ONLY AFTER THE EXIT — incident mayhavepassed20261002.
 *
 * #350 (live 2026-10-01 19:46Z, build 8ad92f96bca8) printed "May have passed
 * <exit> · back in N min" on four rider rides whose bus was still driving to
 * the exit for the first time: 2.6 km short of it on Green, 1–1.4 km on Pink,
 * and it stayed up until the kerb. The countdown beside it was right; the
 * state was not. The ride list keeps one slot per stop, so Green's second pass
 * of a West Campus stop, and Pink's run out past Quigley Stadium Outbound (a
 * stop the repaired ring visits on the way to the hospital, #160), read as
 * past the exit, and having been seen inside the window was all the evidence
 * #350 asked for. Replayed here fix by fix through the shared anchor and the
 * banner's decision.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerRoutePaths } from "./anchor";
import type { AnchorStore } from "./eta";
import type { LatLon } from "./geo";
import { anchorIndexOnList } from "./liveAnchor";
import { rideEvidence, rideInWindow, rideLappedExit, type RideEvidence } from "./rideArrival";
import { ROUTE_LISTS } from "./routes";
import green from "./__fixtures__/green-published-order.json";
import pink from "./__fixtures__/pink-published-order.json";
import fixture from "./__fixtures__/ride-lapped-exit-2026-10-02.json";

const routeStops: Record<string, number[]> = { "8": pink.stops, "9": green.stops };
const coords: Record<number, LatLon> = {};
for (const [id, ll] of Object.entries({ ...pink.stopCoords, ...green.stopCoords })) {
  const [lat, lon] = ll as [number, number];
  coords[Number(id)] = { lat, lon };
}

type Ride = (typeof fixture.rides)[number];
const ride = (runId: string) => fixture.rides.find((r) => r.runId === runId)!;
const passedOnPage = (shown: string | null) => (shown ?? "").startsWith("May have passed");

/** Each recorded poll through `anchorIndexOnList` (one store, as on the server),
 * then the banner's evidence fold from the moment the ride started. `rule350`
 * is #350's decision on the same index: seen inside the window, ever. */
function replay(r: Ride, alightStopId = r.alightStopId) {
  const cfg = ROUTE_LISTS.find((c) => c.label === r.routeLabel)!;
  const raw = routeStops[String(r.routeId)]!;
  const list = [...new Set(raw)];
  const board = list.indexOf(r.boardStopId), alight = list.indexOf(alightStopId);
  const store: AnchorStore = new Map();
  let evidence: RideEvidence = "none";
  let rode = false;
  return r.positions.map((fix) => {
    const bus = { ...fix, route_id: r.routeId, bus_name: r.busName };
    const idx = anchorIndexOnList(bus, cfg, routeStops, coords, list, fix.observed_at + 100, store);
    const onRide = fix.phase !== "waiting";
    if (onRide) {
      evidence = rideEvidence(evidence, idx, board, alight, list.length);
      rode = rode || rideInWindow(idx, board, alight, list.length);
    }
    const lapped = (reachedExit: boolean) => onRide && rideLappedExit({
      busIndex: idx, boardIndex: board, alightIndex: alight, stopCount: list.length,
      reachedExit, rawRoute: raw, alightStopId,
    });
    return {
      at: fix.at, shown: fix.shown, stopId: list[idx], evidence,
      beforeArrival: Date.parse(fix.at) < Date.parse(r.arrivedAt),
      rule350: lapped(rode), passed: lapped(evidence === "reached"),
    };
  });
}

beforeEach(() => registerRoutePaths({ "8": pink.path, "9": green.path } as unknown as Record<string, [number, number][]>));
afterEach(() => registerRoutePaths(null));

describe.each(fixture.rides.map((r) => [`${r.routeLabel} ${r.busName} run ${r.runId}`, r] as const))(
  "%s (incident mayhavepassed20261002)",
  (_name, r) => {
    it("the recording is the reported defect: the page said the exit was passed before the bus reached it", () => {
      expect(r.positions.some((p) => passedOnPage(p.shown) && Date.parse(p.at) < Date.parse(r.arrivedAt))).toBe(true);
    });

    it("#350's rule reproduces it from the same polls", () => {
      const steps = replay(r).filter((s) => s.beforeArrival);
      expect(steps.some((s) => s.rule350)).toBe(true);
      // Every poll the replay calls passed, the page printed it.
      for (const s of steps.filter((s) => s.rule350)) expect([s.at, s.shown]).toEqual([s.at, expect.stringMatching(/^May have passed /)]);
    });

    it("never says the exit may have been passed before the bus reaches it", () => {
      const steps = replay(r);
      expect(steps.filter((s) => s.beforeArrival && s.passed).map((s) => `${s.at} ${s.stopId}`)).toEqual([]);
    });

    it("still sees the bus carry the ride to the exit", () => {
      const steps = replay(r);
      expect(steps[steps.length - 1]!.evidence).toBe("reached");
    });
  },
);

// The same recordings with an exit the bus really did drive past: the state
// #350 added must survive the fix.
describe("a genuinely lapped exit still reads as passed", () => {
  const firstPassed = (steps: ReturnType<typeof replay>) => steps.find((s) => s.passed);

  it("Pink #324 past Quigley Stadium Inbound, on toward the VA", () => {
    const steps = replay(ride("1790946135278"), 109);
    const at = steps.findIndex((s) => s.stopId === 109 && s.evidence === "reached");
    expect(steps.slice(0, at + 1).some((s) => s.passed)).toBe(false);
    expect(firstPassed(steps)?.at).toBe(steps[at + 1]!.at);
    expect(steps.slice(at + 1).filter((s) => s.beforeArrival).every((s) => s.passed)).toBe(true);
  });

  it("Green #122 past Building 750, on to Building 800", () => {
    const steps = replay(ride("1790942316465"), 24);
    const at = steps.findIndex((s) => s.stopId === 24 && s.evidence === "reached");
    expect(at).toBeGreaterThan(0);
    expect(steps.slice(0, at + 1).some((s) => s.passed)).toBe(false);
    expect(firstPassed(steps)?.stopId).toBe(25);
  });

  it("Pink #307 out to VA Hospital and back past it", () => {
    const steps = replay(ride("1790887397343"), 125);
    const at = steps.findIndex((s) => s.stopId === 125 && s.evidence === "reached");
    expect(at).toBeGreaterThan(0);
    expect(steps.slice(0, at + 1).some((s) => s.passed)).toBe(false);
    // Back at VA Entrance Inbound — the pickup — is not past; VA Entrance Outbound is.
    expect(firstPassed(steps)?.stopId).toBe(124);
  });
});
