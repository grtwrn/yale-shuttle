import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installPullToRefresh,
  isVerticalPull,
  PULL_RESISTANCE,
  PULL_THRESHOLD_PX,
  pullDistance,
  shouldRefresh,
} from "./pullToRefresh";

describe("pull-to-refresh gesture math", () => {
  it("damps finger travel so the pull feels elastic", () => {
    expect(pullDistance(100, 200)).toBe(100 * PULL_RESISTANCE);
  });

  it("never reports a negative pull for an upward drag", () => {
    expect(pullDistance(200, 100)).toBe(0);
  });

  it("needs real finger travel to trigger — threshold over damped distance", () => {
    const fingerPx = PULL_THRESHOLD_PX / PULL_RESISTANCE;
    expect(shouldRefresh(0, fingerPx - 1)).toBe(false);
    expect(shouldRefresh(0, fingerPx + 1)).toBe(true);
  });

  it("rejects mostly-horizontal drags as swipes, not pulls", () => {
    expect(isVerticalPull(100, 40)).toBe(false); // sideways swipe
    expect(isVerticalPull(10, 40)).toBe(true);   // clean pull
    expect(isVerticalPull(0, -20)).toBe(false);  // scrolling up
  });
});

// --- Install-time gesture ownership -----------------------------------------
// Android's Chrome keeps its own pull-to-refresh in an INSTALLED app, so the
// installed case has to claim the gesture or both fire on one drag. These run
// in the node environment (no jsdom here), against the injectable `doc`.

function fakeStyle() {
  const props = new Map<string, string>();
  return {
    cssText: "",
    top: "",
    setProperty(k: string, v: string) { props.set(k, v); },
    getPropertyValue(k: string) { return props.get(k) ?? ""; },
    removeProperty(k: string) { props.delete(k); },
  };
}

function fakeDoc() {
  const listeners = new Map<string, (e: unknown) => void>();
  const root = { style: fakeStyle() };
  const doc = {
    documentElement: root,
    scrollingElement: { scrollTop: 0 },
    body: { appendChild() {} },
    createElement: () => ({
      setAttribute() {},
      style: fakeStyle(),
      textContent: "",
      remove() {},
    }),
    addEventListener(t: string, h: (e: unknown) => void) { listeners.set(t, h); },
    removeEventListener(t: string) { listeners.delete(t); },
  };
  return { doc: doc as unknown as Document, root, listeners };
}

const OVERSCROLL = "overscroll-behavior-y";
const touchAt = (y: number) => ({
  target: null,
  touches: [{ clientX: 100, clientY: y }],
  changedTouches: [{ clientX: 100, clientY: y }],
});

describe("pull-to-refresh gesture ownership", () => {
  const g = globalThis as unknown as {
    window?: unknown; Element?: unknown;
  };
  let savedWindow: unknown;
  let savedElement: unknown;

  function setStandalone(standalone: boolean) {
    g.window = { matchMedia: () => ({ matches: standalone }) };
  }

  beforeEach(() => {
    savedWindow = g.window;
    savedElement = g.Element;
    // `inMap` does `t instanceof Element`, which needs the global to exist.
    g.Element = class {};
  });

  afterEach(() => {
    g.window = savedWindow;
    g.Element = savedElement;
  });

  it("an installed app turns the browser's own pull-to-refresh off", () => {
    setStandalone(true);
    const { doc, root } = fakeDoc();
    installPullToRefresh(doc, () => {});
    expect(root.style.getPropertyValue(OVERSCROLL)).toBe("contain");
  });

  it("a browser tab is left alone, so the native gesture still works", () => {
    setStandalone(false);
    const { doc, root } = fakeDoc();
    installPullToRefresh(doc, () => {});
    expect(root.style.getPropertyValue(OVERSCROLL)).toBe("");
  });

  it("uninstalling hands the gesture back to the browser", () => {
    setStandalone(true);
    const { doc, root } = fakeDoc();
    installPullToRefresh(doc, () => {})();
    expect(root.style.getPropertyValue(OVERSCROLL)).toBe("");
  });

  it("still refreshes the installed app, exactly once per pull", () => {
    setStandalone(true);
    const { doc, listeners } = fakeDoc();
    let reloads = 0;
    installPullToRefresh(doc, () => { reloads += 1; });
    listeners.get("touchstart")!(touchAt(100));
    listeners.get("touchmove")!(touchAt(120));
    listeners.get("touchmove")!(touchAt(300));
    listeners.get("touchend")!(touchAt(300));
    expect(reloads).toBe(1);
  });

  it("a short tug is not a refresh", () => {
    setStandalone(true);
    const { doc, listeners } = fakeDoc();
    let reloads = 0;
    installPullToRefresh(doc, () => { reloads += 1; });
    listeners.get("touchstart")!(touchAt(100));
    listeners.get("touchmove")!(touchAt(120));
    listeners.get("touchend")!(touchAt(120));
    expect(reloads).toBe(0);
  });
});
