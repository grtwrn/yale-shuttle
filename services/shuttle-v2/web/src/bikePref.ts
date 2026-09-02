// Whether the trip picker offers a bike row, remembered between visits.
//
// Default ON. A hidden-by-default option is one nobody finds — that lesson is
// already written down about the weather line, which was suppressed below a
// 50% chance of rain and so taught riders not to look for it. So the bike row
// shows up on its own, and the rider who has no bike turns it off once.
//
// Off is therefore a deliberate choice and must survive the visit; the toggle
// that sets it stays on the options card either way, so there is never a state
// with a row missing and no obvious way back.
//
// Every storage touch is guarded: with site data blocked `localStorage` throws
// on ACCESS, and an unguarded read in a state initialiser blank-screens the
// app — that has happened here before.

const KEY = "bikeOption";

/** The stored preference, defaulting to on for a browser that has never set it. */
export function loadBikePref(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveBikePref(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode or quota — the choice still holds for this visit */
  }
}
