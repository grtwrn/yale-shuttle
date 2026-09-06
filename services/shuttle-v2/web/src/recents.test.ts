import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECENTS_KEY, RECENTS_MAX, loadRecents, recordRecent, saveRecents } from "./recents";

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

/** Storage that throws on every touch — Safari with site data blocked. */
function blockedStorage(): Storage {
  const boom = () => { throw new DOMException("blocked", "SecurityError"); };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 } as unknown as Storage;
}

const UNION = { text: "Union Station", lat: 41.29752, lon: -72.92651 };
const TJS = { text: "Trader Joe's, Milford", lat: 41.2285, lon: -73.0201 };
const PROSPECT = { text: "517 Prospect Street", lat: 41.3243, lon: -72.9236 };

beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("recordRecent", () => {
  it("puts the newest place first", () => {
    let list = recordRecent([], UNION, 1);
    list = recordRecent(list, TJS, 2);
    list = recordRecent(list, PROSPECT, 3);
    expect(list.map((t) => t.toText)).toEqual([PROSPECT.text, TJS.text, UNION.text]);
  });

  it("remembers the coordinate, so a re-pick never re-geocodes", () => {
    const [entry] = recordRecent([], PROSPECT, 1);
    expect(entry.toLat).toBe(PROSPECT.lat);
    expect(entry.toLon).toBe(PROSPECT.lon);
    expect(entry.name).toBe(PROSPECT.text);
  });

  it("dedups by coordinate, moving a re-used place to the top", () => {
    let list = recordRecent([], UNION, 1);
    list = recordRecent(list, TJS, 2);
    list = recordRecent(list, UNION, 3);
    expect(list.map((t) => t.toText)).toEqual([UNION.text, TJS.text]);
    expect(list).toHaveLength(2);
  });

  it("treats a coordinate within ~10 m as the same place", () => {
    let list = recordRecent([], UNION, 1);
    list = recordRecent(list, { ...UNION, text: "Union Station, New Haven", lat: UNION.lat + 5e-5 }, 2);
    expect(list).toHaveLength(1);
    // The newer name wins.
    expect(list[0].toText).toBe("Union Station, New Haven");
  });

  it("caps at ten, dropping the oldest", () => {
    let list: ReturnType<typeof recordRecent> = [];
    for (let i = 0; i < RECENTS_MAX + 3; i++) {
      list = recordRecent(list, { text: `Place ${i}`, lat: 41 + i * 0.01, lon: -72 }, i + 1);
    }
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list[0].toText).toBe(`Place ${RECENTS_MAX + 2}`);
    expect(list[RECENTS_MAX - 1].toText).toBe("Place 3");
  });

  it("returns the same array when the place is already on top", () => {
    const list = recordRecent([], UNION, 1);
    expect(recordRecent(list, UNION, 2)).toBe(list);
  });

  it("never mutates its input", () => {
    const list = recordRecent([], UNION, 1);
    const frozen = Object.freeze([...list]);
    recordRecent(frozen as typeof list, TJS, 2);
    expect(frozen).toHaveLength(1);
  });
});

describe("storage", () => {
  it("round-trips through localStorage", () => {
    const list = recordRecent(recordRecent([], UNION, 1), TJS, 2);
    saveRecents(list);
    expect(loadRecents()).toEqual(list);
  });

  it("starts empty", () => {
    expect(loadRecents()).toEqual([]);
  });

  it("keeps the pre-existing storage key and record shape", () => {
    // A rider's recents from before the shared list must survive the upgrade.
    localStorage.setItem("shuttle-recent-trips", JSON.stringify([{
      id: "r1", name: "Union Station",
      fromText: "", fromLat: 0, fromLon: 0,
      toText: "Union Station", toLat: 41.29752, toLon: -72.92651,
    }]));
    expect(RECENTS_KEY).toBe("shuttle-recent-trips");
    expect(loadRecents().map((t) => t.toText)).toEqual(["Union Station"]);
  });

  it("drops junk rows and survives non-JSON", () => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([
      { id: "ok", toText: "Union Station", toLat: 41.3, toLon: -72.9 },
      { id: "no-coord", toText: "Nowhere" },
      { id: "nan", toText: "Nowhere", toLat: "41", toLon: -72.9 },
      "string",
      null,
    ]));
    expect(loadRecents().map((t) => t.id)).toEqual(["ok"]);
    localStorage.setItem(RECENTS_KEY, "{not json");
    expect(loadRecents()).toEqual([]);
    localStorage.setItem(RECENTS_KEY, JSON.stringify({ not: "a list" }));
    expect(loadRecents()).toEqual([]);
  });

  it("survives blocked storage without throwing", () => {
    vi.stubGlobal("localStorage", blockedStorage());
    expect(loadRecents()).toEqual([]);
    expect(() => saveRecents(recordRecent([], UNION, 1))).not.toThrow();
  });

  it("survives a missing localStorage entirely", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadRecents()).toEqual([]);
    expect(() => saveRecents([])).not.toThrow();
  });
});
