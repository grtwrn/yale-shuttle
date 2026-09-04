import { describe, expect, it } from "vitest";
import {
  advance,
  ambiguous,
  buildGeometry,
  DEADBAND_M,
  forwardM,
  geometryFromLegs,
  lastStopLike,
  mixtureRemainingM,
  remainingForwardM,
  stepBelief,
} from "./belief";
import type { Mixture, RouteGeometry } from "./belief";
import type { LatLon } from "./geo";

const O = { lat: 41.31, lon: -72.93 };
const point = (eastM: number, northM = 0): [number, number] => [
  O.lat + northM / 111_000,
  O.lon + eastM / 84_000,
];
const latLon = (p: [number, number]): LatLon => ({ lat: p[0], lon: p[1] });
const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

function square() {
  const a = point(0);
  const b = point(200);
  const c = point(200, 200);
  const d = point(0, 200);
  return {
    a, b, c, d,
    geo: geometryFromLegs([[a, b], [b, c], [c, d], [d, a]]),
  };
}

/** A→B→C then C→B→A along the same road. */
function outAndBack() {
  const a = point(0);
  const b = point(200);
  const c = point(400);
  return {
    a, b, c,
    geo: geometryFromLegs([[a, b], [b, c], [c, b], [b, a]]),
    stops: [10, 20, 30, 20],
  };
}

function branchWeight(mix: Mixture, id: number): number {
  const branch = mix.branches.find((b) => b.id === id);
  return branch?.components.reduce((sum, c) => sum + c.weight, 0) ?? 0;
}

function branchMeanX(mix: Mixture, id: number): number {
  const branch = mix.branches.find((b) => b.id === id)!;
  const weight = branchWeight(mix, id);
  return branch.components.reduce((sum, c) => sum + c.weight * c.x, 0) / weight;
}

function run(
  geo: RouteGeometry,
  points: LatLon[],
  extra: Partial<Parameters<typeof stepBelief>[2]> = {},
): Mixture {
  let mix: Mixture | null = null;
  for (let i = 0; i < points.length; i++) {
    mix = stepBelief(geo, mix, { ...points[i]!, t: i * 5_000, ...extra });
  }
  return mix!;
}

describe("directed-loop arithmetic", () => {
  it("wraps last→first forward; the opposite arc is almost a lap", () => {
    expect(forwardM(790, 10, 800)).toBe(20);
    expect(remainingForwardM(790, 10, 800)).toBe(20);
    expect(forwardM(10, 790, 800)).toBe(780);
  });

  it("has no reverse process operation", () => {
    expect(advance(100, -40)).toBe(100);
    expect(advance(790, 20)).toBe(810); // unwrapped; no seam discontinuity
  });

  it("computes E[forward arc], not the arc from E[x]", () => {
    const component = (
      mode: "standing" | "running",
      x: number,
      weight: number,
    ) => ({
      mode, x, weight, v: 0, varX: 1, covXV: 0, varV: 1, restSec: 0,
    });
    const mix: Mixture = {
      loopLength: 800,
      branches: [
        {
          id: 0,
          lastFixX: 100,
          components: [component("standing", 100, 0.25), component("running", 100, 0.25)],
        },
        {
          id: 1,
          lastFixX: 700,
          components: [component("standing", 700, 0.25), component("running", 700, 0.25)],
        },
      ],
      lastT: 0,
      lastFixLat: 0,
      lastFixLon: 0,
      lastFixT: 0,
      lastStopId: null,
      updates: 0,
      resolved: false,
    };
    expect(mixtureRemainingM(mix, 200)).toBeCloseTo(200);
    expect(remainingForwardM(400, 200, 800)).toBe(600);
  });

  it("returns empty geometry rather than dereferencing an absent first stop", () => {
    expect(buildGeometry([[0, 0], [0, 1]], [])).toMatchObject({
      loopLength: 0,
      legs: [],
    });
  });

  it("normalizes an off-path cold start without likelihood underflow", () => {
    const { geo, a, b } = outAndBack();
    const middle = lerp(a, b, 0.5);
    const offPath = latLon([middle[0] + 300 / 111_000, middle[1]]);
    const mix = run(geo, [offPath]);
    const weights = mix.branches.flatMap((branch) =>
      branch.components.map((component) => component.weight)
    );
    expect(weights.every(Number.isFinite)).toBe(true);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  });
});

describe("Gaussian-sum IMM", () => {
  it("keeps standing and running as separately weighted Gaussian states", () => {
    const { geo, a, b } = square();
    const mix = run(geo, [latLon(lerp(a, b, 0.4))]);
    expect(mix.branches).toHaveLength(1);
    expect(mix.branches[0]!.components.map((c) => c.mode).sort())
      .toEqual(["running", "standing"]);
    expect(mix.branches[0]!.components.every((c) =>
      c.varX > 0 && c.varV > 0 && Number.isFinite(c.covXV)
    )).toBe(true);
  });

  it("uses the repeated fix as interval evidence and shifts mass to standing", () => {
    const { geo, a, b } = square();
    const p = latLon(lerp(a, b, 0.35));
    let mix = run(geo, [p]);
    const initialStanding = mix.branches[0]!.components.find((c) => c.mode === "standing")!.weight;
    for (let i = 1; i <= 12; i++) {
      mix = stepBelief(geo, mix, { ...p, t: i * 5_000 });
    }
    const standing = mix.branches[0]!.components.find((c) => c.mode === "standing")!;
    expect(standing.weight).toBeGreaterThan(initialStanding);
    expect(standing.restSec).toBeGreaterThan(0);
    for (const c of mix.branches[0]!.components) {
      expect(c.x - mix.branches[0]!.lastFixX).toBeLessThanOrEqual(DEADBAND_M + 0.1);
    }
  });

  it("is idempotent when multiple views consume the same feed poll", () => {
    const { geo, a, b } = square();
    const p = latLon(lerp(a, b, 0.35));
    const first = stepBelief(geo, null, { ...p, t: 5_000 });
    const second = stepBelief(geo, first, { ...p, t: 5_100 });
    expect(second).toBe(first);
  });

  it("a fresh moving fix shifts mass to running", () => {
    const { geo, a, b } = square();
    const p0 = latLon(lerp(a, b, 0.2));
    const p1 = latLon(lerp(a, b, 0.45));
    let mix = run(geo, [p0]);
    mix = stepBelief(geo, mix, { ...p1, t: 5_000 });
    const runWeight = mix.branches[0]!.components.find((c) => c.mode === "running")!.weight;
    expect(runWeight).toBeGreaterThan(0.5);
  });
});

describe("coincident out-and-back legs remain a recoverable mixture", () => {
  it("merges adjacent leg endpoints but keeps the two sequence positions", () => {
    const { geo, b } = outAndBack();
    const mix = run(geo, [latLon(b)]);
    // Four geometric segments touch B, but they are two route positions:
    // outbound leg-end/next-leg-start and inbound leg-end/next-leg-start.
    expect(mix.branches).toHaveLength(2);
  });

  it("stays ambiguous while stationary on the shared road", () => {
    const { geo, a, b } = outAndBack();
    const p = latLon(lerp(a, b, 0.5));
    let mix = run(geo, [p]);
    expect(mix.branches).toHaveLength(2);
    for (let i = 1; i <= 8; i++) {
      mix = stepBelief(geo, mix, { ...p, t: i * 5_000 });
    }
    expect(mix.branches).toHaveLength(2);
    expect(ambiguous(mix)).toBe(true);
    expect(mix.resolved).toBe(false);
    expect(branchWeight(mix, 0)).toBeCloseTo(0.5, 1);
    expect(branchWeight(mix, 1)).toBeCloseTo(0.5, 1);
  });

  it("resolves eastbound motion without deleting the westbound branch", () => {
    const { geo, a, b, c } = outAndBack();
    let mix = run(geo, [latLon(lerp(a, b, 0.4))]);
    mix = stepBelief(geo, mix, { ...latLon(lerp(a, b, 0.65)), t: 5_000 });
    mix = stepBelief(geo, mix, { ...latLon(lerp(b, c, 0.15)), t: 10_000 });
    expect(mix.branches).toHaveLength(2);
    expect(branchWeight(mix, 0)).toBeGreaterThan(0.9);
    expect(branchWeight(mix, 1)).toBeLessThan(0.1);
    expect(mix.resolved).toBe(true);
    const same = latLon(lerp(b, c, 0.15));
    for (let i = 3; i <= 12; i++) {
      mix = stepBelief(geo, mix, { ...same, t: i * 5_000 });
    }
    expect(mix.resolved).toBe(true);
  });

  it("resolves westbound motion without deleting the eastbound branch", () => {
    const { geo, a, b } = outAndBack();
    let mix = run(geo, [latLon(lerp(a, b, 0.6))]);
    mix = stepBelief(geo, mix, { ...latLon(lerp(a, b, 0.35)), t: 5_000 });
    mix = stepBelief(geo, mix, { ...latLon(lerp(a, b, 0.1)), t: 10_000 });
    expect(mix.branches).toHaveLength(2);
    expect(branchWeight(mix, 1)).toBeGreaterThan(0.9);
    expect(branchWeight(mix, 0)).toBeLessThan(0.1);
  });

  it("never rewinds either branch when GPS twitches behind", () => {
    const { geo, a, b } = outAndBack();
    let mix = run(geo, [latLon(lerp(a, b, 0.5))]);
    const before = mix.branches.map((branch) => branchMeanX(mix, branch.id));
    mix = stepBelief(geo, mix, { ...latLon(lerp(a, b, 0.35)), t: 5_000 });
    for (const [i, branch] of mix.branches.entries()) {
      expect(branchMeanX(mix, branch.id)).toBeGreaterThanOrEqual(before[i]! - 1e-6);
    }
  });
});

describe("last_stop_id is a one-shot likelihood", () => {
  it("handles duplicate sequence entries instead of collapsing with indexOf", () => {
    const stops = [10, 20, 30, 20];
    expect(lastStopLike(20, 0, stops)).toBeGreaterThan(0.01);
    expect(lastStopLike(20, 2, stops)).toBeGreaterThan(0.01);
  });

  it("does not compound an unchanged stale hint on every poll", () => {
    const { geo, a, b, stops } = outAndBack();
    const p = latLon(lerp(a, b, 0.5));
    let mix = stepBelief(geo, null, { ...p, t: 0, lastStopId: 10, stops });
    const initialRatio = branchWeight(mix, 0) / branchWeight(mix, 1);
    for (let i = 1; i <= 8; i++) {
      mix = stepBelief(geo, mix, { ...p, t: i * 5_000, lastStopId: 10, stops });
    }
    const finalRatio = branchWeight(mix, 0) / branchWeight(mix, 1);
    expect(finalRatio).toBeCloseTo(initialRatio, 4);
  });
});
