import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawnHidden, loadHiddenRoutes, saveHiddenRoutes, toggleAll, toggleOne } from "./mapFilter";

const KNOWN = ["Red", "Blue", "Green"];

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

beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("map route filter", () => {
  it("remembers hidden routes across visits", () => {
    saveHiddenRoutes(new Set(["Red", "Green"]));
    expect([...loadHiddenRoutes(KNOWN)].sort()).toEqual(["Green", "Red"]);
  });

  it("starts with everything shown", () => {
    expect(loadHiddenRoutes(KNOWN).size).toBe(0);
  });

  it("drops labels it no longer recognises", () => {
    // A renamed route must not leave a ghost that hides nothing and cannot be
    // cleared from the chip row.
    saveHiddenRoutes(new Set(["Red", "Chartreuse"]));
    expect([...loadHiddenRoutes(KNOWN)]).toEqual(["Red"]);
  });

  it("survives junk in storage rather than throwing", () => {
    localStorage.setItem("mapHiddenRoutes", "{not json");
    expect(loadHiddenRoutes(KNOWN).size).toBe(0);
    localStorage.setItem("mapHiddenRoutes", JSON.stringify({ Red: true }));
    expect(loadHiddenRoutes(KNOWN).size).toBe(0);
    localStorage.setItem("mapHiddenRoutes", JSON.stringify([1, null, "Red"]));
    expect([...loadHiddenRoutes(KNOWN)]).toEqual(["Red"]);
  });

  it("never throws when storage itself is blocked", () => {
    // iOS "Block All Cookies" throws on ACCESS, not just on write.
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("The operation is insecure."); },
      setItem: () => { throw new Error("The operation is insecure."); },
    } as unknown as Storage);
    expect(() => loadHiddenRoutes(KNOWN)).not.toThrow();
    expect(loadHiddenRoutes(KNOWN).size).toBe(0);
    expect(() => saveHiddenRoutes(new Set(["Red"]))).not.toThrow();
  });

  it("toggleAll flips between everything and nothing", () => {
    expect([...toggleAll(KNOWN, new Set())].sort()).toEqual(["Blue", "Green", "Red"]);
    expect(toggleAll(KNOWN, new Set(KNOWN)).size).toBe(0);
    // A partial selection hides the rest rather than doing nothing.
    expect([...toggleAll(KNOWN, new Set(["Red"]))].sort()).toEqual(["Blue", "Green", "Red"]);
  });

  it("toggleOne flips one label without mutating the input", () => {
    const before = new Set(["Red"]);
    const after = toggleOne(before, "Blue");
    expect([...before]).toEqual(["Red"]);
    expect([...after].sort()).toEqual(["Blue", "Red"]);
    expect([...toggleOne(after, "Red")]).toEqual(["Blue"]);
  });

  describe("Running now on the map", () => {
    const running = new Set(["Blue"]);

    it("hides every line without a bus on top of the chip selection", () => {
      const out = drawnHidden(KNOWN, new Set(["Green"]), true, true, running);
      expect([...out].sort()).toEqual(["Green", "Red"]);
    });

    it("keeps a chip the rider switched off hidden even when that line is running", () => {
      // The chips are the manual override in ONE direction only.
      const out = drawnHidden(KNOWN, new Set(["Blue"]), true, true, running);
      expect([...out].sort()).toEqual(["Blue", "Green", "Red"]);
    });

    it("with Every route selected the map shows exactly the chip selection", () => {
      const out = drawnHidden(KNOWN, new Set(["Green"]), false, true, running);
      expect([...out]).toEqual(["Green"]);
    });

    it("with no buses reporting the toggle is inert and the chips decide", () => {
      const out = drawnHidden(KNOWN, new Set(["Green"]), true, false, new Set());
      expect([...out]).toEqual(["Green"]);
    });

    it("never mutates the chip set it was given", () => {
      const chips = new Set(["Green"]);
      drawnHidden(KNOWN, chips, true, true, running);
      expect([...chips]).toEqual(["Green"]);
    });
  });
});
