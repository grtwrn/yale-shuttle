import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBikePref, saveBikePref } from "./bikePref";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

/** Site data blocked: every access THROWS, it does not return null. */
function hostileStorage(): Storage {
  const boom = () => { throw new DOMException("denied", "SecurityError"); };
  return {
    get getItem() { return boom(); },
    get setItem() { return boom(); },
  } as unknown as Storage;
}

beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("the bike-row preference", () => {
  // The weather line taught this lesson: an option nobody sees by default is
  // an option nobody knows exists.
  it("is on for a browser that has never chosen", () => {
    expect(loadBikePref()).toBe(true);
  });

  it("remembers being turned off", () => {
    saveBikePref(false);
    expect(loadBikePref()).toBe(false);
  });

  it("remembers being turned back on", () => {
    saveBikePref(false);
    saveBikePref(true);
    expect(loadBikePref()).toBe(true);
  });

  // An unguarded read in a state initialiser blank-screens the whole app —
  // that has happened in this codebase before.
  it("survives storage that throws on access", () => {
    vi.stubGlobal("localStorage", hostileStorage());
    expect(loadBikePref()).toBe(true);
    expect(() => saveBikePref(false)).not.toThrow();
  });
});
