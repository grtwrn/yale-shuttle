import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import type { Collector } from "../collector/collector.js";
import type { DbBundle } from "../db/client.js";
import { planTrip } from "../planner/planner.js";
import { PlanRequestSchema } from "../schema/api.js";

import {
  listMyReports,
  listReports,
  followupImageFile,
  reportImageFile,
  rateLimitAllow,
  riderUpdateReport,
  submitReport,
  updateReport,
  type ReportListParams,
  type RiderAction,
} from "./reports.js";
import { createActivesTracker } from "./actives.js";
import { canaryReport, recordCanaryRuns } from "./canary.js";
import { operatorIds, outsideReports, seedOperatorIds } from "./outsideReports.js";
import { createSearchTermsTracker } from "./searchTerms.js";
import { buildLiveSnapshot } from "./snapshot.js";
import { createWeatherService, WEATHER_TTL_MS, type WeatherService } from "./weather.js";
import {
  buildAccuracyV1,
  createBusesPayloadCache,
  createExternalGeocoder,
  geocodeV1,
  type ExternalGeocoder,
} from "./v1compat.js";

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
// A report with a screenshot attached. 2 MB of image as base64 is ~2.7 MB of
// JSON; the client downscales before sending so a normal one is ~100-300 KB.
const REPORT_WITH_IMAGE_BODY_LIMIT = 3 * 1024 * 1024;
const REPORT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const PLAN_BODY_LIMIT = 16 * 1024;
// The triage-update body only ever carries a status and a short note, so it
// gets a far tighter cap than a rider's free-form report.
const REPORT_UPDATE_BODY_LIMIT = 8 * 1024;
// The stats-login body is one token and nothing else.
const STATS_SESSION_BODY_LIMIT = 2 * 1024;
// A shipped canary batch: up to 50 run SUMMARIES, ~1 KB each. The samples and
// page dumps that make a run 40 KB on disk never travel — see canary.ts.
const CANARY_BODY_LIMIT = 256 * 1024;
/** Default window for the /stats canary panel: a day of riding. */
const CANARY_DEFAULT_HOURS = 24;

// -- Operator stats session ---------------------------------------------------
// The dashboard at /stats needs to re-authenticate on every load without the
// operator's phone holding the admin token: a token in localStorage is one XSS
// (or one borrowed phone) away from full triage access, including reporter IPs.
// So the token is exchanged ONCE for a cookie that is (a) HttpOnly, so no
// script can read it back, (b) scoped to /api/stats, so it is never even sent
// to the report routes, and (c) STATELESS — "<expiryMs>.<hmac>" signed with
// the admin token itself, so the server stores no session table and a restart
// does not log the operator out.
const STATS_COOKIE = "stats_session";
const STATS_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Trend window bounds for /api/stats/history. 90 = the row retention. */
const HISTORY_MAX_DAYS = 90;
const HISTORY_DEFAULT_DAYS = 30;
// Longest text we persist for a rider's report body or an operator's
// resolution note. Matches ReportSubmitSchema's `body` cap in schema/api.ts.
const REPORT_TEXT_MAX = 2000;

/** Same shape the tracker accepts, so a typo can't silently insert junk. */
const ANON_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /**
   * Comma-separated anon ids that belong to the operator's own browsers, so
   * the dashboard's "someone wrote in" alert can ignore them. Defaults to
   * SHUTTLE_OPERATOR_ANON_IDS.
   */
  operatorAnonIds?: string;
  /**
   * First ET day the operator statistics count (see the counting epoch in
   * actives.ts). Tests that freeze the clock in the past set their own.
   */
  statsSinceDay?: string;
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
  /**
   * Cached rain forecast behind /api/weather. Injectable so tests never reach
   * the network; the default talks to Open-Meteo (see weather.ts).
   */
  weather?: WeatherService;
  /**
   * External half of /api/geocode (Photon, then Nominatim). Injectable so
   * tests never reach the network; the default is created in v1compat.ts.
   */
  geocoder?: ExternalGeocoder;
}

export function buildApp(opts: AppOptions): Hono {
  const now = opts.now ?? Date.now;
  const app = new Hono();
  // Unique-rider counting. Rides along on the poll the app already makes, so
  // there is no extra request; see actives.ts for the cost and privacy shape.
  const actives = createActivesTracker(
    opts.bundle,
    opts.statsSinceDay ? { sinceDay: opts.statsSinceDay } : {},
  );
  // Who the operator is, so "somebody wrote in" can mean somebody else. Tests
  // pass their own list; production reads the Fly secret.
  seedOperatorIds(opts.bundle, opts.operatorAnonIds ?? process.env.SHUTTLE_OPERATOR_ANON_IDS);
  // What riders type, so lookup is fixed with evidence rather than one rider
  // report at a time. Words only — see searchTerms.ts for why there is no id.
  const searchTerms = createSearchTermsTracker(opts.bundle);

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
    // Every rider polls this every 5 s, so it is the natural place to notice a
    // rider exists. `seen` is a Set hit after the first sighting of the day.
    actives.seen(c.req.header("x-anon-id"), "poll", now());
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

  // Tests that build the app without injecting a geocoder must not reach
  // photon.komoot.io / nominatim from CI or the Pi — that is how an egress IP
  // gets banned, silently, for good.
  const geocoder = opts.geocoder ??
    (process.env.VITEST ? { lookup: async () => [] } : createExternalGeocoder());

  app.get("/api/geocode", async (c) => {
    // Cap the query before it reaches the matcher: the prefix-match tier is
    // O(query tokens x candidate words) per candidate, so an unbounded ?q=
    // would block the single event loop for seconds.
    // A destination search is a deliberate action, unlike the automatic poll,
    // so it is the honest measure of "queries".
    const anonId = c.req.header("x-anon-id");
    actives.seen(anonId, "search", now());
    const q = (c.req.query("q") ?? "").slice(0, 100);
    const results = await geocodeV1(opts.collector.ref.get(), q, geocoder);
    // The words and whether they found anything — no id, no IP, no time of
    // day. A search that finds nothing is the only reliable signal that a
    // place is missing from the list.
    //
    // ...which is why our own harnesses must not be in it. `search_terms`
    // stores no anon id BY DESIGN, so unlike `daily_actives` it cannot filter
    // test traffic after the fact — the decision has to happen here, before
    // the write. On 2026-09-03 the loudest zero-result term in the whole log
    // was walk-fallback-check.mjs's hardcoded destination, 8 of 12 coordinate
    // searches; a list meant to prioritise work by RIDER evidence was topped
    // by a robot. This reuses the exclusion the harnesses already carry
    // (`TEST_ANON_ID`, seeded into `excluded_anon_ids` at startup), so a new
    // harness is covered the moment it calls `seedTestId` and nothing extra
    // is stored to make it work: the id is read from the header, compared in
    // memory, and dropped.
    if (!actives.isExcluded(anonId)) searchTerms.record(q, results.length, now());
    c.header("Cache-Control", "no-store");
    return c.json({ results });
  });

  // -- Weather (rain warning for the walk legs) -----------------------------
  // Proxied rather than called from the browser so Open-Meteo sees ONE request
  // per 10 minutes no matter how many riders are looking. Never fails: a bad
  // upstream answers `{available:false}` and the client simply shows no line.

  const weather = opts.weather ?? createWeatherService({ now });

  app.get("/api/weather", async (c) => {
    const data = await weather.get(now());
    // Riders share one forecast; let any intermediary hold it as long as we do.
    c.header("Cache-Control", `public, max-age=${Math.floor(WEATHER_TTL_MS / 1000)}`);
    return c.json(data);
  });

  // -- Reports --------------------------------------------------------------

  // Push-style hook for the triage bot: one long-lived admin SSE connection
  // (outbound from the Pi — the app can't reach into it) gets an event per
  // submitted report. Nothing rider-facing depends on this.
  const reportListeners = new Set<(id: number) => void>();
  const notifyReportListeners = (id: number) => {
    for (const fn of reportListeners) {
      try { fn(id); } catch { /* listener's problem */ }
    }
  };

  // Screenshots attached to reports live as files beside the DB, never inside
  // it — a 2 MB blob has no business in a row the triage list scans. The name
  // is random, the extension is decided by US from the verified magic bytes
  // (nothing user-supplied touches the filesystem path), and the file is only
  // readable back through the admin-token endpoint below.
  const imageDir = path.join(
    path.dirname(process.env.SHUTTLE_V2_DB ??
      path.join(process.env.SHUTTLE_V2_DB_DIR ?? "./store", "shuttle-v2.db")),
    "report-images",
  );
  const decodeReportImage = (v: unknown): { bytes: Buffer; ext: string } | null => {
    if (typeof v !== "string") return null;
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(v);
    if (!m) return null;
    const bytes = Buffer.from(m[2]!, "base64");
    if (bytes.length < 8 || bytes.length > REPORT_IMAGE_MAX_BYTES) return null;
    // Trust the magic bytes, not the label.
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { bytes, ext: "png" };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, ext: "jpg" };
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
        bytes.subarray(8, 12).toString("latin1") === "WEBP") return { bytes, ext: "webp" };
    return null;
  };


  // v1's frontend posts a free-form payload: { note?, source?, option?, ... }.
  // We stash the whole thing as context and return v1's { ok, id } shape.
  app.post("/api/report", bodyLimit({
    maxSize: REPORT_WITH_IMAGE_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const ip = clientIp(c) ?? "anon";
    // The reporter's anonymous browser id (same header the /api/buses poll
    // carries) lets /api/my-reports show them THEIR reports later. Optional:
    // a rider with storage disabled still gets their report through.
    const anonHeader = c.req.header("x-anon-id");
    const anonId = anonHeader && ANON_ID_PATTERN.test(anonHeader) ? anonHeader : null;
    // Budget per BROWSER when we can tell browsers apart, because campus
    // Wi-Fi puts a whole building behind one NAT address: 10 reports a
    // minute per IP was a per-building cap on the first school morning. The
    // IP still carries a looser flood guard so one box minting fresh ids
    // cannot outrun it.
    if (!rateLimitAllow(anonId ? `rep:${anonId}` : ip, now())) {
      return c.json({ error: "rate_limited" }, 429);
    }
    if (!rateLimitAllow(`repip:${ip}`, now(), { perMinute: 60, perDay: 1500 })) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request" }, 400);
    }
    let b = body as Record<string, unknown>;
    // ReportSubmitSchema caps `body` at 2000 chars but this handler
    // hand-parses instead of running it, so enforce the cap here.
    const note = typeof b.note === "string" ? b.note.trim().slice(0, REPORT_TEXT_MAX) : "";
    const kind: "issue" | "feedback" = b.source === "feedback" ? "feedback" : "issue";
    const routeId = typeof b.routeId === "number" ? b.routeId : null;
    // Rider-declared priority (operator/bot can re-triage later).
    const priority =
      b.priority === "urgent" || b.priority === "nice_to_have" || b.priority === "normal"
        ? b.priority
        : "normal";

    // Optional screenshot. The data URL is pulled OUT of the context stash
    // (2 MB of base64 in a DB row would make every triage query pay for it)
    // and written beside the DB; the context keeps only the filename. A bad
    // image never fails the report — the words still matter without it.
    let imageFile: string | undefined;
    const img = decodeReportImage(b.image);
    delete b.image;
    if (img) {
      try {
        fs.mkdirSync(imageDir, { recursive: true });
        imageFile = `${crypto.randomBytes(12).toString("hex")}.${img.ext}`;
        fs.writeFileSync(path.join(imageDir, imageFile), img.bytes);
      } catch {
        imageFile = undefined;
      }
    }
    // The body limit above is sized for the screenshot, which has just been
    // pulled out; what remains is stored verbatim in the row, so cap it at
    // the text-only limit — a legitimate context snapshot is ~2 KB, and
    // 3 MB × 200/day of it would fill the 1 GB volume in two days.
    if (JSON.stringify(b).length > REPORT_BODY_LIMIT) {
      b = { note, source: b.source, contextTruncated: true };
    }
    const { id } = submitReport(
      opts.bundle.db,
      { kind, routeId, body: note || "(report)", priority, context: imageFile ? { ...b, imageFile } : b },
      ip,
      anonId,
    );
    notifyReportListeners(id);
    return c.json({ ok: true, id, attached: Boolean(imageFile) });
  });

  // -- Rider self-service: their own reports --------------------------------
  // Public, but scoped by the anonymous browser id: you only ever see and
  // touch reports submitted with YOUR id. Ownership failures are 404, never
  // 403 — an id that belongs to someone else must look nonexistent. The
  // rider-facing shape is a strict allowlist (see listMyReports); client_ip
  // and the raw context snapshot never leave the server.

  const riderAnonId = (c: Context): string | null => {
    const v = c.req.header("x-anon-id");
    return v && ANON_ID_PATTERN.test(v) ? v : null;
  };

  app.get("/api/my-reports", (c) => {
    c.header("Cache-Control", "no-store");
    const anonId = riderAnonId(c);
    // No (valid) id means no reports can be theirs — an empty list, not an
    // error, so the frontend needs no special case.
    if (!anonId) return c.json({ reports: [] });
    // Separate bucket from report submission (a rider refreshing their list
    // must not eat their submit budget), looser per-minute for the UI. Keyed
    // by browser, not IP: the app fetches this once per load, and a campus
    // NAT address serves hundreds of loads a minute at 8 AM. The IP guard is
    // only there to bound a flood of invented ids from one machine.
    if (!rateLimitAllow(`my:${anonId}`, now(), { perMinute: 30, perDay: 2000 })) {
      return c.json({ error: "rate_limited" }, 429);
    }
    if (!rateLimitAllow(`myip:${clientIp(c) ?? "anon"}`, now(), { perMinute: 600, perDay: 50_000 })) {
      return c.json({ error: "rate_limited" }, 429);
    }
    return c.json({ reports: listMyReports(opts.bundle.db, anonId) });
  });

  // A follow-up may carry a screenshot, so this shares the report-submission
  // limit rather than the 8 KB triage-note one. The image is pulled out of the
  // body and written beside the DB exactly as a new report's is.
  app.post("/api/my-reports/:id/update", bodyLimit({
    maxSize: REPORT_WITH_IMAGE_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    // Looser than report submission on purpose: archiving a long history is
    // one tap per row, and a rider tidying 15 old reports in a minute is using
    // the feature, not abusing it (the bot's first find, from a screenshot of
    // exactly that failing at row 11).
    if (!rateLimitAllow(`myupd:${clientIp(c) ?? "anon"}`, now(), { perMinute: 40, perDay: 500 })) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as {
      action?: unknown;
      text?: unknown;
      priority?: unknown;
      image?: unknown;
    } | null;
    let action: RiderAction;
    if (body?.action === "resolve") {
      action = { action: "resolve" };
    } else if (body?.action === "archive" || body?.action === "unarchive") {
      action = { action: body.action };
    } else if (
      body?.action === "set_priority" &&
      (body.priority === "urgent" || body.priority === "normal" || body.priority === "nice_to_have")
    ) {
      action = { action: "set_priority", priority: body.priority };
    } else if (body?.action === "followup" && typeof body.text === "string" && body.text.trim()) {
      action = { action: "followup", text: body.text.trim().slice(0, REPORT_TEXT_MAX) };
      // An attached screenshot is written before the follow-up is recorded, so
      // a failed write simply means a message without a picture — the words
      // still matter, exactly as on a new report.
      const img = body.image === undefined ? null : decodeReportImage(body.image);
      if (img) {
        // A separate, tighter budget than the text-only actions above: a
        // chatty rider archiving rows is cheap, a rider posting 3 MB is not.
        if (!rateLimitAllow(`myimg:${clientIp(c) ?? "anon"}`, now(), { perMinute: 4, perDay: 40 })) {
          return c.json({ error: "rate_limited" }, 429);
        }
        try {
          fs.mkdirSync(imageDir, { recursive: true });
          const name = `${crypto.randomBytes(12).toString("hex")}.${img.ext}`;
          fs.writeFileSync(path.join(imageDir, name), img.bytes);
          action.imageFile = name;
        } catch {
          /* no screenshot; the follow-up still goes through */
        }
      }
    } else {
      return c.json({ error: "invalid_request" }, 400);
    }
    const anonId = riderAnonId(c);
    const id = Number(c.req.param("id"));
    // A missing id header or malformed id can't own anything; same 404 as a
    // wrong owner so existence is never confirmed.
    if (!anonId || !Number.isInteger(id)) return c.json({ error: "not_found" }, 404);
    const result = riderUpdateReport(opts.bundle.db, id, anonId, action, now());
    if ("error" in result) {
      if (result.error === "too_many_followups") {
        return c.json({ error: "too_many_followups" }, 400);
      }
      return c.json({ error: "not_found" }, 404);
    }
    // A follow-up is a rider continuing the conversation — wake the triage
    // bot for it just like a fresh submission. Resolve/archive/priority are
    // administrative and wake nothing.
    if (action.action === "followup") notifyReportListeners(id);
    return c.json({ ok: true, status: result.status });
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

  /**
   * Mint a stats-session cookie value. The signature covers the expiry stamp,
   * so a client cannot extend its own session by editing the number.
   */
  const statsMac = (stamp: string): string =>
    crypto.createHmac("sha256", adminToken).update(stamp).digest("hex");

  const mintStatsSession = (expiryMs: number): string => {
    const stamp = String(expiryMs);
    return `${stamp}.${statsMac(stamp)}`;
  };

  /** Verify a cookie value: well-formed, correctly signed, and unexpired. */
  const statsSessionValid = (value: string | undefined, nowMs: number): boolean => {
    if (!adminToken || !value) return false;
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const stamp = value.slice(0, dot);
    // Bound the parse before touching it: an unbounded digit string would
    // otherwise reach Number() and the HMAC.
    if (!/^[0-9]{1,15}$/.test(stamp)) return false;
    const expiryMs = Number(stamp);
    if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return false;
    // Sign the stamp exactly as it arrived, so a re-rendered number (leading
    // zeros, say) can never be compared against a different string than the
    // one that was actually signed.
    return safeEqual(value.slice(dot + 1), statsMac(stamp));
  };

  /**
   * Read-only usage numbers accept EITHER the admin header or the session
   * cookie. Every other admin route keeps requiring the header: the cookie
   * rides along on requests the browser makes and must never be able to
   * unlock /api/reports, which serves reporters' IP addresses.
   */
  const requireStatsAuth = async (c: Context, next: () => Promise<void>) => {
    if (!adminToken) {
      return c.json({ error: "admin_token_not_configured" }, 503);
    }
    const header = c.req.header("x-admin-token") ?? "";
    if (safeEqual(header, adminToken) || statsSessionValid(getCookie(c, STATS_COOKIE), now())) {
      await next();
      return;
    }
    return c.json({ error: "unauthorized" }, 401);
  };

  // Exchange the admin token for the cookie above. Rate-limited per IP so the
  // endpoint cannot be used as a brute-force oracle, and the failure body says
  // nothing about why.
  app.post("/api/stats/session", bodyLimit({
    maxSize: STATS_SESSION_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    if (!adminToken) {
      return c.json({ error: "admin_token_not_configured" }, 503);
    }
    const ip = clientIp(c) ?? "anon";
    if (!rateLimitAllow(`statslogin:${ip}`, now(), { perMinute: 10, perDay: 200 })) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const token = body && typeof body.token === "string" ? body.token : "";
    if (!safeEqual(token, adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const expiryMs = now() + STATS_SESSION_MAX_AGE_S * 1000;
    setCookie(c, STATS_COOKIE, mintStatsSession(expiryMs), {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/api/stats",
      maxAge: STATS_SESSION_MAX_AGE_S,
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });

  // Rider counts. Operator-only: an audience number is competitive information,
  // and there is no reason for it to be public just because it is anonymous.
  app.get("/api/stats", requireStatsAuth, (c) => {
    c.header("Cache-Control", "no-store");
    // `since` travels with the numbers so the dashboard can say what it is
    // counting from without hard-coding a date of its own.
    return c.json({ riders: actives.stats(now()), since: actives.sinceDay() });
  });

  // When the app is used, hour by hour, one row per day. Derived from spans
  // already stored — see actives.hourly().
  app.get("/api/stats/hourly", requireStatsAuth, (c) => {
    const raw = parseInt(c.req.query("days") ?? "", 10);
    c.header("Cache-Control", "no-store");
    return c.json({
      hourly: actives.hourly(
        Number.isFinite(raw) ? Math.max(1, Math.min(HISTORY_MAX_DAYS, raw)) : 7,
        now(),
      ),
    });
  });

  // What riders searched for, and what found nothing. Same auth as the rest
  // of /api/stats; the payload is words and counts, never a rider.
  app.get("/api/stats/searches", requireStatsAuth, (c) => {
    const days = parseInt(c.req.query("days") ?? "", 10);
    const limit = parseInt(c.req.query("limit") ?? "", 10);
    c.header("Cache-Control", "no-store");
    return c.json(searchTerms.report(
      Number.isFinite(days) ? days : 30,
      Number.isFinite(limit) ? limit : 25,
      now(),
    ));
  });

  // Reports from someone OTHER than the operator — the dashboard's alert.
  // Same auth as the rest of /api/stats, which means the cookie reaches it,
  // so the payload carries no IP, no anon id and no context: an excerpt, a
  // status and a timestamp. Anything identifying a reporter stays behind
  // requireAdmin on /api/reports.
  app.get("/api/stats/reports", requireStatsAuth, (c) => {
    const raw = parseInt(c.req.query("limit") ?? "", 10);
    c.header("Cache-Control", "no-store");
    // Same epoch the rider numbers count from, read off the tracker rather
    // than re-derived: the page prints "counting from Mon Aug 31" over this
    // very panel, so a pre-launch report here would contradict it.
    return c.json(outsideReports(
      opts.bundle,
      Number.isFinite(raw) ? raw : 20,
      { sinceDay: actives.sinceDay() },
    ));
  });

  // What the rider canary saw. Same auth as the rest of /api/stats — the
  // payload is entirely harness output (a route label, a countdown string, a
  // timestamp) and names no rider at all, so the cookie is safe here for the
  // same reason it is safe on the search terms.
  app.get("/api/stats/canary", requireStatsAuth, (c) => {
    const raw = parseInt(c.req.query("hours") ?? "", 10);
    c.header("Cache-Control", "no-store");
    return c.json(canaryReport(
      opts.bundle,
      Number.isFinite(raw) ? raw : CANARY_DEFAULT_HOURS,
      now(),
    ));
  });

  // Where the canary ships its runs from the Pi. ADMIN HEADER ONLY: this is a
  // write, and the stats cookie rides along on a browser's requests — it must
  // never be able to put words on the operator's own dashboard.
  //
  // The response tells the shipper which findings the server judged worth an
  // interruption, and which lines have recovered since. That decision lives on
  // the server because only the server has the history a cooldown needs, and
  // because a rule about waking somebody up should be unit-tested. See
  // canary.ts for the measurement that set the rule.
  app.post("/api/canary/runs", requireAdmin, bodyLimit({
    maxSize: CANARY_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { runs?: unknown } | null;
    if (!body || !Array.isArray(body.runs)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    c.header("Cache-Control", "no-store");
    return c.json(recordCanaryRuns(opts.bundle, body.runs, now()));
  });

  // Claim (or release) a browser as the operator's own, so its reports stop
  // reading as a stranger's. Admin header only: it changes what the alert
  // above will ever show.
  app.post("/api/stats/operator", requireAdmin, bodyLimit({
    maxSize: REPORT_UPDATE_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { anonId?: string; note?: string; remove?: boolean }
      | null;
    if (!body || typeof body.anonId !== "string" || !ANON_ID_PATTERN.test(body.anonId)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const db = opts.bundle.db;
    if (body.remove === true) {
      db.run(sql`DELETE FROM operator_anon_ids WHERE anon_id = ${body.anonId}`);
    } else {
      const note = (typeof body.note === "string" ? body.note : "operator browser").slice(0, 200);
      db.run(sql`INSERT OR IGNORE INTO operator_anon_ids (anon_id, note)
                 VALUES (${body.anonId}, ${note})`);
    }
    return c.json({ ok: true, operators: operatorIds(opts.bundle) });
  });

  // Per-day trend behind the dashboard chart. Days with no rows are absent
  // rather than zero — see actives.history().
  app.get("/api/stats/history", requireStatsAuth, (c) => {
    const raw = parseInt(c.req.query("days") ?? "", 10);
    const days = Number.isFinite(raw)
      ? Math.max(1, Math.min(HISTORY_MAX_DAYS, raw))
      : HISTORY_DEFAULT_DAYS;
    c.header("Cache-Control", "no-store");
    return c.json({ history: actives.history(days, now()) });
  });

  // Flag browsers as test traffic so they stop counting. Non-destructive: the
  // rows stay, the statistics ignore them. `all: true` sweeps every browser
  // seen so far, which is how a pre-launch database gets cleaned in one call.
  app.post("/api/stats/exclude", requireAdmin, bodyLimit({
    maxSize: REPORT_UPDATE_BODY_LIMIT,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { anonId?: string; all?: boolean; note?: string }
      | null;
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const note = (typeof body.note === "string" ? body.note : "manual").slice(0, 200);
    const db = opts.bundle.db;
    if (body.all === true) {
      db.run(sql`
        INSERT OR IGNORE INTO excluded_anon_ids (anon_id, note)
        SELECT DISTINCT anon_id, ${note} FROM daily_actives`);
    } else if (typeof body.anonId === "string" && ANON_ID_PATTERN.test(body.anonId)) {
      db.run(sql`
        INSERT OR IGNORE INTO excluded_anon_ids (anon_id, note)
        VALUES (${body.anonId}, ${note})`);
    } else {
      return c.json({ error: "invalid_request" }, 400);
    }
    const n = opts.bundle.sqlite
      .prepare("SELECT COUNT(*) AS n FROM excluded_anon_ids")
      .get() as { n: number };
    return c.json({ ok: true, excluded: n.n, riders: actives.stats(now()) });
  });

  app.get("/api/reports", requireAdmin, (c) => {
    const status = c.req.query("status") as ReportListParams["status"] | undefined;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const params: ReportListParams = {};
    if (status === "open" || status === "addressed" || status === "wontfix") {
      params.status = status;
    }
    const priority = c.req.query("priority");
    if (priority === "urgent" || priority === "normal" || priority === "nice_to_have") {
      params.priority = priority;
    }
    if (limit && Number.isFinite(limit)) params.limit = limit;
    return c.json({ reports: listReports(opts.bundle.db, params) });
  });

  // New-report event stream for the triage bot. Heartbeats every 25 s so
  // proxies don't reap the idle connection; the bot reconnects on drop.
  app.get("/api/reports/stream", requireAdmin, (c) => {
    return streamSSE(c, async (stream) => {
      let open = true;
      const listener = (id: number) => {
        void stream.writeSSE({ event: "report", data: String(id) });
      };
      reportListeners.add(listener);
      stream.onAbort(() => { open = false; reportListeners.delete(listener); });
      await stream.writeSSE({ event: "hello", data: "listening" });
      while (open) {
        await new Promise((r) => setTimeout(r, 25_000));
        if (!open) break;
        try { await stream.writeSSE({ event: "ping", data: String(Date.now()) }); }
        catch { break; }
      }
      reportListeners.delete(listener);
    });
  });

  // The screenshot attached to one report. Admin-only for the same reason the
  // list is: riders' screenshots can contain their location and plans. The
  // filename comes from the report's own context, never from the URL, so this
  // cannot be used to read arbitrary files.
  // The screenshot on one of a report's follow-ups, by index. Same admin gate
  // and same filename validation as the report's own image below.
  app.get("/api/reports/:id/followups/:index/image", requireAdmin, (c) => {
    const id = Number(c.req.param("id"));
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(id) || !Number.isInteger(index) || index < 0) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const name = followupImageFile(opts.bundle.db, id, index);
    if (!name || !/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name)) {
      return c.json({ error: "no_image" }, 404);
    }
    try {
      const bytes = fs.readFileSync(path.join(imageDir, name));
      const type = name.endsWith(".png") ? "image/png"
        : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      c.header("Content-Type", type);
      c.header("Cache-Control", "private, max-age=3600");
      return c.body(bytes);
    } catch {
      return c.json({ error: "no_image" }, 404);
    }
  });

  app.get("/api/reports/:id/image", requireAdmin, (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_request" }, 400);
    const name = reportImageFile(opts.bundle.db, id);
    if (!name || !/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name)) {
      return c.json({ error: "no_image" }, 404);
    }
    try {
      const bytes = fs.readFileSync(path.join(imageDir, name));
      const type = name.endsWith(".png") ? "image/png"
        : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      c.header("Content-Type", type);
      c.header("Cache-Control", "private, max-age=3600");
      return c.body(bytes);
    } catch {
      return c.json({ error: "no_image" }, 404);
    }
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
      anonId?: string;
      priority?: string;
    } | null;
    if (!body || (body.status !== "open" && body.status !== "addressed" && body.status !== "wontfix")) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const update: { status: "open" | "addressed" | "wontfix"; note?: string } = {
      status: body.status,
    };
    if (typeof body.note === "string") update.note = body.note.slice(0, REPORT_TEXT_MAX);
    const update2: typeof update & { anonId?: string; priority?: "urgent" | "normal" | "nice_to_have" } = update;
    if (typeof body.anonId === "string" && ANON_ID_PATTERN.test(body.anonId)) {
      update2.anonId = body.anonId;
    }
    if (body.priority === "urgent" || body.priority === "normal" || body.priority === "nice_to_have") {
      update2.priority = body.priority;
    }
    const ok = updateReport(opts.bundle.db, id, update2, now());
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

    // The operator dashboard is a standalone page in web/public, which Vite
    // copies verbatim; serveStatic already answers /stats.html, and this makes
    // the extensionless /stats work too. Registered before the SPA fallback so
    // it isn't swallowed by index.html. Deliberately unlinked from the rider app.
    // Both spellings answer identically — /stats.html would otherwise fall to
    // serveStatic with no Cache-Control at all and be heuristically cached,
    // so a bookmark to it could show yesterday's dashboard after a deploy.
    for (const route of ["/stats", "/stats.html"]) {
      app.get(route, async (c) => {
        const statsPath = path.join(opts.staticDir!, "stats.html");
        try {
          const html = await fs.promises.readFile(statsPath, "utf8");
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
