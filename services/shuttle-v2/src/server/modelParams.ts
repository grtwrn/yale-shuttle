/**
 * The estimator's learned parameters, on the server side (docs/closed-loop.md,
 * stages 3-4).
 *
 * The client's ring estimator (web/src/eta/filter.ts) runs on a handful of
 * constants that were measured once by hand — the deadband emissions, the
 * hold hazards, the shuffle rate, the departure prior — plus a per-horizon
 * widening of its 10-90 band. `scripts/reestimate-params.mjs` re-counts them
 * nightly on the archive, replays champion against challenger, and publishes
 * through `POST /api/model-params`. This module is the server's half:
 *
 *   - the wire shape and the RANGES a published value must sit in (the
 *     client re-checks the same ranges, web/src/eta/params.ts; a test pins
 *     the two tables equal);
 *   - the `model_params` table: one row per nightly decision, accepted or not,
 *     with the fit's n, window and version;
 *   - what the payload serves: the latest ACCEPTED row, as `model_params`.
 *
 * Nothing here knows the compiled defaults. A database with no accepted row
 * serves no `model_params` field at all, and the client then runs on its
 * constants — which is exactly today's behaviour, and the test in
 * web/src/eta/params.test.ts that a served copy of the constants changes no
 * output is what makes "publish" safe to reason about.
 */

import type Database from "better-sqlite3";

export const CONFORMAL_HORIZONS = ["0-2", "2-5", "5-10", "10-30"] as const;
export type ConformalHorizon = (typeof CONFORMAL_HORIZONS)[number];

export const SCALAR_PARAM_KEYS = [
  "P_REPEAT_STAND", "P_REPEAT_MOVE", "P_REPEAT_MOVE_ZONE",
  "HOLD_ENTER_PER_S", "HOLD_LEAVE_PER_S", "SHUFFLE_PER_POLL", "P_DEPART_ON_FRESH",
] as const;
export type ScalarParamKey = (typeof SCALAR_PARAM_KEYS)[number];

/** Mirrors web/src/eta/params.ts PARAM_RANGES exactly (modelParams.test.ts pins it). */
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
/** Mirrors web/src/eta/params.ts ROUTE_SCALE_RANGE / MAX_ROUTE_SCALE_KEYS. */
export const ROUTE_SCALE_RANGE: readonly [number, number] = [0.75, 1.25];
export const MAX_ROUTE_SCALE_KEYS = 64;
const ROUTE_KEY_RE = /^[0-9]{1,6}$/;

export type ModelParamSet = Record<ScalarParamKey, number> & {
  CONFORMAL: Record<ConformalHorizon, number>;
  /** Per bus route id, the multiplicative correction on the priced arrival. */
  ROUTE_SCALE: Record<string, number>;
};

export interface ModelParamsSubmission {
  params: ModelParamSet;
  /** Sample count behind each key (free-form keys, numbers). */
  n: Record<string, number>;
  window: { from: string; to: string; days: number };
  version: string;
  accepted: boolean;
  note: string | null;
  decision: unknown;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_NOTE = 400;
const MAX_DECISION_BYTES = 16_384;
const MAX_N_KEYS = 64;

function inRange(v: unknown, range: readonly [number, number]): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= range[0] && v <= range[1];
}

/** A full parameter set from untrusted JSON, or the reason it is not one. */
export function parseParamSet(raw: unknown): { ok: true; value: ModelParamSet } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "params_not_object" };
  const o = raw as Record<string, unknown>;
  const out: Partial<ModelParamSet> = {};
  for (const k of SCALAR_PARAM_KEYS) {
    if (!inRange(o[k], PARAM_RANGES[k])) return { ok: false, error: `out_of_range:${k}` };
    out[k] = o[k] as number;
  }
  const conf = o["CONFORMAL"];
  if (!conf || typeof conf !== "object") return { ok: false, error: "conformal_not_object" };
  const c = conf as Record<string, unknown>;
  const conformal = {} as Record<ConformalHorizon, number>;
  for (const h of CONFORMAL_HORIZONS) {
    if (!inRange(c[h], CONFORMAL_RANGE)) return { ok: false, error: `out_of_range:CONFORMAL.${h}` };
    conformal[h] = c[h] as number;
  }
  // ROUTE_SCALE is optional on the way in: the row published on 2026-09-07
  // predates it and must keep parsing, or the payload would stop serving a
  // set that riders are already running.
  const scales: Record<string, number> = {};
  const rs = o["ROUTE_SCALE"];
  if (rs !== undefined && rs !== null) {
    if (typeof rs !== "object") return { ok: false, error: "route_scale_not_object" };
    const entries = Object.entries(rs as Record<string, unknown>);
    if (entries.length > MAX_ROUTE_SCALE_KEYS) return { ok: false, error: "route_scale_too_many_keys" };
    for (const [k, v] of entries) {
      if (!ROUTE_KEY_RE.test(k)) return { ok: false, error: `route_scale_key:${k}` };
      if (!inRange(v, ROUTE_SCALE_RANGE)) return { ok: false, error: `out_of_range:ROUTE_SCALE.${k}` };
      scales[k] = v as number;
    }
  }
  return { ok: true, value: { ...(out as Record<ScalarParamKey, number>), CONFORMAL: conformal, ROUTE_SCALE: scales } };
}

/** The whole POST body, validated. */
export function parseSubmission(raw: unknown): { ok: true; value: ModelParamsSubmission } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body_not_object" };
  const b = raw as Record<string, unknown>;
  const params = parseParamSet(b["params"]);
  if (!params.ok) return params;
  const n: Record<string, number> = {};
  if (b["n"] !== undefined) {
    if (!b["n"] || typeof b["n"] !== "object") return { ok: false, error: "n_not_object" };
    const entries = Object.entries(b["n"] as Record<string, unknown>);
    if (entries.length > MAX_N_KEYS) return { ok: false, error: "n_too_many_keys" };
    for (const [k, v] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,48}$/.test(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return { ok: false, error: `n_invalid:${k}` };
      }
      n[k] = v;
    }
  }
  const w = b["window"] as Record<string, unknown> | undefined;
  if (!w || typeof w !== "object") return { ok: false, error: "window_missing" };
  if (typeof w["from"] !== "string" || !DAY_RE.test(w["from"])) return { ok: false, error: "window_from" };
  if (typeof w["to"] !== "string" || !DAY_RE.test(w["to"])) return { ok: false, error: "window_to" };
  if (typeof w["days"] !== "number" || !Number.isInteger(w["days"]) || w["days"] < 1 || w["days"] > 400) return { ok: false, error: "window_days" };
  if (w["from"] > w["to"]) return { ok: false, error: "window_order" };
  if (typeof b["version"] !== "string" || !VERSION_RE.test(b["version"])) return { ok: false, error: "version" };
  if (typeof b["accepted"] !== "boolean") return { ok: false, error: "accepted" };
  let note: string | null = null;
  if (b["note"] !== undefined && b["note"] !== null) {
    if (typeof b["note"] !== "string") return { ok: false, error: "note" };
    note = b["note"].slice(0, MAX_NOTE);
  }
  let decision: unknown = null;
  if (b["decision"] !== undefined && b["decision"] !== null) {
    const text = JSON.stringify(b["decision"]);
    if (text === undefined || Buffer.byteLength(text) > MAX_DECISION_BYTES) return { ok: false, error: "decision_too_large" };
    decision = b["decision"];
  }
  return {
    ok: true,
    value: {
      params: params.value, n,
      window: { from: w["from"], to: w["to"], days: w["days"] },
      version: b["version"], accepted: b["accepted"], note, decision,
    },
  };
}

/** Append one decision. Returns the row id. */
export function recordModelParams(sqlite: Database.Database, sub: ModelParamsSubmission, now: number): number {
  const r = sqlite
    .prepare(
      `INSERT INTO model_params
         (published_at, accepted, version, window_from, window_to, window_days, params, n, note, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now, sub.accepted ? 1 : 0, sub.version, sub.window.from, sub.window.to, sub.window.days,
      JSON.stringify(sub.params), JSON.stringify(sub.n), sub.note, sub.decision === null ? null : JSON.stringify(sub.decision),
    );
  return Number(r.lastInsertRowid);
}

export interface StoredModelParams {
  id: number;
  publishedAt: number;
  accepted: boolean;
  version: string;
  window: { from: string; to: string; days: number };
  params: ModelParamSet;
  n: Record<string, number>;
  note: string | null;
  decision: unknown;
}

interface Row {
  id: number; published_at: number; accepted: number; version: string;
  window_from: string; window_to: string; window_days: number;
  params: string; n: string; note: string | null; decision: string | null;
}

function rowToStored(r: Row): StoredModelParams | null {
  try {
    const params = parseParamSet(JSON.parse(r.params));
    if (!params.ok) return null;
    return {
      id: r.id, publishedAt: r.published_at, accepted: r.accepted === 1, version: r.version,
      window: { from: r.window_from, to: r.window_to, days: r.window_days },
      params: params.value, n: JSON.parse(r.n) as Record<string, number>, note: r.note,
      decision: r.decision === null ? null : (JSON.parse(r.decision) as unknown),
    };
  } catch {
    return null;
  }
}

/** The latest accepted set — what the payload serves — or null. Never throws. */
export function currentModelParams(sqlite: Database.Database): StoredModelParams | null {
  try {
    const r = sqlite
      .prepare("SELECT * FROM model_params WHERE accepted = 1 ORDER BY published_at DESC, id DESC LIMIT 1")
      .get() as Row | undefined;
    return r ? rowToStored(r) : null;
  } catch {
    return null;
  }
}

/** The last `limit` decisions, newest first. Never throws. */
export function modelParamsHistory(sqlite: Database.Database, limit = 10): StoredModelParams[] {
  try {
    const rows = sqlite
      .prepare("SELECT * FROM model_params ORDER BY published_at DESC, id DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit))) as Row[];
    return rows.map(rowToStored).filter((x): x is StoredModelParams => x !== null);
  } catch {
    return [];
  }
}

/** `payload.model_params`: the client reads `params`, shows `version`. */
export interface ModelParamsWire {
  version: string;
  publishedAt: number;
  params: ModelParamSet;
}

export function toWire(s: StoredModelParams | null): ModelParamsWire | null {
  return s ? { version: s.version, publishedAt: s.publishedAt, params: s.params } : null;
}

/**
 * A holder the payload cache keys on: the served set and a version number
 * that moves whenever it changes, so a publish reaches riders on their next
 * poll without waiting for the collector's data version to move.
 */
export interface ModelParamsSource {
  version(): number;
  wire(): ModelParamsWire | null;
  /** Re-read the latest accepted row (after a publish). */
  refresh(): void;
}

export function createModelParamsSource(sqlite: Database.Database): ModelParamsSource {
  let v = 1;
  let wire = toWire(currentModelParams(sqlite));
  return {
    version: () => v,
    wire: () => wire,
    refresh: () => {
      const next = toWire(currentModelParams(sqlite));
      if (JSON.stringify(next) !== JSON.stringify(wire)) { wire = next; v += 1; }
    },
  };
}
