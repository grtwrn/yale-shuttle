import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import type { Collector } from "../collector/collector.js";
import type { DbBundle } from "../db/client.js";
import { planTrip } from "../planner/planner.js";
import { PlanRequestSchema } from "../schema/api.js";

import {
  listReports,
  rateLimitAllow,
  submitReport,
  updateReport,
  type ReportListParams,
} from "./reports.js";
import { buildLiveSnapshot } from "./snapshot.js";
import { buildAccuracyV1, createBusesPayloadCache, geocodeV1 } from "./v1compat.js";

/**
 * Build the HTTP app. Owns no state of its own — everything routes through
 * `collector` (live data) or `bundle.db` (durable). Stateless construction
 * means the app is trivially testable: `app.request("/api/buses")` just works.
 */
// Liveness threshold: the poll loop fires every 5s, so no attempt in 60s means
// it's wedged — /healthz fails so Fly restarts the machine.
const HEALTH_POLL_STALE_MS = 60_000;

// Cap request bodies so a malicious/oversized POST can't OOM the box or bloat
// the DB (report context is stored verbatim).
const REPORT_BODY_LIMIT = 64 * 1024;
const PLAN_BODY_LIMIT = 16 * 1024;
// The triage-update body only ever carries a status and a short note, so it
// gets a far tighter cap than a rider's free-form report.
const REPORT_UPDATE_BODY_LIMIT = 8 * 1024;
// Longest text we persist for a rider's report body or an operator's
// resolution note. Matches ReportSubmitSchema's `body` cap in schema/api.ts.
const REPORT_TEXT_MAX = 2000;

// -- /api/stream limits -------------------------------------------------------
// No rider client uses SSE today, but every open stream costs a full
// buildLiveSnapshot + polyline stringify every 5 s on the single event loop
// shared with the collector, so an accumulation of orphans is expensive.
// A mobile client behind a NAT that vanishes without FIN/RST never trips
// `stream.aborted`, so these three are what actually bound the damage.
const SSE_MAX_CLIENTS = 32;
const SSE_TICK_MS = 5_000;
// Recycle streams so a half-open connection can leak for minutes, not forever.
// Clients reconnect (with Last-Event-ID) on a clean close.
const SSE_MAX_LIFETIME_MS = 15 * 60_000;
// A comment line dispatches no event on the client but resets the idle timers
// of proxies and load balancers in between. Every 4th tick is ample.
const SSE_HEARTBEAT_EVERY_TICKS = 4;

/**
 * Constant-time string compare, so a token can't be recovered byte-by-byte by
 * timing the 401. Length is compared first (and leaks only the length).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface AppOptions {
  collector: Collector;
  bundle: DbBundle;
  /** Used by /healthz and a few other endpoints; injectable for tests. */
  now?: () => number;
  /**
   * Optional directory of pre-built frontend assets to serve. When set, the
   * app falls back to `index.html` for unknown GET paths (SPA routing).
   * Tests leave this unset to avoid filesystem dependencies.
   */
  staticDir?: string;
  /**
   * Shared secret guarding the operator-only triage endpoints. Defaults to
   * $SHUTTLE_ADMIN_TOKEN. When neither is set those endpoints fail closed
   * (503) rather than serving reporter IPs to the public — an unconfigured
   * deploy should be inert, not open.
   */
  adminToken?: string;
}

export function buildApp(opts: AppOptions): Hono {
  const now = opts.now ?? Date.now;
  const app = new Hono();

  // Catch-all so a thrown handler returns clean JSON instead of leaking a
  // stack trace (or, worse, a malformed response) to the client.
  app.onError((err, c) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "http.unhandled",
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "internal_error" }, 500);
  });

  // The API is deliberately public + read-mostly. CORS is permissive to allow
  // the static frontend (or a third-party tool) to call from anywhere.
  app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));

  // -- Live snapshot --------------------------------------------------------

  app.get("/api/live", (c) => {
    const snapshot = buildLiveSnapshot(opts.collector);
    // Short cache: matches the 5s upstream poll cadence so a thundering herd
    // doesn't pound SQLite, but stays fresh enough that the rider doesn't see
    // a stale bus position.
    c.header("Cache-Control", "public, max-age=3, stale-while-revalidate=6");
    return c.json(snapshot);
  });

  // -- v1-compatible fat snapshot (the v1 frontend's primary endpoint) ------
  // One response with live buses + topology + calibrated segment/dwell stats,
  // from which the v1 client does its own trip planning and ETA math. See
  // v1compat.ts for the shape and what degrades gracefully.

  // Built once per collector tick and shared by every concurrent request —
  // see createBusesPayloadCache for why the naive per-request build was the
  // most expensive thing this process did. Per-app instance so tests that
  // build several apps over one collector stay independent.
  const busesJson = createBusesPayloadCache(opts.collector);

  app.get("/api/buses", (c) => {
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=3, stale-while-revalidate=6");
    return c.body(busesJson());
  });

  // -- Server-Sent Events: push live snapshots ------------------------------

  let sseClients = 0;

  app.get("/api/stream", (c) => {
    // Shed past the cap rather than let orphaned streams multiply the per-tick
    // snapshot cost without bound.
    if (sseClients >= SSE_MAX_CLIENTS) {
      return c.json({ error: "too_many_streams" }, 503);
    }
    sseClients++;
    return streamSSE(c, async (stream) => {
      const deadline = Date.now() + SSE_MAX_LIFETIME_MS;
      let ticks = 0;
      // Give the slot back the instant the client goes away. `stream.sleep()`
      // is not abort-aware, so leaving this to the `finally` alone would hold
      // a slot for up to a full tick past every disconnect — enough to keep a
      // reconnecting client bouncing off the cap.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        sseClients--;
      };
      stream.onAbort(release);
      try {
        // Emit immediately so the client doesn't sit waiting on the first tick.
        await stream.writeSSE({
          data: JSON.stringify(buildLiveSnapshot(opts.collector)),
          event: "snapshot",
        });

        // ID is monotonic on serverTime so reconnects with Last-Event-ID work.
        //
        // `stream.aborted` is the ONLY disconnect signal available here: Hono's
        // StreamingApi.write wraps the writer in a bare `catch {}`, so a dead
        // peer never surfaces as a throw. (An earlier comment claimed "the
        // loop's next write throws and we exit cleanly" — it does not.) And
        // `aborted` is set from the response readable being cancelled, i.e. a
        // socket that actually closes: a half-open connection — mobile through
        // a NAT that vanishes without FIN/RST — never sets it, and the loop
        // would re-run buildLiveSnapshot + a full polyline stringify every 5 s
        // forever. The deadline is what bounds that.
        while (!stream.aborted && !stream.closed && Date.now() < deadline) {
          await stream.sleep(SSE_TICK_MS);
          if (stream.aborted || stream.closed) break;
          const snapshot = buildLiveSnapshot(opts.collector);
          await stream.writeSSE({
            data: JSON.stringify(snapshot),
            event: "snapshot",
            id: String(snapshot.serverTime),
          });
          if (++ticks % SSE_HEARTBEAT_EVERY_TICKS === 0) {
            await stream.write(": keep-alive\n\n");
          }
        }
      } finally {
        // Returning from here is what ends the stream: hono's streamSSE closes
        // it in its own `finally`, so on deadline expiry the client sees a
        // clean EOF and reconnects rather than a socket that quietly stops
        // producing. Don't close it here — that would pre-empt hono's error
        // path, which still wants to emit an `error` event first.
        release();
      }
    });
  });

  // -- Trip planning --------------------------------------------------------

  app.post("/api/plan", bodyLimit({
    maxSize: PLAN_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PlanRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const response = planTrip({
      network: opts.collector.ref.get(),
      buses: opts.collector.getLiveBuses(),
      from: parsed.data.from,
      to: parsed.data.to,
      now: parsed.data.departAt ?? now(),
    });
    return c.json(response);
  });

  // -- Accuracy -------------------------------------------------------------

  // Always answers `{overall:null,buckets:[],stops:[]}` today: nothing writes
  // predictions_log, so there is nothing to score. Kept because the frontend
  // polls it every 2 min per rider; buildAccuracyV1 short-circuits before
  // touching SQLite. See the block comment above it before wiring up logging.
  app.get("/api/accuracy", (c) => {
    const data = buildAccuracyV1(opts.bundle, opts.collector.ref.get());
    c.header("Cache-Control", "public, max-age=60");
    return c.json(data);
  });

  // -- Geocode (v1 shape: {results:[{display_name,lat,lon,type,class}]}) ----

  app.get("/api/geocode", async (c) => {
    // Cap the query before it reaches the matcher: the prefix-match tier is
    // O(query tokens x candidate words) per candidate, so an unbounded ?q=
    // would block the single event loop for seconds.
    const q = (c.req.query("q") ?? "").slice(0, 100);
    const results = await geocodeV1(opts.collector.ref.get(), q);
    c.header("Cache-Control", "no-store");
    return c.json({ results });
  });

  // -- Reports --------------------------------------------------------------

  // v1's frontend posts a free-form payload: { note?, source?, option?, ... }.
  // We stash the whole thing as context and return v1's { ok, id } shape.
  app.post("/api/report", bodyLimit({
    maxSize: REPORT_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const ip = clientIp(c) ?? "anon";
    if (!rateLimitAllow(ip, now())) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const b = body as Record<string, unknown>;
    // ReportSubmitSchema caps `body` at 2000 chars but this handler
    // hand-parses instead of running it, so enforce the cap here.
    const note = typeof b.note === "string" ? b.note.trim().slice(0, REPORT_TEXT_MAX) : "";
    const kind: "issue" | "feedback" = b.source === "feedback" ? "feedback" : "issue";
    const routeId = typeof b.routeId === "number" ? b.routeId : null;
    const { id } = submitReport(
      opts.bundle.db,
      { kind, routeId, body: note || "(report)", context: b },
      ip,
    );
    return c.json({ ok: true, id });
  });

  // -- Operator triage (not public) -----------------------------------------
  // These two are the only endpoints no rider client touches: they exist for
  // curl-based triage (and the map-bot's dedupe check). Left open they served
  // every reporter's IP address, user agent and free-text complaint to anyone
  // on the internet, and let anyone rewrite the triage log. Both now require
  // a shared secret.
  const adminToken = opts.adminToken ?? process.env.SHUTTLE_ADMIN_TOKEN ?? "";
  const requireAdmin = async (c: Context, next: () => Promise<void>) => {
    if (!adminToken) {
      return c.json({ error: "admin_token_not_configured" }, 503);
    }
    if (!safeEqual(c.req.header("x-admin-token") ?? "", adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  app.get("/api/reports", requireAdmin, (c) => {
    const status = c.req.query("status") as ReportListParams["status"] | undefined;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const params: ReportListParams = {};
    if (status === "open" || status === "addressed" || status === "wontfix") {
      params.status = status;
    }
    if (limit && Number.isFinite(limit)) params.limit = limit;
    return c.json({ reports: listReports(opts.bundle.db, params) });
  });

  app.post("/api/reports/:id/update", requireAdmin, bodyLimit({
    maxSize: REPORT_UPDATE_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid_id" }, 400);
    const body = (await c.req.json().catch(() => null)) as {
      status?: string;
      note?: string;
    } | null;
    if (!body || (body.status !== "open" && body.status !== "addressed" && body.status !== "wontfix")) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const update: { status: "open" | "addressed" | "wontfix"; note?: string } = {
      status: body.status,
    };
    if (typeof body.note === "string") update.note = body.note.slice(0, REPORT_TEXT_MAX);
    const ok = updateReport(opts.bundle.db, id, update);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // -- Static frontend ------------------------------------------------------
  // Mounted before /healthz so the SPA shell catches any non-API GET.
  if (opts.staticDir) {
    // Serve index.html with no-store so browsers always re-fetch it.
    // Without this, a cached index.html pointing to a prior build's hashed
    // JS bundle causes a blank page after every deploy.
    for (const path_ of ["/", "/index.html"]) {
      app.get(path_, async (c) => {
        const indexPath = path.join(opts.staticDir!, "index.html");
        try {
          const html = await fs.promises.readFile(indexPath, "utf8");
          c.header("Cache-Control", "no-store");
          return c.html(html);
        } catch {
          return c.notFound();
        }
      });
    }

    app.use(
      "/*",
      serveStatic({
        root: path.relative(process.cwd(), opts.staticDir) || ".",
      }),
    );
    app.get("/*", async (c, next) => {
      // SPA fallback: serve index.html for any GET that didn't match a file
      // and isn't an API route.
      if (c.req.path.startsWith("/api/") || c.req.path === "/healthz") return next();
      const indexPath = path.join(opts.staticDir!, "index.html");
      try {
        const html = await fs.promises.readFile(indexPath, "utf8");
        c.header("Cache-Control", "no-store");
        return c.html(html);
      } catch {
        return next();
      }
    });
  }

  // -- Health ---------------------------------------------------------------

  app.get("/healthz", (c) => {
    const buses = opts.collector.getLiveBuses();
    const newest = buses.reduce((a, b) => Math.max(a, b.collectedAt), 0);
    const lagMs = newest > 0 ? now() - newest : null;
    // Liveness, not data-freshness: the poll loop fires every 5s independent of
    // service hours, so a stale *attempt* means the loop is wedged. Fail the
    // check in that case so Fly restarts; a mere upstream outage (no buses to
    // report) keeps us healthy.
    const pollStalenessMs = opts.collector.pollStalenessMs();
    const healthy = pollStalenessMs <= HEALTH_POLL_STALE_MS;
    // Surfaced because nothing else reveals them: `pollSkipped` rising is the
    // only outward sign that upstream latency has crossed the 5 s poll interval
    // and ticks are being dropped to avoid overlapping writes, and
    // `droppedObservations` counts malformed buses filtered out of a payload.
    // Both stay flat in normal operation, so any non-zero value is a signal.
    const poll = opts.collector.pollStats();
    return c.json(
      {
        ok: healthy,
        pollStalenessMs,
        collectorLagMs: lagMs,
        knownBuses: buses.length,
        pollSkipped: poll.skipped,
        droppedObservations: poll.droppedObservations,
      },
      healthy ? 200 : 503,
    );
  });

  return app;
}

/**
 * Best-effort client IP extraction. Fly.io adds Fly-Client-IP; behind a
 * generic proxy we fall back to X-Forwarded-For (first hop).
 */
function clientIp(c: Context): string | null {
  const fly = c.req.header("fly-client-ip");
  if (fly) return fly;
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return null;
}
