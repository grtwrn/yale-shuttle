import { and, desc, eq, sql } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { reports } from "../db/schema.js";
import type { ReportSubmit } from "../schema/api.js";

// Per-IP rate limits, matched to v1.
const PER_MINUTE = 10;
const PER_DAY = 200;

// In-memory rate-limit counters. Fly's single-machine deploy is fine with
// process-local state; a horizontally-scaled deploy would need Redis or
// equivalent, but that's not on the roadmap.
interface RateBucket {
  perMinuteStartMs: number;
  perMinuteCount: number;
  perDayStartMs: number;
  perDayCount: number;
}
const rateLimits = new Map<string, RateBucket>();

// Without this sweep, `rateLimits` grows one entry per unique IP forever — a
// slow memory leak on a long-lived process. Prune buckets untouched for >24h
// at most hourly so the sweep cost is amortized to ~nothing.
const SWEEP_INTERVAL_MS = 60 * 60_000;
const BUCKET_IDLE_MS = 24 * 60 * 60_000;
let lastSweepMs = 0;

function sweepRateLimits(now: number): void {
  if (now - lastSweepMs < SWEEP_INTERVAL_MS) return;
  lastSweepMs = now;
  for (const [ip, b] of rateLimits) {
    if (now - b.perDayStartMs > BUCKET_IDLE_MS) rateLimits.delete(ip);
  }
}

/**
 * Fixed-window rate limit. `key` is normally an IP, optionally prefixed
 * (`my:{ip}`) so different endpoint families get independent buckets — a
 * rider refreshing their report list must not eat their report-submission
 * budget. Callers must use consistent limits for a given key prefix.
 */
export function rateLimitAllow(
  key: string,
  now: number = Date.now(),
  limits: { perMinute?: number; perDay?: number } = {},
): boolean {
  const perMinute = limits.perMinute ?? PER_MINUTE;
  const perDay = limits.perDay ?? PER_DAY;
  sweepRateLimits(now);
  let bucket = rateLimits.get(key);
  if (!bucket) {
    bucket = {
      perMinuteStartMs: now,
      perMinuteCount: 0,
      perDayStartMs: now,
      perDayCount: 0,
    };
    rateLimits.set(key, bucket);
  }
  if (now - bucket.perMinuteStartMs > 60_000) {
    bucket.perMinuteStartMs = now;
    bucket.perMinuteCount = 0;
  }
  if (now - bucket.perDayStartMs > 86_400_000) {
    bucket.perDayStartMs = now;
    bucket.perDayCount = 0;
  }
  if (bucket.perMinuteCount >= perMinute || bucket.perDayCount >= perDay) {
    return false;
  }
  bucket.perMinuteCount += 1;
  bucket.perDayCount += 1;
  return true;
}

export function submitReport(
  db: DB,
  submission: ReportSubmit,
  clientIp: string | null,
  anonId: string | null = null,
): { id: number } {
  const row = db
    .insert(reports)
    .values({
      kind: submission.kind,
      routeId: submission.routeId,
      body: submission.body,
      context:
        submission.context !== undefined
          ? JSON.stringify(submission.context)
          : null,
      clientIp,
      anonId,
    })
    .returning({ id: reports.id })
    .get();
  return { id: row.id };
}

export interface ReportListParams {
  status?: "open" | "addressed" | "wontfix";
  priority?: "urgent" | "normal" | "nice_to_have";
  limit?: number;
}

export function listReports(db: DB, params: ReportListParams = {}) {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const clauses = [
    ...(params.status ? [eq(reports.status, params.status)] : []),
    ...(params.priority ? [eq(reports.priority, params.priority)] : []),
  ];
  return db
    .select()
    .from(reports)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(limit)
    .all();
}

export interface ReportUpdate {
  status: "open" | "addressed" | "wontfix";
  note?: string;
  anonId?: string;
  priority?: "urgent" | "normal" | "nice_to_have";
}

/** Returns true if the row existed and was updated, false otherwise. */
export function updateReport(db: DB, id: number, update: ReportUpdate): boolean {
  const result = db
    .update(reports)
    .set({
      status: update.status,
      ...(update.note !== undefined ? { note: update.note } : {}),
      // Ownership backfill: reports predating the anon_id column (2026-09-01)
      // can be linked to the submitting browser after the fact, so the rider's
      // Issues tab shows their history. Only ever fills a blank — an id a
      // browser stamped itself is never overwritten by hand.
      ...(update.priority !== undefined ? { priority: update.priority } : {}),
      ...(update.anonId !== undefined
        ? { anonId: sql`COALESCE(${reports.anonId}, ${update.anonId})` }
        : {}),
    })
    .where(eq(reports.id, id))
    .run();
  return result.changes > 0;
}

/** The stored screenshot filename for one report, if it has one. */
export function reportImageFile(db: DB, id: number): string | null {
  const row = db
    .select({ context: reports.context })
    .from(reports)
    .where(eq(reports.id, id))
    .get();
  if (!row?.context) return null;
  try {
    const ctx = JSON.parse(row.context) as { imageFile?: unknown };
    return typeof ctx.imageFile === "string" ? ctx.imageFile : null;
  } catch {
    return null;
  }
}

// -- Rider self-service -------------------------------------------------------
// A rider (identified by the same anonymous browser id daily_actives counts)
// can list the reports THEY submitted and act on them. Follow-ups live inside
// the report's `context` JSON under a `followups` array — the context column
// already stashes free-form submit-time state, so a second table would buy
// nothing. The rider-facing projection below is a strict allowlist: client_ip
// and the raw context snapshot never leave the server.

export interface ReportFollowup {
  text: string;
  at: number;
}

/** What GET /api/my-reports returns per report. Contract with the frontend. */
export interface MyReport {
  id: number;
  createdAt: number;
  kind: "issue" | "feedback";
  body: string;
  status: "open" | "addressed" | "wontfix";
  note: string | null;
  hasImage: boolean;
  archived: boolean;
  priority: "urgent" | "normal" | "nice_to_have";
  followups: ReportFollowup[];
}

const MY_REPORTS_LIMIT = 50;
// Bounds context-row growth from a chatty reporter; the operator can always
// read the whole thread, the rider just can't grow it forever.
const MAX_FOLLOWUPS = 50;
const RESOLVED_BY_REPORTER_TEXT = "Reporter marked this as resolved.";

function parseContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Only well-formed {text, at} entries survive; junk in context is dropped. */
function followupsOf(ctx: Record<string, unknown>): ReportFollowup[] {
  const raw = ctx.followups;
  if (!Array.isArray(raw)) return [];
  const out: ReportFollowup[] = [];
  for (const f of raw) {
    if (
      f &&
      typeof f === "object" &&
      typeof (f as { text?: unknown }).text === "string" &&
      typeof (f as { at?: unknown }).at === "number"
    ) {
      out.push({ text: (f as { text: string }).text, at: (f as { at: number }).at });
    }
  }
  return out;
}

export function listMyReports(db: DB, anonId: string): MyReport[] {
  const rows = db
    .select({
      id: reports.id,
      createdAt: reports.createdAt,
      kind: reports.kind,
      body: reports.body,
      status: reports.status,
      note: reports.note,
      priority: reports.priority,
      context: reports.context,
    })
    .from(reports)
    .where(eq(reports.anonId, anonId))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(MY_REPORTS_LIMIT)
    .all();
  return rows.map((r) => {
    const ctx = parseContext(r.context);
    return {
      id: r.id,
      createdAt: r.createdAt.getTime(),
      kind: r.kind,
      body: r.body,
      status: r.status,
      note: r.note,
      hasImage: typeof ctx.imageFile === "string",
      archived: ctx.riderArchived === true,
      priority: r.priority,
      followups: followupsOf(ctx),
    };
  });
}

export type RiderAction =
  | { action: "resolve" }
  | { action: "followup"; text: string }
  // Archive is the rider tidying their own list; it never touches the triage
  // status, and unarchive undoes it. Stored as context.riderArchived.
  | { action: "archive" }
  | { action: "unarchive" };

export type RiderUpdateResult =
  | { ok: true; status: "open" | "addressed" | "wontfix" }
  | { error: "not_found" | "too_many_followups" };

/**
 * A rider acting on their own report. Ownership is the WHERE clause: an id
 * that exists but belongs to someone else is indistinguishable from one that
 * does not exist (the caller should 404 either way, never 403).
 *
 * "resolve" marks it addressed and appends a marker follow-up — the
 * operator's `note` is their log and is never touched (append, don't
 * replace). "followup" appends the rider's text and, if the report had been
 * settled, flips it back to open: a follow-up means it is not settled for
 * them.
 */
export function riderUpdateReport(
  db: DB,
  id: number,
  anonId: string,
  action: RiderAction,
  now: number = Date.now(),
): RiderUpdateResult {
  const row = db
    .select({ status: reports.status, context: reports.context })
    .from(reports)
    .where(and(eq(reports.id, id), eq(reports.anonId, anonId)))
    .get();
  if (!row) return { error: "not_found" };
  const ctx = parseContext(row.context);
  const followups = followupsOf(ctx);

  if (action.action === "archive" || action.action === "unarchive") {
    ctx.riderArchived = action.action === "archive";
    db.update(reports)
      .set({ context: JSON.stringify(ctx) })
      .where(and(eq(reports.id, id), eq(reports.anonId, anonId)))
      .run();
    return { ok: true, status: row.status };
  }

  if (followups.length >= MAX_FOLLOWUPS) return { error: "too_many_followups" };
  let status: "open" | "addressed" | "wontfix";
  if (action.action === "resolve") {
    status = "addressed";
    followups.push({ text: RESOLVED_BY_REPORTER_TEXT, at: now });
  } else {
    // A follow-up means it is not settled for the reporter, whatever the
    // triage log said — an addressed/wontfix report reopens.
    status = "open";
    followups.push({ text: action.text, at: now });
  }
  ctx.followups = followups;
  db.update(reports)
    .set({ status, context: JSON.stringify(ctx) })
    .where(and(eq(reports.id, id), eq(reports.anonId, anonId)))
    .run();
  return { ok: true, status };
}
