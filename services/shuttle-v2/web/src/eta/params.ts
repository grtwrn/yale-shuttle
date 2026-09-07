/**
 * The estimator's re-estimable parameters, served and learned.
 *
 * Stage 3 of the closed loop (docs/closed-loop.md). The constants below were
 * each MEASURED once, by hand, on a window of the feed (filter.ts says which
 * measurement, docs/eta-error-budget.md says how). The daily job
 * `scripts/reestimate-params.mjs` re-counts them on the last two weeks of the
 * archive, replays the candidate against the champion on the last three
 * archived days, and publishes a set the server then serves as
 * `model_params` in the /api/buses payload. This module is where the served
 * set lands on the client.
 *
 * THE DEFAULTS ARE THE COMPILED CONSTANTS, BYTE FOR BYTE. `MP` starts as a
 * copy of `COMPILED_MODEL_PARAMS`; a payload without `model_params` (or with
 * one that fails validation) leaves it there, and `params.test.ts` proves a
 * served set equal to the compiled one changes nothing in the filter's mass
 * or the priced rows. The numbers here duplicate filter.ts's exported
 * constants on purpose — filter.ts imports this module, so this module
 * cannot import filter.ts without a cycle — and the same test pins them
 * equal.
 *
 * Every key is validated against a range on BOTH sides (the server refuses a
 * value outside it at publish time; the client refuses the whole set if any
 * key is off), because a served parameter is a live change to every rider's
 * ETA with no deploy in between.
 */

/** Promised-minutes buckets, the scorecard's (src/server/scorecard.ts HORIZONS). */
export const CONFORMAL_HORIZONS = ["0-2", "2-5", "5-10", "10-30"] as const;
export type ConformalHorizon = (typeof CONFORMAL_HORIZONS)[number];

export interface ModelParams {
  /** Per-poll P(repeated fix | standing). */
  P_REPEAT_STAND: number;
  /** Per-poll P(repeated fix | moving), open road. */
  P_REPEAT_MOVE: number;
  /** Per-poll P(repeated fix | moving) inside a stop's zone. */
  P_REPEAT_MOVE_ZONE: number;
  /** Off-stop run -> stand hazard, per second. */
  HOLD_ENTER_PER_S: number;
  /** Off-stop stand -> run hazard, per second. */
  HOLD_LEAVE_PER_S: number;
  /** Per-poll reposition rate of a standing bus. */
  SHUFFLE_PER_POLL: number;
  /** P(departure | a standing bus moved) where the stop has no stand table. */
  P_DEPART_ON_FRESH: number;
  /**
   * Multiplicative widening of the shown 10-90 band, per promised-minutes
   * bucket: low' = eta - (eta - low) * w, high' = eta + (high - eta) * w.
   * 1.0 is the band as priced (and is skipped entirely, so the default is
   * byte-identical). Split-conformal, fitted by the daily job.
   */
  CONFORMAL: Record<ConformalHorizon, number>;
}

export type ScalarParamKey = Exclude<keyof ModelParams, "CONFORMAL">;
export const SCALAR_PARAM_KEYS: readonly ScalarParamKey[] = [
  "P_REPEAT_STAND", "P_REPEAT_MOVE", "P_REPEAT_MOVE_ZONE",
  "HOLD_ENTER_PER_S", "HOLD_LEAVE_PER_S", "SHUFFLE_PER_POLL", "P_DEPART_ON_FRESH",
];

/**
 * Accepted ranges. Wide enough for any honest re-measurement of this feed,
 * narrow enough that a corrupt row (a percentage where a probability was
 * meant, a per-poll rate served per second) cannot reach a rider.
 */
export const PARAM_RANGES: Readonly<Record<ScalarParamKey, readonly [number, number]>> = {
  P_REPEAT_STAND: [0.7, 0.995],
  P_REPEAT_MOVE: [0.02, 0.5],
  P_REPEAT_MOVE_ZONE: [0.1, 0.9],
  HOLD_ENTER_PER_S: [0.002, 0.1],
  HOLD_LEAVE_PER_S: [0.002, 0.1],
  SHUFFLE_PER_POLL: [0.002, 0.2],
  P_DEPART_ON_FRESH: [0.3, 0.98],
};
export const CONFORMAL_RANGE: readonly [number, number] = [0.5, 4];

/** The compiled constants (filter.ts), the set every client starts from. */
export const COMPILED_MODEL_PARAMS: Readonly<ModelParams> = Object.freeze({
  P_REPEAT_STAND: 0.919,
  P_REPEAT_MOVE: 0.159,
  P_REPEAT_MOVE_ZONE: 0.5,
  HOLD_ENTER_PER_S: 0.01612,
  HOLD_LEAVE_PER_S: 0.01457,
  SHUFFLE_PER_POLL: 0.03,
  P_DEPART_ON_FRESH: 0.76,
  CONFORMAL: Object.freeze({ "0-2": 1, "2-5": 1, "5-10": 1, "10-30": 1 }),
});

/** The live set the filter and the pricing read. Mutated only through `applyModelParams` / `resetModelParams`. */
export const MP: ModelParams = { ...COMPILED_MODEL_PARAMS, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL } };

/** What the server sends: `payload.model_params`. */
export interface ModelParamsWire {
  version: string;
  publishedAt: number;
  params: ModelParams;
}

let active: { version: string; publishedAt: number } | null = null;

/** The served set in force, or null when the compiled constants are. */
export function activeModelParams(): { version: string; publishedAt: number } | null {
  return active;
}

function inRange(v: unknown, range: readonly [number, number]): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= range[0] && v <= range[1];
}

/**
 * Validate a served set. Returns the clean parameters or null; a set is all
 * or nothing — a half-applied set would be a mixture nobody measured.
 */
export function parseModelParams(raw: unknown): ModelParams | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: Partial<ModelParams> = {};
  for (const k of SCALAR_PARAM_KEYS) {
    if (!inRange(o[k], PARAM_RANGES[k])) return null;
    out[k] = o[k] as number;
  }
  const conf = o["CONFORMAL"];
  if (!conf || typeof conf !== "object") return null;
  const c = conf as Record<string, unknown>;
  const conformal = {} as Record<ConformalHorizon, number>;
  for (const h of CONFORMAL_HORIZONS) {
    if (!inRange(c[h], CONFORMAL_RANGE)) return null;
    conformal[h] = c[h] as number;
  }
  return { ...(out as Omit<ModelParams, "CONFORMAL">), CONFORMAL: conformal };
}

/**
 * Adopt the payload's `model_params`. Absent, malformed or out of range: the
 * compiled constants (so an older server, or a server with nothing published,
 * is exactly today's client). Returns true when a served set is in force.
 */
export function applyModelParams(wire: unknown): boolean {
  const w = wire as Partial<ModelParamsWire> | null | undefined;
  const params = w && typeof w === "object" ? parseModelParams(w.params) : null;
  if (!params) { resetModelParams(); return false; }
  for (const k of SCALAR_PARAM_KEYS) MP[k] = params[k];
  for (const h of CONFORMAL_HORIZONS) MP.CONFORMAL[h] = params.CONFORMAL[h];
  active = {
    version: typeof w!.version === "string" ? w!.version : "?",
    publishedAt: typeof w!.publishedAt === "number" ? w!.publishedAt : 0,
  };
  return true;
}

export function resetModelParams(): void {
  for (const k of SCALAR_PARAM_KEYS) MP[k] = COMPILED_MODEL_PARAMS[k];
  for (const h of CONFORMAL_HORIZONS) MP.CONFORMAL[h] = COMPILED_MODEL_PARAMS.CONFORMAL[h];
  active = null;
}

/** The scorecard's bucket for a promised number of seconds; null past 30 min. */
export function conformalHorizon(etaSec: number): ConformalHorizon | null {
  const m = etaSec / 60;
  if (m < 2) return "0-2";
  if (m < 5) return "2-5";
  if (m < 10) return "5-10";
  if (m <= 30) return "10-30";
  return null;
}

/**
 * The band with the bucket's widening applied. A factor of exactly 1 leaves
 * the numbers untouched — not `eta - (eta - low) * 1`, which can differ from
 * `low` in the last bit — so the default is byte-identical.
 */
export function widenBand(eta: number, low: number, high: number): [number, number] {
  const h = conformalHorizon(eta);
  const w = h === null ? 1 : MP.CONFORMAL[h];
  if (w === 1) return [low, high];
  return [eta - (eta - low) * w, eta + (high - eta) * w];
}
