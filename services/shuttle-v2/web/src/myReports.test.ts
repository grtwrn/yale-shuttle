import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasUnseenChanges,
  loadSeenStatuses,
  markAllSeen,
  saveSeenStatuses,
  statusChip,
  type MyReport,
} from "./myReports";

const SEEN_KEY = "issuesSeenStatuses";

function report(over: Partial<MyReport>): MyReport {
  return {
    id: 1,
    createdAt: 1_756_000_000_000,
    kind: "issue",
    body: "The bus vanished",
    status: "open",
    archived: false,
    priority: "normal",
    note: null,
    hasImage: false,
    followups: [],
    ...over,
  };
}

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

describe("hasUnseenChanges", () => {
  it("is quiet when every status matches what was last seen", () => {
    const reports = [report({ id: 1, status: "open" }), report({ id: 2, status: "addressed" })];
    expect(hasUnseenChanges(reports, { "1": "open", "2": "addressed" })).toBe(false);
  });

  it("fires when a seen report's status changed", () => {
    const reports = [report({ id: 1, status: "addressed" })];
    expect(hasUnseenChanges(reports, { "1": "open" })).toBe(true);
  });

  it("does NOT fire for a brand-new report that is still open — the rider just submitted it", () => {
    const reports = [report({ id: 7, status: "open" })];
    expect(hasUnseenChanges(reports, {})).toBe(false);
  });

  it("DOES fire for a never-seen report the operator already answered", () => {
    // Submitted, never opened the Issues tab, operator marked it addressed:
    // that response is news even though the id was never in the seen map.
    const reports = [report({ id: 7, status: "addressed" })];
    expect(hasUnseenChanges(reports, {})).toBe(true);
  });

  it("fires on open → wontfix too, not just fixes", () => {
    const reports = [report({ id: 3, status: "wontfix" })];
    expect(hasUnseenChanges(reports, { "3": "open" })).toBe(true);
  });

  it("is quiet with no reports at all", () => {
    expect(hasUnseenChanges([], {})).toBe(false);
    expect(hasUnseenChanges([], { "9": "open" })).toBe(false);
  });
});

describe("markAllSeen", () => {
  it("records every report's current status keyed by id", () => {
    const seen = markAllSeen([
      report({ id: 1, status: "open" }),
      report({ id: 2, status: "wontfix" }),
    ]);
    expect(seen).toEqual({ "1": "open", "2": "wontfix" });
  });

  it("round-trips through hasUnseenChanges as fully seen", () => {
    const reports = [report({ id: 1, status: "addressed" }), report({ id: 2 })];
    expect(hasUnseenChanges(reports, markAllSeen(reports))).toBe(false);
  });

  it("drops reports the server no longer returns — no stale ids accumulate", () => {
    saveSeenStatuses({ "999": "open" });
    const seen = markAllSeen([report({ id: 1 })]);
    expect(seen).toEqual({ "1": "open" });
  });
});

describe("seen-status persistence", () => {
  it("round-trips through localStorage", () => {
    saveSeenStatuses({ "1": "open", "2": "addressed" });
    expect(loadSeenStatuses()).toEqual({ "1": "open", "2": "addressed" });
  });

  it("returns {} when nothing is stored", () => {
    expect(loadSeenStatuses()).toEqual({});
  });

  it("survives corrupted JSON in the slot", () => {
    localStorage.setItem(SEEN_KEY, "{not json");
    expect(loadSeenStatuses()).toEqual({});
  });

  it("ignores stored values that are not a plain string map", () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(["open"]));
    expect(loadSeenStatuses()).toEqual({});
    localStorage.setItem(SEEN_KEY, JSON.stringify({ "1": 42, "2": "open" }));
    expect(loadSeenStatuses()).toEqual({ "2": "open" });
  });

  // Notification is a convenience; storage being disabled must never throw.
  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage);
    expect(loadSeenStatuses()).toEqual({});
    expect(() => saveSeenStatuses({ "1": "open" })).not.toThrow();
  });
});

describe("statusChip", () => {
  it("labels the three statuses the way the UI promises", () => {
    expect(statusChip("open").label).toBe("Open");
    expect(statusChip("addressed").label).toBe("Fixed");
    expect(statusChip("wontfix").label).toBe("Closed");
  });

  it("gives each status a distinct colour pair", () => {
    const chips = [statusChip("open"), statusChip("addressed"), statusChip("wontfix")];
    expect(new Set(chips.map((c) => c.bg)).size).toBe(3);
    expect(new Set(chips.map((c) => c.fg)).size).toBe(3);
  });
});
