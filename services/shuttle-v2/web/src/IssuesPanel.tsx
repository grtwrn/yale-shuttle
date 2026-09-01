// The "Issues" tab: the rider's own submitted reports, the operator's replies,
// and two actions — mark a report resolved, or send a follow-up message.
//
// Kept out of TransitMap.tsx deliberately (that file is 6.8k lines). Everything
// this panel needs arrives as props; it never reaches into the parent's state.

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchMyReports,
  markAllSeen,
  postReportAction,
  saveSeenStatuses,
  statusChip,
  type MyReport,
} from "./myReports";

const CARD: React.CSSProperties = {
  border: "1px solid #e0ddd8", borderRadius: 10, background: "#fff",
  padding: 12, display: "flex", flexDirection: "column", gap: 8,
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, color: "#78909c", textTransform: "uppercase", letterSpacing: 1,
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  try {
    return d.toLocaleDateString(undefined, opts);
  } catch {
    return d.toDateString();
  }
}

const IssuesPanel: React.FC<{
  /** Called after a successful fetch — the parent clears its badge/banner. */
  onAllSeen: () => void;
}> = ({ onAllSeen }) => {
  const [reports, setReports] = useState<MyReport[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Which report has its reply box open, and its draft text.
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<number | null>(null);

  // The parent passes onAllSeen inline, so its identity changes every parent
  // render (every 5 s poll). Hold it in a ref so `load` stays stable and the
  // mount effect doesn't refetch in a loop.
  const onAllSeenRef = useRef(onAllSeen);
  onAllSeenRef.current = onAllSeen;

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const fetched = await fetchMyReports();
      setReports(fetched);
      // Opening this tab is what "seeing" means: record every current status
      // so the banner and tab dot go quiet until something changes again.
      saveSeenStatuses(markAllSeen(fetched));
      onAllSeenRef.current();
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const [showArchived, setShowArchived] = useState(false);

  const act = async (
    id: number,
    action:
      | { action: "resolve" }
      | { action: "followup"; text: string }
      | { action: "archive" }
      | { action: "unarchive" },
  ) => {
    setBusyId(id);
    setActionError(null);
    try {
      await postReportAction(id, action);
      setReplyFor(null);
      setReplyText("");
      await load();
    } catch {
      setActionError(id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{
      width: "100%", maxWidth: 560, margin: "8px auto 0", padding: "0 16px",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={SECTION_LABEL}>Your reports</div>

      {loadError ? (
        <div style={{ ...CARD, alignItems: "flex-start" }}>
          <span style={{ fontSize: 13, color: "#78909c" }}>
            Couldn’t load your reports.
          </span>
          <button
            onClick={() => void load()}
            style={{
              fontSize: 13, padding: "8px 14px", minHeight: 44, minWidth: 44,
              border: "1px solid #bbb", borderRadius: 6,
              background: "#fff", color: "#546e7a",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Try again
          </button>
        </div>
      ) : reports === null ? (
        <div style={{ fontSize: 13, color: "#78909c", padding: "8px 2px" }}>Loading…</div>
      ) : reports.length === 0 ? (
        <div style={{ fontSize: 13, color: "#78909c", padding: "8px 2px", lineHeight: 1.5 }}>
          No reports yet — 🚩 Report issue or 💬 Send feedback and it will show up here.
        </div>
      ) : (
        <>
        {reports.filter((r) => !r.archived).length === 0 && (
          <div style={{ fontSize: 13, color: "#78909c", padding: "8px 2px" }}>
            Everything’s archived. 🎉
          </div>
        )}
        {reports.filter((r) => showArchived ? true : !r.archived).map((r) => {
          const chip = statusChip(r.status);
          const busy = busyId === r.id;
          return (
            <div key={r.id} style={CARD}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
                  background: chip.bg, color: chip.fg, letterSpacing: 0.3,
                }}>
                  {chip.label}
                </span>
                <span style={{ fontSize: 12, color: "#8a8a9a" }}>
                  {r.kind === "issue" ? "🚩" : "💬"} {fmtDate(r.createdAt)}
                  {r.hasImage ? " · 📎" : ""}
                </span>
              </div>

              <div style={{ fontSize: 14, color: "#1a1a2e", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                {r.body}
              </div>

              {r.note && (
                <div style={{
                  borderLeft: "3px solid #c8e6c9", background: "#f6faf6",
                  borderRadius: "0 6px 6px 0", padding: "8px 10px",
                  display: "flex", flexDirection: "column", gap: 2,
                }}>
                  <span style={{ ...SECTION_LABEL, fontSize: 10 }}>Reply</span>
                  <span style={{ fontSize: 13, color: "#37474f", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                    {r.note}
                  </span>
                </div>
              )}

              {r.followups.map((f, i) => (
                <div key={i} style={{
                  alignSelf: "flex-end", maxWidth: "85%",
                  background: "#f0eeea", borderRadius: "10px 10px 2px 10px",
                  padding: "6px 10px", display: "flex", flexDirection: "column", gap: 1,
                }}>
                  <span style={{ fontSize: 13, color: "#37474f", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                    {f.text}
                  </span>
                  <span style={{ fontSize: 10, color: "#8a8a9a", alignSelf: "flex-end" }}>
                    {fmtDate(f.at)}
                  </span>
                </div>
              ))}

              {replyFor === r.id ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Add anything that helps…"
                    autoFocus
                    rows={3}
                    style={{
                      width: "100%", fontSize: 16, padding: "10px 12px",
                      border: "1px solid #ccc", borderRadius: 6,
                      fontFamily: "inherit", resize: "vertical", minHeight: 64,
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => { setReplyFor(null); setReplyText(""); }}
                      style={{
                        fontSize: 13, padding: "8px 14px", minHeight: 44,
                        border: "1px solid #bbb", borderRadius: 6,
                        background: "#fff", color: "#546e7a",
                        cursor: "pointer", fontFamily: "inherit", flex: 1,
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void act(r.id, { action: "followup", text: replyText.trim() })}
                      disabled={busy || !replyText.trim()}
                      style={{
                        fontSize: 13, padding: "8px 14px", minHeight: 44,
                        border: "1px solid #1976D2", borderRadius: 6,
                        background: busy || !replyText.trim() ? "#90CAF9" : "#1976D2",
                        color: "#fff", fontWeight: 600,
                        cursor: busy || !replyText.trim() ? "default" : "pointer",
                        fontFamily: "inherit", flex: 1,
                      }}
                    >
                      {busy ? "Sending…" : "Send"}
                    </button>
                  </div>
                  {actionError === r.id && (
                    <span style={{ fontSize: 12, color: "#c62828" }}>
                      Didn’t go through — try again
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {r.status === "open" && (
                    <button
                      onClick={() => void act(r.id, { action: "resolve" })}
                      disabled={busy}
                      style={{
                        fontSize: 13, padding: "8px 12px", minHeight: 44,
                        border: "1px solid #a5d6a7", borderRadius: 6,
                        background: "#fff", color: "#2e7d32",
                        cursor: busy ? "default" : "pointer", fontFamily: "inherit",
                      }}
                    >
                      ✓ Resolved for me
                    </button>
                  )}
                  <button
                    onClick={() => { setReplyFor(r.id); setReplyText(""); setActionError(null); }}
                    disabled={busy}
                    style={{
                      fontSize: 13, padding: "8px 12px", minHeight: 44,
                      border: "1px solid #bbb", borderRadius: 6,
                      background: "#fff", color: "#546e7a",
                      cursor: busy ? "default" : "pointer", fontFamily: "inherit",
                    }}
                  >
                    Reply
                  </button>
                  <button
                    onClick={() => void act(r.id, { action: r.archived ? "unarchive" : "archive" })}
                    disabled={busy}
                    title={r.archived ? "Move back to your list" : "Tidy this away — it stays viewable under Archived"}
                    style={{
                      fontSize: 13, padding: "8px 12px", minHeight: 44,
                      border: "1px solid #bbb", borderRadius: 6,
                      background: "#fff", color: "#90a4ae",
                      cursor: busy ? "default" : "pointer", fontFamily: "inherit",
                    }}
                  >
                    {r.archived ? "Unarchive" : "Archive"}
                  </button>
                  {actionError === r.id && (
                    <span style={{ fontSize: 12, color: "#c62828" }}>
                      Didn’t go through — try again
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {reports.some((r) => r.archived) && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            style={{
              fontSize: 13, padding: "8px 12px", minHeight: 44,
              border: "none", background: "transparent", color: "#78909c",
              cursor: "pointer", fontFamily: "inherit", textAlign: "center",
            }}
          >
            {showArchived
              ? "Hide archived"
              : `Show ${reports.filter((r) => r.archived).length} archived`}
          </button>
        )}
        </>
      )}
    </div>
  );
};

export default IssuesPanel;
