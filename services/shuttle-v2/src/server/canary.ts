/**
 * The rider canary's findings, and the decision to wake somebody.
 *
 * `scripts/rider-canary.mjs` rides a line, watches the countdown the app shows
 * a rider, and records what it saw. It had been running for fourteen hours,
 * writing one JSON object per run to `scripts/.canary/runs.jsonl`, and NOTHING
 * READ THAT FILE. At 07:37 ET on 2026-09-04 it caught the exact defect the
 * operator was chasing —
 *
 *     Red  ok=false  eta-jump: "now, then 66 min" -> "in 7, 25 min" in 15 s
 *
 * — and the finding sat there until he hit the bug himself and asked whether
 * the canary was even watching. This module is the half that was missing: the
 * runs are shipped here, /stats renders them, and a narrow class of them is
 * pushed out of band.
 *
 * ── Why the escalation rule is NOT "the run failed" ──────────────────────────
 *
 * Measured against the first 43 runs (2026-09-03 17:21 -> 2026-09-04 07:55):
 *
 *     43 runs, 5 passed
 *     30 runs carried a "catastrophic" transition (|drift| >= 180 s)
 *
 * Escalating on the catastrophic class alone is therefore ~2 pushes an hour,
 * which is precisely the noise the operator switched a previous bot off for.
 * The class had to be narrower, and the narrowing had to be principled rather
 * than "raise the threshold until it goes quiet".
 *
 * What distinguishes the 07:37 finding from the ambient drift is IMMINENCE.
 * A Purple countdown wobbling +-10 min around a 45-minute estimate is a bad
 * estimate; a countdown that said "now" and then said "in 7 min" is a rider
 * standing at a stop watching their bus evaporate. Only the second is worth an
 * interruption, and it is exactly what `VANISHING_BUS` selects: a reading that
 * promised a bus within `IMMINENT_SEC` which then got `CATASTROPHIC_SEC`
 * later than the clock explains. Over the same 43 runs that fires on 11 of
 * them, across 8 lines — and after the per-line cooldown below, ~4 pushes in
 * fourteen hours.
 *
 * Deliberately NOT escalated (recorded and shown on /stats, never pushed):
 *   feed-error, page-error, page-unreadable, stuck-in-details, no-countdown,
 *   fatal      — the harness broke, not the app;
 *   no-arrival, option-vanished, line-missing, no-board-stop
 *              — real, but they are how a line at the end of service looks,
 *                and they are legible at a glance on the dashboard;
 *   first-sight-miss and non-imminent eta-jump
 *              — the estimate was poor. That is the standing ETA-accuracy
 *                work (docs/eta-accuracy.md), not an incident.
 */
import { sql } from "drizzle-orm";

import type { DbBundle } from "../db/client.js";
import { etDay, etDayStartMs } from "./actives.js";

// ── policy constants ────────────────────────────────────────────────────────

/** How long shipped runs are kept. A fortnight of continuous riding. */
export const CANARY_RETAIN_DAYS = 14;

/** Runs accepted in one POST. The shipper sends a backlog after an outage. */
export const CANARY_MAX_RUNS_PER_POST = 50;

/**
 * "The rider is about to act on this." A countdown at or under two minutes is
 * a rider standing at the kerb; one at twenty is a rider deciding whether to
 * leave the building.
 */
export const IMMINENT_SEC = 120;

/**
 * Drift beyond what the passage of time explains, in seconds. Same number the
 * canary's own `thresholds.catastrophicSec` uses — the two must agree or the
 * dashboard would call a finding catastrophic that this module ignores.
 */
export const CATASTROPHIC_SEC = 180;

/**
 * One push per line per six hours. A line that is broken all morning is one
 * interruption that says so, not twelve identical ones — the failure mode that
 * gets an alert channel muted.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * A hard ceiling across all lines per ET day, so a pathological canary (or a
 * genuinely burning app) cannot turn into a pager storm. Findings past the cap
 * are still stored and still shown on /stats; they simply do not push.
 */
export const ALERT_MAX_PER_DAY = 6;

/**
 * Consecutive clean runs on a line before its open alert closes itself. Two,
 * because one clean run is easy to get by watching a line that never produced
 * a countdown — and the canary's own `no-countdown` rule already refuses to
 * call that healthy.
 */
export const RECOVERY_RUNS = 2;

// ── input shape ─────────────────────────────────────────────────────────────

/** A named finding, as the canary phrases it for a human. */
export interface CanaryFailure {
  kind: string;
  detail: string;
}

/**
 * One catastrophic countdown transition, structured. `fromSec` is the low end
 * of the bucket the app showed BEFORE the jump — the escalation rule turns on
 * it, so it travels as a number rather than being re-extracted from prose.
 */
export interface CanaryJump {
  atMs: number;
  fromSec: number;
  driftSec: number;
  from: string;
  to: string;
  /** The app said it had swapped vehicles. An explained jump, not a silent one. */
  announced: boolean;
}

export interface CanaryRunInput {
  runKey: string;
  startedAt: number;
  startedAtEt?: string;
  endedAt?: number | null;
  line: string;
  tripFrom?: string | null;
  tripTo?: string | null;
  ok: boolean;
  arrived: boolean;
  watchedMin?: number | null;
  readings?: number;
  reversals?: number;
  catastrophic?: number;
  worstDriftSec?: number | null;
  firstSightMissSec?: number | null;
  failures?: CanaryFailure[];
  jumps?: CanaryJump[];
}

const MAX_FAILURES = 8;
const MAX_JUMPS = 8;
const MAX_DETAIL = 300;
const MAX_TEXT = 60;
const MAX_KEY = 80;

const str = (v: unknown, max: number): string =>
  (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max);

const int = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Validate and clamp one shipped run. Returns null for anything that cannot be
 * stored sensibly — a bad row is dropped, never allowed to poison the batch,
 * because the shipper is a cursor and a rejected batch would stall behind it.
 */
export function normalizeCanaryRun(raw: unknown): CanaryRunInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const startedAt = int(r.startedAt, 0);
  const line = str(r.line, MAX_TEXT);
  if (!startedAt || startedAt < 0 || !line) return null;
  const runKey = str(r.runKey, MAX_KEY) || `${startedAt}-${line}`;

  const failures: CanaryFailure[] = Array.isArray(r.failures)
    ? r.failures
        .slice(0, MAX_FAILURES)
        .map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          return { kind: str(o.kind, 40) || "unknown", detail: str(o.detail, MAX_DETAIL) };
        })
        .filter((f) => f.detail.length > 0 || f.kind !== "unknown")
    : [];

  const jumps: CanaryJump[] = Array.isArray(r.jumps)
    ? r.jumps
        .slice(0, MAX_JUMPS)
        .map((j) => {
          const o = (j ?? {}) as Record<string, unknown>;
          return {
            atMs: int(o.atMs, startedAt),
            fromSec: Math.max(0, int(o.fromSec, Number.MAX_SAFE_INTEGER)),
            driftSec: int(o.driftSec, 0),
            from: str(o.from, MAX_TEXT),
            to: str(o.to, MAX_TEXT),
            announced: o.announced === true,
          };
        })
    : [];

  return {
    runKey,
    startedAt,
    endedAt: numOrNull(r.endedAt),
    line,
    tripFrom: str(r.tripFrom, 120) || null,
    tripTo: str(r.tripTo, 120) || null,
    ok: r.ok === true,
    arrived: r.arrived === true,
    watchedMin: numOrNull(r.watchedMin),
    readings: Math.max(0, int(r.readings, 0)),
    reversals: Math.max(0, int(r.reversals, 0)),
    catastrophic: Math.max(0, int(r.catastrophic, 0)),
    worstDriftSec: numOrNull(r.worstDriftSec),
    firstSightMissSec: numOrNull(r.firstSightMissSec),
    failures,
    jumps,
  };
}

// ── the escalating class ────────────────────────────────────────────────────

/**
 * "The app said a bus was here, then said it was not." The one class of
 * finding that earns an interruption — see the header for the measurement that
 * ruled every other class out.
 */
export function vanishingBusJumps(jumps: readonly CanaryJump[]): CanaryJump[] {
  return jumps
    .filter((j) => j.fromSec <= IMMINENT_SEC && j.driftSec >= CATASTROPHIC_SEC)
    .sort((a, b) => b.driftSec - a.driftSec);
}

/**
 * One sentence, phrased for a phone notification: the sequence first, because
 * the sequence is what makes the finding actionable. The operator's own words
 * for the 07:37 finding were the sequence, not a count.
 */
export function alertHeadline(line: string, jump: CanaryJump): string {
  const min = (jump.driftSec / 60).toFixed(1);
  return `${line}: "${jump.from}" then "${jump.to}" — a bus promised within ` +
    `${Math.round(jump.fromSec / 60) || "<1"} min slipped ${min} min beyond the clock` +
    (jump.announced ? " (the app announced a vehicle swap)" : "");
}

// ── writing ─────────────────────────────────────────────────────────────────

export interface CanaryAlert {
  runId: number;
  line: string;
  startedAt: number;
  headline: string;
  /** Every qualifying jump in the run, worst first. */
  jumps: CanaryJump[];
  /** Failed runs on this line since the previous alert — "still broken". */
  failedRunsSinceLastAlert: number;
  tripFrom: string | null;
  tripTo: string | null;
}

export interface CanaryResolution {
  line: string;
  /** When the alert that is now closing was raised. */
  alertedAt: number;
  /** Clean runs that closed it. */
  cleanRuns: number;
}

export interface CanaryIngestResult {
  stored: number;
  duplicate: number;
  rejected: number;
  alerts: CanaryAlert[];
  resolved: CanaryResolution[];
  /** Qualifying findings held back by the cooldown or the daily cap. */
  suppressed: number;
}

/**
 * Store a batch of runs and decide which of them are worth an interruption.
 *
 * The policy lives HERE, not in the shipper: the server is the only place that
 * has the history a cooldown needs, it survives the shipper being restarted,
 * and a rule about waking someone up is a rule that should be unit-tested.
 */
export function recordCanaryRuns(
  bundle: DbBundle,
  raw: unknown,
  nowMs: number,
): CanaryIngestResult {
  const list = Array.isArray(raw) ? raw.slice(0, CANARY_MAX_RUNS_PER_POST) : [];
  const runs: CanaryRunInput[] = [];
  let rejected = 0;
  for (const item of list) {
    const run = normalizeCanaryRun(item);
    if (run) runs.push(run);
    else rejected++;
  }
  // Oldest first, so a backlog escalates in the order it happened and the
  // cooldown behaves the same whether runs arrive one at a time or in a heap.
  runs.sort((a, b) => a.startedAt - b.startedAt);

  const insert = bundle.sqlite.prepare(`
    INSERT OR IGNORE INTO canary_runs (
      run_key, started_at, ended_at, line, trip_from, trip_to, ok, arrived,
      watched_min, readings, reversals, catastrophic, worst_drift_sec,
      first_sight_miss_sec, failures_json, jumps_json, received_at
    ) VALUES (
      @runKey, @startedAt, @endedAt, @line, @tripFrom, @tripTo, @ok, @arrived,
      @watchedMin, @readings, @reversals, @catastrophic, @worstDriftSec,
      @firstSightMissSec, @failuresJson, @jumpsJson, @receivedAt
    )
  `);

  let stored = 0;
  let duplicate = 0;
  const fresh: Array<{ id: number; run: CanaryRunInput }> = [];
  for (const run of runs) {
    const info = insert.run({
      runKey: run.runKey,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      line: run.line,
      tripFrom: run.tripFrom ?? null,
      tripTo: run.tripTo ?? null,
      ok: run.ok ? 1 : 0,
      arrived: run.arrived ? 1 : 0,
      watchedMin: run.watchedMin ?? null,
      readings: run.readings ?? 0,
      reversals: run.reversals ?? 0,
      catastrophic: run.catastrophic ?? 0,
      worstDriftSec: run.worstDriftSec ?? null,
      firstSightMissSec: run.firstSightMissSec ?? null,
      failuresJson: JSON.stringify(run.failures ?? []),
      jumpsJson: JSON.stringify(run.jumps ?? []),
      receivedAt: nowMs,
    });
    if (info.changes === 1) {
      stored++;
      fresh.push({ id: Number(info.lastInsertRowid), run });
    } else {
      duplicate++;
    }
  }

  const alerts: CanaryAlert[] = [];
  let suppressed = 0;
  const markAlerted = bundle.sqlite.prepare(
    "UPDATE canary_runs SET alerted_at = ? WHERE id = ?",
  );
  const lastAlertFor = bundle.sqlite.prepare(
    "SELECT MAX(alerted_at) AS at FROM canary_runs WHERE line = ? AND alerted_at IS NOT NULL",
  );
  const alertsToday = bundle.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM canary_runs WHERE alerted_at >= ?",
  );
  const failedSince = bundle.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM canary_runs WHERE line = ? AND ok = 0 AND started_at > ?",
  );
  const dayStart = etDayStartMs(etDay(nowMs));

  for (const { id, run } of fresh) {
    const qualifying = vanishingBusJumps(run.jumps ?? []);
    if (qualifying.length === 0) continue;
    const last = (lastAlertFor.get(run.line) as { at: number | null }).at;
    if (last !== null && nowMs - last < ALERT_COOLDOWN_MS) {
      suppressed++;
      continue;
    }
    if ((alertsToday.get(dayStart) as { n: number }).n >= ALERT_MAX_PER_DAY) {
      suppressed++;
      continue;
    }
    markAlerted.run(nowMs, id);
    const worst = qualifying[0]!;
    alerts.push({
      runId: id,
      line: run.line,
      startedAt: run.startedAt,
      headline: alertHeadline(run.line, worst),
      jumps: qualifying,
      failedRunsSinceLastAlert: last === null
        ? 0
        : (failedSince.get(run.line, last) as { n: number }).n,
      tripFrom: run.tripFrom ?? null,
      tripTo: run.tripTo ?? null,
    });
  }

  const resolved = closeRecoveredAlerts(bundle, nowMs);
  sweepCanaryRuns(bundle, nowMs);
  return { stored, duplicate, rejected, alerts, resolved, suppressed };
}

/**
 * Close an open alert once its line has been clean `RECOVERY_RUNS` times in a
 * row. This is what keeps the alert channel from becoming a graveyard the
 * operator has to garden — which is the OTHER way an alert channel gets turned
 * off. Nothing here re-opens: a fresh finding raises a fresh alert.
 */
function closeRecoveredAlerts(bundle: DbBundle, nowMs: number): CanaryResolution[] {
  const open = bundle.sqlite.prepare(`
    SELECT line, MAX(alerted_at) AS at
      FROM canary_runs
     WHERE alerted_at IS NOT NULL AND resolved_at IS NULL
     GROUP BY line
  `).all() as Array<{ line: string; at: number }>;
  if (open.length === 0) return [];
  const recent = bundle.sqlite.prepare(
    "SELECT ok FROM canary_runs WHERE line = ? ORDER BY started_at DESC LIMIT ?",
  );
  const close = bundle.sqlite.prepare(
    "UPDATE canary_runs SET resolved_at = ? WHERE line = ? AND alerted_at IS NOT NULL AND resolved_at IS NULL",
  );
  const out: CanaryResolution[] = [];
  for (const row of open) {
    const rows = recent.all(row.line, RECOVERY_RUNS) as Array<{ ok: number }>;
    if (rows.length < RECOVERY_RUNS || rows.some((r) => r.ok !== 1)) continue;
    close.run(nowMs, row.line);
    out.push({ line: row.line, alertedAt: row.at, cleanRuns: RECOVERY_RUNS });
  }
  return out;
}

/**
 * Retention, on write. The table gains a handful of rows an hour, so there is
 * nothing to gain from a timer and one less thing that can be forgotten — the
 * same shape `searchTerms` uses. Guarded: a failed sweep must never fail the
 * POST that carried a finding.
 */
export function sweepCanaryRuns(bundle: DbBundle, nowMs: number): void {
  try {
    const cutoff = nowMs - CANARY_RETAIN_DAYS * 86_400_000;
    bundle.db.run(sql`DELETE FROM canary_runs WHERE started_at < ${cutoff}`);
  } catch {
    /* the sweep is housekeeping, never a reason to lose a finding */
  }
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface CanaryLineSummary {
  line: string;
  runs: number;
  passed: number;
  lastRunAt: number;
  lastOk: boolean;
  /** Whether that line currently has an alert nobody has seen close. */
  alerting: boolean;
}

export interface CanaryFinding {
  id: number;
  line: string;
  startedAt: number;
  watchedMin: number | null;
  failures: CanaryFailure[];
  /** Non-null when this finding was pushed out of band. */
  alertedAt: number | null;
  resolvedAt: number | null;
}

export interface CanaryReport {
  windowHours: number;
  runs: number;
  passed: number;
  lastRunAt: number | null;
  lines: CanaryLineSummary[];
  findings: CanaryFinding[];
  /** Alerts raised and not yet closed by a recovery — the loud state. */
  openAlerts: number;
}

const REPORT_MAX_FINDINGS = 12;
const REPORT_MAX_HOURS = CANARY_RETAIN_DAYS * 24;

/**
 * What /stats renders. Deliberately the same window for every number on the
 * panel: a "24 of 43 passed" over a list of findings from a different span is
 * the sort of quiet contradiction the "From riders" panel had to be fixed for.
 */
export function canaryReport(
  bundle: DbBundle,
  hours: number,
  nowMs: number,
): CanaryReport {
  const windowHours = Math.max(1, Math.min(REPORT_MAX_HOURS, Math.floor(hours) || 24));
  const since = nowMs - windowHours * 3_600_000;

  const lineRows = bundle.sqlite.prepare(`
    SELECT line,
           COUNT(*) AS runs,
           SUM(ok) AS passed,
           MAX(started_at) AS last_at
      FROM canary_runs
     WHERE started_at >= ?
     GROUP BY line
     ORDER BY last_at DESC
  `).all(since) as Array<{ line: string; runs: number; passed: number; last_at: number }>;

  const lastOkStmt = bundle.sqlite.prepare(
    "SELECT ok FROM canary_runs WHERE line = ? ORDER BY started_at DESC LIMIT 1",
  );
  const alertingStmt = bundle.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM canary_runs WHERE line = ? AND alerted_at IS NOT NULL AND resolved_at IS NULL",
  );

  const lines: CanaryLineSummary[] = lineRows.map((r) => ({
    line: r.line,
    runs: r.runs,
    passed: r.passed ?? 0,
    lastRunAt: r.last_at,
    lastOk: ((lastOkStmt.get(r.line) as { ok: number } | undefined)?.ok ?? 0) === 1,
    alerting: (alertingStmt.get(r.line) as { n: number }).n > 0,
  }));

  const findingRows = bundle.sqlite.prepare(`
    SELECT id, line, started_at, watched_min, failures_json, alerted_at, resolved_at
      FROM canary_runs
     WHERE started_at >= ? AND ok = 0
     ORDER BY started_at DESC
     LIMIT ?
  `).all(since, REPORT_MAX_FINDINGS) as Array<{
    id: number; line: string; started_at: number; watched_min: number | null;
    failures_json: string; alerted_at: number | null; resolved_at: number | null;
  }>;

  const totals = bundle.sqlite.prepare(
    "SELECT COUNT(*) AS runs, SUM(ok) AS passed, MAX(started_at) AS last_at FROM canary_runs WHERE started_at >= ?",
  ).get(since) as { runs: number; passed: number | null; last_at: number | null };

  const openAlerts = (bundle.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM canary_runs WHERE alerted_at IS NOT NULL AND resolved_at IS NULL",
  ).get() as { n: number }).n;

  return {
    windowHours,
    runs: totals.runs,
    passed: totals.passed ?? 0,
    lastRunAt: totals.last_at,
    lines,
    findings: findingRows.map((r) => ({
      id: r.id,
      line: r.line,
      startedAt: r.started_at,
      watchedMin: r.watched_min,
      failures: (() => {
        try {
          const v = JSON.parse(r.failures_json);
          return Array.isArray(v) ? (v as CanaryFailure[]) : [];
        } catch {
          return [];
        }
      })(),
      alertedAt: r.alerted_at,
      resolvedAt: r.resolved_at,
    })),
    openAlerts,
  };
}
