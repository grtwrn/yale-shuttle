/**
 * "Do I have a bike?" — one boolean, kept in localStorage beside the
 * favourites and saved trips the app already stores there.
 *
 * It is a standing fact about the rider, not a per-search choice: someone who
 * owns a bike owns it tomorrow too, so asking again every time they plan a
 * trip would be the wrong question. Off by default — riders without a bike
 * must never see a bike row.
 *
 * Every path is non-throwing. localStorage THROWS outright under Safari's
 * "Block All Cookies" and inside some in-app webviews; a preference is not a
 * reason for the trip planner to fail, so a browser that cannot store one
 * simply plans without a bike.
 */

const KEY = "shuttle-has-bike";

/** The stored preference, false when unset or unreadable. */
export function loadBikePref(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the preference. Silently a no-op when storage is unavailable. */
export function saveBikePref(hasBike: boolean): void {
  try {
    if (hasBike) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked — the toggle still works for this session */
  }
}
