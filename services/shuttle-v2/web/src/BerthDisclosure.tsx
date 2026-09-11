// The berth block, folded away behind a warning on the Directions row.
//
// THE ASK (operator, 2026-09-11, on the block shipped in #221): "maybe we can
// collapse the stop location by default and put a drop-down button next to
// directions to published stop that has an ! alert to tell user historical stop
// location is different published and it shows the details?"
//
// The block answers a question most riders at most stops do not have — ten
// cells out of 229 measured — and it had grown to a 200 px map plus two lines
// of prose sitting between the trip and its one prominent action. Folded, what
// is left is the one fact that matters at a glance ("⚠ Stops 55 m past") and a
// way in. The warning is the summary, not a label on an empty drawer: a rider
// who reads only the closed state has already been told the thing.
//
// Two consequences worth keeping:
//
// - **Collapsed means the map is NOT MOUNTED.** `BerthInset` is rendered, not
//   hidden, so a folded card carries no Leaflet instance at all — no tile
//   requests, no panes, no teardown to get right. That is the same lifecycle
//   `expandedKey` gives the card, one level down, and it is measured the same
//   way (`scripts/berth-teardown-check.mjs`).
// - **The fold does not persist, by decision.** The state lives in this
//   component and this component mounts when the card expands, so every expand
//   starts folded. A remembered "open" would re-mount a map on a card the rider
//   only glanced at, and the warning is already the summary.
//
// Cards with no berth never reach this file: `TransitMap` renders the plain
// Directions anchor exactly as before, byte for byte.

import { useState } from "react";

import type { Berth } from "./berths";
import { berthDirectionsText, berthToggleText } from "./berthWords";
import { BerthInset } from "./BerthInset";
import type { LatLon } from "./geo";

export function BerthDisclosure({
  berth, published, routeLabel, color, stopName, path, navHref, boardName,
}: {
  berth: Berth;
  published: LatLon | undefined;
  routeLabel: string;
  color: string;
  stopName: string;
  path: readonly [number, number][];
  /** Null when the board stop has no coordinate — then the row is the toggle alone. */
  navHref: string | null;
  boardName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* One row: the card's prominent action, and the warning that qualifies
          it. `flexWrap` is the fallback, and what it catches is the OPEN state,
          where the longer label pushes the pair to 393 px — two rows of
          controls above a 200 px map is nothing, and stacking beats an
          ellipsis on either one. Folded, the pair is 311 px and shares a line
          at 360, 390 and 430. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {/* Directions is the card's one prominent action (user request
            2026-07-17: "make it more obvious"); `berthDirectionsText` above is
            why its words depend on the fold. */}
        {navHref && (
          <a
            href={navHref}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`Walking directions to ${boardName}`}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: 6, minHeight: 44, borderRadius: 8,
              border: "1.5px solid #1a73e8", color: "#1a73e8",
              fontWeight: 600, fontSize: 14,
              textDecoration: "none", fontFamily: "inherit",
              flex: "1 1 auto", whiteSpace: "nowrap", padding: "0 8px",
            }}
          >{berthDirectionsText(open)}</a>
        )}
        {/* The amber of the service announcements above, not a second blue
            button: this qualifies the action beside it, it does not compete
            with it. */}
        <button
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          aria-expanded={open}
          aria-label={`${routeLabel} stops about ${Math.round(Math.abs(berth.offsetM))} metres ${berth.offsetM > 0 ? "past" : "before"} the published ${stopName} stop — show where`}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 4, minHeight: 44, borderRadius: 8, padding: "0 10px",
            border: "1.5px solid #FFE082", background: "#FFF8E1",
            color: "#795548", fontWeight: 600, fontSize: 13,
            fontFamily: "inherit", cursor: "pointer",
            // Grows with the button beside it, so the row reads as two columns
            // when they share a line and as two stacked controls when the open
            // state pushes them apart — not a full-width button with an
            // orphaned chip under one end of it.
            flex: "1 1 auto", whiteSpace: "nowrap",
          }}
        >
          <span>{berthToggleText(berth)}</span>
          <span aria-hidden="true" style={{ fontSize: 11 }}>{open ? "▴" : "▾"}</span>
        </button>
      </div>
      {/* Below the control that opens it, which is what a disclosure is. It
          used to sit ABOVE Directions, when it was always on screen and the
          thing it corrected was the button under it. */}
      {open && (
        <BerthInset
          berth={berth}
          published={published}
          routeLabel={routeLabel}
          color={color}
          stopName={stopName}
          path={path}
        />
      )}
    </>
  );
}
