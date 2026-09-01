// Pull-to-refresh for the installed app. Standalone display mode strips the
// browser chrome, and with it Safari's own pull-to-refresh — riders on the
// home-screen app had no way to force a reload. This restores the gesture.
//
// Deliberately conservative about when it engages:
//   - standalone mode only (in a normal tab the browser's own gesture works,
//     and stacking ours on top would double-refresh),
//   - only when the page is scrolled to the very top,
//   - never inside the Leaflet map (dragging the map IS a vertical pan),
//   - a mostly-horizontal drag is a swipe, not a pull.

/** Pure gesture math, split out for tests. */
export interface PullState {
  startY: number;
  startX: number;
  pulling: boolean;
}

export const PULL_THRESHOLD_PX = 70;
/** Finger travel is damped so the indicator feels elastic, like the native one. */
export const PULL_RESISTANCE = 0.45;

export function pullDistance(startY: number, currentY: number): number {
  return Math.max(0, (currentY - startY) * PULL_RESISTANCE);
}

/** A drag that moved further sideways than down is not a pull. */
export function isVerticalPull(dx: number, dy: number): boolean {
  return dy > 0 && dy > Math.abs(dx) * 1.5;
}

export function shouldRefresh(startY: number, endY: number): boolean {
  return pullDistance(startY, endY) >= PULL_THRESHOLD_PX;
}

export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** Wire the gesture onto the document. Returns an uninstaller. */
export function installPullToRefresh(
  doc: Document = document,
  reload: () => void = () => window.location.reload(),
): () => void {
  if (!isStandalone()) return () => {};

  const indicator = doc.createElement("div");
  indicator.setAttribute("aria-hidden", "true");
  indicator.style.cssText =
    "position:fixed;top:-44px;left:50%;transform:translateX(-50%);z-index:10000;" +
    "width:36px;height:36px;border-radius:50%;background:#fff;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;" +
    "justify-content:center;font-size:18px;transition:top 0.15s ease;" +
    "pointer-events:none;";
  indicator.textContent = "↓";
  doc.body.appendChild(indicator);

  let state: PullState | null = null;

  const atTop = () => (doc.scrollingElement?.scrollTop ?? 0) <= 0;
  const inMap = (t: EventTarget | null) =>
    t instanceof Element && t.closest(".leaflet-container") !== null;

  const onStart = (e: TouchEvent) => {
    if (!atTop() || inMap(e.target) || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    state = { startY: t.clientY, startX: t.clientX, pulling: false };
  };

  const onMove = (e: TouchEvent) => {
    if (!state) return;
    const t = e.touches[0]!;
    const dy = t.clientY - state.startY;
    const dx = t.clientX - state.startX;
    if (!state.pulling) {
      if (!isVerticalPull(dx, dy)) {
        // Sideways or upward: hand the gesture back to normal scrolling.
        if (Math.abs(dx) > 10 || dy < -10) state = null;
        return;
      }
      if (dy > 12) state.pulling = true;
    }
    if (state.pulling) {
      const d = pullDistance(state.startY, t.clientY);
      indicator.style.top = `${Math.min(d, PULL_THRESHOLD_PX + 20) - 44}px`;
      indicator.textContent = d >= PULL_THRESHOLD_PX ? "↻" : "↓";
    }
  };

  const reset = () => {
    indicator.style.top = "-44px";
    state = null;
  };

  const onEnd = (e: TouchEvent) => {
    if (!state?.pulling) { state = null; return; }
    const t = e.changedTouches[0]!;
    if (shouldRefresh(state.startY, t.clientY)) {
      indicator.textContent = "↻";
      indicator.style.top = "12px";
      reload();
    } else {
      reset();
    }
    state = null;
  };

  doc.addEventListener("touchstart", onStart, { passive: true });
  doc.addEventListener("touchmove", onMove, { passive: true });
  doc.addEventListener("touchend", onEnd, { passive: true });
  doc.addEventListener("touchcancel", reset, { passive: true });
  return () => {
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
    doc.removeEventListener("touchend", onEnd);
    doc.removeEventListener("touchcancel", reset);
    indicator.remove();
  };
}
