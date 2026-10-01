import { useId, useState } from "react";

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
  const frameId = useId();
  const url = trackerUrl(routeLabel);
  if (!url) return null;

  return (
    <div className={open ? "trip-tracker-open" : undefined} onClick={(e) => e.stopPropagation()}>
      <div style={open ? { display: "flex", alignItems: "center", gap: 8 } : undefined}>
        <button
          className="trip-action-button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={frameId}
          title={open ? "Hide preview" : `Open the official Yale tracker for ${routeLabel}`}
          style={open ? { flex: 1, color, borderColor: color } : undefined}
        >
          <span>📱 Yale tracker{open ? ` — ${routeLabel}` : ""}</span>
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
        {open && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            style={{ minHeight: 44, display: "inline-flex", alignItems: "center",
              padding: "0 8px", fontSize: 13, color: "#1a73e8", whiteSpace: "nowrap" }}
          >Open ↗</a>
        )}
      </div>
      {open && (
        <iframe
          id={frameId}
          src={url}
          title={`Official Yale tracker for ${routeLabel}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ display: "block", boxSizing: "border-box", width: "100%", height: 360,
            marginTop: 8, border: `1px solid ${color}`, borderRadius: 8, background: "#fff" }}
        />
      )}
    </div>
  );
}
