#!/usr/bin/env node
/**
 * Ship the rider canary's findings to the server, and escalate the ones that
 * cannot wait to be read.
 *
 * `scripts/rider-canary.mjs` rides a line and appends one run per line to
 * `scripts/.canary/runs.jsonl`. On 2026-09-04 it had been doing that for
 * fourteen hours and NOTHING HAD EVER READ THE FILE. At 07:37 ET it caught
 * the exact defect the operator was chasing —
 *
 *     Red  ok=false  eta-jump: "now, then 66 min" -> "in 7, 25 min" in 15 s
 *
 * — and the finding sat there until he hit the bug himself. This script is the
 * path from detection to attention. It does two things and nothing else:
 *
 *   1. POSTs each new run's SUMMARY to /api/canary/runs, which /stats renders.
 *      Summaries only: the ~100 samples and the two 3 KB page dumps per jump
 *      that make a run 40 KB stay on the machine that captured them.
 *   2. Raises whatever the SERVER decided was worth an interruption. The
 *      escalation rule lives in src/server/canary.ts, not here, because only
 *      the server has the history a cooldown needs and it survives this script
 *      being restarted. See that file for the measurement behind the rule.
 *
 * It is a READER of the canary's log. It never starts, stops or writes to the
 * canary process, so it is safe to run beside a watch that is mid-rotation.
 *
 *   3. Reconciles, every time: the log's own run count for the last day
 *      against the server's. Both of this shipper's bugs were SILENT losses
 *      (a batch truncated to 50 and answered 200; a cursor that skipped every
 *      earlier-started run that finished late), and both were found by a
 *      person diffing two files days later. It now exits non-zero when the
 *      server holds fewer runs than the log does.
 *
 * Usage:
 *   node scripts/canary-ship.mjs                 ship anything new, escalate
 *   node scripts/canary-ship.mjs --dry-run       show what would be sent
 *   node scripts/canary-ship.mjs --all           re-ship the whole log
 *                                                (the server de-duplicates)
 *
 * Env:
 *   BOT_BASE_URL          default https://yale-shuttle.fly.dev
 *   SHUTTLE_ADMIN_TOKEN   else ~/.yale-shuttle-admin-token
 *   CANARY_DIR            default scripts/.canary
 *   CANARY_ALERT          gh (default) | webhook | none
 *   CANARY_ALERT_URL      for CANARY_ALERT=webhook — a plain-text POST, in the
 *                         shape ntfy.sh accepts
 *   CANARY_ALERT_REPO     for CANARY_ALERT=gh, default grtwrn/yale-shuttle
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeLines, FINGERPRINT_BYTES, fingerprintOf, readCursor, reconcile, resumeOffset,
} from "./canary-ship-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BASE = (process.env.BOT_BASE_URL || "https://yale-shuttle.fly.dev").replace(/\/$/, "");
const DIR = process.env.CANARY_DIR || path.join(HERE, ".canary");
const RUNS = path.join(DIR, "runs.jsonl");
const CURSOR = path.join(DIR, "shipped.json");
const CHANNEL = (process.env.CANARY_ALERT || "gh").toLowerCase();
const REPO = process.env.CANARY_ALERT_REPO || "grtwrn/yale-shuttle";
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");
const ALL = ARGS.has("--all");

/** Same token the triage queue uses. Never checked into the repo. */
function token() {
  if (process.env.SHUTTLE_ADMIN_TOKEN) return process.env.SHUTTLE_ADMIN_TOKEN.trim();
  const file = path.join(os.homedir(), ".yale-shuttle-admin-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    console.error(`No admin token. Set $SHUTTLE_ADMIN_TOKEN or put it in ${file}.`);
    process.exit(2);
  }
}

// ── reading the canary's log ────────────────────────────────────────────────

/**
 * Everything appended since the cursor, in APPEND ORDER, with the byte offset
 * that each record ends at.
 *
 * Append order, not `startedAt` order: the offset the cursor saves has to mean
 * "I have seen every byte up to here", and sorting first would break that. The
 * server sorts a batch by `startedAt` itself before it escalates, so the
 * ordering the cooldown depends on is unaffected. See canary-ship-lib.mjs for
 * why the cursor stopped being a timestamp.
 */
function loadPending() {
  if (!existsSync(RUNS)) return { records: [], resume: { offset: 0, why: "no log yet" }, fingerprint: null, size: 0 };
  const fd = openSync(RUNS, "r");
  try {
    const size = statSync(RUNS).size;
    const head = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
    if (head.length) readSync(fd, head, 0, head.length, 0);
    const fingerprint = fingerprintOf(head);
    const resume = resumeOffset(readCursor(readCursorFile()), { size, fingerprint }, { all: ALL });
    const length = Math.max(0, size - resume.offset);
    const buf = Buffer.alloc(length);
    if (length) readSync(fd, buf, 0, length, resume.offset);
    const records = [];
    for (const { line, endOffset } of completeLines(buf, resume.offset)) {
      if (!line.trim()) continue;
      // One malformed line must not hide every finding behind it. A TORN line
      // is not this case — `completeLines` never returns one — so anything
      // that fails here is genuinely corrupt and skipping it is right.
      try {
        records.push({ record: JSON.parse(line), endOffset });
      } catch {
        console.error(`skipping an unparseable line at byte ${endOffset}`);
      }
    }
    return { records, resume, fingerprint, size };
  } finally {
    closeSync(fd);
  }
}

function readCursorFile() {
  try {
    return readFileSync(CURSOR, "utf8");
  } catch {
    return null;
  }
}

/**
 * Advance only over bytes the SERVER has acknowledged. A failure mid-backlog
 * leaves the cursor at the last acknowledged chunk and the next run resumes
 * there; the server de-duplicates on run_key, so a repeat costs nothing.
 *
 * `lastStartedAt` is still written, for a human reading the file and for the
 * old shape's sake. NOTHING READS IT — that is the bug this replaced.
 */
function saveCursor(offset, fingerprint, lastStartedAt) {
  try {
    writeFileSync(CURSOR, `${JSON.stringify({ offset, fingerprint, lastStartedAt }, null, 2)}\n`);
  } catch {
    /* the cursor is an optimisation; the server de-duplicates on run_key */
  }
}

/** Runs in the log that STARTED inside the reconciliation window. */
function localRunsWithin(records, hours, nowMs) {
  const since = nowMs - hours * 3_600_000;
  return records.filter((r) => (r.startedAt ?? 0) >= since).length;
}

/** What the server thinks it has over the same window. `null` if it will not say. */
async function shippedRunsWithin(hours) {
  try {
    const res = await fetch(`${BASE}/api/stats/canary?hours=${hours}`, {
      headers: { "x-admin-token": token() },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Number.isFinite(body?.runs) ? body.runs : null;
  } catch {
    return null;
  }
}

/**
 * The catastrophic countdown transitions, with the ONE fact the escalation
 * rule needs that the prose does not carry: how imminent the app said the bus
 * was immediately before the jump.
 *
 * Since 2026-09-04 a transition names its own bucket (`fromEtaSec`), because
 * pairing means a reading can produce a drift for EITHER of the two buses it
 * holds and slot 0 is no longer the answer. Records written before that lack
 * the field, so the old walk-back — to the previous readable countdown's
 * first slot — stays as the fallback for them.
 */
function jumpsOf(record) {
  const samples = Array.isArray(record.samples) ? record.samples : [];
  const readable = samples
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => s && s.present && s.eta && Array.isArray(s.eta.first));
  const out = [];
  for (const t of record.sequence?.transitions ?? []) {
    if (!t.catastrophic) continue;
    const at = readable.filter((r) => r.s.atMs <= t.atMs);
    const prev = at.length >= 2 ? at[at.length - 2].s : null;
    out.push({
      atMs: t.atMs,
      // No previous reading means no claim about imminence, and the server's
      // rule must not be able to fire on an absence.
      fromSec: Number.isFinite(t.fromEtaSec) ? Number(t.fromEtaSec)
        : prev ? Number(prev.eta.first[0]) : Number.MAX_SAFE_INTEGER,
      driftSec: t.driftSec,
      from: t.from,
      to: t.to,
      announced: !!t.pinAnnouncedChange,
    });
  }
  return out.slice(0, 8);
}

/** Everything that travels. Nothing here identifies a rider; it is all ours. */
function summarize(record) {
  return {
    runKey: `${record.startedAt}-${record.line}`,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    line: record.line,
    tripFrom: record.trip?.from ?? null,
    tripTo: record.trip?.to ?? null,
    ok: record.ok === true,
    arrived: record.arrived === true,
    watchedMin: record.watchedMin ?? null,
    readings: record.sequence?.readings ?? 0,
    reversals: record.sequence?.reversals ?? 0,
    catastrophic: record.sequence?.catastrophic ?? 0,
    worstDriftSec: record.sequence?.worstDriftSec ?? null,
    firstSightMissSec: record.firstSightMissSec ?? null,
    failures: (record.failures ?? []).slice(0, 8).map((f) => ({
      kind: String(f.kind ?? "unknown"),
      detail: String(f.detail ?? "").slice(0, 300),
    })),
    jumps: jumpsOf(record),
  };
}

// ── escalation ──────────────────────────────────────────────────────────────

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

/** The issue that stands for "this line is currently lying to riders". */
const issueTitle = (line) => `Canary: ${line} — a bus promised now, then not`;

function ghOpenIssue(line) {
  try {
    const out = gh([
      "issue", "list", "--repo", REPO, "--state", "open", "--label", "canary",
      "--search", issueTitle(line), "--json", "number,title", "--limit", "10",
    ]);
    const rows = JSON.parse(out);
    const hit = rows.find((r) => r.title === issueTitle(line));
    return hit ? hit.number : null;
  } catch {
    return null;
  }
}

function ghRaise(alert, body) {
  const existing = ghOpenIssue(alert.line);
  if (existing) {
    gh(["issue", "comment", String(existing), "--repo", REPO, "--body", body]);
    return `commented on #${existing}`;
  }
  // The label may not exist on a fresh clone of the repo; creating it is
  // idempotent and its failure must not swallow the finding.
  try {
    gh(["label", "create", "canary", "--repo", REPO, "--color", "eb6834",
      "--description", "Raised automatically by the rider canary"]);
  } catch {
    /* already there */
  }
  const url = gh([
    "issue", "create", "--repo", REPO, "--label", "canary",
    "--title", issueTitle(alert.line), "--body", body,
  ]).trim();
  return `opened ${url}`;
}

function ghResolve(resolution, body) {
  const existing = ghOpenIssue(resolution.line);
  if (!existing) return "nothing open";
  gh(["issue", "comment", String(existing), "--repo", REPO, "--body", body]);
  gh(["issue", "close", String(existing), "--repo", REPO]);
  return `closed #${existing}`;
}

async function webhook(title, body, priority) {
  const url = process.env.CANARY_ALERT_URL;
  if (!url) return "CANARY_ALERT_URL is not set";
  const res = await fetch(url, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: "bird" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return `${res.status}`;
}

/** What the operator reads. The sequence first: it is the actionable part. */
function alertBody(alert) {
  const when = new Date(alert.startedAt).toLocaleString("en-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
  });
  const lines = [
    alert.headline,
    "",
    `Line: **${alert.line}**`,
    `Run started: ${when} ET`,
    alert.tripFrom ? `Trip watched: ${alert.tripFrom} -> ${alert.tripTo}` : "",
    "",
    "What the countdown did:",
    "",
    "```",
    ...alert.jumps.map((j) =>
      `"${j.from}" -> "${j.to}"   ${j.driftSec > 0 ? "+" : ""}${(j.driftSec / 60).toFixed(1)} min beyond the clock` +
      (j.announced ? "   (the app announced a vehicle swap)" : "")),
    "```",
    "",
    alert.failedRunsSinceLastAlert
      ? `${alert.failedRunsSinceLastAlert} run(s) on this line have failed since the last time this was raised.`
      : "",
    "",
    `Full panel: ${BASE}/stats · full record: scripts/.canary/runs.jsonl on the Pi.`,
    "",
    "_Raised by scripts/canary-ship.mjs. This is not a rider report._",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

async function escalate(alerts, resolved) {
  if (CHANNEL === "none" || DRY) {
    for (const a of alerts) console.log(`[would alert] ${a.headline}`);
    for (const r of resolved) console.log(`[would close] ${r.line} recovered`);
    return;
  }
  for (const a of alerts) {
    const body = alertBody(a);
    try {
      const how = CHANNEL === "webhook"
        ? await webhook(`Canary: ${a.line}`, `${a.headline}\n\n${BASE}/stats`, "high")
        : ghRaise(a, body);
      console.log(`escalated ${a.line}: ${how}`);
    } catch (e) {
      // A channel that is down must not lose the finding: it is already on
      // /stats, and the next run on the same line re-raises after the cooldown.
      console.error(`could not escalate ${a.line}: ${e?.message ?? e}`);
    }
  }
  for (const r of resolved) {
    const body = `${r.line} has been clean for ${r.cleanRuns} consecutive canary runs. ` +
      `Closing automatically; a fresh finding opens a fresh issue.`;
    try {
      const how = CHANNEL === "webhook"
        ? await webhook(`Canary: ${r.line} recovered`, body, "low")
        : ghResolve(r, body);
      console.log(`resolved ${r.line}: ${how}`);
    } catch (e) {
      console.error(`could not close ${r.line}: ${e?.message ?? e}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

/** The window the reconciliation below argues over. A day of riding. */
const RECONCILE_HOURS = 24;

const pending = loadPending();
if (pending.resume.why) console.log(pending.resume.why);

if (DRY) {
  console.log(JSON.stringify({ runs: pending.records.map((p) => summarize(p.record)) }, null, 2));
  process.exit(0);
}

/**
 * The server accepts `CANARY_MAX_RUNS_PER_POST` (50) and used to SILENTLY
 * TRUNCATE a longer batch — `raw.slice(0, MAX)` in src/server/canary.ts —
 * returning 200 for the whole request. This script POSTed every pending run at
 * once and then advanced the cursor past all of them, so on 2026-09-08 a
 * backlog of 202 runs shipped 50 and threw the other 152 away, with no error
 * anywhere and the operator's dashboard quietly missing five days of riding.
 * The server now refuses an over-size batch outright; this sends chunks it
 * will accept whole, and advances the cursor only over BYTES the server has
 * acknowledged.
 */
const CHUNK = 50;
let stored = 0, duplicate = 0, rejected = 0, suppressed = 0;
const alerts = [], resolved = [];
for (let i = 0; i < pending.records.length; i += CHUNK) {
  const slice = pending.records.slice(i, i + CHUNK);
  const res = await fetch(`${BASE}/api/canary/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token() },
    body: JSON.stringify({ runs: slice.map((p) => summarize(p.record)) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // The cursor stands at the last acknowledged chunk: the next run re-ships
    // from there, and the server drops the duplicates on run_key.
    console.error(`ship failed after ${stored} stored: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const body = await res.json();
  stored += body.stored ?? 0;
  duplicate += body.duplicate ?? 0;
  rejected += body.rejected ?? 0;
  suppressed += body.suppressed ?? 0;
  alerts.push(...(body.alerts ?? []));
  resolved.push(...(body.resolved ?? []));
  const last = slice[slice.length - 1];
  saveCursor(last.endOffset, pending.fingerprint, last.record.startedAt ?? null);
}
if (pending.records.length === 0) {
  console.log(`nothing new in ${RUNS}`);
} else {
  console.log(
    `shipped ${pending.records.length} run(s) in ${Math.ceil(pending.records.length / CHUNK)} batch(es): ` +
    `${stored} stored, ${duplicate} already known, ${rejected} rejected, ${alerts.length} escalated, ${suppressed} held back`,
  );
}

await escalate(alerts, resolved);

/**
 * AND THEN CHECK ITS OWN WORK. Both shipper bugs were silent, and both were
 * caught by a person diffing the log against the dashboard days later. This
 * runs on EVERY invocation, including the ones with nothing to send — a cursor
 * that has skipped past evidence looks exactly like a quiet afternoon.
 */
const everything = existsSync(RUNS)
  ? readFileSync(RUNS, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean)
  : [];
const check = reconcile({
  localRuns: localRunsWithin(everything, RECONCILE_HOURS, Date.now()),
  shippedRuns: await shippedRunsWithin(RECONCILE_HOURS),
  windowHours: RECONCILE_HOURS,
});
console[check.ok ? "log" : "error"](check.message);
if (!check.ok) process.exit(1);
