// The rider's own reports ("Issues" tab): fetch, and the pure logic that
// decides when to show the "your report was updated" banner/badge.
//
// The seen-status map lives in localStorage next to the favourites and anon id
// this app already keeps there. Every storage access is wrapped in try/catch —
// a rider with storage disabled simply sees no badge; the app must never crash
// over a convenience.

import { anonIdHeader } from "./anonId";

export type ReportStatus = "open" | "addressed" | "wontfix";

export type MyReportFollowup = { text: string; at: number };

export type MyReport = {
  id: number;
  createdAt: number; // ms
  kind: "issue" | "feedback";
  body: string;
  status: ReportStatus;
  /** The latest reply. `replies` carries the whole thread; this stays for the badge. */
  note: string | null;
  /** Every reply the rider has been sent, oldest first. Absent on an old server. */
  replies?: MyReportFollowup[];
  hasImage: boolean;
  archived: boolean;
  priority: "urgent" | "normal" | "nice_to_have";
  followups: MyReportFollowup[];
};

export type ThreadEntry = { from: "us" | "rider"; text: string; at: number };

/**
 * The report's conversation in order: our replies and the rider's follow-ups
 * interleaved by time.
 *
 * Both sides used to be rendered separately, and our side was ONE box that got
 * rewritten with each new note — so a rider who was answered twice saw only
 * the second answer, and never in sequence with what they had written. The
 * server now sends every reply; `note` alone is the fallback for a cached
 * bundle talking to a new server, or the reverse.
 */
export function threadOf(r: MyReport): ThreadEntry[] {
  const replies = (Array.isArray(r.replies) && r.replies.length > 0
    ? r.replies
    : r.note
      ? [{ text: r.note, at: r.createdAt }]
      : []
  ).filter((n) => n && typeof n.text === "string" && Number.isFinite(n.at));
  const out: ThreadEntry[] = [
    ...replies.map((n) => ({ from: "us" as const, text: n.text, at: n.at })),
    ...(Array.isArray(r.followups) ? r.followups : [])
      .filter((f) => f && typeof f.text === "string" && Number.isFinite(f.at))
      .map((f) => ({ from: "rider" as const, text: f.text, at: f.at })),
  ];
  // Stable: equal stamps keep our reply first, since a rider's follow-up is
  // always a response to it.
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map(({ e }) => e);
}

/** localStorage key for {reportId: lastSeenStatus}. */
const SEEN_KEY = "issuesSeenStatuses";

export type SeenStatuses = Record<string, string>;

export function loadSeenStatuses(): SeenStatuses {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: SeenStatuses = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSeenStatuses(seen: SeenStatuses): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage disabled — the rider just won't get change badges.
  }
}

/** The map that records the current state as fully seen. */
export function markAllSeen(reports: MyReport[]): SeenStatuses {
  const out: SeenStatuses = {};
  for (const r of reports) out[String(r.id)] = r.status;
  return out;
}

/**
 * Does any report carry a status the rider hasn't seen yet?
 *
 * A report the rider has never seen (not in the map) counts as unseen only if
 * its status is no longer "open" — they just submitted it themselves, so the
 * initial "open" is not news; an operator response before they ever opened the
 * Issues tab is.
 */
export function hasUnseenChanges(reports: MyReport[], seen: SeenStatuses): boolean {
  return reports.some((r) => {
    const last = seen[String(r.id)];
    if (last === undefined) return r.status !== "open";
    return last !== r.status;
  });
}

/** Chip colours per status — matches the app's palette, not a new one. */
export function statusChip(status: ReportStatus): { label: string; bg: string; fg: string } {
  switch (status) {
    case "addressed":
      return { label: "Fixed", bg: "#e8f5e9", fg: "#2e7d32" };
    case "wontfix":
      return { label: "Closed", bg: "#eceff1", fg: "#78909c" };
    default:
      return { label: "Open", bg: "#fff8e1", fg: "#b26a00" };
  }
}

/**
 * Fetch the rider's reports. Throws on network/HTTP failure — callers decide
 * whether that means "retry text" (the panel) or "no badge" (the app shell).
 */
export async function fetchMyReports(): Promise<MyReport[]> {
  const res = await fetch("/api/my-reports", { headers: { ...anonIdHeader() } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  const reports = (data as { reports?: unknown })?.reports;
  if (!Array.isArray(reports)) throw new Error("Malformed /api/my-reports payload");
  return reports as MyReport[];
}

/** Post an action on one report; resolves to the report's new status. */
export async function postReportAction(
  id: number,
  action:
    | { action: "resolve" }
    | { action: "followup"; text: string }
    | { action: "archive" }
    | { action: "unarchive" }
    | { action: "set_priority"; priority: "urgent" | "normal" | "nice_to_have" },
): Promise<void> {
  const res = await fetch(`/api/my-reports/${id}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...anonIdHeader() },
    body: JSON.stringify(action),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
