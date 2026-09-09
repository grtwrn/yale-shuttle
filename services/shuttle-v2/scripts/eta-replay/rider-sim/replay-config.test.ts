import { describe, expect, it } from "vitest";
import { replayConfig, validateHookFit } from "./replay-config";
const start = Date.parse("2026-09-04T15:00:00Z");
const fixed = { REPLAY_CALIBRATION: "production", REPLAY_FIT_AT: "2026-09-04T04:00:00Z" };
describe("rider replay fidelity configuration", () => {
  it("preserves explicit legacy mode and current production clocks by default", () => {
    expect(replayConfig({}, start)).toMatchObject({ calibration: "legacy", fitAt: null, legacyBusClocks: false, audit: false });
    expect(replayConfig({ LEGACY_BUS_CLOCKS: "1" }, start).legacyBusClocks).toBe(true);
  });
  it("requires a causal, unambiguous fixed cutoff and complete production tables", () => {
    for (const value of [undefined, "bad", "2026-09-04T04:00:00", "2026-09-04T16:00:00Z"]) {
      expect(() => replayConfig({ REPLAY_CALIBRATION: "production", REPLAY_FIT_AT: value }, start)).toThrow();
    }
    expect(() => replayConfig({ ...fixed, PAYLOAD_PATCH: "future.json" }, start)).toThrow(/complete production/);
    expect(() => replayConfig({ ...fixed, CALIB_LAG_MIN: "5" }, start)).toThrow(/legacy/);
    expect(() => replayConfig({ REPLAY_FIT_AT: fixed.REPLAY_FIT_AT }, start)).toThrow();
  });
  it("binds the hook's immutable fit timestamp to the production table cutoff", () => {
    const config = replayConfig(fixed, start);
    expect(validateHookFit(config, { fitAt: Date.parse(fixed.REPLAY_FIT_AT) }, start)).toBe(config.fitAt);
    expect(() => validateHookFit(config, {}, start)).toThrow();
    expect(() => validateHookFit(config, { fitAt: Date.parse("2026-09-03T04:00:00Z") }, start)).toThrow(/differs/);
    expect(() => validateHookFit(config, { fitAt: start + 1 }, start)).toThrow(/before/);
  });
  it("automatically audits hook activation, with optional exact positive-weight cell requirements", () => {
    expect(replayConfig({ STANDING_HOOK: "hook.ts", STANDING_AUDIT: "0", STANDING_REQUIRE_CELLS: "3:11:14" }, start))
      .toMatchObject({ audit: true, requiredCells: ["3:11:14"], allowUnused: false });
    expect(() => replayConfig({ STANDING_HOOK_ROUTES: "3" }, start)).toThrow();
    expect(() => replayConfig({ STANDING_HOOK: "hook.ts", STANDING_HOOK_ROUTES: "Red" }, start)).toThrow();
    expect(() => replayConfig({ STANDING_HOOK: "hook.ts", STANDING_REQUIRE_CELLS: "3:11" }, start)).toThrow();
  });
});
