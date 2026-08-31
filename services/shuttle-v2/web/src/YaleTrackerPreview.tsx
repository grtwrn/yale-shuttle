import { useState } from "react";

import { ROUTE_LISTS } from "./routes";

/**
 * Opens the official Yale Downtowner tracker for a specific route, inline.
 *
 * This existed in v1 and was lost in the v2 rewrite. It earns its place: this
 * app is a third-party reading of the same feed, so when a rider doubts what
 * they are seeing, being one tap from the operator's own view — for the route
 * they are actually looking at, not the tracker's landing page — is the fastest
 * way to settle it.
 *
 * The frame is deliberately NOT granted geolocation. v1 passed
 * `allow="geolocation"`, which silently handed the rider's position to a third
 * party embedded in our page; this app already shows them their own position,
 * so the grant bought nothing a rider would notice and cost something they
 * could not see. "Open ↗" gives the full experience in its own tab, where the
 * permission prompt is the site's own and the rider can see who is asking.
 */

/** The tracker publishes one page per upstream route id. */
const TRACKER_BASE = "https://yale.downtownerapp.com/routes";

/** Upstream route id for a ROUTE_LISTS label, or null if the label is unknown. */
export function trackerRouteId(routeLabel: string): number | null {
  const cfg = ROUTE_LISTS.find((r) => r.label === routeLabel);
  return cfg?.busRouteIds[0] ?? null;
}

export function trackerUrl(routeLabel: string): string | null {
  const id = trackerRouteId(routeLabel);
  return id == null ? null : `${TRACKER_BASE}/${id}`;
}

export function YaleTrackerPreview({
  routeLabel,
  color,
}: {
  routeLabel: string;
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const url = trackerUrl(routeLabel);
  // A route we cannot map to an upstream id has nothing to open.
  if (!url) return null;

  if (!open) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={`Open the official Yale tracker for ${routeLabel}`}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          marginTop: 8,
          borderRadius: 8,
          minHeight: 44,
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "inherit",
          border: `1px solid ${color}`,
          background: "#fff",
          color,
          cursor: "pointer",
        }}
      >
        <span>📱 Yale tracker</span>
        <span style={{ fontSize: 16, lineHeight: 1 }}>▾</span>
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
      {/* The whole bar collapses, so the rider does not have to hunt for a
          small ✕. "Open ↗" stops propagation so it opens instead of closing. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
        title="Hide preview"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 14px",
          borderRadius: "8px 8px 0 0",
          border: `1px solid ${color}`,
          borderBottom: "none",
          background: color,
          color: "#fff",
          fontSize: 14,
          fontWeight: 600,
          minHeight: 44,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        <span>📱 Yale tracker — {routeLabel}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open in a new tab"
            style={{
              fontSize: 13,
              color: "#fff",
              textDecoration: "underline",
              fontWeight: 500,
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            open ↗
          </a>
          <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
            ✕
          </span>
        </span>
      </button>
      <iframe
        src={url}
        title={`Official Yale tracker for ${routeLabel}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{
          display: "block",
          width: "100%",
          height: 360,
          border: `1px solid ${color}`,
          borderTop: "none",
          borderRadius: "0 0 8px 8px",
          background: "#fff",
        }}
      />
    </div>
  );
}
