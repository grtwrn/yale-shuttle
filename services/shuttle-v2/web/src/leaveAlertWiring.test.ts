import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE REMINDER IS ARMED AND PRICED ON THE WALK THE CARD SHOWS (report #108
 * follow-up).
 *
 * `leaveAlert.ts` is pure and unit-tested, so every timing rule is asserted in
 * `leaveAlert.test.ts`. What cannot be asserted there is the WIRING: that
 * TransitMap hands the engine the live walk, and that the button offering the
 * reminder is gated on the same number. `TransitMap.tsx` cannot be rendered by
 * this repo's harness, so these are source-level, the same approach as
 * `walkingWins.test.ts` and `mapFilter.test.ts`.
 *
 * Three surfaces, ONE resolution (`displayWalkToSec` in optionLegs.ts): the
 * card's chips, the arming gate, and the ping's own text. A second copy of
 * `liveWalkToSec ?? walkToSec` is exactly how two surfaces drift apart, which
 * is the defect this fixes rather than a style preference.
 */
const src = readFileSync(new URL("./TransitMap.tsx", import.meta.url), "utf8");
const engine = readFileSync(new URL("./leaveAlert.ts", import.meta.url), "utf8");
const planner = readFileSync(new URL("./planner.ts", import.meta.url), "utf8");

describe("the reminder engine's input", () => {
  it("carries the live walk into the alert, not just the planned one", () => {
    expect(src).toContain("liveWalkToSec: o.liveWalkToSec");
  });
});

describe("the Remind me button's gate", () => {
  it("is gated on the walk the card displays", () => {
    expect(src).toContain("displayWalkToSec(o) >= AT_STOP_WALK_SEC");
  });

  it("is NOT gated on the planned walk", () => {
    // The mirror case: a rider inside AT_PLACE_M has a live walk of 0 and no
    // walk chip, yet the planned-walk gate still offered them a reminder —
    // which, priced on the live walk, could never fire. A button that arms and
    // cannot ping is a promise the app does not keep.
    expect(src).not.toContain("o.walkToSec >= AT_STOP_WALK_SEC");
  });
});

describe("one walk resolution, shared", () => {
  it("leaveAlert.ts reads the walk through optionLegs, not its own rule", () => {
    expect(engine).toContain('from "./optionLegs"');
    expect(engine).toContain("displayWalkToSec(s)");
  });

  it("leaveAlert.ts never reads a bare planned walk off its input", () => {
    // Every read goes through the helper; a bare `s.walkToSec` anywhere here
    // is a second answer waiting to disagree with the card.
    expect(engine).not.toMatch(/\bs\.walkToSec\b/);
  });
});

/**
 * ONE REACHABILITY RULE, SHARED — the same argument as the walk above, applied
 * to `canCatch`. It lived in three places at once (both of planner.ts's own
 * picks and a re-typed copy in the terminal ping's guard); it now lives in
 * planner.ts and is called.
 */
describe("one reachability rule, shared", () => {
  it("planner.ts owns it and exports it", () => {
    expect(planner).toContain("export function canCatch(walkSec: number, etaSec: number): boolean");
  });

  it("leaveAlert.ts calls it rather than re-typing the formula", () => {
    expect(engine).toContain('from "./planner"');
    expect(engine).toContain("canCatch(displayWalkToSec(s)");
  });

  it("no pick in planner.ts restates it inline", () => {
    // The two re-typings the export replaced. `canCatchWithBuffer` keeps its own
    // arithmetic on purpose: a deliberately looser threshold for a different
    // question (see planner.ts), so it is not folded into this rule.
    expect(planner).not.toMatch(/effectiveWalkToSec <= a\.eta \+ STOP_DWELL_SEC;/);
    expect(planner).not.toMatch(/walkToSec <= a\.eta \+ STOP_DWELL_SEC\)/);
  });
});
