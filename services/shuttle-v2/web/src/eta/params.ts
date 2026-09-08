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

/**
 * The correction is applied only to the part of a promise ABOVE this many
 * seconds — which is where the deficit is. The measured bias inside two
 * minutes is +2 to +20 s on EVERY line (the number is already right, or
 * slightly late) and −80 to −175 s at ten to thirty (docs/route-bias.md §1),
 * so a correction that touches the near number is correcting nothing.
 *
 * 180 s is the strand threshold (docs/rider-sim.md), and this hinge does
 * guarantee that a given (bus, stop) promise under it is returned unchanged.
 * **That is NOT the same as "cannot introduce a strand", and this comment used
 * to say so.** The rider simulator measured both forms on Red and the hinge
 * introduced twelve strands where the uniform form introduced ten: a rider's
 * wait is scored against the bus they are PINNED to, and changing the numbers
 * changes which bus that is. The hinge is kept because it is the right shape,
 * not because it is free (docs/route-bias.md §6).
 */
export const ROUTE_SCALE_FLOOR_SEC = 180;

/** A published per-route scale must sit here; 1 is "no correction". */
export const ROUTE_SCALE_RANGE: readonly [number, number] = [0.75, 1.25];
/** At most this many routes may carry one (the network has fifteen). */
export const MAX_ROUTE_SCALE_KEYS = 64;
const ROUTE_KEY_RE = /^[0-9]{1,6}$/;

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
  /**
   * Per BUS ROUTE ID, a correction on the priced arrival, applied to the part
   * of it above `ROUTE_SCALE_FLOOR_SEC`:
   *
   *     eta' = eta + max(0, eta − 180) × (s − 1)
   *
   * and low/high through the same hinge, which is monotone, so the band keeps
   * its order. Absent (the default, and every route not listed) is 1 and is
   * skipped entirely, so a payload with no `ROUTE_SCALE` prices
   * byte-identically to one that never had the key.
   *
   * It exists because the ring's LAP is short on the routes whose published
   * stop list flattens an out-and-back: the list omits passes the bus makes,
   * so no adjacency of it can be billed for that time and every promise that
   * spans the fold is optimistic in proportion to how much of the lap it
   * spans (docs/route-bias.md). That proportionality is why this is a scale
   * and not an offset — an additive per-route constant, fitted the same way
   * on the same pairs, made the pooled median |error| WORSE (60.8 s against
   * the champion's 59.2) where the scale took it to 54.4.
   */
  ROUTE_SCALE: Record<string, number>;
}

export type ScalarParamKey = Exclude<keyof ModelParams, "CONFORMAL" | "ROUTE_SCALE">;
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
  ROUTE_SCALE: Object.freeze({}),
});

/** The live set the filter and the pricing read. Mutated only through `applyModelParams` / `resetModelParams`. */
export const MP: ModelParams = { ...COMPILED_MODEL_PARAMS, CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL }, ROUTE_SCALE: { ...COMPILED_MODEL_PARAMS.ROUTE_SCALE } };

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
  // ROUTE_SCALE is OPTIONAL: a set published before it existed (the
  // 2026-09-07 fit) must keep applying rather than being rejected whole.
  const scales: Record<string, number> = {};
  const rs = o["ROUTE_SCALE"];
  if (rs !== undefined && rs !== null) {
    if (typeof rs !== "object") return null;
    const entries = Object.entries(rs as Record<string, unknown>);
    if (entries.length > MAX_ROUTE_SCALE_KEYS) return null;
    for (const [k, v] of entries) {
      if (!ROUTE_KEY_RE.test(k) || !inRange(v, ROUTE_SCALE_RANGE)) return null;
      scales[k] = v as number;
    }
  }
  return { ...(out as Omit<ModelParams, "CONFORMAL" | "ROUTE_SCALE">), CONFORMAL: conformal, ROUTE_SCALE: scales };
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
  for (const k of Object.keys(MP.ROUTE_SCALE)) delete MP.ROUTE_SCALE[k];
  for (const [k, v] of Object.entries(params.ROUTE_SCALE)) MP.ROUTE_SCALE[k] = v;
  active = {
    version: typeof w!.version === "string" ? w!.version : "?",
    publishedAt: typeof w!.publishedAt === "number" ? w!.publishedAt : 0,
  };
  return true;
}

export function resetModelParams(): void {
  for (const k of SCALAR_PARAM_KEYS) MP[k] = COMPILED_MODEL_PARAMS[k];
  for (const h of CONFORMAL_HORIZONS) MP.CONFORMAL[h] = COMPILED_MODEL_PARAMS.CONFORMAL[h];
  for (const k of Object.keys(MP.ROUTE_SCALE)) delete MP.ROUTE_SCALE[k];
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

/**
 * The published scale for a bus route, or 1. Keyed on the BUS route id — the
 * same id the replay's pairs and the scorecard's rows carry — so the number
 * that was fitted and the number that is applied cannot be keyed apart.
 */
export function routeScale(routeId: string | number): number {
  const s = MP.ROUTE_SCALE[String(routeId)];
  return typeof s === "number" && Number.isFinite(s) ? s : 1;
}

/**
 * A promised number of seconds with a route's correction applied. Hinged at
 * `ROUTE_SCALE_FLOOR_SEC`: everything under it is returned unchanged, so the
 * correction cannot move a number across the strand threshold, and everything
 * above it is stretched by `s`. Monotone in `sec`, so applying it to `low`,
 * `eta` and `high` keeps the band's order.
 */
export function applyRouteScale(sec: number, s: number): number {
  if (s === 1) return sec;
  return sec + Math.max(0, sec - ROUTE_SCALE_FLOOR_SEC) * (s - 1);
}
