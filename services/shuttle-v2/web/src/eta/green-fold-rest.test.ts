/**
 * A RECORDED REST ON THE FOLD, ATTACHED TO THE OCCURRENCE THE BUS WAS AT.
 *
 * Green #331 stood 435 s at Building 800 on 2026-09-12, 10:16-10:24 ET — the
 * operator watched the line "flick from 22 to 34 minutes" and the flick was the
 * app recovering; the eight minutes before it were the defect.
 *
 * Building 800 is ring 13 OUTBOUND and ring 18 on the return, the same kerb.
 * The detector's own `stop_visits` row for this stand names `stop_index` 13,
 * and the rest of the pass corroborates it: the bus went on to Building 600,
 * 400, 600, 750, Building 800 AGAIN (a 20 s stand at occurrence 18), 900 and
 * the station. So which occurrence the bus was at is not a matter of opinion
 * here, and the belief said 18.
 *
 * It said 18 because the published line's OUTBOUND pass never comes within
 * 99 m of Building 800's kerb, so occurrence 13's projected cell was 99 m from
 * the stop, no cell of the ring lay inside that marker's zone, and the
 * emission made the state the bus was actually in ~180,000 : 1 less likely
 * than the RETURN occurrence 92.6 m away. `buildRing` now places such a cell
 * on its marker (`ring.unreached`, one occurrence in 280 network-wide).
 *
 * The bound this file cares about is the RIDER'S, and it is asymmetric: a bus
 * promised EARLIER than it comes sends someone down to a stop the bus has
 * already left. Master is optimistic by up to 693 s here, on 103 of 120 polls
 * at Building 900; this arm's worst is 264 s on 31. It pays for that by being
 * pessimistic later in the stand, which is the trade the repo takes.
 *
 * Regenerate with `scripts/eta-replay/greenfold/make-rest-fixture.ts` from a
 * capture directory; `raw_positions` is swept at 6 h, so do not expect to
 * re-record this pass from production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerRoutePaths } from "../anchor";
import type { LatLon } from "../geo";
import { anchorKeyFor } from "../liveAnchor";
import { arrivalsForBus, beliefFor, ringForBus, type AnchorStore } from "./index";
import { applyModelParams } from "./params";

import fixture from "../__fixtures__/green-fold-rest.json";

const F = fixture as unknown as {
  routeLabel: string; busName: string; restStopId: number; restRingIndex: number;
  rest: { arrivedAt: number; pinnedAt: number; departedAt: number; standSec: number };
  routeStops: Record<string, number[]>;
  stopCoords: Record<string, [number, number] | LatLon>;
  routePath: [number, number][];
  segments: Record<string, Record<string, never>>;
  dwells: Record<string, Record<string, never>>;
  modelParams: { params?: unknown; version?: string; publishedAt?: number } | null;
  positions: Array<{
    t: number; lat: number; lon: number; heading: number; last_stop_id: number | null;
    at_stop_id: number | null; at_stop_since: number | null;
    stationary_since: number | null; last_moved_at: number | null;
  }>;
  visits: Array<{ stopId: number; stopIndex: number; arrivedAt: number; departedAt: number | null; standSec: number; outcome: string }>;
  arrivals: Array<{ stopId: number; arrivedAt: number; departedAt: number | null }>;
};

const STOPS = F.routeStops["9"]!;
const COORDS: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(F.stopCoords)) {
  COORDS[Number(k)] = Array.isArray(v) ? { lat: v[0]!, lon: v[1]! } : v;
}
const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString().replace(/Z$/, ""));

/** The stops downstream of the rest that the incident was scored against. */
const WATCHED = [26, 127, 80, 94];

/**
 * The rider-harm bound: no poll may promise any watched stop more than this
 * many seconds EARLIER than the bus actually reached it. Master's worst is
 * 693 s; this arm's is 264 s, so the bound separates them with margin on both
 * sides and is not a re-recording of either.
 */
const MAX_OPTIMISM_SEC = 300;

/** The 435 s rest itself: arrival at the kerb to the detector's departure. */
const inRest = (p: Poll) => p.t >= F.rest.arrivedAt && p.t <= F.rest.departedAt;

interface Poll {
  t: number;
  restStop: number;
  rested: boolean;
  standingAt: number;
  atStopId: number | null;
  err: Map<number, number>;
}

function replay(): Poll[] {
  const store: AnchorStore = new Map();
  const key = anchorKeyFor(F.routeLabel, F.busName);
  const targets = new Set(STOPS);
  const out: Poll[] = [];
  for (const p of F.positions) {
    const bus = {
      bus_id: 66263, bus_name: F.busName, route_id: 9,
      lat: p.lat, lon: p.lon, heading: p.heading, last_stop_id: p.last_stop_id,
      ...(p.at_stop_id != null ? { at_stop_id: p.at_stop_id, at_stop_since: iso(p.at_stop_since) } : {}),
      ...(p.stationary_since != null ? { stationary_since: iso(p.stationary_since) } : {}),
      ...(p.last_moved_at != null ? { last_moved_at: iso(p.last_moved_at) } : {}),
    } as never;
    const ring = ringForBus({ route_id: 9 }, STOPS, COORDS)!;
    const belief = beliefFor(store, key, bus, ring, ring.stops, p.t);
    const rows = arrivalsForBus(
      store, key, bus, ring, STOPS, COORDS,
      F.segments["9"] as never, F.dwells["9"] as never, targets, p.t, undefined, F.dwells as never,
    );
    const err = new Map<number, number>();
    let standingAt = -1;
    for (const sid of WATCHED) {
      const row = rows.filter((r) => r.stopId === sid).sort((a, b) => a.eta - b.eta)[0];
      if (!row) continue;
      standingAt = row.standingAt;
      const truth = F.arrivals
        .filter((a) => a.stopId === sid && a.arrivedAt >= p.t)
        .sort((a, b) => a.arrivedAt - b.arrivedAt)[0];
      if (truth) err.set(sid, Math.round(row.eta - (truth.arrivedAt - p.t) / 1000));
    }
    out.push({ t: p.t, restStop: belief.restStop, rested: belief.rested, standingAt, atStopId: p.at_stop_id, err });
  }
  return out;
}

let polls: Poll[];

beforeAll(() => {
  registerRoutePaths({ "9": F.routePath });
  if (F.modelParams) expect(applyModelParams(F.modelParams), "the fixture's served model_params were rejected").toBe(true);
  polls = replay();
});
afterAll(() => {
  registerRoutePaths(null);
  applyModelParams(null);
});

describe("the recorded Green stand is attached to the occurrence the bus was at", () => {
  it("the fixture is the recorded pass, and the detector names occurrence 13", () => {
    expect(F.positions.length).toBeGreaterThan(300);
    expect(F.rest.standSec).toBeGreaterThan(400);
    const visit = F.visits.find((v) => v.stopId === F.restStopId && v.standSec > 400);
    expect(visit, "the 435 s Building 800 visit").toBeTruthy();
    expect(visit!.stopIndex).toBe(F.restRingIndex);
    // And the SECOND call at the same kerb, minutes later, is the other
    // occurrence — which is what makes 13 the answer rather than a coin flip.
    const second = F.visits.find((v) => v.stopId === F.restStopId && v.standSec < 100);
    expect(second!.stopIndex).toBe(18);
  });

  it("never attaches THIS rest to the return occurrence", () => {
    // Master attaches it to 18 on the poll the bus reaches the kerb and holds
    // it for the whole stand; this is the assertion that fails there. Scoped to
    // the rest, because the bus really does call at occurrence 18 later in the
    // same fixture and a rest there is then the right answer.
    const seen = new Set(polls.filter(inRest).filter((p) => p.rested).map((p) => p.restStop));
    expect(Array.from(seen).sort((a, b) => a - b)).not.toContain(18);
    // ... and that later call is the control: 18 is reachable, just not now.
    const late = polls.filter((p) => p.rested && p.restStop === 18);
    expect(late.every((p) => p.t > F.rest.departedAt)).toBe(true);
  });

  it("attaches every standing poll of the rest to occurrence 13", () => {
    const during = polls.filter((p) => p.atStopId === F.restStopId && p.t <= F.rest.departedAt && p.rested);
    expect(during.length).toBeGreaterThan(80);
    for (const p of during) {
      expect(p.restStop, `poll ${new Date(p.t).toISOString()} attached the rest elsewhere`).toBe(F.restRingIndex);
    }
    // And it is the stop the price is taken from, not just a label on the chip.
    const standing = during.filter((p) => p.standingAt >= 0);
    expect(standing.length).toBeGreaterThan(80);
    for (const p of standing) expect(p.standingAt).toBe(F.restRingIndex);
  });

  it("never promises a downstream stop more than five minutes early", () => {
    // The direction that has a rider stroll down and find the bus gone. Over
    // the 91 polls of the rest, master is optimistic past 120 s on 91 of 91 at
    // Building 900, 87 of 91 at the station and 87 of 91 at Bradley (N), by up
    // to 693 s; this arm's worst is 203 s and its count is 21 of 364 stop-polls.
    //
    // Scoped to the rest. Before it the bus is eleven minutes out and both arms
    // are identically wrong (−905 s at Building 900); that is the cold belief
    // and a different question.
    for (const p of polls.filter(inRest)) {
      for (const [sid, err] of p.err) {
        expect(err, `stop ${sid} at ${new Date(p.t).toISOString()} promised ${-err} s early`)
          .toBeGreaterThan(-MAX_OPTIMISM_SEC);
      }
    }
  });

  it("keeps the optimistic tail small across the whole rest", () => {
    // The aggregate of the same thing, so a single lucky poll cannot carry it:
    // stop-polls optimistic by more than 120 s over the rest. Master 318 of
    // 364, this arm 21.
    const tail = polls.filter(inRest)
      .reduce((n, p) => n + Array.from(p.err.values()).filter((e) => e < -120).length, 0);
    expect(tail).toBeLessThanOrEqual(40);
  });

  it("holds one number through the stand rather than re-pricing it", () => {
    // The stand is a wait, not news: while the bus is standing at 13 and the
    // rest has not ended, the station's promise must not move by more than a
    // poll's worth of clock.
    const during = polls.filter((p) => p.atStopId === F.restStopId && p.t <= F.rest.departedAt && p.standingAt === F.restRingIndex);
    const etas = during.map((p) => p.err.get(127)).filter((x): x is number => x != null);
    expect(etas.length).toBeGreaterThan(80);
    // err = promise - (truth - now), so a frozen promise makes err rise with
    // the clock, 5 s per poll. Any JUMP is a re-price.
    for (let i = 1; i < etas.length; i++) {
      expect(Math.abs(etas[i]! - etas[i - 1]!), `re-priced at poll ${i}`).toBeLessThanOrEqual(10);
    }
  });
});
