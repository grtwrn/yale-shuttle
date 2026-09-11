import React from "react";

// The dropdown under a trip-form box: one list for suggestions as the rider
// types AND for the places offered before they type (recents, saved, popular,
// "Current location"). The From and To boxes both render through it, so a
// row looks and behaves the same under either — it used to be two inline
// copies that had already begun to drift.

export type PlaceRow = {
  /** Stable identity for React and for `aria-activedescendant`. */
  key: string;
  /** Leading emoji — `suggIcon` for a geocoder hit, 🕘 for a recent, and so on. */
  icon: string;
  label: string;
  /** Small caption printed above this row when it opens a new group. */
  section?: string;
  onPick: () => void;
};

export const PlaceList: React.FC<{
  /** The listbox id the input's `aria-controls` names; rows are `${id}-${i}`. */
  id: string;
  rows: PlaceRow[];
  /** Keyboard-highlighted index, -1 for none. */
  active: number;
  onHover: (i: number) => void;
}> = ({ id, rows, active, onHover }) => {
  if (rows.length === 0) return null;
  return (
    <div
      id={id}
      role="listbox"
      // A tap on a row must not blur the input first: the box's blur handler
      // restores the previous pill 180 ms later, and on a slow tap the click
      // used to lose that race. Keeping focus on the input means the only
      // blur is the one the pick itself performs.
      onMouseDown={(e) => e.preventDefault()}
      style={{ border: "1px solid #e0ddd8", borderRadius: 6, marginTop: 4, background: "#fff", marginLeft: 32 }}
    >
      {rows.map((r, i) => (
        <React.Fragment key={r.key}>
          {r.section && (r.section !== rows[i - 1]?.section) && (
            <div style={{
              fontSize: 9, color: "#78909c", textTransform: "uppercase", letterSpacing: 1,
              padding: "8px 14px 0",
              borderTop: i === 0 ? "none" : "1px solid #f0ede8",
            }}>
              {r.section}
            </div>
          )}
          <div
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => onHover(i)}
            onClick={r.onPick}
            style={{
              padding: "12px 14px",
              fontSize: 15,
              cursor: "pointer",
              minHeight: 48,
              display: "flex",
              alignItems: "center",
              background: i === active ? "#eef4ff" : "transparent",
              borderBottom: i === rows.length - 1 || rows[i + 1]?.section !== r.section ? "none" : "1px solid #f0ede8",
              gap: 8,
            }}
          >
            <span style={{ flexShrink: 0 }}>{r.icon}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
