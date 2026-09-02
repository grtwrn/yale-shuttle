import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBikePref, saveBikePref } from "./bikePref";

const KEY = "shuttle-has-bike";

function fakeStorage() {
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

/** localStorage that THROWS — Safari "Block All Cookies", some webviews. */
function blockedStorage() {
  const die = () => { throw new DOMException("denied", "SecurityError"); };
  return {
    getItem: die, setItem: die, removeItem: die, clear: die, key: die, length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the bike preference", () => {
  it("is off until the rider turns it on", () => {
    expect(loadBikePref()).toBe(false);
  });

  it("survives a round trip", () => {
    saveBikePref(true);
    expect(loadBikePref()).toBe(true);
    saveBikePref(false);
    expect(loadBikePref()).toBe(false);
  });

  it("clears the key when turned off rather than storing a falsy string", () => {
    saveBikePref(true);
    saveBikePref(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reads anything unrecognised as off", () => {
    localStorage.setItem(KEY, "yes");
    expect(loadBikePref()).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", blockedStorage());
    expect(() => saveBikePref(true)).not.toThrow();
    expect(loadBikePref()).toBe(false);
  });
});
