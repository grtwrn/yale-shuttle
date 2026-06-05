import { and, desc, eq } from "drizzle-orm";

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

export function rateLimitAllow(ip: string, now: number = Date.now()): boolean {
  sweepRateLimits(now);
  let bucket = rateLimits.get(ip);
  if (!bucket) {
    bucket = {
      perMinuteStartMs: now,
      perMinuteCount: 0,
      perDayStartMs: now,
      perDayCount: 0,
    };
    rateLimits.set(ip, bucket);
  }
  if (now - bucket.perMinuteStartMs > 60_000) {
    bucket.perMinuteStartMs = now;
    bucket.perMinuteCount = 0;
  }
  if (now - bucket.perDayStartMs > 86_400_000) {
    bucket.perDayStartMs = now;
    bucket.perDayCount = 0;
  }
  if (bucket.perMinuteCount >= PER_MINUTE || bucket.perDayCount >= PER_DAY) {
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
    })
    .returning({ id: reports.id })
    .get();
  return { id: row.id };
}

export interface ReportListParams {
  status?: "open" | "addressed" | "wontfix";
  limit?: number;
}

export function listReports(db: DB, params: ReportListParams = {}) {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const where = params.status ? eq(reports.status, params.status) : undefined;
  return db
    .select()
    .from(reports)
    .where(where ? and(where) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(limit)
    .all();
}

export interface ReportUpdate {
  status: "open" | "addressed" | "wontfix";
  note?: string;
}

/** Returns true if the row existed and was updated, false otherwise. */
export function updateReport(db: DB, id: number, update: ReportUpdate): boolean {
  const result = db
    .update(reports)
    .set({
      status: update.status,
      ...(update.note !== undefined ? { note: update.note } : {}),
    })
    .where(eq(reports.id, id))
    .run();
  return result.changes > 0;
}
