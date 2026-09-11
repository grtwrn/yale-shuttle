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

/**
 * The per-horizon CENTRE correction (docs/horizon-bias.md), the companion of
 * the per-horizon widening below: `CONFORMAL` says how wide the band must be
 * to cover the truth, `HORIZON_BIAS` says where the middle of it belongs.
 *
 * The measurement it exists for: bucket every promise by the number that was
 * ON SCREEN and the residual is one-sided and grows with the horizon. Most of
 * the band's width is therefore OFFSET, not spread, and an offset is the
 * cheap half to fix — a band re-centred on the conditional median covers the
 * same share of arrivals from a narrower interval.
 *
 * RAW ON THE WIRE, SHRUNK ON THE CLIENT, exactly as the stand quantiles and
 * the diurnal profile are: the wire carries the bucket's own median residual
 * and the sample it was measured on, and `horizonBiasSec` damps it by
 * n/(n+K). A bucket with no evidence is a correction of exactly zero, not a
 * correction the fit could not measure.
 */
export interface HorizonBiasCell {
  /** The bucket's RAW median residual (truth − promise), seconds. */
  b: number;
  /** Pairs behind it. Zero — or a payload without the key — is no correction. */
  n: number;
}

/**
 * k = σ²/τ², the same shape as PR #164's two shrinkages and read off the data
 * the same way: σ is the per-pair spread of the residual inside a bucket and
 * τ the day-to-day spread of the bucket's own offset. Measured on the 9/3 and
 * 9/4 replays (docs/horizon-bias.md §3): σ ≈ 250 s, τ ≈ 6.7 s → k ≈ 1,390
 * pairs.
 *
 * At the ~150,000 pairs a day yields this damps by under a percent, and that
 * is the point: it exists so a bucket that a quiet window measured on a
 * thousand pairs is pulled halfway back to no correction rather than
 * published as if it were the day's best fact. τ is measured across a whole
 * day and an evening, so it carries the day-part difference too and the
 * shrinkage errs toward doing less.
 */
export const HORIZON_BIAS_K = 1390;

/**
 * A published raw offset must sit here. Ten minutes is far outside any honest
 * re-measurement of this feed (the largest bucket median ever measured is
 * −1:23) and a corrupt row cannot reach a rider through it.
 */
export const HORIZON_BIAS_RANGE: readonly [number, number] = [-600, 600];

/**
 * The horizon each bucket's offset is attached to, seconds: the MIDPOINT of
 * the bucket, because that is the promise the bucket's median describes.
 *
 * The correction is the piecewise-linear interpolation through these knots
 * (and through the origin, so a bus arriving now is never moved), NOT the
 * step function the buckets suggest. A step would move a rider's number by
 * the whole difference between two buckets the moment the promise crossed a
 * boundary — 300 s and 301 s would be corrected differently — which is a jump
 * the rider sees and the strand metric counts.
 */
export const HORIZON_BIAS_KNOT_SEC: Readonly<Record<ConformalHorizon, number>> = Object.freeze({
  "0-2": 60, "2-5": 210, "5-10": 450, "10-30": 1200,
});

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
  /**
   * Per promised-minutes bucket, the RAW median residual (truth − promise)
   * and the sample behind it. `horizonBiasSec` shrinks it and
   * `applyHorizonBias` applies it as a monotone map on the priced seconds.
   * Every cell zero — the default, and any payload without the key — is
   * skipped entirely, so the correction is byte-identical to not having one.
   */
  HORIZON_BIAS: Record<ConformalHorizon, HorizonBiasCell>;
}

export type ScalarParamKey = Exclude<keyof ModelParams, "CONFORMAL" | "ROUTE_SCALE" | "HORIZON_BIAS">;
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
  HORIZON_BIAS: Object.freeze({
    "0-2": Object.freeze({ b: 0, n: 0 }), "2-5": Object.freeze({ b: 0, n: 0 }),
    "5-10": Object.freeze({ b: 0, n: 0 }), "10-30": Object.freeze({ b: 0, n: 0 }),
  }) as Record<ConformalHorizon, HorizonBiasCell>,
});

/** The live set the filter and the pricing read. Mutated only through `applyModelParams` / `resetModelParams`. */
export const MP: ModelParams = {
  ...COMPILED_MODEL_PARAMS,
  CONFORMAL: { ...COMPILED_MODEL_PARAMS.CONFORMAL },
  ROUTE_SCALE: { ...COMPILED_MODEL_PARAMS.ROUTE_SCALE },
  HORIZON_BIAS: { "0-2": { b: 0, n: 0 }, "2-5": { b: 0, n: 0 }, "5-10": { b: 0, n: 0 }, "10-30": { b: 0, n: 0 } },
};

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


function emptyHorizonBias(): Record<ConformalHorizon, HorizonBiasCell> {
  return { "0-2": { b: 0, n: 0 }, "2-5": { b: 0, n: 0 }, "5-10": { b: 0, n: 0 }, "10-30": { b: 0, n: 0 } };
}

/**
 * The applied curve: the knots (x, x + shrunk offset), forced non-decreasing.
 *
 * Rebuilt only when the served set changes. Monotone by construction —
 * `m[i] = max(m[i], m[i-1])`, starting from the origin — because the map is
 * applied to `low`, `eta` and `high` alike (the band must keep its order) and
 * because the #119 floor stores the UNCORRECTED number: a correction that
 * could reorder two promises could make the shown remainder climb.
 */
let curve: { xs: number[]; ms: number[] } | null = null;

function horizonCurve(): { xs: number[]; ms: number[] } | null {
  if (curve) return curve;
  const xs: number[] = [0];
  const ms: number[] = [0];
  let any = false;
  for (const h of CONFORMAL_HORIZONS) {
    const cell = MP.HORIZON_BIAS[h];
    const x = HORIZON_BIAS_KNOT_SEC[h];
    const b = cell && cell.n > 0 ? cell.b * (cell.n / (cell.n + HORIZON_BIAS_K)) : 0;
    if (b !== 0) any = true;
    xs.push(x);
    ms.push(Math.max(x + b, ms[ms.length - 1]!));
  }
  curve = any ? { xs, ms } : null;
  return curve;
}

/** The shrunk offset a bucket carries, seconds. Zero when it has no evidence. */
export function horizonBiasSec(h: ConformalHorizon): number {
  const cell = MP.HORIZON_BIAS[h];
  if (!cell || cell.n <= 0) return 0;
  return cell.b * (cell.n / (cell.n + HORIZON_BIAS_K));
}

/**
 * A priced number of seconds with the learned centre correction applied:
 * linear interpolation of the knot map, flat past the last knot (there is no
 * evidence beyond thirty minutes, so the offset stops growing rather than
 * being extrapolated). Monotone and time-invariant, so `low <= eta <= high`
 * survives it and so does the standing clamp's "never climbs".
 */
export function applyHorizonBias(sec: number): number {
  const c = horizonCurve();
  if (!c || !(sec > 0)) return sec;
  const { xs, ms } = c;
  const last = xs.length - 1;
  if (sec >= xs[last]!) return Math.max(0, sec + (ms[last]! - xs[last]!));
  let i = 1;
  while (i < last && sec > xs[i]!) i++;
  const x0 = xs[i - 1]!, x1 = xs[i]!;
  const t = (sec - x0) / (x1 - x0);
  return Math.max(0, ms[i - 1]! + (ms[i]! - ms[i - 1]!) * t);
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
  // HORIZON_BIAS is OPTIONAL for the same reason ROUTE_SCALE is: a set
  // published before it existed must keep applying rather than being rejected
  // whole, which would silently drop every other key with it.
  const bias = emptyHorizonBias();
  const hb = o["HORIZON_BIAS"];
  if (hb !== undefined && hb !== null) {
    if (typeof hb !== "object") return null;
    const h = hb as Record<string, unknown>;
    for (const k of CONFORMAL_HORIZONS) {
      const cell = h[k];
      if (cell === undefined || cell === null) continue;
      if (typeof cell !== "object") return null;
      const c = cell as Record<string, unknown>;
      if (!inRange(c["b"], HORIZON_BIAS_RANGE)) return null;
      const n = c["n"];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
      bias[k] = { b: c["b"] as number, n };
    }
  }
  return {
    ...(out as Omit<ModelParams, "CONFORMAL" | "ROUTE_SCALE" | "HORIZON_BIAS">),
    CONFORMAL: conformal, ROUTE_SCALE: scales, HORIZON_BIAS: bias,
  };
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
  for (const h of CONFORMAL_HORIZONS) MP.HORIZON_BIAS[h] = { ...params.HORIZON_BIAS[h] };
  curve = null;
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
  for (const h of CONFORMAL_HORIZONS) MP.HORIZON_BIAS[h] = { b: 0, n: 0 };
  curve = null;
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
