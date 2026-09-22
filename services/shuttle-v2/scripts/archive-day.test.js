import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveDay, etDayStartMs, fetchTable, TABLES } from "./archive-day.mjs";
import { archiveTableFile, readArchiveTable } from "./archive-files.mjs";
import { checkDay } from "./archive-check.mjs";
import { readArchiveRows } from "./eta-replay/archive-db.ts";

const day = "2026-09-21", start = etDayStartMs(day);
const gps = (offset) => ({ bus_id: 7, bus_name: "#7", route_id: 9, lat: 41.3,
  lon: -72.95, heading: 90, last_stop_id: 8, collected_at: start + offset });
let dir, opts, rows, trailers, extra, failures;
const selected = () => JSON.parse(fs.readFileSync(path.join(dir, day, "manifest.json"), "utf8"));
const read = (table) => readArchiveTable(path.join(dir, day), table);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shuttle-archive-test-"));
  opts = { archiveDir: dir, capturesDir: path.join(dir, "captures"), token: "test-only", base: "https://archive.test" };
  rows = {
    raw_positions: [gps(1), gps(2)],
    arrivals: [{ id: 1, arrived_at: start + 1, departed_at: null, dwell_sec: null }],
    stop_visits: [{ id: 1, anchored_at: start + 1, outcome: "stopped" }],
    legs: [{ id: 1, departed_at: start + 1 }],
    predictions_log: [{ id: 1, predicted_at: start + 1, predicted_sec: 60 }],
    upstream_etas: [{ id: 1, sampled_at: start + 1 }],
    scorecard_days: [{ day, route_id: 9, horizon: "all", surface: "trip", scored_through: start + 1,
      scored_at: start + 2, final: 0, metrics: "{}" }],
  };
  trailers = {}; extra = {}; failures = new Set();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    expect(init.headers["x-admin-token"]).toBe("test-only");
    const table = new URL(url).searchParams.get("table");
    if (failures.has(table)) return new Response("failed", { status: 503 });
    const header = { table, day, columns: Object.keys(rows[table][0] ?? {}), build: "test-build" };
    const trailer = Object.hasOwn(trailers, table) ? trailers[table] : { end: true, rows: rows[table].length };
    const stream = [header, ...rows[table], ...(trailer ? [trailer] : []), ...(extra[table] ?? [])];
    return new Response(stream.map(row => JSON.stringify(row)).join("\n") + "\n");
  }));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("immutable archive attempts and selection", () => {
  it("writes all tables, hashes and manifest paths readable by the existing replay", async () => {
    const attempt = await archiveDay(day, opts), manifest = selected();
    expect(attempt.ok).toBe(true);
    expect(checkDay(path.join(dir, day)).complete).toBe(true);
    for (const table of TABLES) {
      expect(manifest.tables[table].file).toMatch(/^snapshots\//);
      expect(read(table)).toEqual(rows[table]);
      expect(readArchiveRows(day, table, dir)).toEqual(rows[table]);
    }
    expect(manifest.completeness).toContain("transport only");
  });

  it("keeps complete history when retention makes a later export smaller", async () => {
    await archiveDay(day, opts);
    const prior = selected(), file = archiveTableFile(path.join(dir, day), "raw_positions", prior);
    const bytes = fs.readFileSync(file);
    rows.raw_positions = [gps(2)];
    const attempt = await archiveDay(day, opts);
    expect(attempt.ok).toBe(false);
    expect(attempt.archiveOk).toBe(true);
    expect(attempt.tables.raw_positions.replacementError).toContain("omits");
    expect(selected().tables.raw_positions).toEqual(prior.tables.raw_positions);
    expect(read("raw_positions")).toEqual([gps(1), gps(2)]);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(readArchiveTable(path.join(dir, day), "raw_positions", attempt)).toEqual([gps(2)]);
    expect(selected().lastAttempt.ok).toBe(false);
  });

  it("rejects an equal-size export with different observations", async () => {
    await archiveDay(day, opts);
    rows.raw_positions = [gps(2), gps(3)];
    const attempt = await archiveDay(day, opts);
    expect(attempt.tables.raw_positions.replacementError).toContain("omits");
    expect(read("raw_positions")).toEqual([gps(1), gps(2)]);
  });

  it("rejects changed immutable values and duplicate identities", async () => {
    await archiveDay(day, opts);
    rows.predictions_log[0].predicted_sec = 120;
    rows.raw_positions = [gps(1), gps(1)];
    const attempt = await archiveDay(day, opts);
    expect(attempt.tables.predictions_log.replacementError).toContain("changes");
    expect(attempt.tables.raw_positions.error).toContain("duplicate");
    expect(read("predictions_log")[0].predicted_sec).toBe(60);
    expect(read("raw_positions")).toHaveLength(2);
  });

  it("accepts supersets and settled arrivals, retaining older immutable files", async () => {
    await archiveDay(day, opts);
    const prior = selected();
    rows.raw_positions.push(gps(3));
    rows.arrivals[0].departed_at = start + 1001; rows.arrivals[0].dwell_sec = 1;
    expect((await archiveDay(day, opts)).ok).toBe(true);
    expect(read("raw_positions")).toHaveLength(3);
    expect(read("arrivals")[0].departed_at).toBe(start + 1001);
    expect(readArchiveTable(path.join(dir, day), "arrivals", prior)[0].departed_at).toBeNull();
    rows.arrivals[0].departed_at = null;
    expect((await archiveDay(day, opts)).tables.arrivals.replacementError).toContain("changes");
  });

  it("accepts advancing scorecards but refuses a rollback or a changed final scorecard", async () => {
    await archiveDay(day, opts);
    Object.assign(rows.scorecard_days[0], { scored_through: start + 10, scored_at: start + 11, metrics: "{\"n\":1}" });
    expect((await archiveDay(day, opts)).ok).toBe(true);
    rows.scorecard_days[0].scored_through = start + 5;
    expect((await archiveDay(day, opts)).tables.scorecard_days.replacementError).toContain("changes");
    Object.assign(rows.scorecard_days[0], { scored_through: start + 10, final: 1 });
    expect((await archiveDay(day, opts)).ok).toBe(true);
    rows.scorecard_days[0].metrics = "{\"n\":2}";
    expect((await archiveDay(day, opts)).tables.scorecard_days.replacementError).toContain("changes");
  });

  it("does not let a partial capture certify a truncated server stream", async () => {
    fs.mkdirSync(opts.capturesDir);
    fs.writeFileSync(path.join(opts.capturesDir, "positions-20260921.jsonl"), JSON.stringify(gps(3)) + "\n");
    trailers.raw_positions = null;
    const attempt = await archiveDay(day, opts);
    expect(attempt.ok).toBe(false);
    expect(attempt.tables.raw_positions.complete).toBe(false);
    expect(attempt.positions.capture).toBe(1);
    expect(read("raw_positions")).toHaveLength(3);
    expect(checkDay(path.join(dir, day)).complete).toBe(false);
    rows.raw_positions.push(gps(3)); delete trailers.raw_positions;
    expect((await archiveDay(day, opts)).archiveOk).toBe(true);
  });

  it("preserves selected data on HTTP failure and still attempts the other tables", async () => {
    await archiveDay(day, opts);
    const prior = selected();
    failures.add("raw_positions"); rows.legs.push({ id: 2, departed_at: start + 2 });
    const attempt = await archiveDay(day, opts);
    expect(attempt.ok).toBe(false);
    expect(selected().tables.raw_positions).toEqual(prior.tables.raw_positions);
    expect(read("legs")).toHaveLength(2);
  });

  it("detects same-size corruption and refuses to replace unverified earlier data", async () => {
    await archiveDay(day, opts);
    const file = archiveTableFile(path.join(dir, day), "raw_positions"), bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
    expect(checkDay(path.join(dir, day)).complete).toBe(false);
    const attempt = await archiveDay(day, opts);
    expect(attempt.tables.raw_positions.replacementError).toContain("integrity check failed");
    expect(attempt.archiveOk).toBe(false);
    expect(selected().ok).toBe(false);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("keeps the entire previous manifest when final publication fails", async () => {
    await archiveDay(day, opts);
    const file = path.join(dir, day, "manifest.json"), prior = fs.readFileSync(file);
    rows.raw_positions.push(gps(3));
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) throw new Error("simulated publication failure");
      return rename(from, to);
    });
    await expect(archiveDay(day, opts)).rejects.toThrow("simulated publication failure");
    expect(fs.readFileSync(file)).toEqual(prior);
    expect(read("raw_positions")).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, day, ".archive-lock"))).toBe(false);
  });

  it("refuses an overlapping writer before downloading or modifying data", async () => {
    await archiveDay(day, opts);
    fs.mkdirSync(path.join(dir, day, ".archive-lock"));
    fetch.mockClear();
    await expect(archiveDay(day, opts)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(read("raw_positions")).toHaveLength(2);
  });

  it("reads and safely advances a legacy archive without overwriting its files", async () => {
    await archiveDay(day, opts);
    const manifest = selected();
    for (const table of TABLES) {
      const file = archiveTableFile(path.join(dir, day), table, manifest);
      fs.copyFileSync(file, path.join(dir, day, `${table}.jsonl.gz`));
      manifest.tables[table].file = `${table}.jsonl.gz`;
    }
    fs.writeFileSync(path.join(dir, day, "manifest.json"), JSON.stringify(manifest));
    expect(readArchiveRows(day, "raw_positions", dir)).toHaveLength(2);
    rows.raw_positions.push(gps(3));
    expect((await archiveDay(day, opts)).ok).toBe(true);
    expect(readArchiveRows(day, "raw_positions", dir)).toHaveLength(3);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, day, "raw_positions.jsonl.gz")))
      .toString().trim().split("\n")).toHaveLength(2);
  });
});

describe("stream framing", () => {
  it.each([null, { end: true, rows: 3 }, { end: true, rows: "2" }])("rejects missing or invalid trailer counts: %j", async trailer => {
    trailers.raw_positions = trailer;
    expect((await fetchTable(opts.base, opts.token, day, "raw_positions")).complete).toBe(false);
  });
  it.each([[gps(3)], [{ end: true, rows: 2 }]])("rejects any data after the trailer: %j", async suffix => {
    extra.raw_positions = suffix;
    await expect(fetchTable(opts.base, opts.token, day, "raw_positions")).rejects.toThrow("data after trailer");
  });
});
