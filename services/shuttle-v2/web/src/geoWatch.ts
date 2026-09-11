// The single place a geolocation watch is registered.
//
// Report #54 (Chromebook, "location request timed out even though it worked
// before") was fixed by hardening the watch the app starts AT MOUNT: give it a
// timeout, always clear the "Locating…" state when it fails, and retry once at
// network accuracy — a device with no GPS radio resolves through the network
// provider and routinely blows a cold high-accuracy budget.
//
// But the app restarts its watch twice more during a session: when the
// accuracy tier changes (the battery saver, on leaving/entering the passive
// all-routes list) and when a backgrounded tab becomes visible again. Neither
// restart carried any of that hardening — no timeout, and an error callback
// that did nothing at all. So a session long enough to hit one of those
// restarts silently dropped back onto the pre-#54 code path, which is exactly
// report #65: "still stalls on getting your location ... if I've left the app
// open for a while".
//
// Every registration now goes through startGeoWatch, so the hardening cannot
// apply to one code path and not the others.

export interface GeoLike {
  watchPosition(
    success: (pos: GeolocationPosition) => void,
    error?: ((err: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
  getCurrentPosition(
    success: (pos: GeolocationPosition) => void,
    error?: ((err: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): void;
}

/** `GeolocationPositionError.PERMISSION_DENIED` — spelled out because the
 *  error reaching us in tests is a plain object, not a DOM instance. */
export const PERMISSION_DENIED = 1;

/**
 * Live tracking tier: a trip in progress, or a rider walking to their stop.
 * Unchanged from what scripts/gps-tier-check.mjs asserts (high accuracy, 5 s
 * cache) — the only addition is the timeout.
 */
export const PRECISE_WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5_000,
  timeout: 15_000,
};

/** Battery-saver tier: the passive all-routes list, where no dot is drawn. */
export const COARSE_WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 60_000,
  timeout: 20_000,
};

/**
 * The one-shot fallback. Network accuracy, a long budget and a willingness to
 * take a two-minute-old fix: a rough position beats a permanent spinner when
 * you are choosing a boarding stop.
 */
export const RESCUE_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 20_000,
  maximumAge: 120_000,
};

/**
 * How long to wait for a watch that reports NOTHING — no fix, no error.
 * Longer than either tier's own timeout, so this only fires when the browser
 * has broken its own contract (which is the observed Chromebook failure: the
 * network provider wedges and the callback never comes).
 */
export const WATCH_STALL_MS = 25_000;

export function watchOptions(precise: boolean): PositionOptions {
  return precise ? PRECISE_WATCH_OPTIONS : COARSE_WATCH_OPTIONS;
}

export interface GeoWatchHandle {
  /** The browser's watch id, for debugging; null if registration threw. */
  readonly id: number | null;
  stop(): void;
}

export interface GeoWatchCallbacks {
  precise: boolean;
  /** A position arrived (first fix or a later update). */
  onFix: (pos: GeolocationPosition) => void;
  /**
   * Called once the watch has resolved one way or the other — a fix, an error,
   * or a failed rescue. The caller uses it to clear "Locating…", so it must
   * fire on EVERY terminal path or the spinner runs forever (#54, #65).
   */
  onSettled?: () => void;
  stallMs?: number;
}

/**
 * Register a position watch that always resolves: it times out, it retries
 * once at network accuracy, and it tells the caller when to stop showing
 * "Locating…" — whatever the outcome.
 */
export function startGeoWatch(geo: GeoLike, cb: GeoWatchCallbacks): GeoWatchHandle {
  const { precise, onFix, onSettled, stallMs = WATCH_STALL_MS } = cb;
  let stopped = false;
  let gotFix = false;
  let rescued = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const settle = () => {
    cancelStallTimer();
    onSettled?.();
  };

  const accept = (pos: GeolocationPosition) => {
    if (stopped) return;
    gotFix = true;
    settle();
    onFix(pos);
  };

  // At most one rescue per watch: a wedged provider stays wedged, and a
  // retry storm is how you flatten a phone battery.
  const rescue = () => {
    if (stopped || gotFix || rescued) return;
    rescued = true;
    geo.getCurrentPosition(accept, () => { if (!stopped) settle(); }, RESCUE_OPTIONS);
  };

  let id: number | null = null;
  try {
    id = geo.watchPosition(
      accept,
      (err) => {
        if (stopped) return;
        settle();
        // Asking a browser that already said no cannot help.
        if (err.code === PERMISSION_DENIED) return;
        rescue();
      },
      watchOptions(precise),
    );
  } catch {
    // A browser that refuses to register a watch at all should still not
    // leave the rider staring at a spinner.
    settle();
    rescue();
  }

  if (id !== null) stallTimer = setTimeout(rescue, stallMs);

  const watchId = id;
  return {
    get id() { return watchId; },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelStallTimer();
      if (watchId !== null) {
        try { geo.clearWatch(watchId); } catch { /* already gone */ }
      }
    },
  };
}
