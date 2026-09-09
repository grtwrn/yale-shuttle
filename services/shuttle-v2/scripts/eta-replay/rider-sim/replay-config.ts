/** Explicit offline replay modes; neither mode changes the estimator. */
export function replayConfig(env: NodeJS.ProcessEnv, dataStart: number) {
  const calibration = env.REPLAY_CALIBRATION ?? "legacy";
  if (calibration !== "legacy" && calibration !== "production") throw new Error("REPLAY_CALIBRATION must be legacy or production");
  const fitAt = env.REPLAY_FIT_AT ? Date.parse(env.REPLAY_FIT_AT) : null;
  if (calibration === "production") {
    if (!env.REPLAY_FIT_AT || !/(Z|[+-]\d\d:\d\d)$/i.test(env.REPLAY_FIT_AT)
      || !Number.isSafeInteger(fitAt) || fitAt! <= 0 || fitAt! > dataStart) {
      throw new Error("Production replay requires REPLAY_FIT_AT with an explicit timezone at or before the first captured poll");
    }
    if (env.PAYLOAD_PATCH) throw new Error("Production replay uses complete production tables; PAYLOAD_PATCH cannot be merged into them");
    if (Number(env.CALIB_LAG_MIN ?? 0) !== 0) throw new Error("CALIB_LAG_MIN applies only to legacy hourly tables");
  } else if (env.REPLAY_FIT_AT) throw new Error("REPLAY_FIT_AT requires REPLAY_CALIBRATION=production");
  const hookRoutes = (env.STANDING_HOOK_ROUTES ?? "").split(",").map(x => x.trim()).filter(Boolean).map(Number);
  if (hookRoutes.some(x => !Number.isSafeInteger(x) || x <= 0)) throw new Error("STANDING_HOOK_ROUTES requires positive numeric route IDs");
  const requiredCells = (env.STANDING_REQUIRE_CELLS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (requiredCells.some(x => !/^\d+:\d+:\d+$/.test(x))) throw new Error("STANDING_REQUIRE_CELLS uses route:stop:index, comma-separated");
  if (!env.STANDING_HOOK && (hookRoutes.length || requiredCells.length)) throw new Error("Standing route/cell requirements need STANDING_HOOK");
  return { calibration, fitAt, hookRoutes: [...new Set(hookRoutes)], requiredCells,
    audit: !!env.STANDING_HOOK || env.STANDING_AUDIT === "1", allowUnused: env.STANDING_ALLOW_UNUSED === "1",
    legacyBusClocks: env.LEGACY_BUS_CLOCKS === "1" };
}

export function validateHookFit(config: ReturnType<typeof replayConfig>, manifest: { fitAt?: unknown }, dataStart: number) {
  const fitAt = manifest.fitAt;
  if (typeof fitAt !== "number" || !Number.isSafeInteger(fitAt) || fitAt <= 0 || fitAt > dataStart) {
    throw new Error("Standing hook must declare a finite fitAt at or before the first captured poll");
  }
  if (config.calibration === "production" && fitAt !== config.fitAt) {
    throw new Error(`Standing hook fitAt ${fitAt} differs from fixed production table cutoff ${config.fitAt}`);
  }
  return fitAt;
}
