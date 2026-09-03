import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReportActionError,
  actionErrorText,
  emptyReportsText,
  hasUnseenChanges,
  postReportAction,
  loadSeenStatuses,
  markAllSeen,
  saveSeenStatuses,
  statusChip,
  threadOf,
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

describe("threadOf — the report's conversation in order", () => {
  const base: MyReport = {
    id: 1, createdAt: 1000, kind: "issue", body: "bus never came",
    status: "open", note: null, hasImage: false, archived: false,
    priority: "normal", followups: [],
  };

  it("interleaves every reply with the rider's follow-ups by time", () => {
    // The bug: two replies used to collapse into one box showing only the
    // last, and the rider's own message sat below both regardless of when.
    const r: MyReport = {
      ...base,
      note: "Fixed now.",
      replies: [{ text: "Looking into it.", at: 2000 }, { text: "Fixed now.", at: 4000 }],
      followups: [{ text: "still broken", at: 3000 }],
    };
    expect(threadOf(r)).toEqual([
      { from: "us", text: "Looking into it.", at: 2000 },
      { from: "rider", text: "still broken", at: 3000 },
      { from: "us", text: "Fixed now.", at: 4000 },
    ]);
  });

  it("falls back to the single note when the server sends no history", () => {
    expect(threadOf({ ...base, note: "Thanks!" })).toEqual([
      { from: "us", text: "Thanks!", at: base.createdAt },
    ]);
    expect(threadOf(base)).toEqual([]);
  });

  it("puts our reply before a follow-up written in the same millisecond", () => {
    const r: MyReport = {
      ...base,
      replies: [{ text: "Any details?", at: 5000 }],
      followups: [{ text: "sure", at: 5000 }],
    };
    expect(threadOf(r).map((e) => e.from)).toEqual(["us", "rider"]);
  });

  it("drops malformed entries instead of rendering junk", () => {
    const r = {
      ...base,
      replies: [{ text: "ok", at: 1 }, { text: 5, at: 2 }, null, { text: "x", at: "nope" }],
      followups: [{ text: "hi", at: 3 }, undefined],
    } as unknown as MyReport;
    expect(threadOf(r)).toEqual([
      { from: "us", text: "ok", at: 1 },
      { from: "rider", text: "hi", at: 3 },
    ]);
  });
});

describe("a rider action the server refused", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (status: number) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status }) as unknown as Response));

  it("carries the status out of postReportAction", async () => {
    stubFetch(429);
    await expect(postReportAction(7, { action: "archive" })).rejects.toMatchObject({ status: 429 });
  });

  it("resolves quietly when the server accepts it", async () => {
    stubFetch(200);
    await expect(postReportAction(7, { action: "archive" })).resolves.toBeUndefined();
  });

  // The bug this exists for: a rider archiving a long list hit the ceiling and
  // was told to try again, which inside the same minute fails again.
  it("tells a rate-limited rider to wait, not to retry", () => {
    const text = actionErrorText(new ReportActionError(429));
    expect(text).toMatch(/moment/i);
    expect(text).not.toMatch(/try again/i);
  });

  it("keeps the old wording for every other failure", () => {
    for (const err of [new ReportActionError(500), new ReportActionError(404), new TypeError("offline"), undefined]) {
      expect(actionErrorText(err)).toBe("Didn’t go through — try again");
    }
  });
});

describe("the empty Issues tab", () => {
  it("invites a report when the browser can be shown one later", () => {
    expect(emptyReportsText(true)).toMatch(/No reports yet/);
  });

  // A browser with no id is never sent its own reports, so "No reports yet"
  // is a promise the app cannot keep (report #51).
  it("explains itself when the browser keeps no id, and says the report arrived", () => {
    const text = emptyReportsText(false);
    expect(text).not.toMatch(/No reports yet/);
    expect(text).toMatch(/private browsing/i);
    expect(text).toMatch(/still reaches us/i);
  });

  it("stays free of jargon a rider would have to look up", () => {
    const text = emptyReportsText(false);
    for (const word of ["localStorage", "cookie", "anon", "id", "browser storage", "429"]) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
