import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COARSE_WATCH_OPTIONS,
  PERMISSION_DENIED,
  PRECISE_WATCH_OPTIONS,
  RESCUE_OPTIONS,
  WATCH_STALL_MS,
  startGeoWatch,
  watchOptions,
  type GeoLike,
} from "./geoWatch";

interface Registered {
  ok: (pos: GeolocationPosition) => void;
  err: ((e: GeolocationPositionError) => void) | null;
  opts: PositionOptions | undefined;
  id: number;
}

function fakeGeo() {
  const watches: Registered[] = [];
  const oneShots: Registered[] = [];
  const cleared: number[] = [];
  let nextId = 1;
  const geo: GeoLike = {
    watchPosition(ok, err, opts) {
      const id = nextId++;
      watches.push({ ok, err: err ?? null, opts, id });
      return id;
    },
    clearWatch(id) { cleared.push(id); },
    getCurrentPosition(ok, err, opts) {
      oneShots.push({ ok, err: err ?? null, opts, id: 0 });
    },
  };
  return { geo, watches, oneShots, cleared };
}

const fix = (lat = 41.31, lon = -72.92) =>
  ({ coords: { latitude: lat, longitude: lon } } as GeolocationPosition);

const failure = (code: number) => ({ code, message: "" } as GeolocationPositionError);

const TIMEOUT = 3;
const POSITION_UNAVAILABLE = 2;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchOptions", () => {
  // The tier policy itself is load-bearing (scripts/gps-tier-check.mjs asserts
  // the live watch is high-accuracy on the trip view) — pin it.
  it("keeps the live tier high-accuracy with a short cache", () => {
    expect(watchOptions(true)).toEqual(PRECISE_WATCH_OPTIONS);
    expect(PRECISE_WATCH_OPTIONS.enableHighAccuracy).toBe(true);
    expect(PRECISE_WATCH_OPTIONS.maximumAge).toBe(5_000);
  });

  it("keeps the idle tier coarse", () => {
    expect(watchOptions(false)).toEqual(COARSE_WATCH_OPTIONS);
    expect(COARSE_WATCH_OPTIONS.enableHighAccuracy).toBe(false);
  });

  // Report #65: the restarted watches (tier change, tab made visible again)
  // were registered WITHOUT a timeout, so a provider that never answered
  // produced no fix and no error, forever.
  it("gives every tier a timeout", () => {
    for (const precise of [true, false]) {
      const t = watchOptions(precise).timeout;
      expect(typeof t).toBe("number");
      expect(t as number).toBeGreaterThan(0);
    }
  });
});

describe("startGeoWatch", () => {
  it("reports fixes and settles on the first one", () => {
    const { geo, watches } = fakeGeo();
    const onFix = vi.fn();
    const onSettled = vi.fn();
    startGeoWatch(geo, { precise: true, onFix, onSettled });

    expect(watches).toHaveLength(1);
    expect(watches[0].opts).toEqual(PRECISE_WATCH_OPTIONS);

    watches[0].ok(fix());
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    watches[0].ok(fix(41.32, -72.93));
    expect(onFix).toHaveBeenCalledTimes(2);
  });

  it("settles on error so the Locating spinner always clears", () => {
    const { geo, watches } = fakeGeo();
    const onSettled = vi.fn();
    startGeoWatch(geo, { precise: false, onFix: vi.fn(), onSettled });

    watches[0].err?.(failure(TIMEOUT));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("retries once at network accuracy when the tier times out", () => {
    const { geo, watches, oneShots } = fakeGeo();
    const onFix = vi.fn();
    startGeoWatch(geo, { precise: true, onFix, onSettled: vi.fn() });

    watches[0].err?.(failure(TIMEOUT));
    expect(oneShots).toHaveLength(1);
    expect(oneShots[0].opts).toEqual(RESCUE_OPTIONS);

    oneShots[0].ok(fix());
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ coords: expect.anything() }));

    // A second failure must not start a retry storm.
    watches[0].err?.(failure(POSITION_UNAVAILABLE));
    expect(oneShots).toHaveLength(1);
  });

  // The Chromebook failure mode: the watch is registered and the browser then
  // says nothing at all — neither a position nor its own timeout error.
  it("rescues a watch that reports nothing at all", () => {
    const { geo, oneShots } = fakeGeo();
    const onFix = vi.fn();
    const onSettled = vi.fn();
    startGeoWatch(geo, { precise: true, onFix, onSettled });

    expect(oneShots).toHaveLength(0);
    vi.advanceTimersByTime(WATCH_STALL_MS - 1);
    expect(oneShots).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(oneShots).toHaveLength(1);

    oneShots[0].ok(fix());
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles even when the rescue fails too", () => {
    const { geo, watches, oneShots } = fakeGeo();
    const onSettled = vi.fn();
    startGeoWatch(geo, { precise: true, onFix: vi.fn(), onSettled });

    watches[0].err?.(failure(TIMEOUT));
    oneShots[0].err?.(failure(POSITION_UNAVAILABLE));
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("does not rescue a watch that is already working", () => {
    const { geo, watches, oneShots } = fakeGeo();
    startGeoWatch(geo, { precise: true, onFix: vi.fn(), onSettled: vi.fn() });

    watches[0].ok(fix());
    vi.advanceTimersByTime(WATCH_STALL_MS * 2);
    expect(oneShots).toHaveLength(0);
  });

  it("does not re-ask after the rider denied permission", () => {
    const { geo, watches, oneShots } = fakeGeo();
    const onSettled = vi.fn();
    startGeoWatch(geo, { precise: true, onFix: vi.fn(), onSettled });

    watches[0].err?.(failure(PERMISSION_DENIED));
    expect(onSettled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WATCH_STALL_MS * 2);
    expect(oneShots).toHaveLength(0);
  });

  it("stop() clears the watch and cancels the pending rescue", () => {
    const { geo, watches, oneShots, cleared } = fakeGeo();
    const onFix = vi.fn();
    const onSettled = vi.fn();
    const handle = startGeoWatch(geo, { precise: true, onFix, onSettled });

    handle.stop();
    expect(cleared).toEqual([watches[0].id]);

    vi.advanceTimersByTime(WATCH_STALL_MS * 2);
    expect(oneShots).toHaveLength(0);

    // A late callback from a watch we already abandoned must not move the dot.
    watches[0].ok(fix());
    watches[0].err?.(failure(TIMEOUT));
    expect(onFix).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("stop() is idempotent", () => {
    const { geo, cleared } = fakeGeo();
    const handle = startGeoWatch(geo, { precise: true, onFix: vi.fn() });
    handle.stop();
    handle.stop();
    expect(cleared).toHaveLength(1);
  });

  it("still settles and retries when registering the watch throws", () => {
    const { oneShots } = fakeGeo();
    const onSettled = vi.fn();
    const geo: GeoLike = {
      watchPosition() { throw new Error("nope"); },
      clearWatch() {},
      getCurrentPosition(ok, err, opts) { oneShots.push({ ok, err: err ?? null, opts, id: 0 }); },
    };
    const handle = startGeoWatch(geo, { precise: true, onFix: vi.fn(), onSettled });

    expect(handle.id).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(oneShots).toHaveLength(1);
  });
});
