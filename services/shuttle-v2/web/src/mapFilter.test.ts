import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { allHidden, drawnHidden, loadHiddenRoutes, saveHiddenRoutes, toggleAll, toggleOne } from "./mapFilter";

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

  describe("Hide all", () => {
    it("is true only when every known line is hidden", () => {
      expect(allHidden(KNOWN, new Set(KNOWN))).toBe(true);
      expect(allHidden(KNOWN, new Set(["Red", "Blue"]))).toBe(false);
      expect(allHidden(KNOWN, new Set())).toBe(false);
    });

    it("is never true for an empty legend, so the page cannot open on the empty-state line", () => {
      expect(allHidden([], new Set())).toBe(false);
    });

    it("agrees with what toggleAll does next", () => {
      // toggleAll shows everything exactly when allHidden says all is hidden.
      for (const hidden of [new Set<string>(), new Set(["Red"]), new Set(KNOWN)]) {
        expect(toggleAll(KNOWN, hidden).size === 0).toBe(allHidden(KNOWN, hidden));
      }
    });
  });

  describe("one filter for the whole Map tab", () => {
    // The chip row above the map is the page's ONLY per-route filter, and
    // "Running now" is folded into it once (drawnHidden). Both consumers —
    // the map and the route cards — must take that one set, or a line can be
    // on the map while its card is missing (operator, 2026-09-06: "can both
    // charts on the map page share one filter setting instead of two?").
    // Read straight out of the shell's source: a refactor that hands
    // StopList the raw chip set again, or re-applies activeOnly on top,
    // brings the second decision back.
    const src = readFileSync(fileURLToPath(new URL("./TransitMap.tsx", import.meta.url)), "utf8");
    const start = src.indexOf('listView === "map" ? (');
    const end = src.indexOf('listView === "issues" ? (', start);
    const mapTab = src.slice(start, end);

    it("the map tab exists where this test expects it", () => {
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
    });

    it("the map and the route cards are handed the SAME hidden set", () => {
      expect(mapTab.match(/hiddenRoutes=\{mapDrawnHidden\}/g)?.length).toBe(2);
      expect(mapTab).not.toMatch(/hiddenRoutes=\{mapHidden\}/);
    });

    it("the cards do not re-apply the Running now mode on their own", () => {
      // drawnHidden already folded it in; a second copy is a second decision.
      expect(mapTab).not.toMatch(/activeOnly=\{/);
    });

    it("there is only one row of route chips on the page", () => {
      // The jump index under the map was a second row of route names that
      // did something different from the first.
      expect(mapTab).not.toMatch(/Jump to the/);
      expect(mapTab.match(/LEGEND_ROUTES\.map\(/g)?.length).toBe(1);
    });
  });

  describe("the shared decision, as both consumers see it", () => {
    const running = new Set(["Blue"]);

    it("Hide all hides every line in both modes, buses or not", () => {
      for (const activeOnly of [true, false]) for (const anyBuses of [true, false]) {
        const out = drawnHidden(KNOWN, new Set(KNOWN), activeOnly, anyBuses, running);
        expect(allHidden(KNOWN, out)).toBe(true);
      }
    });

    it("two chips off leave exactly the third line, in Every route mode", () => {
      const out = drawnHidden(KNOWN, new Set(["Red", "Green"]), false, true, running);
      expect(KNOWN.filter((l) => !out.has(l))).toEqual(["Blue"]);
    });

    it("Running now with every chip on shows exactly the running lines", () => {
      const out = drawnHidden(KNOWN, new Set(), true, true, running);
      expect(KNOWN.filter((l) => !out.has(l))).toEqual(["Blue"]);
      expect(allHidden(KNOWN, out)).toBe(false);
    });

    it("Running now with only idle chips on is the 'nothing running' state, not Hide all", () => {
      const chips = new Set(["Blue"]);
      const out = drawnHidden(KNOWN, chips, true, true, running);
      expect(allHidden(KNOWN, out)).toBe(true);
      expect(allHidden(KNOWN, chips)).toBe(false);
    });
  });
});
