// Which shuttle lines the Map tab is showing, remembered between visits.
//
// The rider who only ever rides Blue should not re-hide fourteen routes every
// time they open the map (operator request, 2026-09-02). Stored as the set of
// HIDDEN toggle labels rather than the shown ones, so a route added upstream
// shows up by default instead of silently staying invisible.
//
// Every storage touch is guarded: with site data blocked, `localStorage`
// throws on ACCESS, and an unguarded read in a state initialiser blank-screens
// the app — that has happened here before.

const KEY = "mapHiddenRoutes";

/** Hidden toggle labels from storage; an empty set when nothing is stored. */
export function loadHiddenRoutes(known: readonly string[]): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    // Drop labels we no longer recognise: a renamed route must not leave a
    // ghost entry that hides nothing and can never be cleared from the UI.
    const knownSet = new Set(known);
    return new Set(parsed.filter((x): x is string => typeof x === "string" && knownSet.has(x)));
  } catch {
    return new Set();
  }
}

export function saveHiddenRoutes(hidden: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    /* private mode or quota — the filter still works for this visit */
  }
}

/**
 * The toggle every "Show all / Hide all" press should produce.
 *
 * Pressing it when anything is visible hides everything; pressing it when all
 * are hidden shows everything. Never a no-op, and never a state where the map
 * is empty with no obvious way back.
 */
export function toggleAll(known: readonly string[], hidden: Set<string>): Set<string> {
  const allHidden = known.length > 0 && known.every((l) => hidden.has(l));
  return allHidden ? new Set() : new Set(known);
}

/** Flip one route, returning a new set (never mutates). */
export function toggleOne(hidden: Set<string>, label: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  return next;
}

/**
 * What the MAP hides once the "Running now" toggle is applied on top of the
 * chip row (operator, 2026-09-06: "have the running now filter work on the
 * map" — it used to filter only the route cards underneath).
 *
 * With the toggle on and buses reporting, every known line without a bus on
 * it is hidden IN ADDITION to whatever the chips hide, so the chips remain
 * the manual override in the other direction: a chip switched off stays off.
 * With the toggle off — or with no buses at all, when it is inert for the
 * cards too — the chip selection comes back unchanged, so the map behaves
 * exactly as it did before the toggle reached it.
 *
 * `running` is the set of toggle labels with a live bus ON ROUTE, the same
 * test the cards use — a bus upstream has mis-assigned to a line does not
 * light that line up here either.
 */
export function drawnHidden(
  known: readonly string[],
  chipHidden: ReadonlySet<string>,
  activeOnly: boolean,
  anyBuses: boolean,
  running: ReadonlySet<string>,
): Set<string> {
  const out = new Set(chipHidden);
  if (!activeOnly || !anyBuses) return out;
  for (const label of known) if (!running.has(label)) out.add(label);
  return out;
}
