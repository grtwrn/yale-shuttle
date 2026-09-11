import { describe, expect, it } from "vitest";

import {
  completeLines, FINGERPRINT_BYTES, fingerprintOf, readCursor, reconcile, resumeOffset,
} from "./canary-ship-lib.mjs";

/**
 * THE REAL APPENDS. These three lines are the tail of
 * scripts/.canary/runs.jsonl on the Pi at 2026-09-08 21:15 UTC, in the order
 * the file holds them. The Orange Day run STARTED at 20:55:55 and was written
 * after the Red run that started at 20:58:09, because Red's watch is 25
 * minutes and the rotation rider's was 7. That is the whole bug in three
 * records.
 */
const REAL_TAIL = [
  { startedAt: 1_788_899_582_699, line: "Red", ok: true },
  { startedAt: 1_788_901_089_029, line: "Red", ok: true },
  { startedAt: 1_788_900_955_435, line: "Orange Day", ok: true },
];
const asLog = (runs) => Buffer.from(runs.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
/** A real run record is ~30 KB; these fixtures are 60 B, so pad past the window. */
const padded = (runs) => asLog(runs.map((r, i) => (i === 0 ? { ...r, pad: "x".repeat(FINGERPRINT_BYTES) } : r)));

/** What the retired cursor did: ship everything with a newer startedAt, remember the newest. */
function shipByStartedAt(runs, lastStartedAt) {
  const due = runs.filter((r) => r.startedAt > lastStartedAt).sort((a, b) => a.startedAt - b.startedAt);
  return { shipped: due, cursor: due.length ? due[due.length - 1].startedAt : lastStartedAt };
}

describe("the retired timestamp cursor", () => {
  it("skips an earlier-started run that was appended later, and never offers it again", () => {
    // The file arrives one line at a time; the shipper runs after each.
    let cursor = 0;
    const seen = new Set();
    for (let i = 1; i <= REAL_TAIL.length; i++) {
      const round = shipByStartedAt(REAL_TAIL.slice(0, i), cursor);
      for (const r of round.shipped) seen.add(r.line);
      cursor = round.cursor;
    }
    expect(seen.has("Orange Day")).toBe(false);
    // And it stays lost: the cursor is now past its startedAt for good.
    expect(shipByStartedAt(REAL_TAIL, cursor).shipped).toHaveLength(0);
  });
});

describe("the byte-offset cursor", () => {
  const fileOf = (runs) => {
    const buf = asLog(runs);
    return { buf, size: buf.length, fingerprint: fingerprintOf(buf) };
  };

  it("ships an earlier-started run that was appended later", () => {
    let cursor = { offset: null, fingerprint: null, legacy: false };
    const shipped = [];
    for (let i = 1; i <= REAL_TAIL.length; i++) {
      const file = fileOf(REAL_TAIL.slice(0, i));
      const { offset } = resumeOffset(cursor, file);
      const lines = completeLines(file.buf.subarray(offset), offset);
      for (const { line } of lines) shipped.push(JSON.parse(line));
      cursor = { offset: lines.length ? lines[lines.length - 1].endOffset : offset, fingerprint: file.fingerprint, legacy: false };
    }
    expect(shipped.map((r) => r.line)).toEqual(["Red", "Red", "Orange Day"]);
    expect(shipped.map((r) => r.startedAt)).toEqual(REAL_TAIL.map((r) => r.startedAt));
  });

  it("ships nothing a second time when the log has not grown", () => {
    const file = fileOf(REAL_TAIL);
    const cursor = { offset: file.size, fingerprint: file.fingerprint, legacy: false };
    const { offset, why } = resumeOffset(cursor, file);
    expect(offset).toBe(file.size);
    expect(why).toBeNull();
    expect(completeLines(file.buf.subarray(offset), offset)).toEqual([]);
  });

  it("starts again from zero when the log was truncated", () => {
    const big = fileOf(REAL_TAIL);
    const small = fileOf(REAL_TAIL.slice(0, 1));
    const { offset, why } = resumeOffset(
      { offset: big.size, fingerprint: small.fingerprint, legacy: false }, small);
    expect(offset).toBe(0);
    expect(why).toMatch(/shrank/);
  });

  it("starts again from zero when the log was rotated under the cursor", () => {
    const buf = padded(REAL_TAIL);
    const file = { buf, size: buf.length, fingerprint: fingerprintOf(buf) };
    const { offset, why } = resumeOffset(
      { offset: 10, fingerprint: "0000000000000000", legacy: false }, file);
    expect(offset).toBe(0);
    expect(why).toMatch(/rotated/);
  });

  it("leaves a torn final line for the next run instead of shipping half of it", () => {
    const whole = asLog(REAL_TAIL);
    const torn = Buffer.concat([whole, Buffer.from('{"startedAt":178890', "utf8")]);
    const lines = completeLines(torn, 0);
    expect(lines).toHaveLength(3);
    // The cursor stops at the end of the last COMPLETE record, so the partial
    // one is read whole next time.
    expect(lines[2].endOffset).toBe(whole.length);
  });

  it("re-ships the whole log once when the stored cursor predates byte offsets", () => {
    const file = fileOf(REAL_TAIL);
    const cursor = readCursor('{"lastStartedAt": 1788900131759}');
    expect(cursor).toMatchObject({ offset: null, legacy: true });
    const { offset, why } = resumeOffset(cursor, file);
    expect(offset).toBe(0);
    expect(why).toMatch(/startedAt/);
  });

  it("re-ships the whole log when asked with --all", () => {
    const file = fileOf(REAL_TAIL);
    expect(resumeOffset({ offset: file.size, fingerprint: file.fingerprint, legacy: false }, file, { all: true }).offset).toBe(0);
  });

  it("keeps the same fingerprint as the log grows, so an append is not read as a rotation", () => {
    // The bug this guards: fingerprinting a window the file has not filled yet
    // changes it on every append, which reads as a rotation and re-ships the
    // whole log every minute the canary is running.
    const one = padded(REAL_TAIL.slice(0, 1));
    const three = padded(REAL_TAIL);
    expect(fingerprintOf(three)).toBe(fingerprintOf(one));
    expect(fingerprintOf(one)).not.toBeNull();
  });

  it("has no fingerprint to disagree with while the log is shorter than the window", () => {
    expect(fingerprintOf(Buffer.from('{"startedAt":178', "utf8"))).toBeNull();
    expect(resumeOffset({ offset: 0, fingerprint: null, legacy: false }, { size: 16, fingerprint: null }).offset).toBe(0);
  });

  it("treats an unreadable cursor file as no cursor rather than as byte zero of a rotation", () => {
    expect(readCursor(null)).toMatchObject({ offset: null, legacy: false });
    expect(readCursor("not json")).toMatchObject({ offset: null, legacy: false });
    expect(readCursor('{"offset": -1}')).toMatchObject({ offset: null });
  });
});

describe("the shipper checking its own work", () => {
  it("reports a loss when the server holds fewer runs than the log", () => {
    // The Pi, 2026-09-08: 104 runs in the log for the last 24 h, 42 on the
    // server. Both earlier bugs looked exactly like this and nothing said so.
    const r = reconcile({ localRuns: 104, shippedRuns: 42, windowHours: 24 });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(62);
    expect(r.message).toMatch(/62 never arrived/);
  });

  it("is quiet when the two counts agree", () => {
    expect(reconcile({ localRuns: 40, shippedRuns: 40, windowHours: 24 })).toMatchObject({ ok: true, missing: 0 });
  });

  it("does not call it a loss when the server holds MORE than this log", () => {
    // Another machine may ship to the same app, and a run can land between the
    // read and the check.
    expect(reconcile({ localRuns: 40, shippedRuns: 44, windowHours: 24 }).ok).toBe(true);
  });

  it("says it could not check, rather than passing, when the server will not answer", () => {
    const r = reconcile({ localRuns: 40, shippedRuns: null, windowHours: 24 });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/could not read/);
  });
});
