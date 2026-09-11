/**
 * The shipper's cursor, and the check that says whether it lost anything.
 *
 * WHY THIS IS A SEPARATE FILE. `canary-ship.mjs` is a script: it reads a
 * token, POSTs, and opens GitHub issues at import time. The cursor is the part
 * that has now been wrong twice, so it lives here where a test can hold it.
 *
 * WHY THE CURSOR IS A BYTE OFFSET AND NOT A TIMESTAMP.
 *
 * `scripts/.canary/runs.jsonl` is APPENDED TO IN COMPLETION ORDER, and the
 * canary runs two riders at once: the dedicated Red rider watches for up to 25
 * minutes while the rotation rider turns over every 3-7. So an earlier-STARTED
 * run is routinely written after a later-started one. The cursor used to be
 * `lastStartedAt` — the newest `startedAt` acknowledged — and a run whose
 * `startedAt` fell below it when it finally landed was below the cursor
 * FOREVER.
 *
 * Measured on the Pi's log, 2026-09-08: 248 archived runs, 22 of them appended
 * out of start order, 14 of those never reached the server. The runs that lose
 * are structurally the LONG watches — the dedicated Red rider's, the line the
 * operator watches, and the only ones with enough watched minutes to have
 * standing to fail. In the last 24 h the skipped set had a median watch of 25
 * minutes against 11.7 for the log as a whole, and it included four failing
 * runs (three `eta-jump`, one `no-arrival`).
 *
 * A byte offset cannot do that: the file only ever grows at the end, so
 * "everything after offset N" is exactly "everything not yet seen", whatever
 * order the clocks inside the records run in.
 *
 * THE FINGERPRINT is what makes the offset safe across a truncation or a
 * rotation. If the file's opening bytes change, or the file is shorter than
 * the cursor, this is not the file the offset was measured against and the
 * only correct answer is to start again from the beginning — the server
 * de-duplicates on `run_key`, so re-shipping costs a few hundred rows and
 * loses nothing. An unchanged file keeps its offset, so an ordinary restart
 * ships nothing twice.
 *
 * The log is APPEND-ONLY, so its opening bytes are immutable once written and
 * hashing them is stable. The one moment they are not is before the file is
 * even that long, which is why a short file fingerprints as `null` rather than
 * as a different-looking file — otherwise a brand-new log would read as a
 * rotation on every append until it grew past the window. One run record is
 * ~30 KB, so in practice the window is filled by the first run ever written.
 */
import { createHash } from "node:crypto";

/** Opening bytes of the log that name it. Immutable, because it is appended to. */
export const FINGERPRINT_BYTES = 512;

/**
 * Short, stable name for "the log that starts with these bytes".
 *
 * `null` for a file too short to fill the window. A null on either side is not
 * a mismatch: there is nothing to disagree with, and calling it a rotation
 * would re-ship the log on every append until it grew.
 */
export function fingerprintOf(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(String(head ?? ""), "utf8");
  if (buf.length < FINGERPRINT_BYTES) return null;
  return createHash("sha256").update(buf.subarray(0, FINGERPRINT_BYTES)).digest("hex").slice(0, 16);
}

/**
 * Read whatever `shipped.json` held into the one shape the rest of this uses.
 *
 * The pre-2026-09-08 cursor is `{ lastStartedAt }` with no offset. That is not
 * convertible — the whole point is that `startedAt` does not order the file —
 * so it is reported as "no offset", which starts from zero and back-fills. On
 * the Pi that recovers the 156 runs the two earlier shipper bugs threw away.
 */
export function readCursor(json) {
  let raw = json;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== "object") return { offset: null, fingerprint: null, legacy: false };
  const offset = Number.isInteger(raw.offset) && raw.offset >= 0 ? raw.offset : null;
  const fingerprint = typeof raw.fingerprint === "string" && raw.fingerprint ? raw.fingerprint : null;
  return { offset, fingerprint, legacy: offset === null && raw.lastStartedAt != null };
}

/**
 * Where to resume reading, and the sentence explaining it.
 *
 * `file` is `{ size, fingerprint }` for the log as it is right now.
 */
export function resumeOffset(cursor, file, { all = false } = {}) {
  if (all) return { offset: 0, why: "--all: re-shipping the whole log" };
  if (cursor.offset === null) {
    return {
      offset: 0,
      why: cursor.legacy
        ? "cursor predates the byte offset (it keyed on startedAt, which the log is not ordered by) — shipping the whole log once; the server de-duplicates"
        : "no cursor yet — shipping the whole log",
    };
  }
  if (cursor.fingerprint && file.fingerprint && cursor.fingerprint !== file.fingerprint) {
    return { offset: 0, why: "the log was rotated (its first bytes changed) — starting again" };
  }
  if (cursor.offset > file.size) {
    return { offset: 0, why: `the log shrank (${file.size} B < cursor ${cursor.offset} B) — starting again` };
  }
  return { offset: cursor.offset, why: null };
}

/**
 * Complete lines in `buf`, each with the byte offset just past its newline.
 *
 * The canary appends while this reads, so the last line is regularly torn. A
 * torn line has no newline yet: it is left out AND the offset never advances
 * past it, so the next run reads it whole. `loadRuns` in the shipper used to
 * swallow the parse error and move on, which was harmless only because the
 * timestamp cursor happened to re-read it.
 */
export function completeLines(buf, baseOffset = 0) {
  const out = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) break;
    const line = buf.subarray(start, nl).toString("utf8");
    out.push({ line, endOffset: baseOffset + nl + 1 });
    start = nl + 1;
  }
  return out;
}

/**
 * Does the server hold everything the log holds, over the same window?
 *
 * THE POINT IS THAT THE LOOP NOTICES ITS OWN LOSSES. Both shipper bugs were
 * silent: the truncation answered 200 for a batch it had cut to 50, and the
 * timestamp cursor simply never offered the skipped runs. Both were found by
 * a human diffing two files by hand, days later, and in between the dashboard
 * read as a healthy canary because the runs it never received could not
 * contradict it.
 *
 * More on the server than in the log is NOT a loss — another machine may ship
 * to the same app, and a run can land between the read and the check.
 */
export function reconcile({ localRuns, shippedRuns, windowHours }) {
  if (!Number.isFinite(shippedRuns)) {
    return { ok: true, missing: 0, message: `could not read the server's count; skipping the ${windowHours} h reconciliation` };
  }
  const missing = Math.max(0, localRuns - shippedRuns);
  if (missing === 0) {
    return { ok: true, missing: 0, message: `reconciled over ${windowHours} h: ${localRuns} run(s) in the log, ${shippedRuns} on the server` };
  }
  return {
    ok: false,
    missing,
    message: `LOST EVIDENCE: the log holds ${localRuns} run(s) started in the last ${windowHours} h and the server holds ${shippedRuns} — ${missing} never arrived. Re-ship with: node scripts/canary-ship.mjs --all`,
  };
}
