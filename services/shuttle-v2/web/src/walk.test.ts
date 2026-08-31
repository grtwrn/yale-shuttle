import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_WALK_M, WALK_DETOUR, WALK_EFFECTIVE_M_S, WALK_ONLY_MAX_SEC, WALK_SPEED_M_S,
  walkSecFromMeters,
} from "./walk";

/**
 * Read the SERVER's walking constant straight out of its source. Importing the
 * module would drag in the whole backend build graph, and hard-coding 1.4 here
 * would defeat the point: the whole reason this test exists is that the two
 * halves of the app drifted apart silently. Parsing the source means a change
 * on the server side fails this test on the next run.
 */
function serverWalkSpeed(): number {
  const path = fileURLToPath(new URL("../../src/network/TransitNetwork.ts", import.meta.url));
  const src = readFileSync(path, "utf8");
  const m = /export const WALK_M_PER_S = ([0-9.]+);/.exec(src);
  if (!m) throw new Error("could not find WALK_M_PER_S in the server's TransitNetwork.ts");
  return Number(m[1]);
}

describe("the walking model matches the server planner", () => {
  // Report #35 was this disagreement made visible: the client's own model
  // (1.3 m/s over a 1.2x detour = an effective 1.083 m/s) made a 4.3 km trip a
  // 66-minute walk, past the one-hour cutoff, while the server called the same
  // trip 53 minutes. The client suppressed the walk and showed "No trip
  // options found" for a trip that had a perfectly good answer.
  it("uses the same effective rate over crow-flies distance", () => {
    expect(WALK_EFFECTIVE_M_S).toBe(serverWalkSpeed());
  });

  it("computes the same seconds the server would for the same distance", () => {
    const server = serverWalkSpeed();
    for (const m of [0, 50, 150, 400, 1_000, 1_500, 4_300, 10_000]) {
      expect(walkSecFromMeters(m)).toBeCloseTo(m / server, 6);
    }
  });

  it("keeps the detour factor and the ground pace algebraically consistent", () => {
    // The detour stays explicit in the model rather than being folded away —
    // but the composition must land exactly on the server's effective rate.
    expect(WALK_SPEED_M_S).toBeCloseTo(WALK_EFFECTIVE_M_S * WALK_DETOUR, 10);
    expect(walkSecFromMeters(1_000)).toBeCloseTo((1_000 * WALK_DETOUR) / WALK_SPEED_M_S, 10);
  });

  it("mirrors the server's option-pruning thresholds", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/planner/planner.ts", import.meta.url)), "utf8",
    );
    expect(/const WALK_ONLY_MAX_SEC = (\d+);/.exec(src)?.[1]).toBe(String(WALK_ONLY_MAX_SEC));
    expect(/const MAX_WALK_M = (\d+);/.exec(src)?.[1]).toBe(String(MAX_WALK_M));
  });
});

describe("walkSecFromMeters", () => {
  it("is linear and monotonic", () => {
    expect(walkSecFromMeters(0)).toBe(0);
    expect(walkSecFromMeters(200)).toBeCloseTo(2 * walkSecFromMeters(100), 9);
    expect(walkSecFromMeters(100)).toBeLessThan(walkSecFromMeters(101));
  });

  // Concrete numbers so a future change to the model is visible in a diff
  // rather than buried in a ratio.
  it("pins the estimates riders actually see", () => {
    const minutes = (m: number) => Math.round((walkSecFromMeters(m) / 60) * 10) / 10;
    expect(minutes(150)).toBe(2.3);    // a stop across the street
    expect(minutes(400)).toBe(6.1);    // typical walk to a board stop
    expect(minutes(1_000)).toBe(15.2);
    expect(minutes(1_500)).toBe(22.7); // MAX_WALK_M, the longest leg allowed
    expect(minutes(4_300)).toBe(65.2); // report #35's trip — genuinely an hour+
  });

  // Report #35 was a 4.3 km trip that rendered "No trip options found". The
  // fix is NOT to declare such a walk short enough to clear the cutoff — at an
  // honest pace it really is over an hour, and pretending otherwise is how the
  // model drifted optimistic in the first place. The guarantee is that the
  // cutoff may hide a long walk as CLUTTER, never as the rider's only answer;
  // planTrip keeps it when nothing else matched (see planner.test.ts).
  it("treats report #35's trip as the hour-plus walk it really is", () => {
    expect(walkSecFromMeters(4_300)).toBeGreaterThan(WALK_ONLY_MAX_SEC);
    // Still sane: an hour and five minutes, not two hours.
    expect(walkSecFromMeters(4_300)).toBeLessThan(1.3 * WALK_ONLY_MAX_SEC);
  });
});
