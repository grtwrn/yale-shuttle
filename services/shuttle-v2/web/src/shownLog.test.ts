import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpcomingArrival } from "./arrivals";
import {
  DEFAULT_SHOWN_SAMPLE,
  drainBatch,
  flushShown,
  noteShown,
  pendingCount,
  resetShownLog,
  SHOWN_BUCKET_MS,
  SHOWN_MAX_AGE_MS,
  SHOWN_MAX_BATCH,
  shownSampleRate,
  type ShownTuple,
} from "./shownLog";

/**
 * Aligned to a 15 s bucket boundary, so "age" in these tests is the age of the
 * reading rather than the age of the bucket it fell into. (The wire always
 * carries the age of the BUCKET — that is what makes the server's re-floor land
 * back on the same instant.)
 */
const T = 1_700_000_010_000;

const arrival = (over: Partial<UpcomingArrival> = {}): UpcomingArrival => ({
  eta: 300,
  low: 240,
  high: 360,
  routeLabel: "Red",
  color: "#C62828",
  busName: "40",
  stopId: 48,
  stopsAhead: 3,
  ...over,
});

/** Report on every page load, so the sampling coin never decides a test. */
const alwaysSampled = () => vi.spyOn(Math, "random").mockReturnValue(0);

let posts: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  resetShownLog();
  posts = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posts.push({ url, init });
    return {
      ok: true,
      json: async () => ({ sample: 1 }),
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetShownLog();
});

describe("what leaves the browser", () => {
  it("sends the reading and nothing about the reader", async () => {
    alwaysSampled();
    noteShown([arrival()], T);
    await flushShown(T);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/shown");
    const body = JSON.parse(String(posts[0]!.init.body)) as { b: string; p: ShownTuple[] };
    expect(body.p).toEqual([["40", 48, 300, 240, 360, 3, 0]]);

    // The whole payload, stringified. Nothing that could name a browser, a
    // person or a place may appear in it — this is the client half of the
    // promise `predictions_log`'s column set keeps on the server.
    const raw = String(posts[0]!.init.body);
    for (const forbidden of ["anon", "lat", "lon", "origin", "dest", "session", "id="]) {
      expect(raw.toLowerCase()).not.toContain(forbidden);
    }
    // And no credentials or custom identity headers ride along.
    expect(posts[0]!.init.credentials).toBeUndefined();
    expect(JSON.stringify(posts[0]!.init.headers)).not.toContain("anon");
  });

  it("sends an AGE, never a timestamp — the server owns the clock", async () => {
    alwaysSampled();
    noteShown([arrival()], T);
    await flushShown(T + 20_000);
    const body = JSON.parse(String(posts[0]!.init.body)) as { p: ShownTuple[] };
    expect(body.p[0]![6]).toBe(20_000);
    // No absolute instant anywhere in the payload.
    expect(String(posts[0]!.init.body)).not.toContain(String(T));
  });

  it("names the bundle that produced the reading", async () => {
    alwaysSampled();
    noteShown([arrival()], T);
    await flushShown(T);
    const body = JSON.parse(String(posts[0]!.init.body)) as { b: string };
    // Under vitest the module is loaded from source, so there is no hash to
    // read; the point is that the field is always present and always a plain
    // token, never something a browser could be recognised by.
    expect(body.b).toMatch(/^[A-Za-z0-9_-]{1,24}$/);
  });
});

describe("dedup and batching", () => {
  it("collapses repeats within one 15 s bucket", () => {
    alwaysSampled();
    for (let i = 0; i < 20; i++) noteShown([arrival({ eta: 300 + i })], T + i * 100);
    expect(pendingCount()).toBe(1);
    expect(drainBatch(T)[0]![2]).toBe(300);
  });

  it("keeps one reading per bucket, so the sequence survives", () => {
    alwaysSampled();
    noteShown([arrival({ eta: 300 })], T);
    noteShown([arrival({ eta: 280 })], T + SHOWN_BUCKET_MS);
    noteShown([arrival({ eta: 260 })], T + 2 * SHOWN_BUCKET_MS);
    const batch = drainBatch(T + 2 * SHOWN_BUCKET_MS);
    expect(batch.map((r) => r[2])).toEqual([300, 280, 260]);
  });

  it("is idempotent under a double-invoked render", () => {
    alwaysSampled();
    const a = [arrival()];
    noteShown(a, T);
    noteShown(a, T); // React StrictMode renders twice in development.
    expect(pendingCount()).toBe(1);
  });

  it("drops a reading that has gone stale rather than posting a lie", () => {
    alwaysSampled();
    noteShown([arrival()], T);
    // A tab backgrounded for five minutes must not wake up and claim this was
    // on screen a moment ago.
    expect(drainBatch(T + SHOWN_MAX_AGE_MS + 1)).toHaveLength(0);
  });

  it("caps the batch", () => {
    alwaysSampled();
    const many = Array.from({ length: SHOWN_MAX_BATCH + 50 }, (_, i) =>
      arrival({ stopId: i, busName: `b${i}` }),
    );
    noteShown(many, T);
    expect(pendingCount()).toBeLessThanOrEqual(SHOWN_MAX_BATCH);
  });
});

describe("sampling and the control channel", () => {
  it("decides once per page load, not per reading", () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
    noteShown([arrival()], T);
    noteShown([arrival({ stopId: 49 })], T);
    noteShown([arrival({ stopId: 50 })], T);
    expect(pendingCount()).toBe(0);
    // One coin toss for the whole visit: half a countdown is not a countdown.
    expect(rnd).toHaveBeenCalledTimes(1);
  });

  it("starts at the documented default", () => {
    expect(shownSampleRate()).toBe(DEFAULT_SHOWN_SAMPLE);
  });

  it("takes the server's rate from the reply it already gets", async () => {
    alwaysSampled();
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ sample: 0 }) }) as unknown as Response);
    noteShown([arrival()], T);
    await flushShown(T);
    expect(shownSampleRate()).toBe(0);
    // ...and stops immediately, without another deploy or another request.
    noteShown([arrival({ stopId: 49 })], T);
    expect(pendingCount()).toBe(0);
  });
});

describe("it must never be visible to a rider", () => {
  it("survives a browser with no fetch", async () => {
    alwaysSampled();
    vi.stubGlobal("fetch", undefined);
    noteShown([arrival()], T);
    await expect(flushShown(T)).resolves.toBeUndefined();
  });

  it("survives a rejected or blocked request", async () => {
    alwaysSampled();
    vi.stubGlobal("fetch", async () => { throw new Error("blocked"); });
    noteShown([arrival()], T);
    await expect(flushShown(T)).resolves.toBeUndefined();
  });

  it("survives a 429 and a nonsense reply", async () => {
    alwaysSampled();
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => { throw new Error("nope"); } }) as unknown as Response);
    noteShown([arrival()], T);
    await expect(flushShown(T)).resolves.toBeUndefined();
    expect(shownSampleRate()).toBe(DEFAULT_SHOWN_SAMPLE);
  });

  it("ignores a garbage sample rate", async () => {
    alwaysSampled();
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ sample: "lots" }) }) as unknown as Response);
    noteShown([arrival()], T);
    await flushShown(T);
    expect(shownSampleRate()).toBe(DEFAULT_SHOWN_SAMPLE);
  });

  it("posts nothing when there is nothing to say", async () => {
    alwaysSampled();
    await flushShown(T);
    expect(posts).toHaveLength(0);
  });

  it("skips a nonsense arrival rather than throwing in the render path", () => {
    alwaysSampled();
    expect(() =>
      noteShown([arrival({ eta: Number.NaN }), arrival({ eta: -1 })], T),
    ).not.toThrow();
    expect(pendingCount()).toBe(0);
  });
});
