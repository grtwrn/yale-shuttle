import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type DbBundle } from "../db/client.js";
import {
  CONFORMAL_HORIZONS,
  CONFORMAL_RANGE,
  HORIZON_BIAS_RANGE,
  MAX_ROUTE_SCALE_KEYS,
  PARAM_RANGES,
  ROUTE_SCALE_RANGE,
  SCALAR_PARAM_KEYS,
  createModelParamsSource,
  currentModelParams,
  modelParamsHistory,
  parseParamSet,
  parseSubmission,
  recordModelParams,
  type ModelParamSet,
  type ModelParamsSubmission,
} from "./modelParams.js";

/** A set with every value at the middle of its range: valid by construction. */
function goodParams(): ModelParamSet {
  const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
  const out = {} as Record<string, unknown>;
  for (const k of SCALAR_PARAM_KEYS) out[k] = mid(PARAM_RANGES[k]);
  out["CONFORMAL"] = Object.fromEntries(CONFORMAL_HORIZONS.map((h) => [h, mid(CONFORMAL_RANGE)]));
  out["ROUTE_SCALE"] = {};
  out["HORIZON_BIAS"] = Object.fromEntries(CONFORMAL_HORIZONS.map((h) => [h, { b: 0, n: 0 }]));
  return out as ModelParamSet;
}

function goodSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: goodParams(),
    n: { P_REPEAT_STAND: 1200, HOLD_ENTER_PER_S: 340 },
    window: { from: "2026-08-20", to: "2026-09-03", days: 14 },
    version: "fit-2026-09-04",
    accepted: true,
    note: "nightly",
    decision: { champion: 70, challenger: 66 },
    ...over,
  };
}

describe("parseParamSet", () => {
  it("accepts a full set and rejects each scalar just outside its range, naming the key", () => {
    const good = goodParams();
    expect(parseParamSet(good)).toEqual({ ok: true, value: good });
    const eps = 1e-9;
    for (const k of SCALAR_PARAM_KEYS) {
      const [lo, hi] = PARAM_RANGES[k];
      expect(parseParamSet({ ...good, [k]: lo })).toMatchObject({ ok: true });
      expect(parseParamSet({ ...good, [k]: hi })).toMatchObject({ ok: true });
      expect(parseParamSet({ ...good, [k]: lo - eps })).toEqual({ ok: false, error: `out_of_range:${k}` });
      expect(parseParamSet({ ...good, [k]: hi + eps })).toEqual({ ok: false, error: `out_of_range:${k}` });
      const { [k]: _dropped, ...missing } = good;
      expect(parseParamSet(missing)).toEqual({ ok: false, error: `out_of_range:${k}` });
      expect(parseParamSet({ ...good, [k]: String(good[k]) })).toEqual({ ok: false, error: `out_of_range:${k}` });
    }
  });

  it("requires every conformal horizon inside its range", () => {
    const good = goodParams();
    const { "0-2": _dropped, ...partial } = good.CONFORMAL;
    expect(parseParamSet({ ...good, CONFORMAL: partial })).toEqual({ ok: false, error: "out_of_range:CONFORMAL.0-2" });
    expect(parseParamSet({ ...good, CONFORMAL: { ...good.CONFORMAL, "5-10": CONFORMAL_RANGE[1] + 1e-9 } }))
      .toEqual({ ok: false, error: "out_of_range:CONFORMAL.5-10" });
    expect(parseParamSet({ ...good, CONFORMAL: null })).toEqual({ ok: false, error: "conformal_not_object" });
    expect(parseParamSet(null)).toEqual({ ok: false, error: "params_not_object" });
  });
});

describe("parseSubmission", () => {
  it("rejects a malformed envelope with the offending field", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ window: undefined }, "window_missing"],
      [{ window: { from: "2026-8-20", to: "2026-09-03", days: 14 } }, "window_from"],
      [{ window: { from: "2026-09-03", to: "2026-08-20", days: 14 } }, "window_order"],
      [{ window: { from: "2026-08-20", to: "2026-09-03", days: 0 } }, "window_days"],
      [{ version: "fit 2026/09/04" }, "version"],
      [{ accepted: "yes" }, "accepted"],
      [{ decision: { blob: "x".repeat(16_384) } }, "decision_too_large"],
      [{ n: { P_REPEAT_STAND: -1 } }, "n_invalid:P_REPEAT_STAND"],
    ];
    for (const [over, error] of cases) {
      expect(parseSubmission(goodSubmission(over)), error).toEqual({ ok: false, error });
    }
  });

  it("accepts a good one and clips the note", () => {
    const res = parseSubmission(goodSubmission({ note: "y".repeat(500) }));
    expect(res.ok).toBe(true);
    const v = (res as { ok: true; value: ModelParamsSubmission }).value;
    expect(v.note).toHaveLength(400);
    expect(v).toMatchObject({
      params: goodParams(),
      n: { P_REPEAT_STAND: 1200, HOLD_ENTER_PER_S: 340 },
      window: { from: "2026-08-20", to: "2026-09-03", days: 14 },
      version: "fit-2026-09-04",
      accepted: true,
      decision: { champion: 70, challenger: 66 },
    });
  });
});

// The client re-checks the same ranges (web/src/eta/params.ts) and refuses the
// whole set when a key is off. Read its table out of the SOURCE, the way
// web/src/walk.test.ts reads the server's walking constant: importing the
// client module would drag in the frontend build graph, and hard-coding the
// numbers here would defeat the point.
describe("the ranges match the client's", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "web/src/eta/params.ts"), "utf8");

  it("PARAM_RANGES, key by key", () => {
    const block = /export const PARAM_RANGES[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1];
    expect(block, "PARAM_RANGES block in web/src/eta/params.ts").toBeTruthy();
    const client: Record<string, [number, number]> = {};
    for (const m of block!.matchAll(/^\s*([A-Z_]+): \[([0-9.]+), ([0-9.]+)\],/gm)) {
      client[m[1]!] = [Number(m[2]), Number(m[3])];
    }
    expect(Object.keys(client).sort()).toEqual([...SCALAR_PARAM_KEYS].sort());
    for (const k of SCALAR_PARAM_KEYS) expect(client[k], k).toEqual([...PARAM_RANGES[k]]);
  });

  it("CONFORMAL_RANGE", () => {
    const m = /export const CONFORMAL_RANGE[^=]*= \[([0-9.]+), ([0-9.]+)\];/.exec(src);
    expect(m, "CONFORMAL_RANGE in web/src/eta/params.ts").toBeTruthy();
    expect([Number(m![1]), Number(m![2])]).toEqual([...CONFORMAL_RANGE]);
  });

  it("ROUTE_SCALE_RANGE and its key cap", () => {
    const m = /export const ROUTE_SCALE_RANGE[^=]*= \[([0-9.]+), ([0-9.]+)\];/.exec(src);
    expect(m, "ROUTE_SCALE_RANGE in web/src/eta/params.ts").toBeTruthy();
    expect([Number(m![1]), Number(m![2])]).toEqual([...ROUTE_SCALE_RANGE]);
    const cap = /export const MAX_ROUTE_SCALE_KEYS = (\d+);/.exec(src);
    expect(cap, "MAX_ROUTE_SCALE_KEYS in web/src/eta/params.ts").toBeTruthy();
    expect(Number(cap![1])).toBe(MAX_ROUTE_SCALE_KEYS);
  });

  it("HORIZON_BIAS_RANGE", () => {
    const m = /export const HORIZON_BIAS_RANGE[^=]*= \[(-?[0-9.]+), (-?[0-9.]+)\];/.exec(src);
    expect(m, "HORIZON_BIAS_RANGE in web/src/eta/params.ts").toBeTruthy();
    expect([Number(m![1]), Number(m![2])]).toEqual([...HORIZON_BIAS_RANGE]);
  });
});

describe("HORIZON_BIAS on the wire", () => {
  it("is optional — a set published before the key existed still parses", () => {
    const { HORIZON_BIAS: _gone, ...older } = goodParams();
    const r = parseParamSet(older);
    expect(r.ok && r.value.HORIZON_BIAS["10-30"]).toEqual({ b: 0, n: 0 });
  });

  it("takes an offset in range with its sample, and refuses anything else, whole", () => {
    expect(parseParamSet({ ...goodParams(), HORIZON_BIAS: { "10-30": { b: -90.5, n: 12_000 } } }))
      .toMatchObject({ ok: true });
    expect(parseParamSet({ ...goodParams(), HORIZON_BIAS: { "10-30": { b: HORIZON_BIAS_RANGE[0] - 1, n: 10 } } }))
      .toMatchObject({ ok: false, error: "out_of_range:HORIZON_BIAS.10-30" });
    expect(parseParamSet({ ...goodParams(), HORIZON_BIAS: { "10-30": { b: -10, n: -1 } } }))
      .toMatchObject({ ok: false, error: "horizon_bias_n:10-30" });
    expect(parseParamSet({ ...goodParams(), HORIZON_BIAS: { "10-30": 5 } }))
      .toMatchObject({ ok: false, error: "horizon_bias_cell:10-30" });
    expect(parseParamSet({ ...goodParams(), HORIZON_BIAS: 5 }))
      .toMatchObject({ ok: false, error: "horizon_bias_not_object" });
  });
});

describe("ROUTE_SCALE on the wire", () => {
  it("is optional — a set published before the key existed still parses", () => {
    const { ROUTE_SCALE: _gone, ...older } = goodParams();
    const r = parseParamSet(older);
    expect(r.ok && r.value.ROUTE_SCALE).toEqual({});
  });

  it("takes route ids in range and refuses anything else, whole", () => {
    expect(parseParamSet({ ...goodParams(), ROUTE_SCALE: { "3": 1.1, "8": 0.9 } }))
      .toMatchObject({ ok: true });
    expect(parseParamSet({ ...goodParams(), ROUTE_SCALE: { "3": ROUTE_SCALE_RANGE[1] + 1e-9 } }))
      .toMatchObject({ ok: false, error: "out_of_range:ROUTE_SCALE.3" });
    expect(parseParamSet({ ...goodParams(), ROUTE_SCALE: { Red: 1.1 } }))
      .toMatchObject({ ok: false, error: "route_scale_key:Red" });
    expect(parseParamSet({ ...goodParams(), ROUTE_SCALE: 1.1 }))
      .toMatchObject({ ok: false, error: "route_scale_not_object" });
    const many = Object.fromEntries(Array.from({ length: MAX_ROUTE_SCALE_KEYS + 1 }, (_, i) => [String(i + 1), 1]));
    expect(parseParamSet({ ...goodParams(), ROUTE_SCALE: many }))
      .toMatchObject({ ok: false, error: "route_scale_too_many_keys" });
  });
});

describe("storage", () => {
  let tmpDir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-v2-model-params-"));
    bundle = openDb(path.join(tmpDir, "test.db"));
    migrate(bundle.db, { migrationsFolder: "./drizzle" });
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sub = (version: string, accepted: boolean): ModelParamsSubmission => {
    const r = parseSubmission(goodSubmission({ version, accepted }));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("serves the latest ACCEPTED row, lists every decision newest first, and versions the served set", () => {
    const source = createModelParamsSource(bundle.sqlite);
    expect(source.wire()).toBeNull();
    const v0 = source.version();

    recordModelParams(bundle.sqlite, sub("fit-1", false), 1_000);
    source.refresh();
    expect(source.version()).toBe(v0);
    expect(currentModelParams(bundle.sqlite)).toBeNull();

    recordModelParams(bundle.sqlite, sub("fit-2", true), 2_000);
    source.refresh();
    expect(source.version()).toBe(v0 + 1);
    source.refresh();
    expect(source.version()).toBe(v0 + 1);

    recordModelParams(bundle.sqlite, sub("fit-3", false), 3_000);
    source.refresh();
    expect(source.version()).toBe(v0 + 1);

    expect(currentModelParams(bundle.sqlite)).toMatchObject({ version: "fit-2", accepted: true, publishedAt: 2_000, params: goodParams() });
    expect(modelParamsHistory(bundle.sqlite).map((h) => [h.version, h.accepted])).toEqual([
      ["fit-3", false], ["fit-2", true], ["fit-1", false],
    ]);
    expect(source.wire()).toEqual({ version: "fit-2", publishedAt: 2_000, params: goodParams() });
  });
});
