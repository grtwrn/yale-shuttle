import { serveStatic } from "@hono/node-server/serve-static";
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
import { buildAccuracyV1, buildBusesPayload, geocodeV1 } from "./v1compat.js";

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

  app.get("/api/buses", (c) => {
    const payload = buildBusesPayload(opts.collector);
    c.header("Cache-Control", "public, max-age=3, stale-while-revalidate=6");
    return c.json(payload);
  });

  // -- Server-Sent Events: push live snapshots ------------------------------

  app.get("/api/stream", (c) => {
    return streamSSE(c, async (stream) => {
      // Emit immediately so the client doesn't sit waiting on the first tick.
      await stream.writeSSE({
        data: JSON.stringify(buildLiveSnapshot(opts.collector)),
        event: "snapshot",
      });

      // ID is monotonic on serverTime so reconnects with Last-Event-ID work.
      // Hono's streamSSE handles the abort signal — when the client drops,
      // the loop's next write throws and we exit cleanly.
      while (!stream.aborted) {
        await stream.sleep(5_000);
        const snapshot = buildLiveSnapshot(opts.collector);
        await stream.writeSSE({
          data: JSON.stringify(snapshot),
          event: "snapshot",
          id: String(snapshot.serverTime),
        });
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

  app.get("/api/accuracy", (c) => {
    const data = buildAccuracyV1(opts.bundle, opts.collector.ref.get());
    c.header("Cache-Control", "public, max-age=60");
    return c.json(data);
  });

  // -- Geocode (v1 shape: {results:[{display_name,lat,lon,type,class}]}) ----

  app.get("/api/geocode", async (c) => {
    const q = c.req.query("q") ?? "";
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
    const note = typeof b.note === "string" ? b.note.trim() : "";
    const kind: "issue" | "feedback" = b.source === "feedback" ? "feedback" : "issue";
    const routeId = typeof b.routeId === "number" ? b.routeId : null;
    const { id } = submitReport(
      opts.bundle.db,
      { kind, routeId, body: note || "(report)", context: b },
      ip,
    );
    return c.json({ ok: true, id });
  });

  app.get("/api/reports", (c) => {
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

  app.post("/api/reports/:id/update", async (c) => {
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
    if (typeof body.note === "string") update.note = body.note;
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
    return c.json(
      {
        ok: healthy,
        pollStalenessMs,
        collectorLagMs: lagMs,
        knownBuses: buses.length,
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
