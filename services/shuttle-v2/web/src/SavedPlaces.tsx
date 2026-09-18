import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { samePlace, type SavedTrip } from "./recents";

type Props = {
  saved: SavedTrip[];
  recent: SavedTrip[];
  onPick: (place: SavedTrip) => void;
  onSave: (place: SavedTrip) => void;
  onRename: (id: string, name: string) => void;
  onDeleteSaved: (id: string) => void;
  onDeleteRecent: (id: string) => void;
  onClearRecent: () => void;
  focusDestination: () => void;
};
const actionStyle: CSSProperties = {
  minWidth: 44, minHeight: 44, padding: "6px 8px", border: "none",
  background: "transparent", color: "#546e7a", fontSize: 13,
  cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
};
const nameStyle: CSSProperties = {
  minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  color: "#C62828", fontWeight: 600,
};
const headerStyle: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
};
const headingStyle: CSSProperties = {
  fontSize: 11, color: "#546e7a", textTransform: "uppercase", letterSpacing: 1,
};

/** Destination lists share removal focus but keep stored records in the shell. */
export function SavedPlaces({ saved, recent, onPick, onSave, onRename, onDeleteSaved,
  onDeleteRecent, onClearRecent, focusDestination }: Props) {
  const [editing, setEditing] = useState(false);
  const controls = useRef(new Map<string, HTMLElement>());
  const editButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ origin: Element; key: string | null } | null>(null);
  const controlRef = (key: string) => (element: HTMLElement | null) => {
    if (element) controls.current.set(key, element);
    else controls.current.delete(key);
  };
  // Restore only focus owned by the removed row. A rider who moved elsewhere
  // before this commit keeps that position; no timer can steal it later.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || (document.activeElement !== document.body && document.activeElement !== pending.origin)) return;
    const target = pending.key ? controls.current.get(pending.key) : null;
    if (target) target.focus();
    else if (editButton.current) editButton.current.focus();
    else if (recent[0]) controls.current.get(`recent:${recent[0].id}`)?.focus();
    else focusDestination();
  });
  useLayoutEffect(() => { if (!saved.length) setEditing(false); }, [saved.length]);

  const prepareRemoval = (button: HTMLButtonElement, key: string | null) => {
    const active = document.activeElement;
    if (active && (active === button || button.parentElement?.contains(active))) pendingFocus.current = { origin: active, key };
  };
  const neighbor = (list: SavedTrip[], index: number, prefix: string) => {
    const next = list[index + 1] ?? list[index - 1];
    return next ? `${prefix}:${next.id}` : null;
  };
  return <>
    {saved.length > 0 && <section aria-label="Saved destinations" style={{ marginTop: 20, marginBottom: 8 }}>
      <div style={headerStyle}>
        <span style={headingStyle}>Saved destinations</span>
        <button ref={editButton} type="button" aria-label={editing ? "Done editing saved destinations" : "Edit saved destinations"}
          aria-pressed={editing} onClick={() => setEditing(value => !value)} style={actionStyle}>
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 4, maxHeight: 240, overflowY: "auto" }}>
        {saved.map((place, index) => editing ? <div key={place.id} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8,
          background: "#f1f8e9", border: "1px solid #c5e1a5", gridColumn: "1 / -1",
        }}>
          <span aria-hidden="true" style={{ color: "#2E7D32", fontSize: 11 }}>★</span>
          <input ref={controlRef(`saved:${place.id}`)} aria-label={`Rename ${place.toText}`} defaultValue={place.toText}
            onBlur={event => {
              const value = event.currentTarget.value.trim();
              if (value && value !== place.toText) onRename(place.id, value);
              event.currentTarget.value = value || place.toText;
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.value = place.toText;
                editButton.current?.focus();
              } else if (event.key === "Enter") {
                event.preventDefault();
                editButton.current?.focus();
              }
            }}
            style={{ flex: 1, minWidth: 0, minHeight: 44, boxSizing: "border-box", fontSize: 16, padding: "6px",
              border: "1px solid #cfd8dc", background: "#fff", borderRadius: 4, fontFamily: "inherit", color: "#263238" }} />
          <button type="button" aria-label={`Delete saved destination ${place.toText}`}
            // Prevent pointer blur from saving a partial rename before deletion.
            // Activation belongs to click so touch and keyboard work alike.
            onPointerDown={event => event.preventDefault()}
            onClick={event => { prepareRemoval(event.currentTarget, neighbor(saved, index, "saved")); onDeleteSaved(place.id); }}
            style={{ ...actionStyle, color: "#C62828" }}>Delete</button>
        </div> : <button key={place.id} ref={controlRef(`saved:${place.id}`)} type="button"
          aria-label={`Plan trip to ${place.toText}`} title={place.toText} onClick={() => onPick(place)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, minHeight: 44, minWidth: 0,
            padding: "3px 10px", borderRadius: 999, background: "#fff", border: "1px solid #c5e1a5",
            fontFamily: "inherit", fontSize: 12, cursor: "pointer", maxWidth: "100%" }}>
          <span aria-hidden="true" style={{ color: "#2E7D32", fontSize: 10 }}>★</span>
          <span style={nameStyle}>{place.toText}</span>
        </button>)}
      </div>
    </section>}
    {recent.length > 0 && <section aria-label="Recent places" style={{ marginTop: saved.length ? 8 : 20, marginBottom: 10 }}>
      <div style={headerStyle}>
        <span style={headingStyle}>Recent places</span>
        <button type="button" aria-label="Clear all recent places" style={actionStyle}
          onClick={event => { prepareRemoval(event.currentTarget, null); onClearRecent(); }}>Clear all</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }}>
        {recent.map((place, index) => <div key={place.id} style={{ display: "flex", alignItems: "center", gap: 4,
          padding: "4px 8px", borderRadius: 8, background: "#fff", border: "1px solid #e0ddd8" }}>
          <button ref={controlRef(`recent:${place.id}`)} type="button" aria-label={`Plan trip to ${place.toText}`}
            title={place.toText} onClick={() => onPick(place)}
            style={{ ...actionStyle, ...nameStyle, minWidth: 44, flex: 1, textAlign: "left" }}>
            <span aria-hidden="true" style={{ color: "#78909c", marginRight: 4 }}>→</span>{place.toText}
          </button>
          <button type="button" aria-label={`Save destination ${place.toText}`} title={`Save ${place.toText}`}
            onClick={event => {
              const existing = saved.find(item => samePlace(item, place));
              const entry = existing ?? { ...place, id: `t${Date.now().toString(36)}` };
              prepareRemoval(event.currentTarget, `saved:${entry.id}`);
              if (!existing) onSave(entry);
              onDeleteRecent(place.id);
            }} style={{ ...actionStyle, color: "#2E7D32", fontSize: 18 }}>☆</button>
          <button type="button" aria-label={`Remove recent place ${place.toText}`} title={`Remove ${place.toText}`}
            onClick={event => { prepareRemoval(event.currentTarget, neighbor(recent, index, "recent")); onDeleteRecent(place.id); }}
            style={actionStyle}>✕</button>
        </div>)}
      </div>
    </section>}
  </>;
}
