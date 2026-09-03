import type React from "react";

/**
 * The two standing notices the app owes its riders.
 *
 * Both live here rather than inline in `TransitMap.tsx` for the reason the
 * other sibling modules exist: they are testable without mounting React or
 * Leaflet, and a 7.5k-line component is the wrong place to hide a legal line.
 *
 * Neither is dismissible. The disclaimer is the sentence that keeps the app's
 * name honest, and a rider who dismissed it on day one would never see it
 * again; the beta notice is the operator's only standing invitation to send a
 * report, and on a launch that is days old it is worth the one quiet line.
 * Nothing here touches storage, so there is no blocked-storage path to guard.
 */

/**
 * Colours are spelled out on BOTH sides of every pair (background and text).
 * The app has no dark theme, so a banner that set only one would be the first
 * thing to become unreadable under a browser that darkens pages on its own.
 * These are the muted greys the rest of the chrome already uses; no route
 * colour appears here — those have exactly one source (`routes.ts`).
 */
const MUTED = "#78909c";
const INK = "#37474f";

const betaStyle: React.CSSProperties = {
  // A button, so the whole strip is the target — 44 px is this project's
  // minimum and the strip clears it on its own.
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  width: "100%",
  minHeight: 44,
  padding: "6px 14px",
  fontSize: 13,
  fontFamily: "inherit",
  // Left-aligned text that wraps under itself rather than a centred line
  // breaking into two ragged halves on a narrow phone.
  textAlign: "left",
  lineHeight: 1.3,
  color: INK,
  background: "#fff",
  border: "1px solid #e0ddd8",
  borderRadius: 10,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

const disclaimerStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 560,
  margin: "0 auto 20px",
  padding: "0 16px",
  boxSizing: "border-box",
  // Quiet by design: this is a standing fact, not a message competing with
  // the arrival times above it.
  fontSize: 11,
  lineHeight: 1.4,
  textAlign: "center",
  color: MUTED,
};

/** What the beta strip says. Pinned in a test so it keeps naming the action. */
export const BETA_LABEL = "In beta — please report any issues";

/** The disclaimer, verbatim. */
export const DISCLAIMER_TEXT =
  "Not affiliated with or endorsed by Yale University.";

/**
 * The beta notice. Tapping it opens the footer's feedback composer — a banner
 * that mentions feedback without leading to it is half a feature, and the
 * composer is otherwise a full page-scroll away.
 */
export function BetaBanner({ onSendFeedback }: { onSendFeedback: () => void }) {
  return (
    <div
      style={{
        width: "100%", maxWidth: 560, padding: "0 16px", boxSizing: "border-box",
        margin: "2px auto 6px", display: "flex",
      }}
    >
      <button
        type="button"
        onClick={onSendFeedback}
        // The visible label says "report any issues"; the accessible name has
        // to say what the tap DOES, since a screen reader gets no chevron.
        aria-label="In beta — open the feedback form to report an issue"
        style={betaStyle}
      >
        <span aria-hidden="true" style={{ flex: "none" }}>🧪</span>
        <span style={{ flex: 1 }}>{BETA_LABEL}</span>
        <span aria-hidden="true" style={{ flex: "none", color: MUTED }}>›</span>
      </button>
    </div>
  );
}

/**
 * The affiliation disclaimer, at the foot of every page. Plain text, not a
 * link and not a control: there is nothing to tap and nothing to dismiss.
 */
export function AffiliationDisclaimer() {
  return <div style={disclaimerStyle}>{DISCLAIMER_TEXT}</div>;
}
