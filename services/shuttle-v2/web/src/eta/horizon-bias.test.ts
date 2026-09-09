import { afterEach, describe, expect, it } from "vitest";

import {
  applyHorizonBias, applyModelParams, COMPILED_MODEL_PARAMS, CONFORMAL_HORIZONS, HORIZON_BIAS_K,
  HORIZON_BIAS_KNOT_SEC, HORIZON_BIAS_RANGE, horizonBiasSec, MP, parseModelParams, resetModelParams,
  type ConformalHorizon, type ModelParams,
} from "./params";

afterEach(() => resetModelParams());

const wire = (bias: Partial<Record<ConformalHorizon, { b: number; n: number }>>): unknown => ({
  version: "test", publishedAt: 1,
  params: { ...COMPILED_MODEL_PARAMS, HORIZON_BIAS: { ...COMPILED_MODEL_PARAMS.HORIZON_BIAS, ...bias } },
});

const SEC = [0, 1, 30, 59, 60, 119, 120, 121, 180, 209, 210, 299, 300, 449, 450, 599, 600, 900, 1199, 1200, 1201, 1799, 1800, 2400, 3600];

describe("the per-horizon centre correction", () => {
  it("is exactly nothing until something is published", () => {
    for (const s of SEC) expect(applyHorizonBias(s)).toBe(s);
    for (const h of CONFORMAL_HORIZONS) expect(horizonBiasSec(h)).toBe(0);
    // ...and a served set that carries the compiled cells is the same thing.
    expect(applyModelParams(wire({}))).toBe(true);
    for (const s of SEC) expect(applyHorizonBias(s)).toBe(s);
  });

  it("shrinks the raw offset by n/(n+k): nothing at n=0, half at n=k, most of it at a day's sample", () => {
    applyModelParams(wire({ "10-30": { b: -120, n: 0 } }));
    expect(horizonBiasSec("10-30")).toBe(0);
    applyModelParams(wire({ "10-30": { b: -120, n: HORIZON_BIAS_K } }));
    expect(horizonBiasSec("10-30")).toBeCloseTo(-60, 9);
    applyModelParams(wire({ "10-30": { b: -120, n: 3 * HORIZON_BIAS_K } }));
    expect(horizonBiasSec("10-30")).toBeCloseTo(-90, 9);
    // monotone in n, and never past the raw value
    let prev = 0;
    for (const n of [1, 10, 49, 200, 1000, 50_000]) {
      applyModelParams(wire({ "10-30": { b: -120, n } }));
      const v = horizonBiasSec("10-30");
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThan(-120);
      prev = v;
    }
  });

  it("is monotone and continuous in the promise, even for an adversarial set", () => {
    // The buckets pull in opposite directions and hard: a step function would
    // move a rider's number by minutes at 120 s and 300 s.
    applyModelParams(wire({
      "0-2": { b: 90, n: 10_000 }, "2-5": { b: -90, n: 10_000 },
      "5-10": { b: 240, n: 10_000 }, "10-30": { b: -600, n: 10_000 },
    }));
    let prev = applyHorizonBias(0);
    for (let s = 0; s <= 3600; s += 1) {
      const v = applyHorizonBias(s);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);   // monotone
      expect(v - prev).toBeLessThan(6);                // and no step at a boundary
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });

  it("puts each bucket's shrunk offset at its own knot, and holds it flat past the last", () => {
    applyModelParams(wire({ "5-10": { b: -60, n: 10_000 }, "10-30": { b: -120, n: 10_000 } }));
    const at = (h: ConformalHorizon) => applyHorizonBias(HORIZON_BIAS_KNOT_SEC[h]) - HORIZON_BIAS_KNOT_SEC[h];
    expect(at("5-10")).toBeCloseTo(horizonBiasSec("5-10"), 6);
    expect(at("10-30")).toBeCloseTo(horizonBiasSec("10-30"), 6);
    // beyond the last knot the offset stops growing rather than extrapolating
    const last = HORIZON_BIAS_KNOT_SEC["10-30"];
    for (const s of [last + 1, 2400, 3600, 7200]) {
      expect(applyHorizonBias(s) - s).toBeCloseTo(horizonBiasSec("10-30"), 6);
    }
  });

  it("keeps the band's order, and commutes with the standing clamp's min()", () => {
    applyModelParams(wire({ "2-5": { b: -45, n: 5000 }, "5-10": { b: 90, n: 5000 }, "10-30": { b: -300, n: 5000 } }));
    for (const [low, eta, high] of [[10, 30, 200], [100, 240, 900], [400, 700, 2000], [0, 0, 0]] as const) {
      const [l, e, h] = [applyHorizonBias(low), applyHorizonBias(eta), applyHorizonBias(high)];
      expect(l).toBeLessThanOrEqual(e);
      expect(e).toBeLessThanOrEqual(h);
    }
    // The #119 floor stores the UNCORRECTED number and the correction runs
    // after it, so "the shown remainder never climbs" survives iff the map is
    // monotone: f(min(a, b)) === min(f(a), f(b)).
    for (const a of [30, 200, 640, 1500]) {
      for (const b of [45, 190, 900, 2000]) {
        expect(applyHorizonBias(Math.min(a, b))).toBeCloseTo(Math.min(applyHorizonBias(a), applyHorizonBias(b)), 9);
      }
    }
  });

  it("refuses a corrupt cell whole, and accepts a payload that has never heard of it", () => {
    const base = COMPILED_MODEL_PARAMS as ModelParams;
    expect(parseModelParams({ ...base, HORIZON_BIAS: { "10-30": { b: HORIZON_BIAS_RANGE[1] + 1, n: 10 } } })).toBeNull();
    expect(parseModelParams({ ...base, HORIZON_BIAS: { "10-30": { b: HORIZON_BIAS_RANGE[0] - 1, n: 10 } } })).toBeNull();
    expect(parseModelParams({ ...base, HORIZON_BIAS: { "10-30": { b: -10, n: -1 } } })).toBeNull();
    expect(parseModelParams({ ...base, HORIZON_BIAS: { "10-30": { b: "x", n: 10 } } })).toBeNull();
    expect(parseModelParams({ ...base, HORIZON_BIAS: 7 })).toBeNull();
    // absent entirely: the set published before this key existed still applies
    const noKey = { ...base } as Record<string, unknown>;
    delete noKey["HORIZON_BIAS"];
    const parsed = parseModelParams(noKey);
    expect(parsed).not.toBeNull();
    for (const h of CONFORMAL_HORIZONS) expect(parsed!.HORIZON_BIAS[h]).toEqual({ b: 0, n: 0 });
    // a partially served table leaves the unnamed buckets at no correction
    const partial = parseModelParams({ ...base, HORIZON_BIAS: { "5-10": { b: 30, n: 900 } } });
    expect(partial!.HORIZON_BIAS["5-10"]).toEqual({ b: 30, n: 900 });
    expect(partial!.HORIZON_BIAS["0-2"]).toEqual({ b: 0, n: 0 });
  });

  it("is dropped whole when the set is rejected, and by resetModelParams", () => {
    applyModelParams(wire({ "10-30": { b: -120, n: 10_000 } }));
    expect(applyHorizonBias(1200)).toBeLessThan(1200);
    expect(applyModelParams({ version: "bad", publishedAt: 1, params: { ...COMPILED_MODEL_PARAMS, P_REPEAT_STAND: 42 } })).toBe(false);
    expect(applyHorizonBias(1200)).toBe(1200);
    expect(MP.HORIZON_BIAS["10-30"]).toEqual({ b: 0, n: 0 });
  });
});
