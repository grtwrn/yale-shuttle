import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { anonIdHeader, getAnonId, hasAnonId } from "./anonId";

const KEY = "shuttle-anon-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAnonId", () => {
  it("mints a well-formed id the server will accept", () => {
    const id = getAnonId();
    expect(id).toMatch(UUID);
  });

  it("is stable across calls — the same browser is one person", () => {
    const first = getAnonId();
    expect(getAnonId()).toBe(first);
    expect(getAnonId()).toBe(first);
  });

  it("replaces a corrupted stored value rather than sending junk", () => {
    localStorage.setItem(KEY, "not-a-uuid");
    const id = getAnonId();
    expect(id).toMatch(UUID);
    expect(localStorage.getItem(KEY)).toBe(id);
  });

  it("works without crypto.randomUUID", () => {
    // Older / non-secure contexts have no randomUUID; the fallback must still
    // produce something the server's validation accepts.
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = i * 7;
        return a;
      },
    });
    expect(getAnonId()).toMatch(UUID);
  });

  // Counting must never be a reason the app breaks.
  it("returns null instead of throwing when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage);
    expect(getAnonId()).toBeNull();
    expect(anonIdHeader()).toEqual({});
  });
});

describe("hasAnonId", () => {
  it("is true when the browser can keep an id", () => {
    expect(hasAnonId()).toBe(true);
  });

  // The Issues tab reads this to decide whether an empty list means "nothing
  // sent yet" or "nothing can ever be listed here" (report #51).
  it("is false when storage is unavailable, and does not throw", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage);
    expect(hasAnonId()).toBe(false);
  });
});

describe("anonIdHeader", () => {
  it("carries the id under the header the server reads", () => {
    const h = anonIdHeader();
    expect(Object.keys(h)).toEqual(["x-anon-id"]);
    expect(h["x-anon-id"]).toMatch(UUID);
  });

  it("spreads into a fetch init without disturbing other headers", () => {
    const headers: Record<string, string> = { "content-type": "application/json", ...anonIdHeader() };
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-anon-id"]).toMatch(UUID);
  });
});
