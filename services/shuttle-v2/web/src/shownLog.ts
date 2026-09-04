/**
 * Report what this browser actually put on screen.
 *
 * ── Why the browser has to be the one to say it ────────────────────────────
 *
 * The ETA is computed HERE, from the `/api/buses` payload, by this bundle. The
 * server can replay the arithmetic — that is what `scripts/eta-replay/` and
 * `rider-sim` do — but a replay runs whatever code is checked out, against
 * whatever it infers the client's state to have been. That inference has been
 * wrong expensively: a family of stability numbers turned out to have been
 * measured against a client that had not shipped in months, and a hotfix's
 * before/after got credited to the wrong PR because the harness could not see
 * the change it was measuring. `predictions_log` has existed the whole time
 * with zero rows.
 *
 * So the client posts, and every batch names its own bundle.
 *
 * ── What is sent, and what deliberately is not ─────────────────────────────
 *
 * One reading = (bus name, stop id, eta, low, high, stops ahead, how long ago).
 * That is a fact about a BUS. There is no id in the batch — not the anon id
 * the poll carries, not a session key, nothing — no coordinates, no origin, no
 * destination, and no timestamp (an AGE instead, so the server's clock decides
 * when the reading happened; see the note on the wire shape below). Two
 * batches from one browser cannot be recognised as such by anything in them.
 *
 * The readings come from `computeUpcomingArrivals`, which prices (bus → stop)
 * and knows nothing about where the rider is standing: the rider's position
 * enters the app one layer up, in the walk legs and `pickLiveArrival`'s
 * catchability rule. So a row cannot encode a location even indirectly — only
 * which stop was on some screen, and the server then deduplicates that down to
 * "at least one client somewhere had this on screen".
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 *
 * Nothing happens in the render path but a Map write per reading. Readings
 * accumulate in module scope, deduplicated by (bus, stop, 15 s bucket) exactly
 * as the server dedups, and a module-level timer posts the batch once a minute
 * — so a reporting browser makes one extra request a minute beside a poll it
 * makes every five seconds. Only a sampled share of page loads report at all,
 * and the server's reply carries the live sample rate, so the fleet can be
 * turned off without a deploy and without a request of its own.
 *
 * Every path here is guarded. A browser with no `fetch`, a blocked request, a
 * 429, a malformed reply: the app does not notice.
 */

import type { UpcomingArrival } from "./arrivals";

/** Server-side quantum; mirrored so the client dedups to the same buckets. */
export const SHOWN_BUCKET_MS = 15_000;

/** How often a batch goes out. Matches the server's flush cadence. */
export const SHOWN_POST_MS = 60_000;

/** Readings per batch. The server caps at the same number. */
export const SHOWN_MAX_BATCH = 200;

/**
 * Drop anything older than this rather than post it — the server refuses it
 * anyway, and a tab that was backgrounded for an hour should not wake up and
 * claim an hour-old countdown was on screen a moment ago.
 */
export const SHOWN_MAX_AGE_MS = 120_000;

/** Default share of page loads that report; the server's reply overrides it. */
export const DEFAULT_SHOWN_SAMPLE = 0.25;

/**
 * One reading, positional on the wire:
 * `[busName, stopId, etaSec, lowSec, highSec, stopsAhead, ageMs]`.
 *
 * Positional because this rides on a phone's radio; named keys would roughly
 * triple it and no human reads the payload. The last field is an AGE, not a
 * timestamp — a browser's clock can be wrong by minutes (or lying), and a row
 * whose instant is wrong cannot be paired with an arrival, which is the whole
 * point of the table.
 */
export type ShownTuple = [string, number, number, number, number, number, number];

interface Pending {
  busName: string;
  stopId: number;
  etaSec: number;
  lowSec: number;
  highSec: number;
  stopsAhead: number;
  /** Bucket start, epoch ms on THIS browser's clock — converted to an age on send. */
  at: number;
}

let sampleRate = DEFAULT_SHOWN_SAMPLE;
let sampled: boolean | null = null;
let pending = new Map<string, Pending>();
let timer: ReturnType<typeof setInterval> | null = null;
let installed = false;

/**
 * The bundle that is running, taken from its own filename
 * (`/assets/index-<hash>.js`). Nothing has to be plumbed through the build for
 * this: the hash changes whenever the bundle's content does, which is exactly
 * the identity the accuracy work needs and could never state before. It is the
 * same string for every browser on a deploy, so it names the CODE, not a
 * reader.
 */
export function clientBuild(): string {
  try {
    const url = typeof import.meta !== "undefined" ? String(import.meta.url ?? "") : "";
    const m = /index-([A-Za-z0-9_-]{4,24})\./.exec(url);
    return m ? m[1]! : "dev";
  } catch {
    return "dev";
  }
}

/** Test seam: forget the sampling decision, the batch and the timer. */
export function resetShownLog(): void {
  sampleRate = DEFAULT_SHOWN_SAMPLE;
  sampled = null;
  pending = new Map();
  installed = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Current sample rate, as last told by the server. Exposed for tests. */
export function shownSampleRate(): number {
  return sampleRate;
}

/** How many readings are waiting to be sent. Exposed for tests. */
export function pendingCount(): number {
  return pending.size;
}

/**
 * Decided ONCE per page load, not per reading: a browser either reports for
 * this visit or it does not. Deciding per reading would sample the readings
 * rather than the browsers, which is the same request cost for a strictly
 * worse sequence — half of a countdown is not a countdown.
 */
function isSampled(): boolean {
  if (sampleRate <= 0) return false;
  if (sampled === null) sampled = Math.random() < sampleRate;
  return sampled;
}

/**
 * Record what was just displayed. Called from the render path, so it must stay
 * O(readings) with no allocation beyond the Map entry and must never throw.
 *
 * Idempotent within a bucket, which also makes it safe under React's
 * double-invoked render in development: the same (bus, stop, bucket) collapses
 * to one entry, first write winning, exactly as the server's
 * `INSERT OR IGNORE` does.
 */
export function noteShown(arrivals: readonly UpcomingArrival[], now = Date.now()): void {
  try {
    if (arrivals.length === 0 || !isSampled()) return;
    install();
    const at = Math.floor(now / SHOWN_BUCKET_MS) * SHOWN_BUCKET_MS;
    for (const a of arrivals) {
      if (pending.size >= SHOWN_MAX_BATCH) return;
      if (!Number.isFinite(a.eta) || a.eta < 0) continue;
      const key = `${a.busName}:${a.stopId}:${at}`;
      if (pending.has(key)) continue;
      pending.set(key, {
        busName: a.busName,
        stopId: a.stopId,
        etaSec: Math.round(a.eta),
        lowSec: Math.round(Math.max(0, a.low)),
        highSec: Math.round(Math.max(0, a.high)),
        stopsAhead: a.stopsAhead,
        at,
      });
    }
  } catch {
    /* measurement must never be visible to a rider */
  }
}

/** The batch as it goes on the wire, oldest first. Exported for tests. */
export function drainBatch(now = Date.now()): ShownTuple[] {
  const out: ShownTuple[] = [];
  const rows = [...pending.values()].sort((a, b) => a.at - b.at);
  pending = new Map();
  for (const r of rows) {
    const ageMs = now - r.at;
    // Negative would mean the clock went backwards mid-batch; drop rather than
    // post a reading the server will reject anyway.
    if (ageMs < 0 || ageMs > SHOWN_MAX_AGE_MS) continue;
    out.push([r.busName, r.stopId, r.etaSec, r.lowSec, r.highSec, r.stopsAhead, ageMs]);
  }
  return out.slice(0, SHOWN_MAX_BATCH);
}

/**
 * Post whatever is pending. Safe to call at any time; a no-op when there is
 * nothing to send.
 */
export async function flushShown(now = Date.now()): Promise<void> {
  try {
    const p = drainBatch(now);
    if (p.length === 0) return;
    if (typeof fetch !== "function") return;
    const res = await fetch("/api/shown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Never send credentials or the anon id here: this endpoint is the one
      // place in the app that must not be able to associate a reading with a
      // browser. See the header comment.
      body: JSON.stringify({ b: clientBuild(), p }),
      keepalive: true,
    });
    if (!res.ok) return;
    const body = await res.json().catch(() => null);
    // The server's answer is the control channel: it can dial the fleet's
    // sample rate (including to zero) without a deploy and without a request
    // of its own.
    const next = (body as { sample?: unknown } | null)?.sample;
    if (typeof next === "number" && Number.isFinite(next) && next >= 0 && next <= 1) {
      sampleRate = next;
      if (next === 0) {
        sampled = false;
        pending = new Map();
      }
    }
  } catch {
    /* offline, blocked, aborted — the batch is simply gone */
  }
}

/**
 * Arm the timer, once, on the first reading of a sampled page load. Module
 * scope on purpose: nothing about this belongs in a React hook, where a
 * dependency array referencing a later `const` is a TDZ ReferenceError that
 * blank-screens the app.
 */
function install(): void {
  if (installed) return;
  installed = true;
  if (typeof setInterval === "function") {
    timer = setInterval(() => void flushShown(), SHOWN_POST_MS);
    // Never hold a test runner (or a Node import of this module) open.
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  // A rider who closes the tab mid-countdown is exactly the sequence worth
  // having, so send what is pending on the way out. `visibilitychange` rather
  // than `unload`: iOS Safari does not reliably fire the latter.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void flushShown();
    });
  }
}
