import { describe, expect, it } from "vitest";

import {
  COMPILED, CONFORMAL_RANGE, DRIFT, GAP_MS, HORIZONS, MIN_COVERAGE_BOUND_PCT, MIN_MEDIAN_BOUND_SEC,
  N_FLOORS, RANGES, ROUTE_SCALE_MAX_POOLED, ROUTE_SCALE_RANGE, ROUTE_SCALE_SHRINK_K, SCALAR_KEYS,
  assembleCandidate, conformalFit, distanceMeters, estimateEmissions,
  estimateVisitRates, fitRouteScales, horizonOf, pooled, promotionDecision, sameParams, scaleEffect,
  scoreRows, stillRuns, tracksByName, widen, zoneTester,
} from "./reestimate-lib.mjs";
import {
  PARAM_RANGES, CONFORMAL_RANGE as CLIENT_CONFORMAL_RANGE, COMPILED_MODEL_PARAMS,
  ROUTE_SCALE_RANGE as CLIENT_ROUTE_SCALE_RANGE,
} from "../web/src/eta/params";

// A synthetic feed with the answers known by construction. One degree of
// latitude is ~111 km, so 0.001 is ~111 m — well outside the 25 m ball.
const LAT = 41.31, LON = -72.93;
const M = 1 / 111_195;

/**
 * `stand` polls parked at one point, then `move` polls stepping `stepM` each,
 * every `dt` seconds. `freezeStand` / `freezeMove` say how many of each are
 * byte-identical repeats of the previous fix.
 */
function track({ standPolls, movePolls, stepM = 60, dt = 5, freezeStandEvery = 1, freezeMoveEvery = 0 }) {
  const out = [];
  let t = 0;
  let y = 0;
  for (let i = 0; i < standPolls; i++) {
    // A stand that repeats every poll except where freezeStandEvery says not to.
    if (i > 0 && (freezeStandEvery === 1 || i % freezeStandEvery !== 0)) out.push({ lat: LAT, lon: LON, t });
    else out.push({ lat: LAT + (i === 0 ? 0 : 1e-6 * i), lon: LON, t });
    t += dt * 1000;
  }
  for (let i = 0; i < movePolls; i++) {
    const repeat = freezeMoveEvery > 0 && i > 0 && i % freezeMoveEvery === 0;
    if (!repeat) y += stepM;
    out.push({ lat: LAT + y * M, lon: LON, t });
    t += dt * 1000;
  }
  return out;
}

describe("stillness", () => {
  it("calls a run inside the ball for 15 s standing and a bus doing 12 m/s moving", () => {
    const t = track({ standPolls: 10, movePolls: 10 });
    const still = stillRuns(t);
    expect([...still.slice(0, 10)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect([...still.slice(12)]).toEqual(Array(8).fill(0));
  });

  it("a run shorter than 15 s is not a stand, and a feed gap cuts a run", () => {
    expect([...stillRuns(track({ standPolls: 3, movePolls: 0, dt: 4 }))]).toEqual([0, 0, 0]);
    const gapped = [
      { lat: LAT, lon: LON, t: 0 },
      { lat: LAT, lon: LON, t: 5000 },
      { lat: LAT, lon: LON, t: 5000 + GAP_MS + 1 },
      { lat: LAT, lon: LON, t: 5000 + GAP_MS + 6000 },
    ];
    // The first pair is only 5 s; the gap stops it reaching the later two.
    expect([...stillRuns(gapped)]).toEqual([0, 0, 0, 0]);
  });
});

describe("the emissions and the hold hazards", () => {
  it("recovers repeat rates that were put in by construction", () => {
    // 41 standing polls, every one after the first a byte-identical repeat:
    // 40 standing pairs, 40 frozen. Then 41 moving polls with every 4th a
    // repeat: 40 moving pairs, 10 frozen.
    const positions = track({ standPolls: 41, movePolls: 41, freezeStandEvery: 1, freezeMoveEvery: 4 })
      .map((p) => ({ ...p, bus_name: "#1", collected_at: p.t, route_id: 1 }));
    const em = estimateEmissions(tracksByName(positions));
    expect(em.P_REPEAT_STAND.n).toBe(41);
    expect(em.P_REPEAT_STAND.value).toBeCloseTo(40 / 41, 3);
    expect(em.P_REPEAT_MOVE.value).toBeGreaterThan(0.2);
    expect(em.P_REPEAT_MOVE.value).toBeLessThan(0.3);
    // One run->stand transition and one stand->run over the two spells.
    expect(em.HOLD_ENTER_PER_S.n).toBe(0);
    expect(em.HOLD_LEAVE_PER_S.n).toBe(1);
    // 41 standing polls at 5 s = 200 s of stand before the one departure.
    expect(em.HOLD_LEAVE_PER_S.value).toBeCloseTo(1 / em.HOLD_LEAVE_PER_S.seconds, 6);
  });

  it("counts the hazards per second in each direction", () => {
    // stand (20 polls) -> move (20) -> stand (20): one enter, one leave.
    const a = track({ standPolls: 20, movePolls: 20 });
    const last = a[a.length - 1];
    const b = Array.from({ length: 20 }, (_, i) => ({ lat: last.lat, lon: last.lon, t: last.t + (i + 1) * 5000 }));
    const positions = [...a, ...b].map((p) => ({ ...p, bus_name: "#1", collected_at: p.t, route_id: 1 }));
    const em = estimateEmissions(tracksByName(positions));
    expect(em.HOLD_ENTER_PER_S.n).toBe(1);
    expect(em.HOLD_LEAVE_PER_S.n).toBe(1);
    expect(em.HOLD_ENTER_PER_S.value).toBeGreaterThan(0);
    expect(em.HOLD_LEAVE_PER_S.value).toBeGreaterThan(0);
  });

  it("splits the moving repeats by whether the sample is in a stop's zone", () => {
    const near = { lat: LAT, lon: LON };
    const far = { lat: LAT + 5000 * M, lon: LON };
    const stopCoords = { 7: near };
    const inZone = zoneTester([{ id: 1, stops: [7] }], stopCoords);
    expect(inZone({ ...near, route_id: 1 })).toBe(true);
    expect(inZone({ ...far, route_id: 1 })).toBe(false);
    expect(inZone({ ...near, route_id: 99 })).toBe(false);
    expect(distanceMeters(near, far)).toBeGreaterThan(4900);
  });
});

describe("the visit rates", () => {
  it("counts shuffles per rest poll and departures over departures + shuffles", () => {
    const visits = [
      { outcome: "stopped", rest_polls: 40, shuffles: 1 },
      { outcome: "stopped", rest_polls: 60, shuffles: 2 },
      { outcome: "passed", rest_polls: 0, shuffles: 0 },
      { outcome: "stopped", rest_polls: 0, shuffles: 0 },
    ];
    const r = estimateVisitRates(visits);
    expect(r.SHUFFLE_PER_POLL.value).toBeCloseTo(3 / 100, 6);
    expect(r.SHUFFLE_PER_POLL.n).toBe(2);
    expect(r.P_DEPART_ON_FRESH.value).toBeCloseTo(2 / 5, 6);
  });
});

describe("the conformal fit", () => {
  it("finds the factor that would have covered 80% of a bucket, per bucket", () => {
    // 100 pairs at eta 60 s with a band of ±10 s. 85 of them fall inside
    // ±16 s, the rest at ±40: the smallest factor covering 80% is 1.6.
    const pairs = [];
    for (let i = 0; i < 100; i++) {
      pairs.push({ r: 1, eta: 60, low: 50, high: 70, det: 60 + (i < 85 ? 16 : 40) });
    }
    const f = conformalFit(pairs);
    expect(f["0-2"].n).toBe(100);
    expect(f["0-2"].w).toBeCloseTo(1.6, 2);
    expect(f["2-5"].n).toBe(0);
    expect(f["2-5"].w).toBeNull();
  });

  it("rounds the quantile UP, so a factor that only just reaches 80% is not taken", () => {
    // Exactly 80 of 100 inside ±16 s. Split conformal takes the
    // ceil((n+1)·0.8)-th smallest, which is the next one up — 4, not 1.6.
    // Coverage is a promise; 80.0% by construction is not 80% in the wild.
    const pairs = [];
    for (let i = 0; i < 100; i++) {
      pairs.push({ r: 1, eta: 60, low: 50, high: 70, det: 60 + (i < 80 ? 16 : 40) });
    }
    expect(conformalFit(pairs)["0-2"].w).toBeCloseTo(4, 2);
  });

  it("does not fit past the horizon cap, and a zero-width band needs an infinite factor", () => {
    expect(horizonOf(30 * 60)).toBe("10-30");
    expect(horizonOf(30 * 60 + 1)).toBeNull();
    const f = conformalFit([
      { r: 1, eta: 1000, low: 1000, high: 1000, det: 1100 },
      { r: 1, eta: 1000, low: 1000, high: 1000, det: 900 },
    ]);
    expect(f["10-30"].infinite).toBe(2);
    expect(f["10-30"].w).toBeNull();
    expect(conformalFit([{ r: 1, eta: 3000, low: 2000, high: 4000, det: 3000 }])["10-30"].n).toBe(0);
  });

  it("widen is exactly the identity at 1", () => {
    expect(widen(100, 80, 130, 1)).toEqual([80, 130]);
    expect(widen(100, 80, 130, 2)).toEqual([60, 160]);
  });
});

describe("scoring", () => {
  const pairs = [
    { r: 3, eta: 100, low: 90, high: 110, det: 100 },
    { r: 3, eta: 100, low: 90, high: 110, det: 160 },
    { r: 3, eta: 100, low: 90, high: 110, det: 40 },
    { r: 4, eta: 100, low: 90, high: 110, det: null },
    { r: 4, eta: 3000, low: 2000, high: 4000, det: 3000 },
  ];

  it("pools over routes into route 0 and counts the rules the scorecard counts", () => {
    const rows = scoreRows(pairs);
    const all = pooled(rows);
    expect(all.paired).toBe(3);
    expect(all.missing).toBe(1);
    expect(all.beyondHorizon).toBe(1);
    // Nearest-rank over |0|, |−60|, |+60|.
    expect(all.medianAbsSec).toBe(60);
    expect(all.medianSignedSec).toBe(0);
    expect(rows.find((r) => r.routeId === 3 && r.horizon === "all").metrics.paired).toBe(3);
    expect(rows.find((r) => r.routeId === 4 && r.horizon === "all").metrics.paired).toBe(0);
  });

  it("a wider band covers more and the numbers themselves do not move", () => {
    const base = pooled(scoreRows(pairs));
    const wide = pooled(scoreRows(pairs, { "0-2": 8, "2-5": 1, "5-10": 1, "10-30": 1 }));
    expect(wide.medianAbsSec).toBe(base.medianAbsSec);
    expect(wide.intervalCoveragePct).toBeGreaterThan(base.intervalCoveragePct);
    expect(base.intervalCoveragePct).toBeCloseTo(100 / 3, 1);
    expect(wide.intervalCoveragePct).toBe(100);
  });
});

describe("assembling the candidate", () => {
  const champ = { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL } };
  const goodFits = () => Object.fromEntries(SCALAR_KEYS.map((k) => [k, { value: COMPILED[k], n: N_FLOORS[k] }]));
  const goodConf = () => Object.fromEntries(HORIZONS.map((h) => [h, { w: 1.2, n: N_FLOORS.CONFORMAL }]));

  it("takes every fit that clears its floor, range and drift bound", () => {
    const fits = goodFits();
    fits.P_REPEAT_STAND = { value: 0.93, n: 50_000 };
    const { params, issues, n } = assembleCandidate(fits, goodConf(), champ);
    expect(params.P_REPEAT_STAND).toBe(0.93);
    expect(params.CONFORMAL["0-2"]).toBe(1.2);
    expect(issues).toEqual([]);
    expect(n.P_REPEAT_STAND).toBe(50_000);
    expect(n["CONFORMAL.0-2"]).toBe(N_FLOORS.CONFORMAL);
  });

  it("refuses a value under the n floor and says so", () => {
    const fits = goodFits();
    fits.SHUFFLE_PER_POLL = { value: 0.05, n: N_FLOORS.SHUFFLE_PER_POLL - 1 };
    const { params, issues } = assembleCandidate(fits, goodConf(), champ);
    expect(params.SHUFFLE_PER_POLL).toBe(COMPILED.SHUFFLE_PER_POLL);
    expect(issues[0].key).toBe("SHUFFLE_PER_POLL");
    expect(issues[0].reason).toContain("under the floor");
    expect(issues[0].kept).toBe(COMPILED.SHUFFLE_PER_POLL);
  });

  it("refuses a value outside its range, and one past the drift bound unless allowed", () => {
    const fits = goodFits();
    fits.P_REPEAT_MOVE = { value: 0.9, n: 1e6 };                 // outside [0.02, 0.5]
    fits.P_DEPART_ON_FRESH = { value: 0.5, n: 1e6 };             // in range, 0.26 from compiled
    let r = assembleCandidate(fits, goodConf(), champ);
    expect(r.params.P_REPEAT_MOVE).toBe(COMPILED.P_REPEAT_MOVE);
    expect(r.issues.find((i) => i.key === "P_REPEAT_MOVE").reason).toContain("outside");
    expect(r.params.P_DEPART_ON_FRESH).toBe(COMPILED.P_DEPART_ON_FRESH);
    expect(r.issues.find((i) => i.key === "P_DEPART_ON_FRESH").reason).toContain("more than");
    r = assembleCandidate(fits, goodConf(), champ, { allowDrift: true });
    expect(r.params.P_DEPART_ON_FRESH).toBe(0.5);
    // The range is never waived, drift flag or not.
    expect(r.params.P_REPEAT_MOVE).toBe(COMPILED.P_REPEAT_MOVE);
  });

  it("refuses a conformal factor under its floor or outside its range", () => {
    const conf = goodConf();
    conf["0-2"] = { w: 1.3, n: N_FLOORS.CONFORMAL - 1 };
    conf["2-5"] = { w: 9, n: 1e6 };
    conf["5-10"] = { w: null, n: 0 };
    const { params, issues } = assembleCandidate(goodFits(), conf, champ);
    expect(params.CONFORMAL["0-2"]).toBe(1);
    expect(params.CONFORMAL["2-5"]).toBe(1);
    expect(params.CONFORMAL["5-10"]).toBe(1);
    expect(params.CONFORMAL["10-30"]).toBe(1.2);
    expect(issues.map((i) => i.key)).toEqual(["CONFORMAL.0-2", "CONFORMAL.2-5", "CONFORMAL.5-10"]);
  });

  it("a fit that recovers exactly the champion is no change at all", () => {
    const { params } = assembleCandidate(goodFits(), Object.fromEntries(HORIZONS.map((h) => [h, { w: 1, n: 1e6 }])), champ);
    expect(sameParams(params, champ)).toBe(true);
  });
});

describe("the per-route scale", () => {
  // A route whose buses take exactly `f` times as long as the promise: the
  // fit must recover `f` (before shrinkage) whatever the promises look like.
  const pairsFor = (r, f, n, etaFrom = 120, etaStep = 7) =>
    Array.from({ length: n }, (_, i) => {
      const eta = etaFrom + (i % 40) * etaStep;
      return { r, k: 1, eta, low: eta * 0.8, high: eta * 1.2, det: eta * f - 12, prox: eta * f };
    });

  it("recovers the ratio, on the rider's truth, shrunk toward 1 by sample", () => {
    const n = ROUTE_SCALE_SHRINK_K; // shrinkage of exactly one half
    const fit = fitRouteScales(pairsFor("3", 1.2, n));
    expect(fit["3"].raw).toBe(1.2);
    expect(fit["3"].n).toBe(n);
    expect(fit["3"].value).toBeCloseTo(1.1, 3);
    // 12 s of detector lead is ignored while `prox` is there, and used when it is not.
    const noProx = pairsFor("3", 1.2, n).map(({ prox: _drop, ...p }) => p);
    expect(fitRouteScales(noProx)["3"].raw).toBeLessThan(1.2);
  });

  it("ignores promises under a minute — there the number is the last stand, not the chain", () => {
    const short = Array.from({ length: 500 }, () => ({ r: "3", eta: 30, prox: 90 }));
    expect(fitRouteScales(short)["3"]).toBeUndefined();
  });

  it("is published only when the sample, the range, the drift bound, the pooled share and the held-out day all agree", () => {
    const champ = { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL }, ROUTE_SCALE: {} };
    const goodFits = () => Object.fromEntries(SCALAR_KEYS.map((k) => [k, { value: COMPILED[k], n: N_FLOORS[k] }]));
    const goodConf = () => Object.fromEntries(HORIZONS.map((h) => [h, { w: 1, n: N_FLOORS.CONFORMAL }]));
    const scales = {
      "3": { value: 1.09, raw: 1.09, n: 50_000, pooledShare: 0 },              // publishes
      "8": { value: 1.09, raw: 1.09, n: N_FLOORS.ROUTE_SCALE - 1, pooledShare: 0 }, // thin
      "9": { value: 0.74, raw: 0.74, n: 50_000, pooledShare: 0.72 },           // the Green hole
      "10": { value: 1.4, raw: 1.4, n: 50_000, pooledShare: 0 },               // out of range
      "13": { value: 1.21, raw: 1.21, n: 50_000, pooledShare: 0 },             // past the drift bound
      "14": { value: 1.09, raw: 1.09, n: 50_000, pooledShare: 0 },             // worse on the held-out day
    };
    const heldOut = {
      day: "2026-09-06",
      "3": { before: { medianAbsSec: 60 }, after: { medianAbsSec: 50 } },
      "14": { before: { medianAbsSec: 40 }, after: { medianAbsSec: 44 } },
    };
    const { params, issues } = assembleCandidate(goodFits(), goodConf(), champ, { routeScales: scales, heldOut });
    expect(params.ROUTE_SCALE).toEqual({ "3": 1.09 });
    const why = Object.fromEntries(issues.map((i) => [i.key, i.reason]));
    expect(why["ROUTE_SCALE.8"]).toContain("under the floor");
    expect(why["ROUTE_SCALE.9"]).toContain("pooled prior");
    expect(why["ROUTE_SCALE.10"]).toContain("outside");
    expect(why["ROUTE_SCALE.13"]).toContain("more than");
    expect(why["ROUTE_SCALE.14"]).toContain("held out");
    expect(ROUTE_SCALE_MAX_POOLED).toBeLessThan(0.72);
  });

  it("scores by arithmetic — a scaled pair is exactly eta x s", () => {
    const pairs = pairsFor("3", 1.2, 100);
    const eff = scaleEffect(pairs, { "3": 1.2 });
    expect(eff["3"].before.medianSignedSec).toBeLessThan(0);
    expect(eff["3"].after.medianSignedSec).toBe(0);
    expect(eff["3"].after.medianAbsSec).toBe(0);
  });

  it("a scale nobody published is not a change", () => {
    const a = { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL }, ROUTE_SCALE: {} };
    const b = { ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL }, ROUTE_SCALE: { "3": 1 } };
    expect(sameParams(a, b)).toBe(true);
    expect(sameParams(a, { ...b, ROUTE_SCALE: { "3": 1.05 } })).toBe(false);
    // A champion published before the key existed carries none at all.
    expect(sameParams({ ...COMPILED, CONFORMAL: { ...COMPILED.CONFORMAL } }, a)).toBe(true);
  });
});

describe("the promotion rule", () => {
  const day = (d, cm, cc, hm, hc) => ({
    day: d,
    champion: { medianAbsSec: cm, intervalCoveragePct: cc },
    challenger: { medianAbsSec: hm, intervalCoveragePct: hc },
  });

  it("promotes a challenger that is better on both", () => {
    const d = promotionDecision([day("d1", 100, 70, 95, 78), day("d2", 102, 71, 96, 79), day("d3", 101, 70, 94, 80)], "d3");
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(d.medianDiffSec).toBeLessThan(0);
    expect(d.heldOut).toBe("d3");
  });

  it("promotes a challenger that is worse by less than the champion's own day-to-day noise", () => {
    // The champion itself swings 90/110/100 with nothing changed: sd ~10 s.
    const d = promotionDecision([day("d1", 90, 70, 95, 71), day("d2", 110, 70, 115, 71), day("d3", 100, 70, 105, 71)], "d3");
    expect(d.bounds.medianSec).toBeGreaterThan(5);
    expect(d.medianDiffSec).toBeCloseTo(5, 1);
    expect(d.promote).toBe(true);
  });

  it("refuses one worse by more than the bound, and names the number", () => {
    const d = promotionDecision([day("d1", 100, 70, 130, 71), day("d2", 100, 70, 130, 71), day("d3", 100, 70, 130, 71)], "d3");
    expect(d.promote).toBe(false);
    expect(d.reasons[0]).toContain("median |err| worse by 30.0 s");
    expect(d.bounds.medianSec).toBe(MIN_MEDIAN_BOUND_SEC);
  });

  it("refuses one whose HELD-OUT coverage collapses, even when the median improves", () => {
    const d = promotionDecision([day("d1", 100, 70, 80, 71), day("d2", 100, 70, 80, 71), day("d3", 100, 70, 80, 40)], "d3");
    expect(d.promote).toBe(false);
    expect(d.reasons[0]).toContain("held-out coverage lower by 30.0 points".replace(" points", ""));
    expect(d.bounds.coveragePct).toBe(MIN_COVERAGE_BOUND_PCT);
  });

  it("never promotes on no evidence", () => {
    expect(promotionDecision([], null).promote).toBe(false);
  });
});

describe("the three copies of the ranges agree", () => {
  it("the fitter's RANGES are the client's PARAM_RANGES", () => {
    expect(Object.keys(RANGES).sort()).toEqual([...SCALAR_KEYS].sort());
    for (const k of SCALAR_KEYS) expect(RANGES[k]).toEqual([...PARAM_RANGES[k]]);
    expect(CONFORMAL_RANGE).toEqual([...CLIENT_CONFORMAL_RANGE]);
    expect(ROUTE_SCALE_RANGE).toEqual([...CLIENT_ROUTE_SCALE_RANGE]);
  });

  it("the fitter's COMPILED is the client's COMPILED_MODEL_PARAMS", () => {
    for (const k of SCALAR_KEYS) expect(COMPILED[k]).toBe(COMPILED_MODEL_PARAMS[k]);
    for (const h of HORIZONS) expect(COMPILED.CONFORMAL[h]).toBe(COMPILED_MODEL_PARAMS.CONFORMAL[h]);
  });

  it("every compiled constant sits inside its own drift bound of itself", () => {
    for (const k of SCALAR_KEYS) {
      const d = DRIFT[k];
      expect(d.abs !== undefined || d.factor !== undefined).toBe(true);
    }
  });
});
